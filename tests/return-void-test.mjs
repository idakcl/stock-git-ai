// 退货单作废的闸门：以前作废退货单不看退款凭证，钱付出去了、单子却没了。
// 口径（owner 2026-11-01 拍板选「按核销状态判定」）：
//   · 未核销、未开退款凭证 → 允许作废，并立刻把可退额度还给原单；
//   · 有核销/抵扣记录，或已开 TK-/HX- 凭证 → 409，要求先冲销退款；
//   · 原单的「子单存在」闸门只看还有效的子单，子单作废后原单解锁；
//   · 作废幂等：重复点不报错也不重复动账。
import assert from 'node:assert/strict'
import { applyRefundOperation, returnableLines } from '../src/utils/refunds.js'
import { applyVoidOperation } from '../src/utils/void.js'
import { isVoided } from '../src/utils/account.js'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')) }
}

const fixture = () => ({
  logs: [], stock: {}, refunds: [], orders: [], receipts: [], 'payment-vouchers': [],
  items: [{ code: 'P00001', name: '管件', cost: 10 }],
  customers: [{ code: 'C00001', name: '客户甲', deposits: [] }],
  suppliers: [{ code: 'S00001', name: '供应商甲', advances: [] }],
  sales: [{ id: 'S1', date: '2026-10-01', customer: '客户甲', total: 100, discount: 0,
    payments: [], items: [{ code: 'P00001', name: '管件', qty: 10, price: 10, total: 100 }] }],
  purchases: []
})
const create = (extra = {}) => ({ action: 'create', requestId: 'request-create-00001', kind: 'sale',
  sourceOrderId: 'S1', date: '2026-10-28', reason: '退货', lines: [{ index: 0, qty: 4 }], ...extra })
const settle = (orderIds, extra = {}) => ({ action: 'settle', requestId: 'request-settle-00001',
  kind: 'sale', date: '2026-10-28', orderIds, mode: 'cash', amount: 10, ...extra })
const returnIds = s => s.sales.filter(o => Number(o.total) < 0).map(o => o.id)

console.log('\n未核销退货单：可作废并释放额度')
t('创建退货单后原单可退额度从 10 降到 6', () => {
  const s = applyRefundOperation(fixture(), create({ mode: 'pending' })).state
  assert.equal(returnableLines(s.sales[0], s.sales)[0].available, 6)
})
t('作废这张未核销退货单：成功，且原单额度立刻回到 10', () => {
  const s = applyRefundOperation(fixture(), create({ mode: 'pending' })).state
  const id = returnIds(s)[0]
  const out = applyVoidOperation(s, { kind: 'sale', id, reason: '开错了' })
  assert.ok(isVoided(out.state.sales.find(o => o.id === id)))
  assert.equal(returnableLines(out.state.sales[0], out.state.sales)[0].available, 10)
})
t('作废后还能按原数量重新退一次（额度是真回来了，不是绕过校验）', () => {
  const s = applyRefundOperation(fixture(), create({ mode: 'pending' })).state
  const out = applyVoidOperation(s, { kind: 'sale', id: returnIds(s)[0] })
  const again = applyRefundOperation(out.state, { ...create({ mode: 'pending' }), requestId: 'request-create-00009', lines: [{ index: 0, qty: 10 }] })
  assert.equal(again.state.sales.filter(o => Number(o.total) < 0 && !isVoided(o)).length, 1)
  assert.equal(returnableLines(again.state.sales[0], again.state.sales)[0].available, 0)
})
t('子单作废后，原单不再被「已有变更单」拦住', () => {
  const s = applyRefundOperation(fixture(), create({ mode: 'pending' })).state
  const out = applyVoidOperation(s, { kind: 'sale', id: returnIds(s)[0] })
  const src = applyVoidOperation(out.state, { kind: 'sale', id: 'S1', reason: '整单作废' })
  assert.ok(isVoided(src.state.sales.find(o => o.id === 'S1')))
})

console.log('\n已核销 / 已开凭证：必须拦住')
t('现金退款已开 TK- 凭证 → 409，且不提「请先处理退货」这种自指提示', () => {
  const s = applyRefundOperation(fixture(), create()).state
  assert.ok(s.refunds.length === 1 && /^TK-/.test(s.refunds[0].code))
  assert.throws(() => applyVoidOperation(s, { kind: 'sale', id: returnIds(s)[0] }),
    e => e.status === 409 && /退款凭证/.test(e.message))
})
t('转预存核销（HX-）→ 409（这一条先撞上「已有核销/抵扣」闸门，措辞要说清是核销不是子单）', () => {
  const s = applyRefundOperation(fixture(), create({ mode: 'deposit' })).state
  assert.throws(() => applyVoidOperation(s, { kind: 'sale', id: returnIds(s)[0] }),
    e => e.status === 409 && /核销|退款凭证/.test(e.message) && !/变更单/.test(e.message))
})
t('先退货未核销、后现金退款 → 一旦核销就拦（不是只看下单时状态）', () => {
  const s1 = applyRefundOperation(fixture(), create({ mode: 'pending' })).state
  const s2 = applyRefundOperation(s1, settle([returnIds(s1)[0]])).state
  assert.throws(() => applyVoidOperation(s2, { kind: 'sale', id: returnIds(s2)[0] }),
    e => e.status === 409)
})
t('凭证被作废后闸门自动松开（不是死锁）：refund 置作废即可再作废退货单', () => {
  const s = applyRefundOperation(fixture(), create()).state
  s.refunds[0].status = '作废'
  const out = applyVoidOperation(s, { kind: 'sale', id: returnIds(s)[0] })
  assert.ok(isVoided(out.state.sales.find(o => o.id === returnIds(s)[0])))
})

console.log('\n幂等与回归')
t('重复作废同一张退货单 → duplicate，不重复动账', () => {
  const s = applyRefundOperation(fixture(), create({ mode: 'pending' })).state
  const id = returnIds(s)[0]
  const once = applyVoidOperation(s, { kind: 'sale', id })
  const twice = applyVoidOperation(once.state, { kind: 'sale', id })
  assert.equal(twice.duplicate, true)
  assert.equal(once.state.sales.filter(o => o.id === id).length, 1)
})
t('正常单据的作废闸门没被放松：仍有未作废子单时照旧 409', () => {
  const s = applyRefundOperation(fixture(), create({ mode: 'pending' })).state
  assert.throws(() => applyVoidOperation(s, { kind: 'sale', id: 'S1' }),
    e => e.status === 409 && /变更单/.test(e.message))
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
