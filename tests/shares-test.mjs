// 端到端：用户信息（profile.json）与外链分享（shares.json）
//   · 分享链接无需登录即可读取，但只返回脱敏后的只读数据
//   · 有效期、重复生成复用、过期 410、取消后 404、作废单据不可分享
// 跑法：node tests/shares-test.mjs   （纯 Node，不需要浏览器）
import assert from 'node:assert/strict'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi } from '../api/routes.js'
import { issueToken } from '../api/auth.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw'
}

const line = (code, name, qty, price, { discountRate = 1, discount = 0 } = {}) => ({
  code, name, unit: '个', qty, price, discountRate, discount,
  total: Math.round((qty * price - discount) * 100) / 100
})

const SALE_ID = 'X202610020900000001'
const PURCHASE_ID = 'C202610010900000001'
const ORDER_ID = 'D202610030900000001'
const VOIDED_ID = 'X202610040900000001'

const seedData = () => ({
  items: [
    { code: 'P00001', name: '管件', unit: '个', cost: 8, price: 10 },
    { code: 'P00002', name: '弯头', unit: '只', cost: 4, price: 5 }
  ],
  suppliers: [{ code: 'S00001', name: '供应商甲', products: ['P00001'] }],
  customers: [{ code: 'C00001', name: '客户甲', contact: '张三', phone: '13800000000', address: '城南路 1 号' }],
  purchases: [{
    id: PURCHASE_ID, date: '2026-10-01', supplier: '供应商甲', total: 100, discount: 0,
    payments: [{ date: '2026-10-01', amount: 40, remark: '', time: '' }],
    items: [line('P00001', '管件', 10, 10)]
  }],
  sales: [{
    id: SALE_ID, date: '2026-10-02', customer: '客户甲', no: 'N001', total: 23, discount: 1,
    discountRates: [0.95],
    payments: [{ date: '2026-10-02', amount: 5, remark: '', time: '' }],
    items: [line('P00001', '管件', 2, 10, { discountRate: 0.9, discount: 2 }), line('P00002', '弯头', 1, 5)],
    photos: ['https://example.invalid/secret.png'],
    remark: '月底交货'
  }, {
    id: VOIDED_ID, date: '2026-10-04', customer: '客户甲', total: 10, discount: 0, status: '作废',
    payments: [], items: [line('P00001', '管件', 1, 10)]
  }],
  orders: [{
    id: ORDER_ID, status: '未过账', kind: 'sale', customer: '客户甲', date: '2026-10-03', no: 'HT-1',
    discountRates: [0.9], discount: 0,
    items: [line('P00001', '管件', 2, 10)],
    deposits: [{ date: '2026-10-03', amount: 5, remark: '订金' }]
  }],
  logs: []
})

let repo, token = ''
const seed = (overrides = {}) => {
  repo = makeFakeRepo({
    'items.json': seedData().items,
    'suppliers.json': seedData().suppliers,
    'customers.json': seedData().customers,
    'purchases.json': seedData().purchases,
    'sales.json': seedData().sales,
    'orders.json': seedData().orders,
    'logs.json': [],
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
  if (!res.ok) { const e = new Error(`${method} ${path} → ${res.status} ${data && data.error || ''}`); e.status = res.status; e.payload = data; throw e }
  return data
}
const badCall = async (path, method, body) => {
  try { await call(path, method, body) } catch (e) { return e }
  throw new Error(`${path} 本该被拒绝`)
}
// 公开读取：不带 Authorization，模拟拿到链接的外部人员
const publicCall = async (shareToken) => {
  const req = new Request(`https://worker.test/api/share/${shareToken}`, { method: 'GET', headers: { Origin: 'https://worker.test' } })
  const res = await handleApi(req, new URL(req.url), env)
  const data = await res.json().catch(() => null)
  if (!res.ok) { const e = new Error(`${res.status} ${data && data.error || ''}`); e.status = res.status; e.payload = data; throw e }
  return data
}
const read = (p) => JSON.parse(repo.read(p))

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (String(e && e.message || e)).split('\n').join('\n      ')) }
}

seed()
token = await issueToken(env)

console.log('\n用户信息')

await t('未填写时返回空资料（不报 404）', async () => {
  const p = await call('/profile', 'GET')
  assert.deepEqual(p, { name: '', phone: '', address: '', remark: '' })
  assert.ok(!repo.has('profile.json'), '读操作不应创建文件')
})

await t('保存后落库，空白裁剪、超长截断', async () => {
  const r = await call('/profile', 'POST', { name: '  张三建材  ', phone: '13800000000', address: 'x'.repeat(200), remark: '微信同号' })
  assert.equal(r.ok, true)
  assert.equal(r.profile.name, '张三建材')
  assert.equal(r.profile.address.length, 160)
  const saved = read('profile.json')
  assert.equal(saved.phone, '13800000000')
  assert.equal((await call('/profile', 'GET')).remark, '微信同号')
})

console.log('\n外链分享：创建与公开读取')

let saleShare = null

await t('创建销售单分享：返回长 token 与 7 天有效期', async () => {
  const before = Date.now()
  const r = await call('/shares', 'POST', { action: 'create', kind: 'sale', docId: SALE_ID, days: 7 })
  assert.equal(r.ok, true)
  assert.match(r.share.token, /^[a-f0-9]{36}$/)
  assert.equal(r.share.expired, false)
  const left = Date.parse(r.share.expiresAt) - before
  assert.ok(left > 6.9 * 86400000 && left < 7.1 * 86400000, `有效期应约 7 天，实际 ${left}`)
  const saved = read('shares.json')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].kind, 'sale')
  saleShare = r.share
})

await t('公开读取：无需登录，金额口径与详情页一致', async () => {
  const d = await publicCall(saleShare.token)
  assert.equal(d.readOnly, true)
  assert.equal(d.doc.docLabel, '销售单')
  assert.equal(d.doc.party, '客户甲')
  assert.equal(d.doc.no, 'N001')
  assert.equal(d.lines.length, 2)
  assert.equal(d.lines[0].name, '管件')
  assert.equal(d.lines[0].unit, '个')
  assert.equal(d.lines[0].net, 17.1)
  assert.equal(d.lines[1].net, 4.75)
  assert.equal(d.totals.total, 23)
  assert.equal(d.totals.rateText, '×0.95')
  assert.equal(d.totals.discountedTotal, 21.85)
  assert.equal(d.totals.due, 20.85)
  assert.equal(d.totals.paid, 5)
  assert.equal(d.totals.unpaid, 15.85)
  assert.equal(d.totals.hasLineDiscount, true)
  assert.equal(d.totals.hasOrderDiscount, true)
})

await t('公开数据脱敏：不含成本、收付款流水、照片、客户联系方式', async () => {
  const raw = JSON.stringify(await publicCall(saleShare.token))
  for (const leaked of ['"cost"', '"payments"', 'secret.png', '13800000000', '城南路']) {
    assert.ok(!raw.includes(leaked), `分享数据不应包含 ${leaked}`)
  }
})

await t('重复生成同一张单：复用原链接，不新增记录', async () => {
  const r = await call('/shares', 'POST', { action: 'create', kind: 'sale', docId: SALE_ID, days: 30 })
  assert.equal(r.reused, true)
  assert.equal(r.share.token, saleShare.token)
  assert.equal(read('shares.json').length, 1)
})

await t('采购单分享：应付/实付/未付口径正确', async () => {
  const r = await call('/shares', 'POST', { action: 'create', kind: 'purchase', docId: PURCHASE_ID, days: 0 })
  assert.equal(r.share.expiresAt, null, '0 天＝长期有效')
  const d = await publicCall(r.share.token)
  assert.equal(d.doc.docLabel, '采购单')
  assert.equal(d.doc.partyLabel, '供应商')
  assert.equal(d.totals.due, 100)
  assert.equal(d.totals.paid, 40)
  assert.equal(d.totals.unpaid, 60)
})

await t('订单分享：订单金额＝明细×整单折扣，订金计入已收', async () => {
  const r = await call('/shares', 'POST', { action: 'create', kind: 'order', docId: ORDER_ID, days: 1 })
  const d = await publicCall(r.share.token)
  assert.equal(d.doc.docLabel, '销售订单')
  assert.equal(d.doc.status, '未过账')
  assert.equal(d.totals.total, 20)
  assert.equal(d.totals.due, 18)
  assert.equal(d.totals.paid, 5)
  assert.equal(d.totals.unpaid, 13)
  assert.equal(d.lines[0].net, 18)
})

await t('作废单据不能分享（409），不存在的单据 404', async () => {
  assert.equal((await badCall('/shares', 'POST', { action: 'create', kind: 'sale', docId: VOIDED_ID })).status, 409)
  assert.equal((await badCall('/shares', 'POST', { action: 'create', kind: 'sale', docId: 'X-nope' })).status, 404)
})

console.log('\n外链分享：列表、时效与取消')

await t('列表带单据摘要，按创建时间倒序', async () => {
  const r = await call('/shares', 'GET')
  assert.equal(r.shares.length, 3)
  assert.equal(r.shares[0].kind, 'order')
  assert.ok(r.shares.every(s => s.docLabel && s.party))
})

await t('修改时效为 1 天；到期后公开读取返回 410', async () => {
  const r = await call('/shares', 'POST', { action: 'update', token: saleShare.token, days: 1 })
  assert.ok(Date.parse(r.share.expiresAt) > Date.now())
  // 直接把有效期改到过去，模拟时间流逝（不改业务代码）
  const all = read('shares.json').map(s => s.token === saleShare.token ? { ...s, expiresAt: new Date(Date.now() - 1000).toISOString() } : s)
  repo.poke('shares.json', all)
  const err = await publicCall(saleShare.token).catch(e => e)
  assert.equal(err.status, 410)
  assert.match(err.message, /过期/)
  const listed = (await call('/shares', 'GET')).shares.find(s => s.token === saleShare.token)
  assert.equal(listed.expired, true)
})

await t('已过期的单据重新生成：换新 token，旧 token 失效', async () => {
  const before = read('shares.json').length
  const r = await call('/shares', 'POST', { action: 'create', kind: 'sale', docId: SALE_ID, days: 7 })
  assert.notEqual(r.share.token, saleShare.token)
  assert.equal(read('shares.json').length, before, '同一张单只保留一条分享')
  // 过期记录在重新生成时被清掉：旧 token 从「已过期」变成「不存在」
  assert.equal((await publicCall(saleShare.token).catch(e => e.status)), 404)
  saleShare = r.share
})

await t('取消分享：记录删除，公开读取 404', async () => {
  const before = read('shares.json').length
  await call('/shares', 'POST', { action: 'cancel', token: saleShare.token })
  assert.equal(read('shares.json').length, before - 1)
  assert.equal((await publicCall(saleShare.token).catch(e => e.status)), 404)
  assert.equal((await badCall('/shares', 'POST', { action: 'cancel', token: saleShare.token })).status, 404)
})

await t('无效 token 与不存在的分享均 404', async () => {
  assert.equal((await publicCall('zzzz').catch(e => e.status)), 404)
  assert.equal((await publicCall('a'.repeat(36)).catch(e => e.status)), 404)
})

await t('容量上限：最多 500 条', async () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ token: String(i).padStart(36, '0'), kind: 'sale', docId: SALE_ID, createdAt: '', expiresAt: null }))
  repo.poke('shares.json', many)
  const err = await badCall('/shares', 'POST', { action: 'create', kind: 'purchase', docId: PURCHASE_ID })
  assert.equal(err.status, 400)
  assert.match(err.message, /上限/)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
