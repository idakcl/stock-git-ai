// 统一账务规则（全站唯一欠款/收付款计算入口）
// 支持一单多笔收付款：单据内嵌 payments: [{ date, amount, remark, time }]
//   销售单 payments = 收款流水；采购单 payments = 付款流水
// 兼容旧数据：无 payments 数组时，received / paid 字段视为整单单笔收付金额
// 优惠(discount)是独立字段，不得用「合计 − 实收/实付」反推。
// 欠款只看金额：未收/未付 = max(0, 应收/应付 − 累计实收/实付)，与结算状态(settle)解耦。

function sum(list) {
  return (list || []).reduce((s, p) => s + Number(p.amount || 0), 0)
}

function sortPayments(list) {
  return list.slice().sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')) ||
    String(a.time || '').localeCompare(String(b.time || '')))
}

// 收付款流水（兼容旧字段）：旧单无 payments 数组时，把 received/paid 转成一笔「历史收付」
// 注意：payments 数组一旦存在（即使为空）即为权威数据，不再回退旧字段
export function ensurePayments(order, field) {
  if (order && Array.isArray(order.payments)) return sortPayments(order.payments.map(p => ({ ...p })))
  const legacy = order ? order[field] : null
  if (legacy != null && Number(legacy) > 0) {
    return [{ date: (order && order.date) || '', amount: Number(legacy), remark: '历史收付', time: '' }]
  }
  return []
}

// 销售单累计实收 / 采购单累计实付（兼容旧字段；末位 round2 消除累加浮点尘）
export function receivedSumOf(sale) {
  return round2(sum(ensurePayments(sale, 'received')))
}
export function paidSumOf(purchase) {
  return round2(sum(ensurePayments(purchase, 'paid')))
}

// 两位小数四舍五入：消除 5×1.91=9.549999… 这类浮点残留（金额统一 2 位）
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
// 比率保留 4 位小数（0.01% 粒度）：避免长串小数，也保证换算后金额分文不差
export const round4 = (v) => Math.round((Number(v) + Number.EPSILON) * 10000) / 10000

// ---- 整单折扣：支持「多级折扣链」 ----
// 数据结构：优先用数组 discountRates（如 [0.9, 0.9, 0.8] 表示先打9折、再打9折、再打8折），
// 回退旧标量 discountRate（单级折扣）。无折扣 / 缺失 / 非法一律按 1 处理。
// 兼容旧单据：早期数据只有标量 discountRate，仍按单级折扣生效，不会丢折扣。
// 数组元素必须是 (0,1] 区间的数值；越界或非法一律剔除，避免脏数据污染乘积。

// 规范化折扣链：返回干净的数值数组（剔除非法项）。旧标量 discountRate 视为单级链。
export function discountRatesOf(order) {
  const rates = order?.discountRates
  if (Array.isArray(rates) && rates.length) {
    const valid = rates.map(Number).filter(r => Number.isFinite(r) && r > 0 && r <= 1)
    return valid
  }
  const r = Number(order?.discountRate)
  if (Number.isFinite(r) && r > 0 && r <= 1) return [r]
  return []
}

// 整单等效折扣率：折扣链连乘；无折扣返回 1。1＝不打折。
export function effectiveRateOf(order) {
  const rates = discountRatesOf(order)
  if (!rates.length) return 1
  return rates.reduce((a, b) => a * b, 1)
}

// 折扣链展示文本：单级 "×0.90"；多级 "×0.90 ×0.90 ×0.80 = ×0.65"（含等效）；
// 无折扣返回空串（调用方据此决定是否展示该字段）。
export function discountRatesTextOf(order) {
  const rates = discountRatesOf(order)
  if (!rates.length) return ''
  const parts = rates.map(r => `×${round4(r).toFixed(2)}`)
  if (rates.length === 1) return parts[0]
  return `${parts.join(' ')} = ×${round2(effectiveRateOf(order)).toFixed(2)}`
}

// 单据最终应收/应付金额（合计 × 整单等效折扣率 − 整单优惠金额）
// 整单折扣率既支持多级折扣链 discountRates，也兼容旧单标量 discountRate（见 discountRatesOf）。
// 缺失/非法/≤0 一律按 1 处理，保证旧单据与未设折扣的单据口径不变
// 末位 round2：total×rate 与 discount 相减会产生 1e-15 级浮点尘（如 9.55−4.55=5.000000000000001），
// 不收敛会让未收=尘>0，统计卡误判「有未结清」、 badge 多数一笔
export function grossOf(order) {
  const total = Number(order?.total || 0)
  const rate = effectiveRateOf(order)
  return round2(Math.max(0, round2(total * rate) - Number(order?.discount || 0)))
}

export function receivableOf(sale) {
  return Math.max(0, round2(grossOf(sale) - receivedSumOf(sale)))
}

export function payableOf(purchase) {
  return Math.max(0, round2(grossOf(purchase) - paidSumOf(purchase)))
}

// kind: 'receivable'(销售单) | 'payable'(采购单)
export function netOf(order, kind) {
  return kind === 'payable' ? payableOf(order) : receivableOf(order)
}

// 展示层结清判定：以金额为准——未收/未付 ≤ 1e-6（浮点尘容忍，与 syncPayments 口径一致）即结清。
// 不再让库内 settle 标签短路判定：脏数据（标了结清但钱没收回）必须暴露为挂账，
// 否则会出现「未付合计 > 0 却显示 0 单未结清」的自相矛盾（B202610251227400005 事故：
// 该单 payments 空数组 + 旧 paid 字段导致实收漏算，settle 短路把 1830.25 幽灵欠款藏成了结清）。
// 正常路径下点「结清」时差额已记入抹零优惠、金额归 0，标签与金额天然一致，无需再看标签。
// settle 参数保留仅为兼容既有调用签名，不参与判定
export function isSettledOf(unpaid, settle) {
  return Number(unpaid || 0) <= 1e-6
}

// 累计收付字段名：销售单 received / 采购单 paid
export function sumFieldOf(kind) {
  return kind === 'payable' ? 'paid' : 'received'
}

// 写回收付款流水：同步汇总字段(received/paid)，并按金额自动同步结算状态
// settle 判定容忍浮点尘（1e-6 远小于 1 分钱）：实收合计因累加误差比应收少一丝尘时仍应判结清
export function syncPayments(order, kind) {
  const field = sumFieldOf(kind)
  const payments = ensurePayments(order, field)
  const total = sum(payments)
  return {
    ...order,
    payments,
    [field]: total,
    settle: total >= grossOf(order) - 1e-6 ? '结清' : '挂账'
  }
}

// 追加一笔收付款（date: 'YYYY-MM-DD', amount, remark）
export function appendPayment(order, kind, payment) {
  const field = sumFieldOf(kind)
  const payments = ensurePayments(order, field)
  payments.push({
    date: payment?.date || order?.date || '',
    amount: Number(payment?.amount || 0),
    remark: payment?.remark || '',
    time: new Date().toISOString()
  })
  return syncPayments({ ...order, payments }, kind)
}

// 删除一笔收付款（index 为 payments 数组下标）
export function removePayment(order, kind, index) {
  const field = sumFieldOf(kind)
  const payments = ensurePayments(order, field)
  payments.splice(index, 1)
  return syncPayments({ ...order, payments }, kind)
}

// 客户预存款 / 供应商预付款流水合计
// 流水存于对应档案：customer.deposits / supplier.advances = [{ date, amount, remark, time }]
export function depositSumOf(list) {
  return (list || []).reduce((s, d) => s + Number(d?.amount || 0), 0)
}
