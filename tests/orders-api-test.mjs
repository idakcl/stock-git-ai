// 端到端回归：订单过账 + 单据变更这两条「一次提交写多个文件」的链路。
// 用一个内存假 GitHub（tests/fake-github.mjs）起一个「已经按年分片」的小库，验证：
//   · orders.json 还不存在时能自动创建，且草稿绝不碰单据/库存；
//   · 过账把单写进 sales-2026.json（年片），orders.json/stock.json/logs.json 同一提交生效；
//   · 变更一次生成退货单 + 补差单 + 退款凭证，重放不重复；
//   · 事务写完之后，前端原样整表重存不再产生任何新提交（次序与存储层口径一致）。
// 跑法：node tests/orders-api-test.mjs   （纯 Node，不需要浏览器）
import assert from 'node:assert/strict'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi, derive, rebuildStock } from '../api/routes.js'
import { issueToken } from '../api/auth.js'
import { diffOrderLines } from '../src/utils/amend.js'
import { receivableOf } from '../src/utils/account.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw'
}

const line = (code, name, qty, price) => ({ code, name, unit: '个', qty, price, total: Math.round(qty * price * 100) / 100 })

// 库里已经是「分片态」：事务必须写进 sales-2026.json，而不是把旧整表复活
const seedData = () => ({
  items: [
    { code: 'P00001', name: '管件', unit: '个', cost: 8, price: 10 },
    { code: 'P00003', name: '弯头', unit: '个', cost: 5, price: 6 }
  ],
  suppliers: [{ code: 'S00001', name: '供应商甲', products: ['P00001'] }],
  customers: [{ code: 'C00001', name: '客户甲', contact: '', phone: '', remark: '' }],
  purchases: [{ id: 'C202610010900000001', date: '2026-10-01', supplier: '供应商甲', total: 100, discount: 0, paid: 100, settle: '结清', payments: [{ date: '2026-10-01', amount: 100, remark: '', time: '' }], items: [line('P00001', '管件', 10, 10)] }],
  sales: [{ id: 'X202610020900000001', date: '2026-10-02', customer: '客户甲', no: 'N001', total: 50, discount: 0, received: 50, settle: '结清', payments: [{ date: '2026-10-02', amount: 50, remark: '', time: '' }], items: [line('P00001', '管件', 5, 10)] }],
  receipts: [], 'payment-vouchers': [], refunds: [], logs: [],
  stock: { P00001: { qty: 5, cost: 10 }, P00003: { qty: 0, cost: 5 } }
})

const raw = seedData()
// 底库先过一遍派生：商品链接、供应商 products、库存快照都必须是「derive 的不动点」。
// 否则「原样重存不该有新提交」这条断言会被第一次派生补写打回，测不出真正想测的次序一致性。
const derived = derive(raw.items, raw.suppliers, raw.purchases, raw.sales, raw.customers)
const seedStock = rebuildStock(derived.purchases, derived.sales, derived.items)

// orders.json 故意不播种：新集合上线时库里就是没有这个文件
function seed({ split = true } = {}) {
  const initial = {
    'items.json': derived.items, 'suppliers.json': derived.suppliers, 'customers.json': derived.customers,
    'receipts.json': [], 'payment-vouchers.json': [], 'refunds.json': [], 'logs.json': [],
    'stock.json': seedStock
  }
  if (split) {
    initial['purchases-2026.json'] = derived.purchases
    initial['sales-2026.json'] = derived.sales
    initial['.split-yearly.json'] = { purchases: true, sales: true }
  } else {
    initial['purchases.json'] = derived.purchases
    initial['sales.json'] = derived.sales
  }
  return makeFakeRepo(initial)
}

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (String(e && e.message || e)).split('\n').join('\n      ')) }
}

let repo, token = ''
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

repo = seed()
token = await issueToken(env)

console.log('\n读：新集合还不存在')
await t('GET /orders 在 orders.json 缺失时返回空数组（不报错）', async () => {
  assert.ok(!repo.has('orders.json'), '底库确实还没有 orders.json')
  assert.deepEqual(await call('/orders', 'GET'), [])
})

console.log('\n写：草稿与订金')
let orderId = ''
await t('保存草稿自动创建 orders.json，且一张提交、绝不动单据和库存', async () => {
  const before = commits()
  const salesBefore = repo.read('sales-2026.json')
  const stockBefore = repo.read('stock.json')
  const r = await call('/orders', 'POST', {
    action: 'save',
    order: { kind: 'sale', customer: '客户甲', date: '2026-10-29', items: [line('P00001', '管件', 4, 10)], remark: '先记下' }
  })
  assert.equal(r.ok, true)
  orderId = r.code
  assert.match(orderId, /^D\d{18}$/)
  assert.ok(repo.has('orders.json'), '首次保存必须把新集合建出来')
  const [o] = read('orders.json')
  assert.equal(o.id, orderId)
  assert.equal(o.status, '未过账')
  assert.equal(commits() - before, 1, '一次操作只应有一次提交')
  assert.equal(repo.read('sales-2026.json'), salesBefore, '草稿不能碰单据')
  assert.equal(repo.read('stock.json'), stockBefore, '草稿不能碰库存')
  assert.equal(read('logs.json').at(-1).source, 'order', '日志与数据同一提交')
  assert.equal(read('logs.json').at(-1).action, 'save')
})

await t('非法草稿被服务端拦住并返回 400，库里不留任何东西', async () => {
  const before = commits()
  const e = await badCall('/orders', 'POST', { action: 'save', order: { kind: 'sale', customer: '客户甲', date: '2026-10-29', items: [{ code: 'PX', qty: 1, price: 1, total: 1 }] } })
  assert.equal(e.status, 400, `应返回 400，实际 ${e.status}`)
  assert.match(String(e.message), /不在商品库/)
  assert.equal(commits(), before, '校验失败不该提交')
})

await t('收订金开正式收款单：receipts.json 被创建，订金挂在订单上', async () => {
  const before = commits()
  const r = await call('/orders', 'POST', { action: 'deposit', orderId, amount: 20, date: '2026-10-29', remark: '定金' })
  assert.equal(r.ok, true)
  assert.equal(r.code, 'SK-20261029-0001')
  const v = read('receipts.json')
  assert.equal(v.length, 1)
  assert.equal(v[0].category, 'deposit')
  assert.equal(v[0].items[0].orderId, orderId)
  assert.equal(v[0].items[0].orderType, 'order')
  assert.equal(read('orders.json')[0].deposits[0].voucher, 'SK-20261029-0001')
  assert.equal(commits() - before, 1, '订金 + 订单必须同一提交')
})

await t('备注：只提交 remark，订单号/金额/订金一律不动', async () => {
  const before = commits()
  const r = await call('/orders', 'POST', { action: 'remark', orderId, remark: '  月底前交货  ' })
  assert.equal(r.ok, true)
  const [o] = read('orders.json')
  assert.equal(o.remark, '月底前交货')
  assert.equal(o.status, '未过账')
  assert.equal(o.deposits.length, 1)
  assert.equal(commits() - before, 1, '改备注一次提交')
  const e = await badCall('/orders', 'POST', { action: 'remark', orderId: 'D-NOPE', remark: 'x' })
  assert.equal(e.status, 400)
  assert.match(String(e.message), /订单不存在/)
})

console.log('\n写：过账进年片')
let docId = ''
await t('过账：单据落进 sales-2026.json，订单转已过账，库存同批重算', async () => {
  const before = commits()
  const stockBefore = JSON.parse(repo.read('stock.json')).P00001.qty
  const r = await call('/orders', 'POST', { action: 'post', orderId })
  assert.equal(r.ok, true)
  docId = r.code
  assert.match(docId, /^X\d{18}$/)
  assert.ok(!repo.has('sales.json'), '过账不能把已分片库的旧整表复活')
  const piece = read('sales-2026.json')
  const doc = piece.find(o => o.id === docId)
  assert.ok(doc, '新单必须在 2026 年片里')
  assert.equal(doc.fromOrderId, orderId)
  assert.equal(doc.received, 20, '订金要搬成第一条流水')
  assert.equal(doc.payments[0].voucher, 'SK-20261029-0001')
  assert.equal(doc.settle, '挂账')
  assert.equal(read('orders.json')[0].status, '已过账')
  assert.equal(read('orders.json')[0].postedOrderId, docId)
  assert.equal(JSON.parse(repo.read('stock.json')).P00001.qty, stockBefore - 4, '库存由派生层跟上')
  assert.equal(commits() - before, 1, '过账 = 一张单 + 订单状态 + 库存 + 日志，一次提交')
})

await t('重复过账判定为幂等，不再产生提交', async () => {
  const before = commits()
  const r = await call('/orders', 'POST', { action: 'post', orderId })
  assert.equal(r.duplicate, true)
  assert.equal(commits(), before)
  assert.equal(read('sales-2026.json').length, 2)
})

await t('已过账订单也能补备注：不碰单据与库存', async () => {
  const stockBefore = repo.read('stock.json')
  const salesBefore = repo.read('sales-2026.json')
  const before = commits()
  const r = await call('/orders', 'POST', { action: 'remark', orderId, remark: '发票待补' })
  assert.equal(r.ok, true)
  assert.equal(read('orders.json')[0].remark, '发票待补')
  assert.equal(read('orders.json')[0].status, '已过账')
  assert.equal(repo.read('stock.json'), stockBefore)
  assert.equal(repo.read('sales-2026.json'), salesBefore)
  assert.equal(commits() - before, 1)
})

await t('带订金的单过账后不能撤销过账（钱已在台账里）', async () => {
  const e = await badCall('/orders', 'POST', { action: 'unpost', orderId })
  assert.equal(e.status, 400)
  assert.match(String(e.message), /已有收付款流水/)
})

await t('过账写过的年片，原样整表重存不再重写', async () => {
  const all = await call('/sales', 'GET')
  const before = commits()
  await call('/sales', 'POST', { sales: all })
  assert.equal(commits(), before, `次序/格式与存储层不一致，多出了 ${commits() - before} 个提交`)
})

console.log('\n写：变更单（已收款的单增减商品）')
const REQ = 'e2e-amend-test-req-01'
let returnId = ''
let amendId = ''
await t('一次变更生成退货单 + 补差单 + 退款凭证，全部在同一提交里', async () => {
  const before = commits()
  const sales = await call('/sales', 'GET')
  const source = sales.find(o => o.id === 'X202610020900000001')
  // 前端用同一个纯函数算 diff：把 5 件减到 3 件，并加 1 个弯头
  const d = diffOrderLines(source, [line('P00001', '管件', 3, 10), line('P00003', '弯头', 1, 6)], sales)
  assert.equal(d.ok, true)
  const r = await call('/amends', 'POST', {
    kind: 'sale', sourceOrderId: source.id, party: '客户甲', date: '2026-10-29',
    reason: '现场少发 2 件', mode: 'cash', requestId: REQ,
    refundLines: d.refundLines, amendLines: d.amendLines
  })
  assert.equal(r.ok, true)
  returnId = r.returnId
  amendId = r.amendId
  assert.match(returnId, /^XT-20261029-\d{4}$/)
  assert.match(amendId, /^XA-20261029-\d{4}$/)
  const piece = read('sales-2026.json')
  const back = piece.find(o => o.id === returnId)
  const add = piece.find(o => o.id === amendId)
  assert.equal(back.total, -20)
  assert.equal(back.received, -20)
  assert.equal(back.sourceOrderId, source.id)
  assert.equal(add.total, 6)
  assert.equal(add.settle, '挂账')
  assert.equal(read('refunds.json')[0].total, 20)
  assert.equal(read('refunds.json')[0].code, 'TK-20261029-0001')
  assert.equal(commits() - before, 1, '两张单 + 凭证 + 库存 + 日志必须同一提交')
})

await t('同一 requestId 重放：识别为重复且不再提交', async () => {
  const before = commits()
  const r = await call('/amends', 'POST', {
    kind: 'sale', sourceOrderId: 'X202610020900000001', party: '客户甲', date: '2026-10-29',
    reason: '现场少发 2 件', mode: 'cash', requestId: REQ,
    refundLines: [{ index: 0, qty: 2 }], amendLines: [{ code: 'P00003', name: '弯头', qty: 1, price: 6 }]
  })
  assert.equal(r.duplicate, true)
  assert.equal(commits(), before)
  assert.equal(read('sales-2026.json').length, 4)
})

await t('变更后原单不许再原地改明细：整表重存被资金保护拦住', async () => {
  const all = await call('/sales', 'GET')
  const next = all.map(o => o.id === 'X202610020900000001' ? { ...o, total: 999 } : o)
  const e = await badCall('/sales', 'POST', { sales: next })
  assert.match(String(e.message), /已有关联退货/)
})

await t('库存与应收跟着变更走：退 2 件加回库存，补 1 件弯头再减', async () => {
  const stock = read('stock.json')
  // P00001：进 10、原销售单卖 5、过账单卖 4、退货还回 2 → 3
  assert.equal(stock.P00001.qty, 3)
  assert.equal(stock.P00003.qty, -1)          // 补差单卖了 1 个弯头，货还没进过
  const sales = await call('/sales', 'GET')
  const family = sales.filter(o => o.id === 'X202610020900000001' || o.sourceOrderId === 'X202610020900000001')
  assert.equal(family.length, 3)
  // 原单已结清、退货已退款、补差单挂着 6 元欠款 → 这一族还剩 6 元没收到
  assert.equal(Math.round(family.reduce((s, o) => s + receivableOf(o), 0) * 100), 600)
})

console.log('\n未分片库：事务仍写整表')
repo = seed({ split: false })
await t('库里还没迁移过时，订单过账继续写 sales.json 整表', async () => {
  const s = await call('/orders', 'POST', { action: 'save', order: { kind: 'sale', customer: '客户甲', date: '2026-10-29', items: [line('P00003', '弯头', 2, 6)] } })
  const p = await call('/orders', 'POST', { action: 'post', orderId: s.code })
  assert.match(p.code, /^X\d{18}$/)
  assert.ok(repo.has('sales.json'))
  assert.ok(read('sales.json').some(o => o.id === p.code))
  assert.ok(!repo.has('sales-2026.json'), '事务提交不做迁移，分片仍由普通存单链路负责')
})

await t('未分片库上的变更同样一次提交搞定', async () => {
  const before = commits()
  const d = diffOrderLines(read('sales.json').find(o => o.id === 'X202610020900000001'), [line('P00001', '管件', 4, 10)], read('sales.json'))
  const r = await call('/amends', 'POST', {
    kind: 'sale', sourceOrderId: 'X202610020900000001', party: '客户甲', date: '2026-10-29',
    reason: '退 1 件', mode: 'pending', requestId: 'e2e-amend-test-req-02',
    refundLines: d.refundLines, amendLines: []
  })
  assert.equal(r.ok, true)
  assert.equal(commits() - before, 1)
  assert.equal(read('refunds.json').length, 0, '先挂着模式不开退款凭证')
  assert.ok(read('sales.json').some(o => o.id === r.code && o.total === -10))
})

await t('清空草稿：一次提交删完纯草稿，已过账的留着（removed/skipped 原样回前端）', async () => {
  const a = await call('/orders', 'POST', { action: 'save', order: { kind: 'sale', customer: '客户甲', date: '2026-10-29', items: [line('P00003', '弯头', 1, 6)] } })
  const b = await call('/orders', 'POST', { action: 'save', order: { kind: 'purchase', supplier: '供应商甲', date: '2026-10-29', items: [line('P00003', '弯头', 2, 6)] } })
  const before = commits()
  const r = await call('/orders', 'POST', { action: 'clearDrafts' })
  assert.equal(r.removed, 2)
  assert.equal(r.skipped, 1, '上一条用例过账的那张订单不能被清掉')
  assert.equal(commits() - before, 1, '删干净只应有一次提交')
  const orders = read('orders.json')
  assert.equal(orders.length, 1)
  assert.equal(orders[0].status, '已过账')
  assert.ok(!orders.some(o => o.id === a.code || o.id === b.code))
})

await t('restore 兼容旧备份：status「草稿」写成「未过账」；migrateStatus 幂等不空提交', async () => {
  const before = commits()
  const r = await call('/orders', 'POST', {
    action: 'restore',
    orders: [{ id: 'D202610301000000001', status: '草稿', kind: 'sale', customer: '客户甲', date: '2026-10-30', items: [line('P00003', '弯头', 1, 6)] }]
  })
  assert.equal(r.restored, 1)
  assert.equal(read('orders.json')[0].status, '未过账')
  assert.equal(commits() - before, 1)
  // 已经统一之后，迁移动作是幂等的：migrated = 0，不产生空提交
  const before2 = commits()
  const m = await call('/orders', 'POST', { action: 'migrateStatus' })
  assert.equal(m.migrated, 0)
  assert.equal(commits(), before2)
})

await t('批量过账为结清：单据 + 收款单 + 库存 + 日志同一提交，一次写盘', async () => {
  const a = await call('/orders', 'POST', { action: 'save', order: { kind: 'sale', customer: '客户甲', date: '2026-10-31', items: [line('P00003', '弯头', 1, 6)] } })
  const b = await call('/orders', 'POST', { action: 'save', order: { kind: 'purchase', supplier: '供应商甲', date: '2026-10-31', items: [line('P00003', '弯头', 2, 6)] } })
  const before = commits()
  const receiptsBefore = read('receipts.json').length
  const payoutsBefore = read('payment-vouchers.json').length
  const r = await call('/orders', 'POST', { action: 'postMany', orderIds: [a.code, b.code], settleMode: 'settle' })
  assert.equal(r.posted, 2)
  assert.equal(commits() - before, 1, '批量过账只应有一次提交（含两张资金单据）')
  const docs = read('sales.json').concat(read('purchases.json') || [])
  const saleDoc = docs.find(o => o.fromOrderId === a.code)
  const buyDoc = docs.find(o => o.fromOrderId === b.code)
  assert.equal(saleDoc.settle, '结清')
  assert.equal(buyDoc.settle, '结清')
  assert.equal(saleDoc.received, 6)
  assert.equal(buyDoc.paid, 12)
  assert.equal(read('receipts.json').length, receiptsBefore + 1, '销售单结清 → 收款单')
  assert.equal(read('payment-vouchers.json').length, payoutsBefore + 1, '采购单结清 → 付款单')
  assert.equal(read('receipts.json').at(-1).items[0].orderId, saleDoc.id)
  assert.equal(read('logs.json').at(-1).action, 'postMany')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
