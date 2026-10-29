// 单据变更（已动过钱的单要增减商品）——全站唯一的「明细 diff → 退货单 / 补差单」口径。
//
// 为什么不让编辑弹窗直接改原单：一张已收款的单，明细一改，
//   金额（应收）、库存（派生）、资金（已开的收款单 SK-/FK-）三者会同时错位，
//   而资金台账是只增不改的——改小原单等于凭空抹掉一笔真实进账。
// 所以变更走「原单不动 + 生成关联单」：
//   减少商品 → 销售/采购退货单（XT-/CT-，负数明细），复用 applyRefundOperation 的四档资金处理
//   增加商品 → 销售/采购补差单（XA-/CA-，正数明细），走正常收款链路
// 两张单都用 sourceOrderId 指回原单，库存与应收由派生层自动跟上（见 api/routes.js rebuildStock）。
//
// 纯函数，前端预览与服务端落库共用同一份实现，避免「界面算的差额」和「库里生成的」不一致。
import { round2, netOf, ensurePayments } from './account.js'
import { applyRefundOperation, isReturn, returnableLines } from './refunds.js'
import { genVoucherCode } from './voucher.js'

// 补差单：正数明细、挂在原单名下的追加销售/采购。total>0，故不会被 isReturn 误判成退货
export const isAmend = o => ['sale-amend', 'purchase-amend'].includes(o?.type) ||
  /^(XA|CA)-\d{8}-\d{4}$/.test(String(o?.id || ''))

// 这张单是否已经动过钱：有收付款流水、有退货核销记录，或旧字段里还躺着钱。
// 没动过钱的单允许原地改明细（库存自动重算、资金无牵涉）；动过钱只能走变更。
// 最后一条判据针对「payments 是空数组、钱还记在 received/paid 上」的历史脏数据（写入端已用
// normalizeOrderPayments 堵住，见 api/routes.js）：这笔钱真实存在，只是流水没记全，
// 一律按动过钱处理，宁可让用户走变更，也不能让原地改明细把这笔钱变成幽灵欠款。
export function moneyTouched(order, kind) {
  const field = kind === 'payable' ? 'paid' : 'received'
  if ((order?.settlements || []).length) return true
  if (ensurePayments(order, field).length) return true
  return Number(order?.[field] || 0) !== 0
}

// 按商品编码聚合行数量（同编码多行合并；同编码不同单价视为不可变更，交给上层报错）
function aggregateByCode(items) {
  const map = new Map()
  for (const l of (items || [])) {
    const code = String(l?.code || '')
    if (!code) continue
    const qty = Number(l?.qty || 0)
    const price = Number(l?.price || 0)
    const cur = map.get(code)
    if (!cur) map.set(code, { code, name: l?.name || '', unit: l?.unit || '', qty, price, mixedPrice: false })
    else {
      if (round2(cur.price) !== round2(price)) cur.mixedPrice = true
      cur.qty = round2(cur.qty + qty)
    }
  }
  return map
}

// 明细 diff：原单 items vs 改后 items → 退货行（按原单行索引分摊）+ 补差行
// 退货必须落到「原单的哪一行、退几个」，因为退款要按行净额分摊折扣/优惠（见 returnableLines）。
export function diffOrderLines(source, editedItems, allOrders = []) {
  const before = aggregateByCode(source?.items)
  const after = aggregateByCode(editedItems)
  for (const row of before.values()) if (row.mixedPrice) return { ok: false, error: `商品「${row.name || row.code}」在原单里有多个单价，无法自动变更，请分开开单` }
  for (const row of after.values()) if (row.mixedPrice) return { ok: false, error: `商品「${row.name || row.code}」在改后明细里单价不一致，请统一后再变更` }

  const refundLines = []
  const amendLines = []
  const priceChanged = []
  const candidates = returnableLines(source, allOrders)

  for (const [code, row] of before) {
    const now = after.get(code)
    const nowQty = now ? now.qty : 0
    if (now && round2(now.price) !== round2(row.price)) priceChanged.push({ code, name: row.name, from: row.price, to: now.price })
    const less = round2(row.qty - nowQty)
    if (less <= 0) continue
    // FIFO 分摊到原单各行：先退数量大的行，保证每行都不退超
    let left = less
    for (const line of (source.items || []).map((l, index) => ({ l, index })).filter(x => String(x.l?.code || '') === code)) {
      if (left <= 0) break
      const can = candidates[line.index]?.available ?? Number(line.l.qty || 0)
      const take = round2(Math.min(left, can))
      if (take <= 0) continue
      refundLines.push({ index: line.index, qty: take })
      left = round2(left - take)
    }
    if (left > 0) {
      return { ok: false, error: `商品「${row.name || code}」要退 ${less}，但该单已退过一部分，剩余可退不足` }
    }
  }
  for (const [code, row] of after) {
    const was = before.get(code)
    const more = round2(row.qty - (was ? was.qty : 0))
    if (more <= 0) continue
    amendLines.push({ code, name: row.name, unit: row.unit, qty: more, price: row.price, total: round2(more * row.price) })
  }
  if (priceChanged.length) {
    return { ok: false, error: `变更不允许改价：${priceChanged.map(p => `${p.name || p.code} ¥${p.from}→¥${p.to}`).join('、')}。要改价请另开新单，或先退货再重开。` }
  }
  const untouched = !refundLines.length && !amendLines.length
  return { ok: true, untouched, refundLines, amendLines, refundQty: round2(refundLines.reduce((s, l) => s + l.qty, 0)), amendTotal: round2(amendLines.reduce((s, l) => s + l.total, 0)) }
}

// 退货金额预览：与服务端同一套行净额分摊（直接借 returnableLines 的结果算，避免两套口径）
export function refundPreview(source, refundLines, allOrders = []) {
  const candidates = returnableLines(source, allOrders)
  return round2(refundLines.reduce((s, l) => {
    const row = candidates[l.index]
    if (!row) return s
    const value = Math.abs(Number(l.qty) - row.available) < 1e-8 ? row.remainingMoney : round2(row.lineNet * Number(l.qty) / Number(row.qty))
    return round2(s + value)
  }, 0))
}

// 变更后的净欠款（原单 + 本次生成的两张单一起看），用于给用户一句话结论
export function netAfterAmend(state, kind, sourceId) {
  const key = kind === 'sale' ? 'sales' : 'purchases'
  const orders = state[key] || []
  const party = orders.find(o => o.id === sourceId)
  if (!party) return null
  const acct = kind === 'sale' ? 'receivable' : 'payable'
  return round2(orders.filter(o => o.id === sourceId || o.sourceOrderId === sourceId)
    .reduce((s, o) => s + netOf(o, acct), 0))
}

const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error }

// 服务端事务体：在固定快照上重算并生成退货单 / 补差单。
// 前端传来的金额一律不信，只认 lines/amendLines 的数量与商品编码，价格取原单行与商品主数据。
export function applyAmendOperation(snapshot, input, now = new Date().toISOString()) {
  let state = structuredClone(snapshot)
  if (!['sale', 'purchase'].includes(input?.kind)) fail('请选择销售或采购')
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || '')) fail('缺少有效请求标识')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) fail('日期无效')
  const key = input.kind === 'sale' ? 'sales' : 'purchases'
  const partyKey = input.kind === 'sale' ? 'customer' : 'supplier'
  const field = input.kind === 'sale' ? 'received' : 'paid'
  let orders = state[key]
  const dup = orders.find(o => o.requestId === input.requestId)
  if (dup) return { state: snapshot, duplicate: true, code: dup.id }
  let source = orders.find(o => o.id === input.sourceOrderId)
  if (!source || isReturn(source) || isAmend(source)) fail('只能对正常单据做变更，退货单/补差单请用各自的编辑入口')
  if (source[partyKey] !== input.party) fail('往来单位与原单不一致，请刷新后重试')

  const refundLines = Array.isArray(input.refundLines) ? input.refundLines : []
  const amendLines = Array.isArray(input.amendLines) ? input.amendLines : []
  if (!refundLines.length && !amendLines.length) fail('没有需要变更的商品')

  let returnId = ''
  let codes = []
  if (refundLines.length) {
    // 退货与资金处理整体交给退款链路：它已经实现了退现金/抵欠款/转预存/先挂着 四种模式与幂等
    const r = applyRefundOperation(state, {
      action: 'create', kind: input.kind, sourceOrderId: source.id, date: input.date,
      lines: refundLines, reason: input.reason || '单据变更', mode: input.mode || 'pending',
      requestId: `${input.requestId}-r`, remark: input.remark || '', createdAt: now
    }, now)
    state = r.state
    if (r.duplicate) return { state: snapshot, duplicate: true, code: r.code }
    // 退款链路返回的是它自己的一份克隆：换掉 state 之后必须重新取指针，
    // 否则下面补差单会被 push 进那份已经废弃的旧数组（单号生成了、库里却没有）。
    orders = state[key]
    source = orders.find(o => o.id === input.sourceOrderId)
    returnId = r.returnId || r.code
    codes = r.codes || []
  }

  let amendId = ''
  if (amendLines.length) {
    const items = state.items || []
    const lines = amendLines.map(l => {
      const code = String(l?.code || '')
      const qty = Number(l?.qty || 0)
      const master = items.find(i => i.code === code)
      if (!code || !master) fail(`商品 ${l?.name || code || '（空）'} 不在商品库里，请先在商品档案里新增`)
      if (!Number.isFinite(qty) || qty <= 0) fail(`商品「${master.name || code}」数量必须大于 0`)
      // 原单已有这个编码 → 一律沿用原单行单价，前端传来的价格不作数（改价请另开新单，
      // 见 diffOrderLines 的同一规则）；纯新增行没有原价可依，才取录入价，缺省回落商品档案售价。
      const prior = (source.items || []).find(x => String(x.code) === code)
      const price = prior ? Number(prior.price || 0) : Number(l.price ?? master.price ?? 0)
      if (!Number.isFinite(price) || price < 0) fail(`商品「${master.name || code}」单价无效`)
      return { code, name: master.name || '', unit: master.unit || '', qty, price, total: round2(qty * price) }
    })
    const total = round2(lines.reduce((s, l) => s + l.total, 0))
    if (total <= 0) fail('补差金额为 0，无需生成补差单')
    amendId = genVoucherCode(input.kind === 'sale' ? 'XA' : 'CA', input.date, orders.map(o => ({ code: o.id })))
    orders.push({
      id: amendId, type: `${input.kind}-amend`, sourceOrderId: source.id, no: source.no || '',
      [partyKey]: source[partyKey], date: input.date, items: lines, total, discount: 0,
      amendReason: String(input.reason || '单据变更'), remark: String(input.remark || ''),
      payments: [], [field]: 0, settle: '挂账', requestId: input.requestId, createdAt: now
    })
  }

  return { state, code: amendId || returnId, returnId, amendId, codes }
}
