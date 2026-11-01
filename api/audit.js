// 对账体检：只读检查，不改任何数据。
//
// 目的：把「能算出来但没人看」的矛盾一次性挑出来——单头与明细对不上、实收与流水对不上、
// 标了结清却还欠钱、资金凭证指向已不存在的单据、退货金额超过原单……
// 发现问题只报告，不自动修：修复动作（重新保存单据 / 改结清 / 补录流水）必须由人确认。
import {
  isVoided, grossOf, receivableOf, payableOf, receivedSumOf, paidSumOf, round2
} from '../src/utils/account.js'

const TOL = 0.01
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const money = (v) => round2(num(v)).toFixed(2)

const isReturnOf = (o) => Number(o?.total) < 0 || ['sale-return', 'purchase-return'].includes(o?.type)

function indexById(list) {
  const m = new Map()
  for (const x of (list || [])) if (x && x.id != null) m.set(String(x.id), x)
  return m
}

// 单头合计与逐行金额之和。行的 total 已含行折扣（折后金额），单头 total 就是各行之和，
// 所以口径是 Σ lines[].total，而不是 Σ qty×price（用后者会把有行折扣的单全部误报）。
// 历史数据里存在 old 系统按行四舍五入留下的 ≤0.5 元尾差，这类只报「提示」，不报错误。
function totalMismatch(o) {
  const lines = Array.isArray(o.items) ? o.items : []
  if (!lines.length) return num(o.total) !== 0 ? num(o.total) : 0
  const sum = round2(lines.reduce((s, l) => s + num(l.total), 0))
  return round2(num(o.total) - sum)
}

/**
 * @param {{purchases?:Array, sales?:Array, receipts?:Array, paymentVouchers?:Array, refunds?:Array}} state
 * @returns {{items:Array, counts:{error:number,warn:number,info:number}, checkedAt:string}}
 */
export function auditState(state) {
  const purchases = state.purchases || []
  const sales = state.sales || []
  const receipts = state.receipts || []
  const paymentVouchers = state.paymentVouchers || []
  const refunds = state.refunds || []
  const items = []
  const push = (level, code, title, detail, kind = '', id = '') => {
    items.push({ level, code, title, detail, kind, id: String(id || '') })
  }

  const saleById = indexById(sales)
  const purchaseById = indexById(purchases)
  const allDocs = [...sales.map(o => ['sale', o, saleById]), ...purchases.map(o => ['purchase', o, purchaseById])]

  // 1) 单头合计与明细  2) 实收/实付字段与流水  3) 结算状态与余额
  for (const [kind, o] of allDocs) {
    if (!o || typeof o !== 'object') continue
    const id = String(o.id || '')
    if (!id) {
      push('error', 'doc-no-id', '单据缺少单号', `${kind === 'sale' ? '销售单' : '采购单'}存在没有 id 的记录，无法对账定位`, kind, '')
      continue
    }
    if (isVoided(o)) continue

    const diff = totalMismatch(o)
    if (Math.abs(diff) > 1) {
      push('error', 'total-mismatch', '单头金额与明细对不上',
        `单头合计 ¥${money(o.total)}，明细逐行合计 ¥${money(num(o.total) - diff)}，相差 ¥${money(diff)}`, kind, id)
    } else if (Math.abs(diff) > TOL) {
      // 1 元以内：历史导入按行四舍五入的尾差，只提示，不当作错账
      push('info', 'total-rounding', '单头与明细有舍入尾差',
        `单头合计 ¥${money(o.total)}，明细合计 ¥${money(num(o.total) - diff)}，相差 ¥${money(diff)}（历史舍入，可忽略）`, kind, id)
    }

    const field = kind === 'sale' ? 'received' : 'paid'
    if (Array.isArray(o.payments)) {
      const flow = kind === 'sale' ? receivedSumOf(o) : paidSumOf(o)
      const stored = round2(num(o[field]))
      if (Math.abs(stored - flow) > TOL) {
        push('error', 'payments-mismatch', `${kind === 'sale' ? '实收' : '实付'}字段与流水合计不符`,
          `${field} = ¥${money(stored)}，流水合计 ¥${money(flow)}，相差 ¥${money(stored - flow)}`, kind, id)
      }
    }

    const unpaid = kind === 'sale' ? receivableOf(o) : payableOf(o)
    const settle = String(o.settle || '')
    if (settle === '结清' && unpaid > TOL) {
      push('error', 'settle-contradiction', '标了结清但仍有未收/未付',
        `状态「结清」，实际${kind === 'sale' ? '未收' : '未付'} ¥${money(unpaid)}（应收/应付 ¥${money(grossOf(o))}）`, kind, id)
    }
    if (settle === '挂账' && Math.abs(unpaid) <= 1e-6 && num(o.discount) === 0) {
      push('info', 'settle-flat', '金额已平但仍标挂账',
        '未收/未付为 0，也没有抹零优惠；可点「改结清」把状态归位（不改任何金额）', kind, id)
    }
  }

  // 4) 资金凭证引用的单据必须存在；凭证金额合计必须等于 items 分摊合计
  const voucherSets = [
    ['receipt', receipts, '收款单'],
    ['payment-voucher', paymentVouchers, '付款单'],
    ['refund', refunds, '退款单']
  ]
  for (const [vKind, list, label] of voucherSets) {
    for (const v of (list || [])) {
      if (!v || typeof v !== 'object') continue
      const code = String(v.code || '')
      if (!code) {
        push('error', 'voucher-no-code', `${label}缺少编号`, '资金凭证没有 code，无法与流水对应', vKind, '')
        continue
      }
      if (isVoided(v)) continue
      const rows = Array.isArray(v.items) ? v.items : []
      const sum = round2(rows.reduce((s, it) => s + num(it.amount), 0))
      if (Math.abs(sum - num(v.total)) > TOL) {
        push('warn', 'voucher-total-mismatch', `${label}金额与分录不符`,
          `凭证 ¥${money(v.total)}，分录合计 ¥${money(sum)}，相差 ¥${money(num(v.total) - sum)}`, vKind, code)
      }
      for (const it of rows) {
        const oid = String(it.orderId || '')
        if (!oid) continue
        const type = it.orderType || (vKind === 'receipt' ? 'sale' : 'purchase')
        const target = type === 'sale' ? saleById : purchaseById
        if (!target.has(oid)) {
          push('error', 'voucher-orphan', `${label}指向已不存在的单据`,
            `凭证 ${code} 的分录引用了 ${oid}，但该单已不在${type === 'sale' ? '销售' : '采购'}集合里`, vKind, code)
        }
      }
    }
  }

  // 5) 退货单：必须能追到原单，且退货金额不得超过原单金额
  for (const [kind, o] of allDocs) {
    if (!isReturnOf(o) || isVoided(o)) continue
    const id = String(o.id || '')
    const srcId = String(o.sourceOrderId || '')
    if (!srcId) {
      push('warn', 'return-no-source', '退货单没有关联原单',
        `退货单 ${id} 缺少 sourceOrderId，无法核对可退额度`, kind, id)
      continue
    }
    const src = (kind === 'sale' ? saleById : purchaseById).get(srcId)
    if (!src) {
      push('error', 'return-orphan', '退货单的原单不存在',
        `退货单 ${id} 指向 ${srcId}，但原单已不在${kind === 'sale' ? '销售' : '采购'}集合里`, kind, id)
      continue
    }
    if (Math.abs(num(o.total)) > Math.abs(grossOf(src)) + TOL) {
      push('error', 'return-over', '退货金额超过原单金额',
        `退货单 ${id} 金额 ¥${money(Math.abs(num(o.total)))}，原单 ${srcId} 金额 ¥${money(Math.abs(grossOf(src)))}`, kind, id)
    }
  }

  // 6) 普通单据出现负数收付款流水（退款应走退货单 + TK-/HX- 凭证）
  for (const [kind, o] of allDocs) {
    if (!o || isVoided(o) || isReturnOf(o) || !Array.isArray(o.payments)) continue
    const neg = o.payments.filter(p => num(p.amount) < 0)
    if (!neg.length) continue
    push('warn', 'negative-payment', '普通单据里有负数收付款',
      `单据 ${o.id} 有 ${neg.length} 笔负数流水（合计 ¥${money(neg.reduce((s, p) => s + num(p.amount), 0))}）；退款应通过退货单生成 TK-/HX- 凭证`,
      kind, String(o.id || ''))
  }

  // 7) 单号重复（同一集合内出现两次，读写会互相覆盖）
  const seen = new Map()
  for (const [kind, o] of allDocs) {
    const id = String(o?.id || '')
    if (!id) continue
    const key = `${kind}:${id}`
    if (seen.has(key)) {
      push('error', 'duplicate-id', '单号重复',
        `${kind === 'sale' ? '销售' : '采购'}单号 ${id} 出现了两次，保存时会互相覆盖`, kind, id)
    } else {
      seen.set(key, true)
    }
  }

  const counts = { error: 0, warn: 0, info: 0 }
  for (const it of items) counts[it.level] = (counts[it.level] || 0) + 1
  const order = { error: 0, warn: 1, info: 2 }
  items.sort((a, b) => (order[a.level] - order[b.level]) || a.code.localeCompare(b.code) || a.id.localeCompare(b.id))
  return { items, counts, checkedAt: new Date().toISOString() }
}
