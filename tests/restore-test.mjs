// 备份恢复：密码二次校验 + 一次提交整库替换。
// 覆盖审计里的两条：① 恢复必须验密码（旧实现整条链路不校验）；② 恢复必须原子（旧实现逐表覆盖）。
// 跑法：node tests/restore-test.mjs
import assert from 'node:assert/strict'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi, derive, rebuildStock } from '../api/routes.js'
import { issueToken } from '../api/auth.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', APP_PASSWORD: 'pw'
}

const line = (code, name, qty, price) => ({ code, name, unit: '个', qty, price, total: Math.round(qty * price * 100) / 100 })
const order = (id, date, qty = 10) => ({
  id, date, supplier: '供应商甲', total: qty * 10, discount: 0, settle: '挂账',
  payments: [], items: [line('P00001', '管件', qty, 10)]
})
const sale = (id, date, qty = 3) => ({
  id, date, customer: '客户甲', total: qty * 10, discount: 0, settle: '挂账',
  payments: [], items: [line('P00001', '管件', qty, 10)]
})

const baseItems = [{ code: 'P00001', name: '管件', unit: '个', cost: 8, price: 10 }]
const baseSuppliers = [{ code: 'S00001', name: '供应商甲', products: ['P00001'] }]
const baseCustomers = [{ code: 'C00001', name: '客户甲', contact: '', phone: '', remark: '' }]

// 现库：一张采购、一张销售；库存 = 采购 10 − 销售 3 = 7
const nowPurchases = [order('C202610011000000001', '2026-10-01', 10)]
const nowSales = [sale('X202610021000000001', '2026-10-02', 3)]
const nowStock = rebuildStock(nowPurchases, nowSales, baseItems)

let repo, token = ''
const seed = (overrides = {}) => {
  repo = makeFakeRepo({
    'items.json': baseItems, 'suppliers.json': baseSuppliers, 'customers.json': baseCustomers,
    'receipts.json': [], 'payment-vouchers.json': [], 'refunds.json': [], 'orders.json': [],
    'order-templates.json': [], 'shares.json': [], 'profile.json': { name: '', phone: '', address: '', remark: '' },
    'stock.json': nowStock, 'logs.json': [],
    'purchases-2026.json': nowPurchases, 'sales-2026.json': nowSales,
    '.split-yearly.json': { purchases: true, sales: true },
    ...overrides
  })
}

const call = async (path, method, body) => {
  const req = new Request(`https://worker.test/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://worker.test' },
    body: body ? JSON.stringify(body) : undefined
  })
  const res = await handleApi(req, new URL(req.url), env)
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}
const ok = async (path, method, body) => {
  const r = await call(path, method, body)
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${r.data && r.data.error || ''}`)
  return r.data
}
const read = (p) => JSON.parse(repo.read(p))
const commits = () => repo.log().length

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')) }
}

// 备份：采购 20（换了一张新单）、销售 3，库存应为 20 − 3 = 17
const backup = (extra = {}) => ({
  items: baseItems,
  suppliers: baseSuppliers,
  customers: baseCustomers,
  purchases: [order('C202601011000000002', '2026-01-01', 20)],
  sales: [sale('X202601021000000002', '2026-01-02', 3)],
  ...extra
})

seed()
token = await issueToken(env)

console.log('\n备份恢复：密码闸门')
await t('没有密码 → 403，且一个字都不写', async () => {
  const before = commits()
  const r = await call('/restore', 'POST', { data: backup() })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /密码/)
  assert.equal(commits(), before, '被拒的恢复不能产生提交')
  assert.deepEqual(read('purchases-2026.json'), nowPurchases)
})

await t('密码错误 → 403，且一个字都不写', async () => {
  const before = commits()
  const r = await call('/restore', 'POST', { password: 'wrong', data: backup() })
  assert.equal(r.status, 403)
  assert.equal(commits(), before)
})

await t('/import（整表覆盖式文本导入）同样要求密码', async () => {
  const before = commits()
  const r = await call('/import', 'POST', { text: '{"items":[]}' })
  assert.equal(r.status, 403)
  assert.equal(commits(), before)
})

console.log('\n备份恢复：校验与原子性')
await t('缺核心表 → 400，不提交', async () => {
  const before = commits()
  const r = await call('/restore', 'POST', { password: 'pw', data: { items: [] } })
  assert.equal(r.status, 400)
  assert.match(r.data.error, /备份不完整/)
  assert.equal(commits(), before)
})

await t('行数超上限 → 400（防拿错文件把库写爆）', async () => {
  const huge = new Array(20001).fill({ code: 'P1' })
  const r = await call('/restore', 'POST', { password: 'pw', data: { ...backup(), items: huge } })
  assert.equal(r.status, 400)
  assert.match(r.data.error, /上限/)
})

let committed = 0
await t('恢复成功 = 一次提交，单据/商品/库存同时换成备份里的样子', async () => {
  const before = commits()
  const r = await ok('/restore', 'POST', { password: 'pw', data: backup() })
  committed = commits() - before
  assert.equal(committed, 1, '整库替换必须是一次提交')
  assert.equal(r.counts.items, 1)
  assert.deepEqual(read('purchases-2026.json').map(x => x.id), ['C202601011000000002'])
  assert.deepEqual(read('sales-2026.json').map(x => x.id), ['X202601021000000002'])
  // 库存按恢复后的单据重算：采购 20 − 销售 3 = 17
  assert.equal(read('stock.json').P00001.qty, 17)
  const logs = read('logs.json')
  assert.equal(logs[logs.length - 1].source, 'restore')
})

await t('旧备份没有的集合保持现状（不因为恢复被清空）', async () => {
  seed({ 'orders.json': [{ id: 'D1', status: '未过账', kind: 'sale', customer: '客户甲', date: '2026-10-28', items: [line('P00001', '管件', 1, 10)] }] })
  token = await issueToken(env)
  await ok('/restore', 'POST', { password: 'pw', data: backup() })
  assert.equal(read('orders.json').length, 1, '备份里没有 orders 时不能把现有草稿清掉')
})

await t('备份里有的可选集合会被恢复（模板/分享/用户信息）', async () => {
  seed()
  token = await issueToken(env)
  await ok('/restore', 'POST', {
    password: 'pw',
    data: backup({
      'order-templates': [{ id: 'T1', name: '常用组合', kind: 'sale', items: [] }],
      shares: [{ token: 'abc', kind: 'sale', docId: 'X202601021000000002', createdAt: '2026-01-01T00:00:00.000Z' }],
      profile: { name: '张三', phone: '138', address: '', remark: '' }
    })
  })
  assert.equal(read('order-templates.json')[0].name, '常用组合')
  assert.equal(read('shares.json')[0].token, 'abc')
  assert.equal(read('profile.json').name, '张三')
})

await t('同样内容再恢复一次 = 0 提交（幂等）', async () => {
  const before = commits()
  const r = await ok('/restore', 'POST', { password: 'pw', data: backup() })
  assert.equal(commits(), before, '内容未变不应再提交')
  assert.equal(r.unchanged, true)
})

await t('导入前会剥掉新版不会落库的字段（purchaseHistory / 前端流水标记）', async () => {
  seed()
  token = await issueToken(env)
  const withJunk = backup({
    items: [{ code: 'P00001', name: '管件', unit: '个', cost: 8, price: 10, purchaseHistory: [{ price: 9 }], warning: 0 }],
    sales: [sale('X202601021000000002', '2026-01-02', 3)]
  })
  withJunk.sales[0].payments = [{ date: '2026-01-02', amount: 30, mid: 'm1', _new: true, remark: '', time: '' }]
  await ok('/restore', 'POST', { password: 'pw', data: withJunk })
  const items = read('items.json')
  assert.ok(!('purchaseHistory' in items[0]))
  assert.ok(!('warning' in items[0]))
  const p = read('sales-2026.json')[0].payments[0]
  assert.ok(!('mid' in p) && !('_new' in p), '一次性标记不能落库')
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
