import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRefundOperation, returnableLines, backfillHistoricalRefunds } from './src/utils/refunds.js'
import { netOf, grossOf, syncPayments, distributePayment } from './src/utils/account.js'
import { derive, rebuildStock } from './api/routes.js'
import { refundTransaction } from './api/refunds.js'
const fixture = () => ({ logs: [], items: [{ code: 'P00001', name: '管件', cost: 10 }], stock: {}, refunds: [], customers: [{ code: 'C00001', name: '客户甲' }], suppliers: [{ code: 'S00001', name: '供应商甲' }],
  sales: [{ id: 'S1', date: '2026-10-01', customer: '客户甲', total: 100, discount: 10, payments: [], items: [{ code: 'P00001', name: '管件', qty: 10, price: 10, total: 100 }] }],
  purchases: [{ id: 'B1', date: '2026-10-01', supplier: '供应商甲', total: 100, paid: 100, items: [{ code: 'P00001', name: '管件', qty: 10, price: 10, total: 100 }] }] })
const create = (extra = {}) => ({ action: 'create', requestId: 'request-create-00001', kind: 'sale', sourceOrderId: 'S1', date: '2026-10-28', reason: '退货', lines: [{ index: 0, qty: 5 }], ...extra })
const settle = (orderIds, extra = {}) => ({ action: 'settle', requestId: 'request-settle-00001', kind: 'sale', date: '2026-10-28', orderIds, mode: 'cash', amount: 10, ...extra })
test('默认现金、按原单折后价退、原单不改', () => {
  const before = fixture(), result = applyRefundOperation(before, create())
  const ret = result.state.sales[1], voucher = result.state.refunds[0]
  assert.equal(ret.total, -45); assert.equal(ret.received, -45); assert.equal(netOf(ret, 'receivable'), 0)
  assert.equal(voucher.total, 45); assert.equal(voucher.direction, 'to_customer'); assert.match(voucher.code, /^TK-/)
  assert.deepEqual(result.state.sales[0], before.sales[0]); assert.equal(before.sales.length, 1)
  assert.equal(applyRefundOperation(result.state, create()).duplicate, true)
})
test('采购退货收到退款且库存反向、不覆盖成本', () => {
  const result = applyRefundOperation(fixture(), create({ kind: 'purchase', sourceOrderId: 'B1' }))
  assert.equal(result.state.refunds[0].direction, 'from_supplier')
  assert.equal(result.state.purchases[1].paid, -50)
  result.state.purchases[1].items[0].price = 99
  const derived = derive(result.state.items, result.state.suppliers, result.state.purchases, [], [])
  assert.equal(derived.items[0].cost, 10)
  const stock = rebuildStock(result.state.purchases, [], derived.items)
  assert.equal(stock.P00001.qty, 5); assert.equal(stock.P00001.cost, 10)
})
test('分次退货封顶、重复行和跨单位退款拒绝', () => {
  const s = applyRefundOperation(fixture(), create()).state
  assert.equal(returnableLines(s.sales[0], s.sales)[0].available, 5)
  assert.throws(() => applyRefundOperation(s, create({ requestId: 'request-create-00002', lines: [{ index: 0, qty: 6 }] })), /超过/)
  assert.throws(() => applyRefundOperation(fixture(), create({ lines: [{ index: 0, qty: 1 }, { index: 0, qty: 1 }] })), /重复/)
  s.sales.push({ ...s.sales[1], id: 'OTHER', customer: '其他客户' })
  assert.throws(() => applyRefundOperation(s, settle([s.sales[1].id, 'OTHER'])), /同一/)
})
test('先退货后分次现金退款，同请求重试不重复', () => {
  const s = applyRefundOperation(fixture(), create({ mode: 'pending' })).state
  assert.equal(s.refunds.length, 0); assert.equal(netOf(s.sales[1], 'receivable'), -45)
  const input = settle([s.sales[1].id]), a = applyRefundOperation(s, input)
  assert.equal(a.state.sales[1].received, -10); assert.equal(netOf(a.state.sales[1], 'receivable'), -35)
  assert.equal(applyRefundOperation(a.state, input).duplicate, true)
  assert.throws(() => applyRefundOperation(a.state, { ...input, requestId: 'request-settle-00002', amount: 36 }), /不超过/)
})
test('核销不伪造现金或优惠，净债权保持正确', () => {
  const s = applyRefundOperation(fixture(), create({ mode: 'offset' })).state
  assert.equal(s.sales[0].discount, 10); assert.equal(s.sales[0].received, 0); assert.equal(s.sales[1].received, 0)
  assert.equal(netOf(s.sales[0], 'receivable'), 45); assert.equal(netOf(s.sales[1], 'receivable'), 0)
  assert.equal(s.refunds[0].total, 0); assert.equal(s.refunds[0].settlementTotal, 45)
  assert.match(s.refunds[0].code, /^HX-/)
  assert.equal(s.sales.flatMap(o => o.settlements || []).reduce((s, p) => s + p.amount, 0), 0)
})
test('转预存余额只记一次，无现金流水', () => {
  const input = create({ mode: 'deposit' }), s = applyRefundOperation(fixture(), input).state
  assert.equal(s.customers[0].deposits[0].amount, 45); assert.equal(s.sales[1].received, 0)
  assert.equal(s.refunds[0].total, 0); assert.equal(netOf(s.sales[1], 'receivable'), 0)
  assert.equal(applyRefundOperation(s, input).state.customers[0].deposits.length, 1)
})
test('分分钱尾差、全退还原净额', () => {
  let s = fixture(); s.sales[0].items[0].qty = 3; s.sales[0].total = 1; s.sales[0].discount = 0; s.sales[0].items[0].total = 1
  for (let i = 0; i < 3; i++) s = applyRefundOperation(s, create({ requestId: `rounding-request-${i}`, lines: [{ index: 0, qty: 1 }] })).state
  assert.equal(Math.round(s.refunds.reduce((n, v) => n + v.total, 0) * 100), 100)
  assert.equal(returnableLines(s.sales[0], s.sales)[0].available, 0)
})
test('两张历史退款补凭证幂等、原金额库存不改', () => {
  // 单据编码统一后（4f5f243），这两张历史退货单的 id 已从 T2026051912000000x 改名为 CT-20260519-000x，
  // backfillHistoricalRefunds 按新 id 定位，测试夹具必须跟着改名，否则命中「历史退货单缺失」分支。
  const s = fixture(); s.purchases = [8618, 302].map((a, i) => ({ id: `CT-20260519-000${i + 1}`, supplier: '供应商甲', date: '2026-05-19', total: -a, paid: -a, settle: '结清', items: [{ code: 'P00001', qty: -1, total: -a }] }))
  const result = backfillHistoricalRefunds(s)
  assert.equal(result.codes.length, 2); assert.equal(result.state.refunds.reduce((n, v) => n + v.total, 0), 8920)
  assert.equal(backfillHistoricalRefunds(result.state).codes.length, 0)
  for (let i = 0; i < 2; i++) { const { payments, ...o } = result.state.purchases[i]; assert.deepEqual(o, s.purchases[i]); assert.equal(payments[0].amount, o.paid) }
})
test('普通收付及超付结清口径不回归', () => {
  assert.equal(syncPayments({ total: 10, payments: [{ amount: 11 }] }, 'receivable').settle, '结清')
  assert.equal(netOf({ total: -10, paid: -10 }, 'payable'), 0)
  assert.equal(grossOf({ total: 100, discountRates: [0.9, 0.9], discount: 1 }), 80)
  assert.deepEqual(distributePayment([{ order: { id: 'a' }, kind: 'receivable', outstanding: 10 }], 15).leftover, 5)
})
test('非法输入中止，不改原快照', () => {
  for (const change of [{ lines: [{ index: 0, qty: NaN }] }, { mode: 'bad' }, { date: '2026-02-30' }, { reason: '' }, { requestId: 'short' }]) assert.throws(() => applyRefundOperation(fixture(), create(change)))
})
test('原子提交：先生成单一提交；并发移动分支时拒绝，不重试', async () => {
  const savedFetch = globalThis.fetch, s = fixture(), calls = []
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname.split('/repos/o/r')[1]; calls.push({ path, options })
    const respond = (obj, status = 200) => new Response(JSON.stringify(obj), { status })
    if (path === '/git/ref/heads/main') return respond({ object: { sha: 'base' } })
    if (path === '/git/commits/base') return respond({ tree: { sha: 'treebase' } })
    // 读取一律走「固定提交快照」：recursive tree 拿路径→blob sha，再按 sha 取内容。
    // 不再逐文件读 /contents —— 那样读到的不是同一个提交，跨文件会对不上。
    if (path === '/git/trees/treebase') return respond({ tree: Object.keys(s).map(k => ({ path: `${k}.json`, type: 'blob', sha: `b-${k}` })) })
    if (path.startsWith('/git/blobs/')) {
      const key = path.split('/').pop().replace(/^b-/, '')
      return respond({ encoding: 'base64', content: Buffer.from(JSON.stringify(s[key])).toString('base64') })
    }
    // 分片判据：这里模拟「还没迁移过」，退款必须继续写整表
    if (path === '/contents/.split-yearly.json') return respond({ message: 'Not Found' }, 404)
    if (path.startsWith('/contents/')) { const key = path.split('/').pop().replace('.json', ''); return respond({ content: Buffer.from(JSON.stringify(s[key])).toString('base64') }) }
    if (path === '/git/trees') { const body = JSON.parse(options.body); assert.ok(body.tree.some(e => e.path === 'refunds.json')); assert.ok(body.tree.some(e => e.path === 'sales.json')); return respond({ sha: 'newtree' }) }
    if (path === '/git/commits') return respond({ sha: 'newcommit' })
    if (path === '/git/refs/heads/main') { assert.equal(JSON.parse(options.body).force, false); return respond({ message: 'Update is not a fast forward' }, 422) }
    throw new Error(`unexpected ${path}`)
  }
  try { await assert.rejects(refundTransaction({ GITHUB_OWNER: 'o', GITHUB_REPO: 'r' }, create(), derive, rebuildStock), /422/); assert.equal(calls.filter(c => c.path === '/git/refs/heads/main').length, 1) }
  finally { globalThis.fetch = savedFetch }
})
