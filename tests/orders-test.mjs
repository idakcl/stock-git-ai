// 订单（未过账单据）模型测试：草稿→过账→撤销过账 状态机、订金凭证、以及最要紧的一条
// ——「订单不占库存、不进应收」。跑法：node tests/orders-test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOrderOperation, orderToOrderDoc, canUnpost, orderAmount, validateOrder, orderKeys, DRAFT, POSTED } from '../src/utils/orders.js'
import { grossOf, receivableOf } from '../src/utils/account.js'
import { derive, rebuildStock } from '../api/routes.js'

const line = (code, name, qty, price) => ({ code, name, unit: '个', qty, price, total: Math.round(qty * price * 100) / 100 })

const fixture = () => ({
  logs: [], orders: [], refunds: [], receipts: [], 'payment-vouchers': [], stock: {},
  items: [
    { code: 'P00001', name: '管件', unit: '个', cost: 8, price: 10 },
    { code: 'P00002', name: '阀门', unit: '个', cost: 15, price: 20 }
  ],
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  sales: [{ id: 'X1', date: '2026-10-01', customer: '客户甲', total: 100, discount: 0, payments: [], items: [line('P00001', '管件', 10, 10)] }],
  purchases: [{ id: 'C1', date: '2026-10-01', supplier: '供应商甲', total: 100, paid: 100, payments: [{ date: '2026-10-01', amount: 100 }], items: [line('P00001', '管件', 10, 10)] }]
})

// 一张合法的销售草稿（4 件 × 10 = 40）
const draft = (extra = {}) => ({ kind: 'sale', customer: '客户甲', date: '2026-10-29', items: [line('P00001', '管件', 4, 10)], ...extra })

const saveOrder = (state, order) => applyOrderOperation(state, { action: 'save', order })

test('存草稿只写 orders.json：单据集合与库存一律不动', () => {
  const before = fixture()
  const stockBefore = rebuildStock(before.purchases, before.sales, before.items)
  const r = saveOrder(before, draft())
  const order = r.state.orders[0]
  assert.match(order.id, /^D\d{18}$/)
  assert.equal(order.status, DRAFT)
  assert.deepEqual(order.deposits, [])
  assert.equal(r.state.sales.length, 1)
  assert.equal(r.state.purchases.length, 1)
  // 最关键的一条：草稿不进库存派生（rebuildStock 只看 purchases/sales，orders 天然被排除）
  assert.deepEqual(rebuildStock(r.state.purchases, r.state.sales, r.state.items), stockBefore)
  // 快照本身没被就地改
  assert.equal(before.orders.length, 0)
})

test('校验拦住非法草稿，且不改动原快照', () => {
  assert.deepEqual(validateOrder(draft(), { items: fixture().items }), [])
  assert.match(validateOrder(draft({ items: [{ code: 'PX', qty: 1, price: 1, total: 1 }] }), { items: fixture().items })[0], /不在商品库/)
  assert.match(validateOrder(draft({ items: [{ code: 'P00001', qty: 0, price: 10, total: 0 }] }), { items: [] })[0], /数量必须大于 0/)
  assert.match(validateOrder(draft({ items: [{ code: 'P00001', qty: 2, price: 10, total: 15 }] }), { items: [] })[0], /数量×单价不符/)
  assert.match(validateOrder(draft({ customer: '  ' }))[0], /往来单位/)
  assert.match(validateOrder(draft({ date: '2026-10-29', discountRates: [1.5] }))[0], /折扣率/)
  // 订单金额与单据同口径：合计 × 折扣链 − 整单优惠
  assert.equal(orderAmount(draft({ discount: 5 })), 35)
  assert.equal(orderAmount(draft({ discountRates: [0.9] })), 36)
  assert.throws(() => saveOrder(fixture(), draft({ items: [] })), /明细/)
  assert.throws(() => saveOrder(fixture(), draft({ kind: 'transfer' })), /销售或采购/)
  assert.equal(fixture().orders.length, 0)
})

test('改草稿保留 id；已过账的草稿拒绝原地改', () => {
  const s = saveOrder(fixture(), draft()).state
  const id = s.orders[0].id
  const r = saveOrder(s, { ...draft(), id, remark: '改过了' })
  assert.equal(r.state.orders.length, 1)
  assert.equal(r.state.orders[0].remark, '改过了')
  const posted = applyOrderOperation(r.state, { action: 'post', orderId: id }).state
  assert.equal(posted.orders[0].status, POSTED)
  assert.throws(() => saveOrder(posted, { ...draft(), id }), /请先撤销过账/)
})

test('订金开正式凭证（销售 SK / 采购 FK），category=deposit 且指向订单号', () => {
  const s = saveOrder(fixture(), draft()).state
  const id = s.orders[0].id
  const r = applyOrderOperation(s, { action: 'deposit', orderId: id, amount: 15, date: '2026-10-29', remark: '定金' })
  const v = r.state.receipts[0]
  assert.equal(v.code, 'SK-20261029-0001')
  assert.equal(v.kind, 'receivable')
  assert.equal(v.category, 'deposit')
  assert.equal(v.total, 15)
  assert.deepEqual(v.items, [{ orderId: id, orderType: 'order', amount: 15, note: '订单订金' }])
  assert.equal(r.state.orders[0].deposits[0].voucher, v.code)
  // 采购侧走付款凭证
  const p = saveOrder(fixture(), draft({ kind: 'purchase', customer: undefined, supplier: '供应商甲' })).state
  const pr = applyOrderOperation(p, { action: 'deposit', orderId: p.orders[0].id, amount: 10, date: '2026-10-29' })
  assert.equal(pr.state['payment-vouchers'][0].code, 'FK-20261029-0001')
  assert.equal(pr.state['payment-vouchers'][0].kind, 'payable')
  assert.throws(() => applyOrderOperation(s, { action: 'deposit', orderId: id, amount: 0 }), /大于 0/)
  assert.throws(() => applyOrderOperation(s, { action: 'deposit', orderId: 'nope', amount: 5 }), /不存在/)
})

test('过账：生成正式单据、订金原样搬成第一条流水、凭证号不改写', () => {
  const s = saveOrder(fixture(), draft()).state
  const id = s.orders[0].id
  const withDep = applyOrderOperation(s, { action: 'deposit', orderId: id, amount: 15, date: '2026-10-29' }).state
  const r = applyOrderOperation(withDep, { action: 'post', orderId: id })
  const doc = r.state.sales[1]
  assert.match(doc.id, /^X\d{18}$/)
  assert.equal(doc.fromOrderId, id)
  assert.equal(doc.fromOrderType, 'order')
  assert.equal(doc.no, id)                       // 订单没填业务单号时把订单号写进去，保证双向可查
  assert.equal(doc.total, 40)
  assert.equal(doc.payments.length, 1)
  assert.equal(doc.payments[0].voucher, 'SK-20261029-0001')
  assert.equal(doc.received, 15)
  assert.equal(doc.settle, '挂账')                // 只收了订金，欠款仍在
  assert.equal(receivableOf(doc), 25)
  assert.equal(r.state.orders[0].status, POSTED)
  assert.equal(r.state.orders[0].postedOrderId, doc.id)
  // 过账之后库存派生才跟上（进了 10 件、原单卖了 10 件、这张单再卖 4 件 → 还差 4 件）
  const stock = rebuildStock(r.state.purchases, r.state.sales, r.state.items)
  assert.equal(stock.P00001.qty, -4)
  // 重复过账幂等：不再产生第二张单
  const again = applyOrderOperation(r.state, { action: 'post', orderId: id })
  assert.equal(again.duplicate, true)
  assert.equal(again.state.sales.length, 2)
})

test('撤销过账：没动钱的单可以退回草稿，动过钱的不行', () => {
  const s = saveOrder(fixture(), draft()).state
  const id = s.orders[0].id
  const posted = applyOrderOperation(s, { action: 'post', orderId: id }).state
  const back = applyOrderOperation(posted, { action: 'unpost', orderId: id })
  assert.equal(back.state.sales.length, 1)
  assert.equal(back.removedDocId, posted.orders[0].postedOrderId)
  assert.equal(back.state.orders[0].status, DRAFT)
  assert.equal(back.state.orders[0].postedOrderId, '')
  // 带订金的单过账后已有流水 → 钱在台账里，不能退回草稿
  const withDep = applyOrderOperation(
    applyOrderOperation(s, { action: 'deposit', orderId: id, amount: 15, date: '2026-10-29' }).state,
    { action: 'post', orderId: id }).state
  assert.throws(() => applyOrderOperation(withDep, { action: 'unpost', orderId: id }), /已有收付款流水/)
  assert.throws(() => applyOrderOperation(s, { action: 'unpost', orderId: id }), /还没过账/)
})

test('删草稿：收过订金不许删（凭证已开），已过账不许删', () => {
  const s = saveOrder(fixture(), draft()).state
  const id = s.orders[0].id
  assert.equal(applyOrderOperation(s, { action: 'delete', orderId: id }).state.orders.length, 0)
  const withDep = applyOrderOperation(s, { action: 'deposit', orderId: id, amount: 5, date: '2026-10-29' }).state
  assert.throws(() => applyOrderOperation(withDep, { action: 'delete', orderId: id }), /订金/)
  const posted = applyOrderOperation(s, { action: 'post', orderId: id }).state
  assert.throws(() => applyOrderOperation(posted, { action: 'delete', orderId: id }), /撤销过账/)
})

test('孤儿订单（过账生成的单据已被删掉）：撤销退回草稿、删除也放行', () => {
  const s = saveOrder(fixture(), draft()).state
  const id = s.orders[0].id
  const posted = applyOrderOperation(s, { action: 'post', orderId: id }).state
  // 模拟「清空数据」把这张订单过账生成的销售单删掉：状态还挂着已过账，单据却已经不存在
  const docId = posted.orders[0].postedOrderId
  const orphan = { ...posted, sales: posted.sales.filter(o => o.id !== docId) }
  const back = applyOrderOperation(orphan, { action: 'unpost', orderId: id })
  assert.equal(back.state.orders[0].status, DRAFT)
  assert.equal(back.state.orders[0].postedOrderId, '')
  assert.equal(back.removedDocId, '')
  assert.equal(applyOrderOperation(orphan, { action: 'delete', orderId: id }).state.orders.length, 0)
  // 单据还在时依旧必须先撤销过账，不能绕过状态机直接把两张单留成两套账
  assert.throws(() => applyOrderOperation(posted, { action: 'delete', orderId: id }), /撤销过账/)
})

test('清空草稿：一次请求删掉全部纯草稿，已过账与已收订金的一张不动', () => {
  let s = fixture()
  for (let i = 0; i < 3; i++) s = saveOrder(s, draft()).state
  const withDeposit = saveOrder(s, draft({ customer: '客户甲' }))
  s = applyOrderOperation(withDeposit.state, { action: 'deposit', orderId: withDeposit.code, amount: 5, date: '2026-10-29' }).state
  const posted = saveOrder(s, draft())
  s = applyOrderOperation(posted.state, { action: 'post', orderId: posted.code }).state
  assert.equal(s.orders.length, 5)

  const r = applyOrderOperation(s, { action: 'clearDrafts' })
  // 3 张纯草稿被删，收过订金的（凭证已开）与已过账的（连着正式单据）都保留
  assert.equal(r.removed, 3)
  assert.equal(r.skipped, 2)
  assert.equal(r.state.orders.length, 2)
  assert.deepEqual(r.state.orders.map(o => o.id).sort(), [withDeposit.code, posted.code].sort())
  // 单据集合没被牵连：清草稿不产生也不删除任何正式单据
  assert.deepEqual(r.state.sales.map(o => o.id), s.sales.map(o => o.id))
  // 幂等：再清一次没有可删的
  const again = applyOrderOperation(r.state, { action: 'clearDrafts' })
  assert.equal(again.removed, 0)
  assert.equal(again.state.orders.length, 2)
  // 快照不被就地修改
  assert.equal(s.orders.length, 5)
})

test('orderToOrderDoc 与 canUnpost 单独可用（前端预览同一份实现）', () => {
  const doc = orderToOrderDoc({ kind: 'sale', customer: '客户甲', date: '2026-10-29', no: 'DD-01', items: [line('P00001', '管件', 2, 10)], deposits: [{ date: '2026-10-29', amount: 20, voucher: 'SK-20261029-0009' }] }, 'X9')
  assert.equal(doc.no, 'DD-01')                  // 订单填过业务单号就沿用
  assert.equal(doc.settle, '结清')
  assert.equal(grossOf(doc), 20)
  assert.equal(canUnpost(doc, [doc]).ok, false)
  assert.equal(canUnpost({ id: 'X8', payments: [] }, [{ id: 'X8', payments: [] }]).ok, true)
  // 已有下游变更单的原单也不能撤销过账
  const child = { id: 'XA-20261029-0001', sourceOrderId: 'X8' }
  assert.match(canUnpost({ id: 'X8', payments: [] }, [{ id: 'X8', payments: [] }, child]).reason, /变更单/)
  assert.deepEqual(orderKeys('purchase').listKey, 'purchases')
})

test('过账后派生数据自洽：客户档案、历史价、库存同源重建', () => {
  const s = saveOrder(fixture(), draft({ items: [line('P00002', '阀门', 3, 20)] })).state
  const r = applyOrderOperation(s, { action: 'post', orderId: s.orders[0].id })
  const next = r.state
  Object.assign(next, derive(next.items, next.suppliers, next.purchases, next.sales, next.customers))
  next.stock = rebuildStock(next.purchases, next.sales, next.items)
  assert.equal(next.items.find(i => i.code === 'P00002').price, 20)
  assert.equal(next.stock.P00002.qty, -3)   // 阀门从没进过货，卖 3 件 → 库存 -3（超卖由库存预警暴露）
  assert.equal(next.sales.length, 2)
  assert.equal(next.customers.length, 1)
})
