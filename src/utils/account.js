// 统一账务规则（全站唯一欠款计算入口）
// 规则：欠款按「金额」计算，结算状态(settle)仅用于显示与校验，不参与欠款金额计算。
//   销售单未结 = max(0, 合计 − 优惠 − 实收)   → 客户应收
//   采购单未结 = max(0, 合计 − 优惠 − 实付)   → 供应商应付
// 优惠(discount)是独立字段，不得用「合计 − 实收/实付」反推。

export function receivableOf(sale) {
  const total = Number(sale?.total || 0)
  const discount = Number(sale?.discount || 0)
  const received = sale?.received != null ? Number(sale.received) : 0
  return Math.max(0, total - discount - received)
}

export function payableOf(purchase) {
  const total = Number(purchase?.total || 0)
  const discount = Number(purchase?.discount || 0)
  const paid = purchase?.paid != null ? Number(purchase.paid) : 0
  return Math.max(0, total - discount - paid)
}

// kind: 'receivable'(销售单) | 'payable'(采购单)
export function netOf(order, kind) {
  return kind === 'payable' ? payableOf(order) : receivableOf(order)
}

// 单据最终应收/应付金额（合计 − 优惠）
export function grossOf(order) {
  return Math.max(0, Number(order?.total || 0) - Number(order?.discount || 0))
}
