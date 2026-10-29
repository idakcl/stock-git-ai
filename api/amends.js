import { applyAmendOperation } from '../src/utils/amend.js'
import { openTransaction, commitTransaction } from './tx.js'

// 变更一定动单据（生成退货单 / 补差单），所以 refunds.json（退货核销、退款凭证）必须在读列表里。
const keys = ['items', 'suppliers', 'customers', 'purchases', 'sales', 'refunds', 'stock', 'logs']

// 单据变更的事务入口：原单不动，减少的商品生成退货单、增加的商品生成补差单，
// 两张单都带 sourceOrderId 指回原单，库存与应收由派生层自动跟上。
export async function amendTransaction(env, input, derive, rebuildStock) {
  const tx = await openTransaction(env, keys, { optional: ['refunds'] })
  const result = applyAmendOperation(tx.state, input)
  if (result.duplicate) return { ok: true, code: result.code, duplicate: true }

  const next = result.state
  Object.assign(next, derive(next.items, next.suppliers, next.purchases, next.sales, next.customers))
  next.stock = rebuildStock(next.purchases, next.sales, next.items)

  const r = await commitTransaction(tx, {
    next,
    message: `amend: ${input.kind} ${input.sourceOrderId} ${[result.returnId, result.amendId].filter(Boolean).join(' + ')}`,
    logEntry: { source: 'amend', kind: input.kind, sourceOrderId: input.sourceOrderId, returnId: result.returnId, amendId: result.amendId, codes: result.codes }
  })
  if (r.unchanged) return { ok: true, unchanged: true }
  // code = 本次代表性的那张单号（有补差取补差单，否则取退货单），与退款接口的返回口径一致
  return { ok: true, code: result.code, returnId: result.returnId, amendId: result.amendId, codes: result.codes, commit: r.sha }
}
