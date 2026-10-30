import { applyRefundOperation, backfillHistoricalRefunds } from '../src/utils/refunds.js'
import { openTransaction, commitTransaction } from './tx.js'

const keys = ['items', 'suppliers', 'customers', 'purchases', 'sales', 'refunds', 'stock', 'logs']

// 退款业务的事务入口：读一份固定快照 → 纯函数算出新状态 → 一次提交发布单据/凭证/库存/日志。
// 快照读与多文件提交都在 api/tx.js 里，与订单过账、单据变更共用同一套语义。
export async function refundTransaction(env, input, derive, rebuildStock) {
  const tx = await openTransaction(env, keys, { optional: ['refunds'] })
  const { state } = tx

  // 备份恢复：整表替换退款/核销凭证（全量备份导入用）。
  // 退款凭证只是资金/核销台账，库存与单据由 sales/purchases 决定，因此不跑 derive。
  if (input.action === 'restore') {
    const list = input.refunds
    const fail = (message) => { const e = new Error(message); e.status = 400; throw e }
    if (!Array.isArray(list)) fail('退款凭证数据必须是数组')
    if (list.length > 5000) fail('退款凭证超过 5000 条上限，请分批导入')
    const seen = new Set()
    for (const v of list) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) fail('退款凭证数据中存在非对象记录')
      const code = String(v.code || '').trim()
      if (!code) fail('退款凭证数据中存在缺少编号的记录')
      if (seen.has(code)) fail(`退款凭证编号重复：${code}`)
      seen.add(code)
    }
    const next = { ...state, refunds: list.map(v => ({ ...v })) }
    const r = await commitTransaction(tx, {
      next,
      message: `refund: restore ${list.length}`,
      logEntry: { source: 'refund', action: 'restore', count: list.length }
    })
    if (r.unchanged) return { ok: true, restored: list.length, unchanged: true }
    return { ok: true, restored: list.length, commit: r.sha }
  }

  const result = input.action === 'backfill' ? backfillHistoricalRefunds(state) : applyRefundOperation(state, input)
  if (result.duplicate) return { ok: true, code: result.code, duplicate: true }
  const next = result.state
  if (input.action !== 'backfill') {
    Object.assign(next, derive(next.items, next.suppliers, next.purchases, next.sales, next.customers))
    next.stock = rebuildStock(next.purchases, next.sales, next.items)
  }

  const r = await commitTransaction(tx, {
    next,
    message: `refund: ${input.action} ${result.code || (result.codes || []).join(', ')}`,
    logEntry: { source: 'refund', action: input.action, code: result.code, codes: result.codes }
  })
  if (r.unchanged) return { ok: true, codes: result.codes || [], unchanged: true }
  return { ok: true, code: result.code, returnId: result.returnId, codes: result.codes, commit: r.sha }
}
