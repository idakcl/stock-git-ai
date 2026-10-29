import { grossOf, netOf, ensurePayments, syncPayments, round2, depositSumOf } from './account.js'
import { genVoucherCode } from './voucher.js'

export const isReturn = o => Number(o?.total) < 0 || ['sale-return', 'purchase-return'].includes(o?.type)
const fail = message => { const error = new Error(message); error.status = 400; throw error }
const cents = n => Math.round(Number(n) * 100)
const byDate = (a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id)

// 原单整单折扣/抹零按行净额比例分配，最后一行吸收分差。
export function returnableLines(source, orders) {
  const totalWeight = source.items.reduce((s, l) => s + Math.max(0, Number(l.total)), 0)
  let allocated = 0, cumulativeWeight = 0
  return source.items.map((l, index) => {
    cumulativeWeight += Math.max(0, Number(l.total))
    const nextAllocated = index === source.items.length - 1 ? cents(grossOf(source))
      : Math.round(cents(grossOf(source)) * cumulativeWeight / (totalWeight || 1))
    const lineNet = nextAllocated - allocated
    allocated = nextAllocated
    const prior = orders.filter(o => isReturn(o) && o.sourceOrderId === source.id)
      .flatMap(o => o.items || []).filter(r => r.sourceLine === index)
    const returnedQty = prior.reduce((s, r) => s - Number(r.qty), 0)
    const returnedMoney = prior.reduce((s, r) => s - cents(r.total), 0)
    return { ...l, index, lineNet: lineNet / 100, returnedQty,
      available: Math.max(0, Number(l.qty) - returnedQty), remainingMoney: (lineNet - returnedMoney) / 100 }
  })
}

// 所有金额与可退量在服务端快照上重新计算；前端提交的金额不作为单据价格来源。
export function applyRefundOperation(snapshot, input, now = new Date().toISOString()) {
  const state = structuredClone(snapshot)
  if (!['sale', 'purchase'].includes(input.kind)) fail('请选择销售或采购')
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || '')) fail('缺少有效请求标识')
  const mode = input.mode || 'cash'
  if (!['cash', 'offset', 'deposit', 'pending'].includes(mode)) fail('退款方式无效')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '') || Number.isNaN(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0, 10) !== input.date) fail('日期无效')
  const key = input.kind === 'sale' ? 'sales' : 'purchases'
  const partyKey = input.kind === 'sale' ? 'customer' : 'supplier'
  const kind = input.kind === 'sale' ? 'receivable' : 'payable'
  const field = input.kind === 'sale' ? 'received' : 'paid'
  const orders = state[key]
  const previous = state.refunds.find(v => v.requestId === input.requestId) || orders.find(o => o.requestId === input.requestId)
  if (previous) return { state, duplicate: true, code: previous.code || previous.id }
  let returns
  if (input.action === 'create') {
    const source = orders.find(o => o.id === input.sourceOrderId)
    if (!source || isReturn(source)) fail('原单不存在或不是正常单据')
    if (!String(input.reason || '').trim()) fail('请填写退货原因')
    if (!Array.isArray(input.lines) || !input.lines.length) fail('请选择退货商品')
    const candidates = returnableLines(source, orders)
    const seen = new Set()
    const lines = input.lines.map(l => {
      if (!Number.isInteger(l.index) || seen.has(l.index)) fail('退货行重复或无效')
      seen.add(l.index)
      const row = candidates[l.index]
      const qty = Number(l.qty)
      if (!row || !Number.isFinite(qty) || qty <= 0 || qty > row.available + 1e-8) fail('退货数量超过剩余可退数量')
      const value = Math.abs(qty - row.available) < 1e-8 ? row.remainingMoney : round2(row.lineNet * qty / Number(row.qty))
      if (value < 0 || value > row.remainingMoney + 0.005) fail('退货金额超过原单剩余金额')
      return { code: row.code, name: row.name, unit: row.unit || '', sourceLine: l.index,
        qty: -qty, price: Number(row.price), total: -value }
    })
    const total = round2(lines.reduce((s, l) => s + l.total, 0))
    const id = genVoucherCode(input.kind === 'sale' ? 'XT' : 'CT', input.date, orders.map(o => ({ code: o.id })), 4)
    const entry = { id, type: `${input.kind}-return`, sourceOrderId: source.id, no: source.no || '',
      [partyKey]: source[partyKey], date: input.date, items: lines, total, discount: 0,
      returnReason: String(input.reason).trim(), refundMode: mode, remark: String(input.remark || ''),
      payments: [], [field]: 0, settle: total === 0 ? '结清' : '挂账', requestId: input.requestId, createdAt: now }
    orders.push(entry)
    returns = [entry]
  } else if (input.action === 'settle') {
    if (!Array.isArray(input.orderIds) || !input.orderIds.length || new Set(input.orderIds).size !== input.orderIds.length) fail('请选择不重复的退货单')
    returns = input.orderIds.map(id => orders.find(o => o.id === id))
    if (returns.some(o => !o || !isReturn(o))) fail('退货单不存在')
  } else fail('不支持的操作')
  if (new Set(returns.map(o => o[partyKey])).size !== 1) fail('一次退款只能处理同一往来单位')
  if (mode === 'pending' || returns.every(o => netOf(o, kind) === 0)) {
    if (input.action !== 'create') fail('没有待退金额')
    return { state, code: returns[0].id }
  }
  const available = round2(returns.reduce((s, o) => s + Math.max(0, -netOf(o, kind)), 0))
  let amount = input.action === 'create' ? available : Number(input.amount)
  if (!Number.isFinite(amount) || cents(amount) <= 0 || Math.abs(amount - round2(amount)) > 1e-8 || amount > available + 0.005) fail('退款金额应大于零且不超过待退金额（最多两位小数）')
  const party = returns[0][partyKey]
  const code = genVoucherCode(mode === 'cash' ? 'TK' : 'HX', input.date, state.refunds)
  const voucher = { code, requestId: input.requestId, kind: 'refund', category: mode === 'cash' ? 'refund' : mode === 'offset' ? 'return-offset' : 'return-deposit',
    direction: input.kind === 'sale' ? 'to_customer' : 'from_supplier', party, date: input.date,
    total: mode === 'cash' ? amount : 0, settlementTotal: amount, remark: String(input.remark || ''), items: [], createdAt: now }
  const settle = (o, value, targetOrderId) => {
    o.settlements = [...(o.settlements || []), { date: input.date, amount: value, voucher: code, mode, targetOrderId, time: now }]
  }
  if (mode === 'offset') {
    const targets = orders.filter(o => !isReturn(o) && o[partyKey] === party && netOf(o, kind) > 0).sort(byDate)
    const due = round2(targets.reduce((s, o) => s + netOf(o, kind), 0))
    if (amount > due + 0.005) fail('可抵欠款不足，请减少抵扣金额；余款可退现金或转预存')
    let left = amount
    for (const target of targets) {
      const value = Math.min(left, netOf(target, kind))
      if (value <= 0) continue
      settle(target, value, '')
      Object.assign(target, syncPayments(target, kind))
      voucher.items.push({ orderId: target.id, orderType: input.kind, amount: value, role: 'offset-target', settle: target.settle === '结清' })
      left = round2(left - value)
    }
  }
  if (mode === 'deposit') {
    const parties = state[input.kind === 'sale' ? 'customers' : 'suppliers']
    const entity = parties.find(p => p.name === party)
    if (!entity) fail('往来单位档案不存在')
    const deposits = input.kind === 'sale' ? 'deposits' : 'advances'
    entity[deposits] = [...(entity[deposits] || []), { date: input.date, amount, voucher: code, time: now, remark: '退货款转余额' }]
    if (!Number.isFinite(depositSumOf(entity[deposits]))) fail('余额数据无效')
  }
  let left = amount
  for (const o of returns.sort(byDate)) {
    const value = round2(Math.min(left, Math.max(0, -netOf(o, kind))))
    if (value <= 0) continue
    if (mode === 'cash') o.payments = [...ensurePayments(o, field), { date: input.date, amount: -value, voucher: code, remark: voucher.remark || '现金退款', time: now }]
    else settle(o, -value, '')
    Object.assign(o, syncPayments(o, kind))
    voucher.items.push({ orderId: o.id, orderType: input.kind, amount: value, role: 'return', settle: o.settle === '结清' })
    left = round2(left - value)
  }
  state.refunds.push(voucher)
  return { state, code, returnId: returns[0].id }
}

export function backfillHistoricalRefunds(snapshot) {
  const state = structuredClone(snapshot)
  const codes = []
  for (const id of ['CT-20260519-0001', 'CT-20260519-0002']) {
    const order = state.purchases.find(o => o.id === id)
    if (!order || Number(order.paid) >= 0) fail(`历史退货单 ${id} 缺失或金额异常`)
    const payments = ensurePayments(order, 'paid')
    if (cents(payments.reduce((s, p) => s + p.amount, 0)) !== cents(order.paid)) fail('历史流水与实付不符')
    for (const p of payments) {
      if (p.amount >= 0) continue
      if (p.voucher) {
        if (!state.refunds.some(v => v.code === p.voucher)) fail('历史退款凭证引用缺失')
        continue
      }
      const code = genVoucherCode('TK', p.date || order.date, state.refunds)
      state.refunds.push({ code, kind: 'refund', category: 'refund', direction: 'from_supplier', party: order.supplier,
        date: p.date || order.date, total: -p.amount, settlementTotal: -p.amount, remark: '历史采购退货退款补凭证',
        items: [{ orderId: id, orderType: 'purchase', amount: -p.amount, role: 'return', settle: order.settle === '结清' }] })
      p.voucher = code
      codes.push(code)
    }
    order.payments = payments
  }
  return { state, codes }
}
