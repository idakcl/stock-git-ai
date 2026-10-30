// 退货原因改成非必填：留空不拦、落库记「无」，填了就存去掉首尾空白后的原文。
// 跑法：node tests/refund-reason-test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRefundOperation } from '../src/utils/refunds.js'

const line = (code, name, qty, price) => ({ code, name, unit: '个', qty, price, total: Math.round(qty * price * 100) / 100 })

const fixture = () => ({
  refunds: [],
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  sales: [{ id: 'X1', date: '2026-10-01', customer: '客户甲', no: 'N001', total: 100, discount: 0, payments: [], received: 0, settle: '挂账', items: [line('P00001', '管件', 2, 50)] }],
  purchases: []
})

let seq = 0
const input = (extra = {}) => ({
  action: 'create', kind: 'sale', sourceOrderId: 'X1', date: '2026-10-30',
  lines: [{ index: 0, qty: 1 }], mode: 'pending',
  requestId: `refund-reason-test-${String(++seq).padStart(4, '0')}`,
  ...extra
})

const created = (state) => state.sales.find(o => o.type === 'sale-return')

test('退货原因留空：不报错，落库记「无」', () => {
  const base = fixture()
  // 特意不带 reason 字段（老入口可能根本不传）
  const { state } = applyRefundOperation(base, input())
  const entry = created(state)
  assert.ok(entry, '留空也必须生成退货单')
  assert.equal(entry.returnReason, '无')
})

test('退货原因只填空格：同样记「无」', () => {
  const { state } = applyRefundOperation(fixture(), input({ reason: '   ' }))
  assert.equal(created(state).returnReason, '无')
})

test('填了退货原因：去掉首尾空白后原样保存', () => {
  const { state } = applyRefundOperation(fixture(), input({ reason: '  客户装错型号  ' }))
  assert.equal(created(state).returnReason, '客户装错型号')
})
