// 订单（未过账单据）——全站唯一的「草稿 → 过账 → 正式单据」模型。
//
// 为什么单独一个集合，而不是给销售单加个 status 字段：
//   库存是从 purchases/sales 全量派生的（api/routes.js rebuildStock，逐行累加、无状态过滤），
//   应收/应付、看板、对账也一律读那两个集合。订单若住在 sales.json 里，
//   哪怕没收款也照样扣库存、进应收——那不叫草稿，那叫已经成交。
//   所以订单必须住在 orders.json：不进库存、不进资金、不进债权，随便改、随便删。
//
// 状态机：草稿 --过账--> 已过账（生成销售/采购单）--撤销过账--> 草稿（仅当那张单还没动过钱）
// 订金：订单阶段就能收钱，收的时候开一张正常收款单（SK-/FK-），items.orderId 指向订单号；
//       过账时这笔订金原样搬成新单的第一条收款流水（凭证号带着走，不改写已开凭证）。
import { grossOf, round2, syncPayments, ensurePayments, depositSumOf, isVoided, VOIDED } from './account.js'
import { normalizeRate } from './catalog.js'
import { genOrderId } from './code.js'
import { genVoucherCode } from './voucher.js'
import { todayCN } from './time.js'

export const DRAFT = '未过账'
export const POSTED = '已过账'
// 作废：订单不再参与任何业务，但记录保留（谁、什么时候、为什么作废都能查）。
// 2026-11-01 owner 拍板：订单不再硬删除——草稿也是业务痕迹，删掉就再也说不清「那张单去哪了」。
export const VOIDED_ORDER = '已作废'
// 早期版本草稿状态存的是「草稿」；保留常量用于一次性迁移与兼容判断
export const LEGACY_DRAFT = '草稿'

const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error }

// 订单侧与单据侧的字段名映射：销售↔客户/收款，采购↔供应商/付款
export function orderKeys(kind) {
  return kind === 'purchase'
    ? { partyKey: 'supplier', field: 'paid', acct: 'payable', voucherFile: 'payment-vouchers', voucherPrefix: 'FK', docPrefix: 'C', listKey: 'purchases', orderType: 'purchase' }
    : { partyKey: 'customer', field: 'received', acct: 'receivable', voucherFile: 'receipts', voucherPrefix: 'SK', docPrefix: 'X', listKey: 'sales', orderType: 'sale' }
}

// 订单金额与单据同一口径：合计 × 折扣链 − 整单优惠（红字不适用，订单只允许正数）。
// 合计一律由明细行现算，不读订单上的 total 字段：草稿在界面上改来改去，
// total 有可能是上一次算完没同步的旧值，而 validateOrder 已经逐行校验过 total = qty × price。
export const orderAmount = order => grossOf({ ...(order || {}), total: round2((order?.items || []).reduce((s, l) => s + Number(l.total || 0), 0)) })
export const orderDepositSum = order => round2(depositSumOf(order?.deposits))

// 状态判定：不是「已过账」的都算未过账（兼容早期存成「草稿」的历史数据）。
// 作废单不算未过账：它既不能被过账，也不该出现在「待过账」计数与「清空未过账」里。
export const isUnposted = status => status !== POSTED && status !== VOIDED_ORDER
export const isVoidOrder = o => !!o && o.status === VOIDED_ORDER

// 状态显示口径：界面上「草稿」统一叫「未过账」。库里历史数据仍是 '草稿'，凡是「非已过账」都按未过账显示，
// 这样老订单、备份恢复的数据不用迁移也能显示一致。
export const orderStatusText = status => (status === POSTED ? POSTED : status === VOIDED_ORDER ? VOIDED_ORDER : DRAFT)

// 校验：返回错误数组（空数组＝通过）。前端与服务端共用，避免「界面能提交、服务端拒」
export function validateOrder(order, { items = [] } = {}) {
  const errors = []
  if (!order) return ['订单不存在']
  if (!['sale', 'purchase'].includes(order.kind)) errors.push('请选择销售或采购')
  const { partyKey } = orderKeys(order.kind)
  if (!String(order[partyKey] || '').trim()) errors.push('请填写往来单位')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(order.date || '')) errors.push('日期格式应为 YYYY-MM-DD')
  const lines = order.items || []
  if (!lines.length) errors.push('至少要有 1 行商品明细')
  const codes = new Set(items.map(i => i.code))
  lines.forEach((l, i) => {
    if (!l.code) errors.push(`第 ${i + 1} 行未选商品`)
    else if (codes.size && !codes.has(l.code)) errors.push(`第 ${i + 1} 行商品 ${l.code} 不在商品库里`)
    const qty = Number(l.qty || 0)
    if (!(qty > 0)) errors.push(`第 ${i + 1} 行数量必须大于 0（订单不支持负数，退货请走单据变更）`)
    const price = Number(l.price || 0)
    if (!(price >= 0)) errors.push(`第 ${i + 1} 行单价不能为负`)
    // 行小计＝数量×单价×折扣率（与 utils/catalog.resolveLine、正式单据同一口径）；
    // 无折扣率的旧数据按 1 处理，校验口径不变
    const gross = round2(qty * price)
    const rate = normalizeRate(l, gross)
    const lineTotal = round2(Number(l.total || 0))
    if (lineTotal !== Math.max(0, round2(gross - round2(gross * (1 - rate))))) {
      errors.push(`第 ${i + 1} 行金额与数量×单价×折扣不符`)
    }
  })
  if (Number(order.discount || 0) < 0) errors.push('整单优惠不能为负')
  for (const r of (order.discountRates || [])) {
    if (!(Number(r) > 0 && Number(r) <= 1)) errors.push('折扣率必须在 0~1 之间（1＝不打折）')
  }
  return errors
}

// 订单 → 正式单据。订金转成第一条收款流水，凭证号原样带过去（已开的资金凭证不改写）。
export function orderToOrderDoc(order, id, now = new Date().toISOString()) {
  const { partyKey, field, orderType } = orderKeys(order.kind)
  const deposits = (order.deposits || []).map(d => ({
    date: d.date || order.date, amount: Number(d.amount || 0), remark: d.remark || '订单订金',
    time: d.time || now, voucher: d.voucher || ''
  }))
  const base = {
    id, [partyKey]: order[partyKey], date: order.date || todayCN(),
    // no 保留客户/供应商那边的业务单号；没有就把订单号写进去，保证双向可查
    no: order.no || order.id, fromOrderId: order.id, fromOrderType: 'order',
    items: (order.items || []).map(l => ({ ...l })),
    total: round2((order.items || []).reduce((s, l) => s + Number(l.total || 0), 0)),
    discount: round2(Number(order.discount || 0)),
    discountRates: (order.discountRates || []).slice(),
    remark: order.remark || '', photos: (order.photos || []).slice(),
    // settle 只是初值，下面 syncPayments 会按金额重算（全站口径：以金额为准，不认标签）
    payments: deposits, settle: '挂账'
  }
  base[field] = round2(deposits.reduce((s, p) => s + p.amount, 0))
  // 结算状态按金额判定（全站口径），有订金且订金已覆盖全部应收时自然就是结清
  return syncPayments(base, orderType === 'sale' ? 'receivable' : 'payable')
}

// 能不能撤销过账：那张单必须还没动过钱，也没有下游退货/补差单。
// 一旦收过款（哪怕就是那笔订金转过来的），就不能再"退回草稿"——钱已经在台账里了。
export function canUnpost(doc, allDocs = []) {
  if (!doc) return { ok: false, reason: '过账生成的单据已不存在，请刷新后重试' }
  if (ensurePayments(doc, doc.received != null ? 'received' : 'paid').length) return { ok: false, reason: '这张单已有收付款流水，不能撤销过账；要减少金额请走「变更明细」生成退货单' }
  if ((doc.settlements || []).length) return { ok: false, reason: '这张单已有退货核销记录，不能撤销过账' }
  if (allDocs.some(o => o.sourceOrderId === doc.id)) return { ok: false, reason: '这张单已有变更单（退货/补差），不能撤销过账' }
  return { ok: true }
}

// 过账结清：把未收/未付差额记成一笔实际收/付款，并生成对应的收款单/付款单（SK-/FK-）。
// 全站口径一致：钱真的动了才叫结清（与销售/采购页「收款结清」同一算法），
// 不做「只改结清标签、钱不落账」的假结清。订金本来就在单据流水里，这里只补差额；
// 差额为 0（订金已覆盖、零元单）时不重复记账，单据自然就是结清。
function settlePostedDoc(state, doc, kind, now) {
  const { partyKey, field, voucherFile, voucherPrefix, orderType } = orderKeys(kind)
  const payments = ensurePayments(doc, field)
  const paid = round2(payments.reduce((s, p) => s + Number(p.amount || 0), 0))
  const gap = round2(grossOf(doc) - paid)
  if (!(gap > 0)) return syncPayments({ ...doc, payments }, kind === 'purchase' ? 'payable' : 'receivable')
  const date = doc.date || todayCN()
  state[voucherFile] = (state[voucherFile] || []).slice()
  const code = genVoucherCode(voucherPrefix, date, state[voucherFile].map(v => ({ code: v.code })))
  payments.push({ date, amount: gap, remark: '过账结清', time: now, voucher: code })
  state[voucherFile].push({
    code,
    kind: orderType === 'sale' ? 'receivable' : 'payable',
    category: 'normal',
    party: doc[partyKey],
    date,
    remark: '过账结清',
    total: gap,
    items: [{ orderId: doc.id, orderType, amount: gap, discount: 0, settle: true, note: '过账结清' }],
    createdAt: now
  })
  return syncPayments({ ...doc, payments }, orderType === 'sale' ? 'receivable' : 'payable')
}

const clone = (state) => (typeof structuredClone === 'function' ? structuredClone(state) : JSON.parse(JSON.stringify(state)))

// 服务端事务体：所有订单写操作都走这里，输入非法一律抛错（调用方负责一次提交、失败不重放）。

// 作废订单时连带作废它已经开出的订金凭证。
// 为什么必须连带：订金落库时开的是正经收款单/付款单（SK-/FK-），它已经进了「收付款单」台账。
// 订单作废而凭证留着，就是一笔永远对不上的钱；反过来，只要凭证还在，订单也不该被抹掉。
// 共享凭证（一张凭证同时覆盖别的单据）不替用户猜，直接拦住让他先去拆开。
function voidOrderDeposits(state, order, now) {
  const codes = (order.deposits || []).map(d => d.voucher).filter(Boolean)
  if (!codes.length) return { state, vouchers: [] }
  const { voucherFile } = orderKeys(order.kind)
  const set = new Set(codes)
  const list = state[voucherFile] || []
  const shared = list.filter(v => set.has(v.code) && (v.items || []).some(it => it.orderId && it.orderId !== order.id))
  if (shared.length) {
    fail(`订金凭证 ${shared.map(v => v.code).join('、')} 还覆盖其他单据，请先到「收付款单」里拆开再作废`, 409)
  }
  const voided = []
  const next = list.map(v => {
    if (!set.has(v.code) || isVoided(v)) return v
    voided.push(v.code)
    return { ...v, status: VOIDED, voidedAt: now, voidedReason: '随订单作废', voidOf: order.id }
  })
  return { state: { ...state, [voucherFile]: next }, vouchers: voided }
}

export function applyOrderOperation(snapshot, input, now = new Date().toISOString()) {
  let state = clone(snapshot)
  state.orders = Array.isArray(state.orders) ? state.orders.slice() : []
  const action = input?.action
  const find = id => state.orders.find(o => o.id === id)

  // 备份恢复：整表替换订单集合（全量备份导入用）。
  // 只做「形状」校验，不改金额/状态——备份里是什么就写回什么，恢复后与导出时一致。
  if (action === 'restore') {
    const list = input.orders
    if (!Array.isArray(list)) fail('订单数据必须是数组')
    if (list.length > 5000) fail('订单数量超过 5000 条上限，请分批导入')
    const seen = new Set()
    for (const o of list) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) fail('订单数据中存在非对象记录')
      const id = String(o.id || '').trim()
      if (!id) fail('订单数据中存在缺少订单号的记录')
      if (seen.has(id)) fail(`订单号重复：${id}`)
      seen.add(id)
    }
    state.orders = list.map(o => ({ ...o, status: o.status === LEGACY_DRAFT ? DRAFT : o.status }))
    return { state, code: '', restored: list.length }
  }

  // 一次性数据迁移：早期订单状态存成「草稿」，统一改写成「未过账」。
  // 幂等：没有旧值时不改任何内容，提交层会判定 unchanged、不产生空提交。
  if (action === 'migrateStatus') {
    const migrated = state.orders.filter(o => o.status === LEGACY_DRAFT).length
    if (migrated) {
      state.orders = state.orders.map(o => (o.status === LEGACY_DRAFT ? { ...o, status: DRAFT, updatedAt: now } : o))
    }
    return { state, code: '', migrated }
  }

  if (action === 'save') {
    const draft = input.order || {}
    // AI-API 的幂等入口：同一个 aiRequestId 重试时直接返回已创建的订单，绝不重复开单。
    // 放在事务快照内判定，两个并发请求也只会有一个真正新建。
    if (draft.aiRequestId) {
      const dup = state.orders.find(o => o.aiRequestId === draft.aiRequestId)
      if (dup) return { state, code: dup.id, duplicate: true }
    }
    const errors = validateOrder(draft, { items: state.items })
    if (errors.length) fail(errors[0])
    if (draft.id) {
      const idx = state.orders.findIndex(o => o.id === draft.id)
      if (idx < 0) fail('订单不存在，可能已被删除')
      if (state.orders[idx].status === POSTED) fail('订单已过账，请先撤销过账再修改')
      if (state.orders[idx].status === VOIDED_ORDER) fail('订单已作废，不能再修改；请新建一张')
      const kept = state.orders[idx]
      state.orders[idx] = { ...kept, ...draft, status: DRAFT, postedOrderId: '', updatedAt: now }
      return { state, code: draft.id }
    }
    const id = genOrderId('D', state.orders, draft.date)
    state.orders.push({ ...draft, id, status: DRAFT, deposits: [], createdAt: now, updatedAt: now })
    return { state, code: id }
  }

  // 轻量补备注：只改 remark 一个字段，已过账的订单也能补（不碰金额、明细与凭证）。
  // 与销售/采购详情页的备注入口同一口径：清空内容即删除备注。
  if (action === 'remark') {
    const order = find(input.orderId)
    if (!order) fail('订单不存在')
    if (order.status === VOIDED_ORDER) fail('订单已作废，不能再补备注')
    const remark = String(input.remark ?? '').trim()
    if (remark.length > 500) fail('备注最多 500 字')
    order.remark = remark
    order.updatedAt = now
    return { state, code: order.id }
  }

  if (action === 'deposit') {
    const order = find(input.orderId)
    if (!order) fail('订单不存在')
    if (order.status === POSTED) fail('订单已过账，请到该单据里「记录收款」')
    if (order.status === VOIDED_ORDER) fail('订单已作废，不能再收订金')
    const amount = round2(Number(input.amount || 0))
    if (!(amount > 0)) fail('订金金额必须大于 0')
    const { partyKey, voucherFile, voucherPrefix, orderType } = orderKeys(order.kind)
    const date = input.date || todayCN()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('日期格式应为 YYYY-MM-DD')
    state[voucherFile] = (state[voucherFile] || []).slice()
    const code = genVoucherCode(voucherPrefix, date, state[voucherFile].map(v => ({ code: v.code })))
    state[voucherFile].push({
      code, kind: orderType === 'sale' ? 'receivable' : 'payable', category: 'deposit',
      party: order[partyKey], date, remark: String(input.remark || '订单订金'),
      total: amount, items: [{ orderId: order.id, orderType: 'order', amount, note: '订单订金' }], createdAt: now
    })
    order.deposits = [...(order.deposits || []), { date, amount, remark: String(input.remark || '订单订金'), time: now, voucher: code }]
    order.updatedAt = now
    return { state, code }
  }

  if (action === 'post') {
    const order = find(input.orderId)
    if (!order) fail('订单不存在')
    if (order.status === POSTED) return { state, code: order.postedOrderId, posted: true, duplicate: true }
    if (order.status === VOIDED_ORDER) fail('订单已作废，不能过账')
    const errors = validateOrder(order, { items: state.items })
    if (errors.length) fail(errors[0])
    const { listKey, docPrefix } = orderKeys(order.kind)
    const list = (state[listKey] || []).slice()
    let doc = orderToOrderDoc(order, genOrderId(docPrefix, list, order.date), now)
    // 过账方式：settle＝结清（差额记为本次实际收付并开资金单据）；默认 credit＝挂账（只生成正式单据）
    if (input.settleMode === 'settle') doc = settlePostedDoc(state, doc, order.kind, now)
    list.push(doc)
    state[listKey] = list
    state.orders = state.orders.map(o => o.id === order.id
      ? { ...o, status: POSTED, postedOrderId: doc.id, postedAt: now, updatedAt: now } : o)
    return { state, code: doc.id, orderId: order.id, settleMode: input.settleMode === 'settle' ? 'settle' : 'credit' }
  }

  // 批量过账：勾选多张订单后一次事务提交，避免 N 次 git 提交。
  // 已过账的跳过（skipped 报数）；任一张校验不过就整体失败，不做「一半成功」。
  if (action === 'postMany') {
    const ids = Array.isArray(input.orderIds)
      ? [...new Set(input.orderIds.map(v => String(v || '').trim()).filter(Boolean))]
      : []
    if (!ids.length) fail('请选择要过账的订单')
    if (ids.length > 500) fail('一次最多过账 500 张订单')
    const settleMode = input.settleMode === 'settle' ? 'settle' : 'credit'
    const codes = []
    let skipped = 0
    for (const id of ids) {
      const idx = state.orders.findIndex(o => o.id === id)
      if (idx < 0 || state.orders[idx].status === POSTED || state.orders[idx].status === VOIDED_ORDER) { skipped++; continue }
      const order = state.orders[idx]
      const errors = validateOrder(order, { items: state.items })
      if (errors.length) fail(`订单 ${id}：${errors[0]}`)
      const { listKey, docPrefix } = orderKeys(order.kind)
      const list = (state[listKey] || []).slice()
      let doc = orderToOrderDoc(order, genOrderId(docPrefix, list, order.date), now)
      if (settleMode === 'settle') doc = settlePostedDoc(state, doc, order.kind, now)
      list.push(doc)
      state[listKey] = list
      state.orders[idx] = { ...order, status: POSTED, postedOrderId: doc.id, postedAt: now, updatedAt: now }
      codes.push(doc.id)
    }
    if (!codes.length) fail('勾选的订单都已过账或已作废，无需再过账')
    return { state, code: codes[0], posted: codes.length, skipped, settleMode }
  }

  if (action === 'unpost') {
    const order = find(input.orderId)
    if (!order) fail('订单不存在')
    if (order.status === VOIDED_ORDER) fail('订单已作废，无需撤销过账')
    if (order.status !== POSTED) fail('订单还没过账，无需撤销')
    const { listKey } = orderKeys(order.kind)
    const list = (state[listKey] || []).slice()
    const doc = list.find(o => o.id === order.postedOrderId)
    // 单据已经被删掉（例如「清空数据」）：没有东西可撤，直接把状态退回草稿。
    // 不这样处理的话这张订单永远卡住：撤销报「单据不存在」，删除又要求先撤销。
    if (!doc) {
      state.orders = state.orders.map(o => o.id === order.id
        ? { ...o, status: DRAFT, postedOrderId: '', postedAt: '', updatedAt: now } : o)
      return { state, code: order.id, removedDocId: '' }
    }
    const gate = canUnpost(doc, list)
    if (!gate.ok) fail(gate.reason)
    state[listKey] = list.filter(o => o.id !== order.postedOrderId)
    state.orders = state.orders.map(o => o.id === order.id
      ? { ...o, status: DRAFT, postedOrderId: '', postedAt: '', updatedAt: now } : o)
    return { state, code: order.id, removedDocId: order.postedOrderId }
  }

  // 作废订单（原「删除」）：2026-11-01 起不再硬删。
  // 硬删的代价是「这张单去哪了」永远说不清——订金凭证、打印件、聊天记录都可能还指着它。
  // 作废保留全部字段，只加状态与时间/原因，之后所有写入口都拒绝它（过账、改单、收订金、补备注）。
  if (action === 'delete' || action === 'void') {
    const order = find(input.orderId)
    if (!order) fail('订单不存在')
    if (order.status === VOIDED_ORDER) return { state, code: order.id, duplicate: true }
    if (order.status === POSTED) {
      // 已过账的订单连着正式单据：必须先在单据侧撤销过账，订单才回得到草稿，
      // 否则作废订单会让那张正式单据失去来源（对账时无法解释）。
      // 例外：单据已经被「清空数据」整库清掉，此时原地作废即可，否则它会永远卡在列表里。
      const { listKey } = orderKeys(order.kind)
      const exists = (state[listKey] || []).some(o => o.id === order.postedOrderId)
      if (exists) fail('已过账的订单请先撤销过账')
    }
    // 收过订金的订单：把订金凭证一并作废（钱退回对方），而不是拦着不让作废。
    // 以前这里直接报错，结果是一张「收了订金又想取消」的订单永远卡在列表里，
    // 只能去收付款单里手工作废凭证、再回来删订单——两步都容易漏。
    const dep = voidOrderDeposits(state, order, now)
    state = dep.state
    const idx = state.orders.findIndex(o => o.id === order.id)
    state.orders[idx] = {
      ...order,
      status: VOIDED_ORDER,
      voidedAt: now,
      voidedReason: String(input.reason || '作废订单').trim().slice(0, 200)
    }
    return { state, code: order.id, voided: true, vouchers: dep.vouchers }
  }

  // 批量删除：勾选多张订单后一次提交，只写一次 orders.json。
  // 判据与单张删除完全一致：已过账且单据还在、或已收过订金的，跳过后在 skipped 里报数，
  // 不让批量入口绕过单张删除的两条硬约束。全部都不允许删时直接报错，避免「点了没反应」。
  if (action === 'deleteMany') {
    const ids = Array.isArray(input.orderIds)
      ? [...new Set(input.orderIds.map(v => String(v || '').trim()).filter(Boolean))]
      : []
    if (!ids.length) fail('请选择要删除的订单')
    if (ids.length > 500) fail('一次最多删除 500 张订单')
    const removable = []
    let skipped = 0
    for (const id of ids) {
      const order = find(id)
      if (!order || order.status === VOIDED_ORDER) { skipped++; continue }
      if (order.status === POSTED) {
        const { listKey } = orderKeys(order.kind)
        const exists = (state[listKey] || []).some(o => o.id === order.postedOrderId)
        if (exists) { skipped++; continue }
      }
      // 收过订金的也允许作废：订金凭证会跟着一起作废（见 voidOrderDeposits）
      removable.push(id)
    }
    if (!removable.length) fail('勾选的订单都不能作废：已过账的需先撤销过账')
    const drop = new Set(removable)
    const vouchers = []
    for (const id of removable) {
      const o = state.orders.find(x => x.id === id)
      const dep = voidOrderDeposits(state, o, now)
      state = dep.state
      vouchers.push(...dep.vouchers)
    }
    state.orders = state.orders.map(o => drop.has(o.id)
      ? { ...o, status: VOIDED_ORDER, voidedAt: now, voidedReason: String(input.reason || '作废订单').trim().slice(0, 200) }
      : o)
    return { state, code: '', removed: removable.length, skipped, vouchers }
  }

  // 清空草稿：一次请求删掉全部「纯草稿」，避免几十张草稿各发一次请求、各写一次 git 提交。
  // 两条不删的硬约束与单张删除完全一致，不能让批量入口绕过它们：
  //   ① 已过账的要先撤销过账（它连着一条正式单据）；
  //   ② 收过订金的不删（订金凭证已经开了，删了订单凭证就成孤儿）。
  // 清空未过账订单：与单张作废同一口径——置「已作废」而不是从文件里抹掉。
  // 按钮上显示的 N 仍然是「这次会作废掉的张数」，用户看到的行为不变，但记录留得住。
  if (action === 'clearDrafts') {
    const droppable = o => isUnposted(o.status) && orderDepositSum(o) === 0
    let removed = 0
    // skipped 必须在改写前算：改写后草稿已变成「已作废」，再按 droppable 数会把它们算进 skipped
    const skipped = state.orders.filter(o => !droppable(o)).length
    state.orders = state.orders.map(o => {
      if (!droppable(o)) return o
      removed += 1
      return { ...o, status: VOIDED_ORDER, voidedAt: now, voidedReason: String(input.reason || '清空未过账订单').slice(0, 200) }
    })
    return { state, code: '', removed, skipped }
  }

  fail('不支持的订单操作')
}
