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

// 销售单累计实收 / 采购单累计实付（兼容旧字段）
export function receivedSumOf(sale) {
  return sum(ensurePayments(sale, 'received'))
}
export function paidSumOf(purchase) {
  return sum(ensurePayments(purchase, 'paid'))
}

// 两位小数四舍五入：消除 5×1.91=9.549999… 这类浮点残留（金额统一 2 位）
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
// 比率保留 4 位小数（0.01% 粒度）：避免长串小数，也保证换算后金额分文不差
export const round4 = (v) => Math.round((Number(v) + Number.EPSILON) * 10000) / 10000

// 单据最终应收/应付金额（合计 × 整单折扣率 − 整单优惠金额）
// discountRate：整单折扣率，1＝不打折；缺失/非法/≤0 一律按 1 处理，保证旧单据与未设折扣的单据口径不变
export function grossOf(order) {
  const total = Number(order?.total || 0)
  const rate = Number(order?.discountRate)
  const effective = Number.isFinite(rate) && rate > 0 ? rate : 1
  return Math.max(0, round2(total * effective) - Number(order?.discount || 0))
}

export function receivableOf(sale) {
  return Math.max(0, grossOf(sale) - receivedSumOf(sale))
}

export function payableOf(purchase) {
  return Math.max(0, grossOf(purchase) - paidSumOf(purchase))
}

// kind: 'receivable'(销售单) | 'payable'(采购单)
export function netOf(order, kind) {
  return kind === 'payable' ? payableOf(order) : receivableOf(order)
}

// 展示层结清判定：库内 settle 已标记「结清」，或按口径算出的未收/未付金额为 0
//（容忍 1e-6 浮点尘，与 syncPayments 的结清口径一致）
// unpaid：receivableOf/payableOf 的结果，或来往账等展示行里的未结金额
// 用途：列表/详情/来往账无需打开编辑弹窗，金额收清即显示结清
export function isSettledOf(unpaid, settle) {
  if ((settle || '挂账') === '结清') return true
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
