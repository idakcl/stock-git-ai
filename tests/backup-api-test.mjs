// 备份相关接口：未过账订单 / 退款核销单的「整表恢复」与「按单号去重追加」。
// 备份导入是整体覆盖语义，不能用订单的业务操作接口（save/post）拼出来，因此新增 restore 动作。
// 跑法：node tests/backup-api-test.mjs
import assert from 'node:assert/strict'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi, derive, rebuildStock } from '../api/routes.js'
import { issueToken } from '../api/auth.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw'
}

const line = (code, name, qty, price) => ({ code, name, unit: '个', qty, price, total: Math.round(qty * price * 100) / 100 })

const seedData = () => ({
  items: [{ code: 'P00001', name: '管件', unit: '个', cost: 8, price: 10 }],
  suppliers: [{ code: 'S00001', name: '供应商甲', products: ['P00001'] }],
  customers: [{ code: 'C00001', name: '客户甲', contact: '', phone: '', remark: '' }],
  purchases: [{
    id: 'C1', date: '2026-10-01', supplier: '供应商甲', total: 100, discount: 0, settle: '结清',
    payments: [{ date: '2026-10-01', amount: 100, remark: '', time: '' }], items: [line('P00001', '管件', 10, 10)]
  }],
  sales: [{
    id: 'X1', date: '2026-10-02', customer: '客户甲', total: 50, discount: 0, settle: '结清',
    payments: [{ date: '2026-10-02', amount: 50, remark: '', time: '' }], items: [line('P00001', '管件', 5, 10)]
  }],
  orders: [],
  refunds: [],
  receipts: [], 'payment-vouchers': [], logs: []
})

const raw = seedData()
const derived = derive(raw.items, raw.suppliers, raw.purchases, raw.sales, raw.customers)
const seedStock = rebuildStock(derived.purchases, derived.sales, derived.items)

let repo, token = ''
const seed = (overrides = {}) => {
  repo = makeFakeRepo({
    'items.json': derived.items, 'suppliers.json': derived.suppliers, 'customers.json': derived.customers,
    'receipts.json': [], 'payment-vouchers.json': [], 'refunds.json': [], 'logs.json': [],
    'stock.json': seedStock,
    'purchases-2026.json': derived.purchases, 'sales-2026.json': derived.sales,
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
  if (!res.ok) { const error = new Error(`${method} ${path} → ${res.status} ${data && data.error || ''}`); error.status = res.status; throw error }
  return data
}
const badCall = async (path, method, body) => {
  try { await call(path, method, body) } catch (e) { return e }
  throw new Error(`${path} 本该被拒绝`)
}
const read = (p) => JSON.parse(repo.read(p))
const commits = () => repo.log().length

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (String(e && e.message || e)).split('\n').join('\n      ')) }
}

const order = (id, extra = {}) => ({ id, status: '未过账', kind: 'sale', customer: '客户甲', date: '2026-10-28', items: [line('P00001', '管件', 2, 10)], ...extra })
const refund = (code, extra = {}) => ({ code, kind: 'sale', category: 'refund', direction: 'to_customer', total: 20, date: '2026-10-20', ...extra })

seed()
token = await issueToken(env)

console.log('\n未过账订单：restore 整表替换')

await t('restore 自动创建 orders.json，一次提交，且不动单据与库存', async () => {
  assert.equal(repo.has('orders.json'), false) // 新集合，底库还没有这个文件
  const before = commits()
  const salesBefore = repo.read('sales-2026.json')
  const stockBefore = repo.read('stock.json')
  const r = await call('/orders', 'POST', { action: 'restore', orders: [order('D202610280900000001'), order('D202610280900000002', { status: '已过账', postedOrderId: 'X1' })] })
  assert.equal(r.ok, true)
  assert.equal(r.restored, 2)
  assert.equal(commits(), before + 1)
  assert.equal(read('orders.json').length, 2)
  // 订单不参与派生：单据与库存一个字节都不该变
  assert.equal(repo.read('sales-2026.json'), salesBefore)
  assert.equal(repo.read('stock.json'), stockBefore)
  assert.deepEqual(await call('/orders', 'GET'), read('orders.json'))
})

await t('旧备份里的 status「草稿」在 restore 时统一写成「未过账」', async () => {
  const before = commits()
  const r = await call('/orders', 'POST', {
    action: 'restore',
    orders: [order('D202610280900000003', { status: '草稿' }), order('D202610280900000004', { status: '已过账', postedOrderId: 'X1' })]
  })
  assert.equal(r.restored, 2)
  assert.equal(commits(), before + 1)
  assert.deepEqual(read('orders.json').map(o => o.status), ['未过账', '已过账'])
})

await t('重复导入同一份备份幂等：内容一致时不再产生提交', async () => {
  const before = commits()
  const orders = read('orders.json')
  const r = await call('/orders', 'POST', { action: 'restore', orders })
  assert.equal(r.unchanged, true)
  assert.equal(commits(), before)
})

await t('空数组＝清空：备份里没有草稿时，恢复后也不该留', async () => {
  const r = await call('/orders', 'POST', { action: 'restore', orders: [] })
  assert.equal(r.restored, 0)
  assert.deepEqual(read('orders.json'), [])
})

await t('非法订单数据 → 400，且不落库', async () => {
  const before = commits()
  const e = await badCall('/orders', 'POST', { action: 'restore', orders: [{ id: '' }] })
  assert.equal(e.status, 400)
  assert.equal(commits(), before)
  const dup = await badCall('/orders', 'POST', { action: 'restore', orders: [{ id: 'D1' }, { id: 'D1' }] })
  assert.equal(dup.status, 400)
  assert.equal(commits(), before)
})

console.log('\n退款/核销单：restore 整表替换')

await t('restore 写入 refunds.json，不触发派生（库存与单据不动）', async () => {
  const before = commits()
  const stockBefore = repo.read('stock.json')
  const r = await call('/refunds', 'POST', {
    action: 'restore',
    refunds: [refund('TK-20261020-0001'), refund('HX-20261020-0002', { category: 'settlement', direction: '' })]
  })
  assert.equal(r.restored, 2)
  assert.equal(commits(), before + 1)
  assert.deepEqual(read('refunds.json').map(v => v.code), ['TK-20261020-0001', 'HX-20261020-0002'])
  assert.equal(repo.read('stock.json'), stockBefore)
})

await t('退款凭证编号重复 / 缺编号 → 400', async () => {
  const before = commits()
  const e = await badCall('/refunds', 'POST', { action: 'restore', refunds: [{ code: '' }] })
  assert.equal(e.status, 400)
  const dup = await badCall('/refunds', 'POST', { action: 'restore', refunds: [{ code: 'TK-1' }, { code: 'TK-1' }] })
  assert.equal(dup.status, 400)
  assert.equal(commits(), before)
})

console.log('\n分类导入：订单 / 退款按单号去重追加')

await t('import-merge orders：只追加新单号，重复的跳过', async () => {
  seed()
  token = await issueToken(env)
  await call('/orders', 'POST', { action: 'restore', orders: [order('D1'), { ...order('D2'), status: '已过账' }] })
  const r = await call('/import-merge', 'POST', {
    key: 'orders',
    records: [order('D2'), order('D3'), order('D3'), { name: '没有单号' }]
  })
  assert.equal(r.added, 1)
  assert.equal(r.skippedKey, 2)
  assert.equal(r.invalid, 1)
  assert.equal(r.total, 3)
  assert.deepEqual(read('orders.json').map(o => o.id), ['D1', 'D2', 'D3'])
})

await t('import-merge refunds：按编号去重，可写入新集合', async () => {
  seed()
  token = await issueToken(env)
  assert.equal(repo.has('refunds.json'), true) // 种子里有空的 refunds.json
  const r = await call('/import-merge', 'POST', {
    key: 'refunds',
    records: [refund('TK-0001'), refund('TK-0001'), refund('HX-0002', { category: 'settlement' })]
  })
  assert.equal(r.added, 2)
  assert.equal(r.skippedKey, 1)
  assert.deepEqual(read('refunds.json').map(v => v.code), ['TK-0001', 'HX-0002'])
  // 与资金/单据无关：库存与销售单保持原样
  assert.equal(read('stock.json').P00001.qty, 5)
  assert.equal(read('sales-2026.json').length, 1)
})

if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
