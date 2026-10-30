// 单据作废（/api/voids）纯函数测试：单据归零、凭证同废、库存回滚、预存退回、闸门与幂等。
// 跑法：node tests/void-test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyVoidOperation } from '../src/utils/void.js'
import { grossOf, receivableOf, payableOf, receivedSumOf, paidSumOf, isVoided, VOIDED } from '../src/utils/account.js'
import { derive, rebuildStock } from '../api/routes.js'

const line = (code, name, qty, price) => ({ code, name, unit: '个', qty, price, total: Math.round(qty * price * 100) / 100 })

const fixture = () => ({
  logs: [], orders: [], refunds: [], stock: {},
  items: [{ code: 'P00001', name: '管件', unit: '个', cost: 8, price: 10 }],
  customers: [{ code: 'C00001', name: '客户甲', deposits: [] }],
  suppliers: [{ code: 'S00001', name: '供应商甲', advances: [] }],
  sales: [{
    id: 'X1', date: '2026-10-01', customer: '客户甲', total: 40, discount: 0,
    payments: [{ date: '2026-10-01', amount: 40, voucher: 'SK-0001' }],
    items: [line('P00001', '管件', 4, 10)]
  }],
  purchases: [{
    id: 'C1', date: '2026-10-01', supplier: '供应商甲', total: 40, discount: 0,
    payments: [{ date: '2026-10-01', amount: 40, voucher: 'FK-0001' }],
    items: [line('P00001', '管件', 4, 10)]
  }],
  receipts: [{
    code: 'SK-0001', kind: 'receivable', category: 'normal', party: '客户甲', date: '2026-10-01', total: 40,
    items: [{ orderId: 'X1', orderType: 'sale', amount: 40 }], createdAt: '2026-10-01T08:00:00.000Z'
  }],
  'payment-vouchers': [{
    code: 'FK-0001', kind: 'payable', category: 'normal', party: '供应商甲', date: '2026-10-01', total: 40,
    items: [{ orderId: 'C1', orderType: 'purchase', amount: 40 }], createdAt: '2026-10-01T08:00:00.000Z'
  }]
})

const NOW = '2026-10-30T09:00:00.000Z'

test('作废销售单：应收/实收归零、单据留档、收款单同步作废', () => {
  const before = fixture()
  const r = applyVoidOperation(before, { kind: 'sale', id: 'X1' }, NOW)
  const doc = r.state.sales.find(s => s.id === 'X1')
  assert.equal(doc.status, VOIDED)
  assert.equal(doc.voidedAt, NOW)
  assert.deepEqual(doc.voidedVouchers, ['SK-0001'])
  assert.equal(isVoided(doc), true)
  assert.equal(grossOf(doc), 0)
  assert.equal(receivableOf(doc), 0)
  assert.equal(receivedSumOf(doc), 0)
  // 凭证不删除，只标记；金额与编号保留
  const v = r.state.receipts.find(x => x.code === 'SK-0001')
  assert.equal(v.status, VOIDED)
  assert.equal(v.total, 40)
  assert.equal(v.voidOf, 'X1')
  // 采购单不受影响
  assert.equal(isVoided(r.state.purchases[0]), false)
  assert.equal(grossOf(r.state.purchases[0]), 40)
  // 快照未被就地修改
  assert.equal(before.sales[0].status, undefined)
  assert.equal(before.receipts[0].status, undefined)
  // 返回的 state 是克隆
  assert.notEqual(r.state, before)
})

test('作废采购单：付款单一起作废，应付/实付归零', () => {
  const r = applyVoidOperation(fixture(), { kind: 'purchase', id: 'C1' }, NOW)
  const doc = r.state.purchases.find(p => p.id === 'C1')
  assert.equal(isVoided(doc), true)
  assert.deepEqual(doc.voidedVouchers, ['FK-0001'])
  assert.equal(payableOf(doc), 0)
  assert.equal(paidSumOf(doc), 0)
  assert.equal(r.state['payment-vouchers'][0].status, VOIDED)
  assert.equal(r.state['payment-vouchers'][0].voidOf, 'C1')
})

test('库存与历史价回滚：作废后 rebuildStock / derive 视同没发生过', () => {
  const before = fixture()
  const stockBefore = rebuildStock(before.purchases, before.sales, before.items)
  assert.equal(stockBefore.P00001.qty, 0) // 买 4 卖 4
  const r = applyVoidOperation(before, { kind: 'sale', id: 'X1' }, NOW)
  // 卖出那 4 件"回来"了，只剩采购的 4 件
  assert.equal(rebuildStock(r.state.purchases, r.state.sales, r.state.items).P00001.qty, 4)
  const r2 = applyVoidOperation(before, { kind: 'purchase', id: 'C1' }, NOW)
  assert.equal(rebuildStock(r2.state.purchases, r2.state.sales, r2.state.items).P00001.qty, -4)
  const r3 = applyVoidOperation(r2.state, { kind: 'sale', id: 'X1' }, NOW)
  // 两张单都作废后商品再也没有进出：库存键根本不生成
  assert.equal(rebuildStock(r3.state.purchases, r3.state.sales, r3.state.items).P00001, undefined)
  // derive 不再产出作废单的采购历史
  const d = derive(r3.state.items, r3.state.suppliers, r3.state.purchases, r3.state.sales, r3.state.customers)
  assert.equal(d.history.P00001, undefined)
  assert.equal(d.saleHistory.P00001, undefined)
})

test('重复作废是幂等的：不报错、不二次动账、不再改 voidedAt', () => {
  const r1 = applyVoidOperation(fixture(), { kind: 'sale', id: 'X1' }, NOW)
  const r2 = applyVoidOperation(r1.state, { kind: 'sale', id: 'X1' }, '2027-01-01T00:00:00.000Z')
  assert.equal(r2.duplicate, true)
  assert.equal(r2.state.sales.find(s => s.id === 'X1').voidedAt, NOW)
  assert.equal(r2.state.receipts[0].status, VOIDED)
})

test('闸门：单据不存在返回 404；有退货子单 / 核销记录时拒绝（409）', () => {
  assert.throws(() => applyVoidOperation(fixture(), { kind: 'sale', id: 'NOPE' }), (e) => e.status === 404)
  const withChild = fixture()
  withChild.sales.push({ id: 'X1R', date: '2026-10-02', customer: '客户甲', total: -10, sourceOrderId: 'X1', items: [line('P00001', '管件', -1, 10)] })
  assert.throws(() => applyVoidOperation(withChild, { kind: 'sale', id: 'X1' }), (e) => e.status === 409 && /变更单/.test(e.message))
  const withSettle = fixture()
  withSettle.sales[0].settlements = [{ code: 'HX-0001', total: 10 }]
  assert.throws(() => applyVoidOperation(withSettle, { kind: 'sale', id: 'X1' }), (e) => e.status === 409 && /核销/.test(e.message))
})

test('闸门：一张收款单覆盖多张单据时拒绝，先拆开再作废', () => {
  const s = fixture()
  s.receipts[0].items.push({ orderId: 'X2', orderType: 'sale', amount: 20 })
  assert.throws(() => applyVoidOperation(s, { kind: 'sale', id: 'X1' }), (e) => e.status === 409 && /SK-0001/.test(e.message) && /X2/.test(e.message))
})

test('订金凭证指向来源订单不算共享：可正常作废', () => {
  const s = fixture()
  s.sales[0].fromOrderId = 'D001'
  s.receipts[0].items = [{ orderId: 'D001', orderType: 'order', amount: 40 }]
  const r = applyVoidOperation(s, { kind: 'sale', id: 'X1' }, NOW)
  assert.equal(r.state.receipts[0].status, VOIDED)
})

test('预存抵扣流水随作废撤销：带 order 标记的清掉，余额回到账上', () => {
  const s = fixture()
  s.customers[0].deposits = [
    { date: '2026-09-01', amount: 100, remark: '预存', time: '2026-09-01T00:00:00.000Z' },
    { date: '2026-10-01', amount: -40, remark: '抵扣', order: 'X1', time: '2026-10-01T00:00:00.000Z' }
  ]
  s.sales[0].payments = [{ date: '2026-10-01', amount: 40, voucher: 'SK-0001', fromDeposit: true }]
  const r = applyVoidOperation(s, { kind: 'sale', id: 'X1' }, NOW)
  const flows = r.state.customers[0].deposits
  assert.equal(flows.some(f => f.order === 'X1' && Number(f.amount) < 0), false)
  // 原预存 100 仍在，抵扣的 40 撤销后无需补正向流水（有标记的抵扣流水已删除）
  assert.equal(flows.reduce((n, f) => n + Number(f.amount), 0), 100)
})

test('早期数据：用了预存款但没有带标记的抵扣流水时，补一笔正向流水退回余额', () => {
  const s = fixture()
  s.customers[0].deposits = [{ date: '2026-09-01', amount: 60, remark: '预存' }]
  s.sales[0].payments = [{ date: '2026-10-01', amount: 40, voucher: 'SK-0001', fromDeposit: true }]
  const r = applyVoidOperation(s, { kind: 'sale', id: 'X1' }, NOW)
  const flows = r.state.customers[0].deposits
  assert.equal(flows.length, 2)
  const back = flows.find(f => f.order === 'X1')
  assert.equal(back.amount, 40)
  assert.match(back.remark, /退回预收/)
  assert.equal(flows.reduce((n, f) => n + Number(f.amount), 0), 100)
})

test('订单过账来的单：作废后订单退回未过账，并摘掉已作废的订金凭证记录', () => {
  const s = fixture()
  s.sales[0].fromOrderId = 'D001'
  s.receipts[0].items = [{ orderId: 'D001', orderType: 'order', amount: 40 }]
  s.orders = [{
    id: 'D001', status: '已过账', postedOrderId: 'X1', postedAt: '2026-10-01T00:00:00.000Z',
    deposits: [{ amount: 40, voucher: 'SK-0001' }, { amount: 10, voucher: 'SK-0000' }]
  }]
  const r = applyVoidOperation(s, { kind: 'sale', id: 'X1' }, NOW)
  assert.equal(r.unpostedOrderId, 'D001')
  const o = r.state.orders[0]
  assert.equal(o.status, '未过账')
  assert.equal(o.postedOrderId, '')
  assert.deepEqual(o.deposits.map(d => d.voucher), ['SK-0000'])
})

test('订单已重新过账到别的单据时不误回退', () => {
  const s = fixture()
  s.sales[0].fromOrderId = 'D001'
  s.orders = [{ id: 'D001', status: '已过账', postedOrderId: 'X9', deposits: [] }]
  const r = applyVoidOperation(s, { kind: 'sale', id: 'X1' }, NOW)
  assert.equal(r.unpostedOrderId, '')
  assert.equal(r.state.orders[0].postedOrderId, 'X9')
})

test('只作废本单相关的凭证：其他单据的收款单保持有效', () => {
  const s = fixture()
  s.receipts.push({ code: 'SK-0002', kind: 'receivable', party: '客户甲', date: '2026-10-02', total: 20, items: [{ orderId: 'X2', amount: 20 }] })
  const r = applyVoidOperation(s, { kind: 'sale', id: 'X1' }, NOW)
  assert.deepEqual(r.vouchers, ['SK-0001'])
  assert.equal(r.state.receipts.find(v => v.code === 'SK-0002').status, undefined)
})

test('作废原因截断 200 字并带到单据与凭证上', () => {
  const reason = 'x'.repeat(300)
  const r = applyVoidOperation(fixture(), { kind: 'sale', id: 'X1', reason }, NOW)
  assert.equal(r.state.sales[0].voidedReason.length, 200)
  assert.equal(r.state.receipts[0].voidedReason.length, 200)
})
