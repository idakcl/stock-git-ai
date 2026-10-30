import { applyVoidOperation } from '../src/utils/void.js'
import { openTransaction, commitTransaction } from './tx.js'

// 作废要读的集合：单据两侧、凭证两侧、客户/供应商（撤掉预存预付流水）、订单（过账单回退草稿）、
// 以及派生数据 items/stock（库存与历史价回滚）。
const keys = ['items', 'suppliers', 'customers', 'purchases', 'sales', 'orders',
  'receipts', 'payment-vouchers', 'stock', 'logs']

// 作废业务的事务入口：读一份固定快照 → 纯函数算出新状态 → 一次提交发布单据/凭证/库存/日志。
// 撤销一张单会影响库存、历史价、应收应付与相关凭证，所以必须一次提交，失败不重放。
export async function voidTransaction(env, input, derive, rebuildStock) {
  const tx = await openTransaction(env, keys, { optional: ['orders', 'receipts', 'payment-vouchers'] })
  const result = applyVoidOperation(tx.state, input)
  if (result.duplicate) return { ok: true, code: result.code, duplicate: true, vouchers: result.vouchers || [] }

  const next = result.state
  Object.assign(next, derive(next.items, next.suppliers, next.purchases, next.sales, next.customers))
  next.stock = rebuildStock(next.purchases, next.sales, next.items)

  const r = await commitTransaction(tx, {
    next,
    message: `void: ${input.kind || 'sale'} ${result.code}`,
    logEntry: { source: 'void', action: 'void', code: result.code, vouchers: result.vouchers }
  })
  if (r.unchanged) return { ok: true, code: result.code, unchanged: true, vouchers: result.vouchers }
  return {
    ok: true,
    code: result.code,
    vouchers: result.vouchers || [],
    unpostedOrderId: result.unpostedOrderId || '',
    commit: r.sha
  }
}
