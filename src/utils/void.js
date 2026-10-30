// 单据作废：把一张销售单/采购单整单撤销，并把它的收款单/付款单一起作废。
//
// 为什么不是「删除」：单据删除后凭证、流水、库存都是散落的，事后无法解释「这张 SK- 为什么少了钱」。
// 作废保留单据与凭证（status = 作废、可查可审计），但业务上当作没发生过：
//   · 单据：应收/应付归零（account.grossOf）、实收/实付不再计入（receivedSumOf/paidSumOf）、
//           库存与历史价由 derive / rebuildStock 跳过 → 库存自动回滚；
//   · 凭证：同一张收款单/付款单置为作废（金额与编号保留，不再参与任何合计）；
//   · 预存/预付：本单产生的抵扣、超收转存流水一并撤掉（用了预付款的，余额原样退回）；
//   · 订单：若这张单是订单过账来的，订单退回「草稿」并摘掉已作废的订金记录（凭证已废，留着重过账会带上废号）。
//
// 不可恢复：作废是一次单向操作（确认框里写明）。需要重新开单就再录一张——
// 这样「作废」永远是账实一致的分界线，不会出现「作废又恢复、凭证废了又活」的中间态。
import { ensurePayments, isVoided, round2, VOIDED } from './account.js'
import { todayCN } from './time.js'
import { DRAFT } from './orders.js'

const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error }

const clone = (state) => (typeof structuredClone === 'function' ? structuredClone(state) : JSON.parse(JSON.stringify(state)))

// kind: 'sale' | 'purchase'
export function applyVoidOperation(snapshot, input, now = new Date().toISOString()) {
  if (!input || !input.id) fail('缺少单据号')
  const kind = input.kind === 'purchase' ? 'purchase' : 'sale'
  const listKey = kind === 'purchase' ? 'purchases' : 'sales'
  const voucherKey = kind === 'purchase' ? 'payment-vouchers' : 'receipts'
  const field = kind === 'purchase' ? 'paid' : 'received'
  const partyKey = kind === 'purchase' ? 'supplier' : 'customer'
  const state = clone(snapshot)
  state[listKey] = Array.isArray(state[listKey]) ? state[listKey] : []
  state[voucherKey] = Array.isArray(state[voucherKey]) ? state[voucherKey] : []
  state.sales = Array.isArray(state.sales) ? state.sales : []
  state.purchases = Array.isArray(state.purchases) ? state.purchases : []
  state.orders = Array.isArray(state.orders) ? state.orders : []

  const doc = state[listKey].find(o => o.id === input.id)
  if (!doc) fail('单据不存在，可能已被删除', 404)
  if (isVoided(doc)) {
    // 幂等：重复点（网络重试/双端同时点）不该报错，也不该再动任何账
    return { state, code: doc.id, duplicate: true, vouchers: doc.voidedVouchers || [] }
  }
  // 闸门①：有退货/补差单时先处理子单——子单金额是基于原单算出来的，
  // 原单作废后它们就成了无源之水，库存与往来账都无从解释
  const child = [...state.sales, ...state.purchases].find(o => o.sourceOrderId === doc.id)
  if (child) fail(`这张单已有变更单 ${child.id}（退货/补差），请先处理那张单再作废`, 409)
  // 闸门②：退货核销记录同理（退款业务双边核销，原单一作废，核销的另一半就悬空了）
  if ((doc.settlements || []).length) fail('这张单已有退货核销记录，请先处理退货再作废', 409)

  // ---- 定位要一起作废的凭证 ----
  // 优先用单据流水上回写的编号（这是最可靠的绑定）；再兜底 items 里指向本单的凭证。
  const payCodes = new Set(ensurePayments(doc, field).map(p => p.voucher).filter(Boolean))
  const linked = state[voucherKey].filter(v => !isVoided(v) &&
    (payCodes.has(v.code) || (v.items || []).some(it => it.orderId === doc.id)))
  // 一张凭证可能同时覆盖多张单据（合并收付款）：整张废掉会连带别家的收款记录，
  // 这种情形必须由用户先到「收付款单」里拆开，绝不替用户猜
  for (const v of linked) {
    // 订金凭证的 items 指向的是订单号（orderType=order），过账后凭证号跟到了本单流水上——
    // 这种「指向本单来源订单」的凭证属于本单自己，不算共享
    const others = (v.items || []).filter(it => it.orderId && it.orderId !== doc.id && it.orderId !== doc.fromOrderId)
    if (others.length) {
      fail(`收款/付款单 ${v.code} 还覆盖其他单据（${others.map(it => it.orderId).join('、')}），请先到「收付款单」里拆开再作废`, 409)
    }
  }
  const voidedVouchers = linked.map(v => v.code)
  const voidSet = new Set(voidedVouchers)
  const reason = String(input.reason || '').slice(0, 200)

  // ---- 1) 单据置作废 ----
  Object.assign(doc, {
    status: VOIDED,
    voidedAt: now,
    voidedReason: reason,
    voidedVouchers
  })

  // ---- 2) 凭证置作废（编号、金额、关联单号原样保留，只加状态） ----
  state[voucherKey] = state[voucherKey].map(v => voidSet.has(v.code)
    ? { ...v, status: VOIDED, voidedAt: now, voidedReason: reason, voidOf: doc.id }
    : v)

  // ---- 3) 预存/预付流水：撤掉本单产生的抵扣与超收转存 ----
  // 与「删除单据」同一套口径（utils/deposit.removeDepositFlows）：
  // 带 order 标记的流水一律清掉；用了预付款却没有带标记的抵扣流水（早期数据）时，补一笔正向流水把余额退回。
  const entityList = kind === 'purchase' ? state.suppliers : state.customers
  const entity = (entityList || []).find(x => x.name === (doc[partyKey] || ''))
  if (entity) {
    const flowField = kind === 'purchase' ? 'advances' : 'deposits'
    const flows = entity[flowField] || []
    const used = (doc.payments || []).filter(p => p.fromDeposit).reduce((s, p) => s + Number(p.amount || 0), 0)
    const hadTaggedDeduct = flows.some(f => f.order === doc.id && Number(f.amount) < 0)
    const cleaned = flows.filter(f => f.order !== doc.id)
    if (round2(used) > 0.005 && !hadTaggedDeduct) {
      cleaned.push({
        date: todayCN(),
        amount: round2(used),
        remark: kind === 'purchase' ? '作废单据退回预付款' : '作废单据退回预收款',
        order: doc.id,
        time: now
      })
    }
    entity[flowField] = cleaned
  }

  // ---- 4) 订单过账来的单：订单退回草稿，摘掉已作废的订金 ----
  let unpostedOrderId = ''
  if (doc.fromOrderId) {
    state.orders = state.orders.map(o => {
      if (o.id !== doc.fromOrderId) return o
      // 只回退「确实指向这张单」的订单，避免误伤已经重新过账的订单
      if (o.postedOrderId && o.postedOrderId !== doc.id) return o
      unpostedOrderId = o.id
      return {
        ...o,
        status: DRAFT,
        postedOrderId: '',
        postedAt: '',
        updatedAt: now,
        deposits: (o.deposits || []).filter(d => !voidSet.has(d.voucher))
      }
    })
  }

  return { state, code: doc.id, vouchers: voidedVouchers, unpostedOrderId }
}
