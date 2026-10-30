// 端到端：POST /api/voids 作废销售单/采购单，票据（收款单/付款单）同步作废，库存一次提交回滚。
// 跑法：node tests/void-api-test.mjs   （纯 Node，不需要浏览器）
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

const saleId = 'X202610020900000001'
const saleReturnedId = 'X202610030900000001'
const purchaseId = 'C202610010900000001'

const seedData = () => ({
  items: [{ code: 'P00001', name: '管件', unit: '个', cost: 8, price: 10 }],
  suppliers: [{ code: 'S00001', name: '供应商甲', products: ['P00001'] }],
  customers: [{ code: 'C00001', name: '客户甲', contact: '', phone: '', remark: '' }],
  purchases: [{
    id: purchaseId, date: '2026-10-01', supplier: '供应商甲', total: 100, discount: 0, settle: '结清',
    payments: [{ date: '2026-10-01', amount: 100, remark: '', time: '', voucher: 'FK-0001' }],
    items: [line('P00001', '管件', 10, 10)]
  }],
  sales: [
    {
      id: saleId, date: '2026-10-02', customer: '客户甲', no: 'N001', total: 50, discount: 0, settle: '结清',
      payments: [{ date: '2026-10-02', amount: 50, remark: '', time: '', voucher: 'SK-0001' }],
      items: [line('P00001', '管件', 5, 10)]
    },
    {
      id: saleReturnedId, date: '2026-10-03', customer: '客户甲', no: 'N002', total: 10, discount: 0,
      payments: [], items: [line('P00001', '管件', 1, 10)]
    }
  ],
  receipts: [{
    code: 'SK-0001', kind: 'receivable', category: 'normal', party: '客户甲', date: '2026-10-02', total: 50,
    items: [{ orderId: saleId, orderType: 'sale', amount: 50 }], createdAt: '2026-10-02T09:00:00.000Z'
  }],
  'payment-vouchers': [{
    code: 'FK-0001', kind: 'payable', category: 'normal', party: '供应商甲', date: '2026-10-01', total: 100,
    items: [{ orderId: purchaseId, orderType: 'purchase', amount: 100 }], createdAt: '2026-10-01T09:00:00.000Z'
  }],
  refunds: [], logs: []
})

const raw = seedData()
const derived = derive(raw.items, raw.suppliers, raw.purchases, raw.sales, raw.customers)
const seedStock = rebuildStock(derived.purchases, derived.sales, derived.items)

let repo, token = ''
const seed = (overrides = {}) => {
  repo = makeFakeRepo({
    'items.json': derived.items, 'suppliers.json': derived.suppliers, 'customers.json': derived.customers,
    'receipts.json': raw.receipts, 'payment-vouchers.json': raw['payment-vouchers'], 'refunds.json': [], 'logs.json': [],
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
  if (!res.ok) { const error = new Error(`${method} ${path} → ${res.status} ${data && data.error || ''}`); error.status = res.status; error.payload = data; throw error }
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

seed()
token = await issueToken(env)

console.log('\n作废销售单：单据/收款单/库存一次提交')

await t('销售单与其收款单同时作废，库存回滚，只产生一次提交', async () => {
  const before = commits()
  const stockBefore = read('stock.json').P00001.qty
  assert.equal(stockBefore, 4) // 进 10 卖 5+1
  const r = await call('/voids', 'POST', { kind: 'sale', id: saleId, reason: '客户取消' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.vouchers, ['SK-0001'])
  assert.equal(commits(), before + 1)

  // 年片里的销售单被标记作废，金额与行明细原样保留（可审计）
  const sales = read('sales-2026.json')
  const doc = sales.find(s => s.id === saleId)
  assert.equal(doc.status, '作废')
  assert.equal(doc.voidedReason, '客户取消')
  assert.equal(doc.total, 50)
  assert.equal(doc.items.length, 1)

  // 收款单作废而非删除
  const receipts = read('receipts.json')
  const v = receipts.find(x => x.code === 'SK-0001')
  assert.equal(v.status, '作废')
  assert.equal(v.total, 50)
  assert.equal(v.voidOf, saleId)

  // 库存回滚：作废的 5 件出库还回来
  assert.equal(read('stock.json').P00001.qty, 9)

  // 日志留痕
  const logs = read('logs.json')
  assert.ok(logs.some(l => l.source === 'void' && l.code === saleId))
})

await t('重复作废幂等：返回 duplicate，且不再产生新提交', async () => {
  const before = commits()
  const r = await call('/voids', 'POST', { kind: 'sale', id: saleId })
  assert.equal(r.duplicate, true)
  assert.deepEqual(r.vouchers, ['SK-0001'])
  assert.equal(commits(), before)
})

await t('另一张销售单不受影响，仍计入库存与应收', async () => {
  const sales = read('sales-2026.json')
  const other = sales.find(s => s.id === saleReturnedId)
  assert.notEqual(other.status, '作废')
  assert.equal(read('stock.json').P00001.qty, 9)
})

console.log('\n闸门与作废采购单')

await t('不存在的单据 → 404，且不产生提交', async () => {
  const before = commits()
  const e = await badCall('/voids', 'POST', { kind: 'sale', id: 'NOPE' })
  assert.equal(e.status, 404)
  assert.equal(commits(), before)
})

await t('一张收款单同时覆盖别的单据 → 409，先拆开再作废', async () => {
  const receipts = JSON.parse(JSON.stringify(raw.receipts))
  receipts[0].items.push({ orderId: saleReturnedId, orderType: 'sale', amount: 10 })
  seed({ 'receipts.json': receipts })
  token = await issueToken(env)
  const before = commits()
  const e = await badCall('/voids', 'POST', { kind: 'sale', id: saleId })
  assert.equal(e.status, 409)
  assert.match(e.message, /SK-0001/)
  assert.equal(commits(), before)
})

await t('作废采购单：付款单一并作废，应付与库存回滚', async () => {
  seed(); token = await issueToken(env)
  const r = await call('/voids', 'POST', { kind: 'purchase', id: purchaseId })
  assert.deepEqual(r.vouchers, ['FK-0001'])
  const p = read('purchases-2026.json').find(x => x.id === purchaseId)
  assert.equal(p.status, '作废')
  assert.equal(read('payment-vouchers.json')[0].status, '作废')
  // 采购的 10 件也回滚，只剩两张销售的 6 件出库
  assert.equal(read('stock.json').P00001.qty, -6)
})

await t('作废不写坏集合形态：purchases/sales 仍按年分片，不再生成整表文件', async () => {
  assert.ok(repo.has('sales-2026.json'))
  assert.ok(!repo.has('sales.json'))
  assert.ok(!repo.has('purchases.json'))
})

if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
