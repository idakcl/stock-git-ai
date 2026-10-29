import { applyRefundOperation, backfillHistoricalRefunds } from '../src/utils/refunds.js'
import { openTransaction, commitTransaction } from './tx.js'

const keys = ['items', 'suppliers', 'customers', 'purchases', 'sales', 'refunds', 'stock', 'logs']

// 退款业务的事务入口：读一份固定快照 → 纯函数算出新状态 → 一次提交发布单据/凭证/库存/日志。
// 快照读与多文件提交都在 api/tx.js 里，与订单过账、单据变更共用同一套语义。
export async function refundTransaction(env, input, derive, rebuildStock) {
  const tx = await openTransaction(env, keys, { optional: ['refunds'] })
  const { state } = tx

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
