// 单据变更（已动过钱的单增减商品）测试：明细 diff、退货单/补差单生成、预览与落库同口径。
// 跑法：node tests/amend-test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { isAmend, moneyTouched, diffOrderLines, refundPreview, applyAmendOperation, netAfterAmend } from '../src/utils/amend.js'
import { grossOf, netOf } from '../src/utils/account.js'
import { rebuildStock } from '../api/routes.js'

const line = (code, name, qty, price) => ({ code, name, unit: '个', qty, price, total: Math.round(qty * price * 100) / 100 })

// 原单：管件 10×10=100、阀门 2×20=40，合计 140、整单优惠 14 → 应收 126
// 行净额按优惠分摊：管件 90、阀门 36
const fixture = () => ({
  logs: [], refunds: [], orders: [], stock: {},
  items: [
    { code: 'P00001', name: '管件', unit: '个', cost: 8, price: 10 },
    { code: 'P00002', name: '阀门', unit: '个', cost: 15, price: 20 },
    { code: 'P00003', name: '弯头', unit: '个', cost: 5, price: 6 }
  ],
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  sales: [{ id: 'X1', date: '2026-10-01', customer: '客户甲', no: 'N001', total: 140, discount: 14, payments: [], received: 0, settle: '挂账', items: [line('P00001', '管件', 10, 10), line('P00002', '阀门', 2, 20)] }],
  purchases: [{ id: 'C1', date: '2026-10-01', supplier: '供应商甲', total: 140, paid: 140, settle: '结清', payments: [{ date: '2026-10-01', amount: 140 }], items: [line('P00001', '管件', 10, 10), line('P00002', '阀门', 2, 20)] }]
})

const src = (extra = {}) => ({ kind: 'sale', sourceOrderId: 'X1', party: '客户甲', date: '2026-10-29', reason: '现场少发了', mode: 'pending', requestId: 'amend-request-000001', ...extra })

test('钱有没有动过：决定能否原地编辑，还是要走变更', () => {
  const s = fixture().sales[0]
  assert.equal(moneyTouched(s, 'receivable'), false)                     // 挂账、无流水 → 可原地改
  assert.equal(moneyTouched({ ...s, payments: [{ amount: 10 }] }, 'receivable'), true)
  assert.equal(moneyTouched({ ...s, payments: [], received: 50 }, 'receivable'), true)  // 旧字段回退
  assert.equal(moneyTouched({ ...s, settlements: [{ amount: 20 }] }, 'receivable'), true)
  const p = fixture().purchases[0]
  assert.equal(moneyTouched(p, 'payable'), true)
  assert.equal(moneyTouched({ ...p, payments: [], paid: 0 }, 'payable'), false)
})

test('明细 diff：减量落到原单行、增量成补差行、没改就不动', () => {
  const s = fixture()
  const d = diffOrderLines(s.sales[0], [line('P00001', '管件', 7, 10), line('P00002', '阀门', 2, 20), line('P00003', '弯头', 3, 6)], s.sales)
  assert.equal(d.ok, true)
  assert.deepEqual(d.refundLines, [{ index: 0, qty: 3 }])
  assert.deepEqual(d.amendLines, [{ code: 'P00003', name: '弯头', unit: '个', qty: 3, price: 6, total: 18 }])
  assert.equal(d.refundQty, 3)
  assert.equal(d.amendTotal, 18)
  // 一模一样：untouched，前端据此不给提交
  const same = diffOrderLines(s.sales[0], s.sales[0].items.map(i => ({ ...i })), s.sales)
  assert.equal(same.untouched, true)
  assert.equal(same.refundLines.length, 0)
})

test('diff 拒绝改价与同码多价，并给出可操作的提示', () => {
  const s = fixture()
  const price = diffOrderLines(s.sales[0], [line('P00001', '管件', 10, 12), line('P00002', '阀门', 2, 20)], s.sales)
  assert.equal(price.ok, false)
  assert.match(price.error, /不允许改价/)
  const mixed = diffOrderLines({ ...s.sales[0], items: [line('P00001', '管件', 5, 10), line('P00001', '管件', 5, 9)] }, s.sales[0].items, s.sales)
  assert.equal(mixed.ok, false)
  assert.match(mixed.error, /多个单价/)
  // 数量退到超过可退：先退 8 件，再把 10 件全退掉 → 剩余可退只有 2 件，diff 必须拒绝
  const once = applyAmendOperation(s, src({ refundLines: [{ index: 0, qty: 8 }], amendLines: [] })).state
  const over = diffOrderLines(once.sales[0], [line('P00002', '阀门', 2, 20)], once.sales)
  assert.equal(over.ok, false)
  assert.match(over.error, /剩余可退不足/)
})

test('预览金额＝落库金额：同一套行净额分摊（含整单优惠）', () => {
  const s = fixture()
  const d = diffOrderLines(s.sales[0], [line('P00001', '管件', 7, 10), line('P00002', '阀门', 2, 20)], s.sales)
  const preview = refundPreview(s.sales[0], d.refundLines, s.sales)
  assert.equal(preview, 27)                 // 90 的行净额 × 3/10
  const r = applyAmendOperation(s, src({ refundLines: d.refundLines, amendLines: [] }))
  assert.equal(r.state.sales[1].total, -27) // 生成的退货单分毫不差
  assert.equal(r.state.sales[1].total, -preview)
})

test('变更生成退货单 + 补差单：都挂 sourceOrderId，原单一个字节都不改', () => {
  const before = fixture()
  const r = applyAmendOperation(before, src({ refundLines: [{ index: 0, qty: 3 }], amendLines: [{ code: 'P00003', name: '弯头', qty: 2, price: 6 }] }))
  const [origin, back, add] = r.state.sales
  assert.deepEqual({ ...origin, items: origin.items.map(() => null) }, { ...before.sales[0], items: [null, null] })
  assert.equal(back.id, 'XT-20261029-0001')
  assert.equal(back.type, 'sale-return')
  assert.equal(back.sourceOrderId, 'X1')
  assert.equal(back.no, 'N001')              // 业务单号跟着走，客户对账认得出
  assert.equal(back.total, -27)
  assert.equal(add.id, 'XA-20261029-0001')
  assert.equal(add.type, 'sale-amend')
  assert.equal(isAmend(add), true)
  assert.equal(add.sourceOrderId, 'X1')
  assert.equal(add.total, 12)
  assert.equal(add.settle, '挂账')
  assert.equal(add.no, 'N001')
  assert.equal(r.returnId, back.id)
  assert.equal(r.amendId, add.id)
  // pending 模式不动钱：没有退款凭证，两张单各自的欠款留在账上
  assert.equal(r.state.refunds.length, 0)
  assert.equal(netAfterAmend(r.state, 'sale', 'X1'), 111)   // 126 - 27 + 12
  // 库存由派生层自动跟上：退 3 件 +3、补 2 件 -2
  assert.equal(rebuildStock(r.state.purchases, r.state.sales, r.state.items).P00001.qty, 10 - 10 + 3)
  assert.equal(rebuildStock(r.state.purchases, r.state.sales, r.state.items).P00003.qty, -2)
})

test('补差行价格不认前端：原单已有该编码一律沿用原价', () => {
  const r = applyAmendOperation(fixture(), src({ refundLines: [], amendLines: [{ code: 'P00001', name: '管件', qty: 2, price: 99 }] }))
  assert.equal(r.state.sales[1].items[0].price, 10)
  assert.equal(r.state.sales[1].total, 20)
  // 全新编码没有原价可依，才取录入价；录入价缺失则回落商品档案售价
  const b = applyAmendOperation(fixture(), src({ requestId: 'amend-request-000002', refundLines: [], amendLines: [{ code: 'P00003', name: '弯头', qty: 1, price: 7 }] }))
  assert.equal(b.state.sales[1].total, 7)
  const c = applyAmendOperation(fixture(), src({ requestId: 'amend-request-000003', refundLines: [], amendLines: [{ code: 'P00003', name: '弯头', qty: 1 }] }))
  assert.equal(c.state.sales[1].total, 6)
})

test('退现金模式顺带开退款凭证 TK，退货单转为已退', () => {
  const r = applyAmendOperation(fixture(), src({ mode: 'cash', refundLines: [{ index: 1, qty: 2 }], amendLines: [] }))
  const back = r.state.sales[1]
  assert.equal(back.total, -36)
  assert.equal(back.received, -36)
  assert.equal(back.settle, '结清')
  assert.equal(r.state.refunds[0].code, 'TK-20261029-0001')
  assert.equal(r.state.refunds[0].total, 36)
  assert.equal(r.state.refunds[0].direction, 'to_customer')
})

test('采购侧变更生成 CT- 退货单与 CA- 补差单', () => {
  const r = applyAmendOperation(fixture(), src({ kind: 'purchase', sourceOrderId: 'C1', party: '供应商甲', requestId: 'amend-request-000009', refundLines: [{ index: 0, qty: 1 }], amendLines: [{ code: 'P00003', name: '弯头', qty: 1, price: 5 }] }))
  assert.equal(r.state.purchases[1].id, 'CT-20261029-0001')
  assert.equal(r.state.purchases[2].id, 'CA-20261029-0001')
  assert.equal(r.state.purchases[2].type, 'purchase-amend')
  assert.equal(grossOf(r.state.purchases[2]), 5)
  assert.equal(netOf(r.state.purchases[1], 'payable'), -10)  // 采购单无优惠，行净额＝100，退 1 件＝-10
})

test('同一个 requestId 重放不重复生成；非法输入中止且不改快照', () => {
  const input = src({ refundLines: [{ index: 0, qty: 3 }], amendLines: [{ code: 'P00003', name: '弯头', qty: 2, price: 6 }] })
  const once = applyAmendOperation(fixture(), input)
  assert.equal(applyAmendOperation(once.state, input).duplicate, true)
  // 只有退货行时靠退款链路的幂等兜住
  const onlyBack = src({ requestId: 'amend-request-000007', refundLines: [{ index: 0, qty: 1 }], amendLines: [] })
  const two = applyAmendOperation(fixture(), onlyBack)
  assert.equal(applyAmendOperation(two.state, onlyBack).duplicate, true)
  assert.equal(two.state.sales.length, 2)
  const s = fixture()
  assert.throws(() => applyAmendOperation(s, { ...input, requestId: 'short' }), /请求标识/)
  assert.throws(() => applyAmendOperation(s, { ...input, party: '客户乙' }), /不一致/)
  assert.throws(() => applyAmendOperation(s, { ...input, date: '' }), /日期/)
  assert.throws(() => applyAmendOperation(s, { ...input, kind: 'other' }), /销售或采购/)
  assert.throws(() => applyAmendOperation(s, { ...input, refundLines: [], amendLines: [] }), /没有需要变更/)
  assert.throws(() => applyAmendOperation(s, { ...input, sourceOrderId: 'NOPE' }), /只能对正常单据/)
  // 退货单/补差单本身不能再被变更
  const child = applyAmendOperation(s, input).state
  assert.throws(() => applyAmendOperation(child, { ...input, requestId: 'amend-request-000008', sourceOrderId: child.sales[1].id }), /只能对正常单据/)
  assert.equal(s.sales.length, 1)
})
