import { applyOrderOperation } from '../src/utils/orders.js'
import { openTransaction, commitTransaction } from './tx.js'

// 订单事务要读的集合。
// orders.json 是新上线的集合，数据仓里还没有 → 由 optional 声明为「可为缺失」，
// 首次保存订单时随本次提交一并创建（commitFiles 提交的是完整树，新增路径天然支持）。
// receipts / payment-vouchers 是订金凭证落地的地方，同样是后期新增的文件。
const keys = ['items', 'suppliers', 'customers', 'purchases', 'sales', 'orders',
  'receipts', 'payment-vouchers', 'stock', 'logs']

// 订单业务的事务入口：读一份固定快照 → 纯函数算出新状态 → 一次提交发布。
// 只有「过账 / 撤销过账」会真正增删单据，才需要重算派生数据（商品档案、历史价、库存）；
// 存草稿、收订金、删草稿都只动 orders.json（订金另加一张资金凭证），
// 不跑 derive 是为了避免一次草稿保存重写 200KB 的 items.json。
export async function orderTransaction(env, input, derive, rebuildStock) {
  const tx = await openTransaction(env, keys, { optional: ['orders', 'receipts', 'payment-vouchers'] })
  const result = applyOrderOperation(tx.state, input)
  if (result.duplicate) return { ok: true, code: result.code, orderId: result.orderId, duplicate: true }

  const next = result.state
  if (input.action === 'post' || input.action === 'unpost') {
    Object.assign(next, derive(next.items, next.suppliers, next.purchases, next.sales, next.customers))
    next.stock = rebuildStock(next.purchases, next.sales, next.items)
  }

  const r = await commitTransaction(tx, {
    next,
    message: `order: ${input.action} ${result.code || input.orderId || (result.removed != null ? `${result.removed} drafts` : '')}`.trim(),
    logEntry: { source: 'order', action: input.action, code: result.code, orderId: input.orderId, removed: result.removed }
  })
  if (r.unchanged) return { ok: true, code: result.code, unchanged: true, removed: result.removed || 0, skipped: result.skipped || 0 }
  // code 按操作含义不同：save/post/delete = 订单号，post 时 result.orderId 也是订单号、code 是新单据号，
  // deposit = 凭证号，clearDrafts = 空串（数量看 removed/skipped）。前端只用它做提示，落库结果一律以重新拉取为准。
  return {
    ok: true,
    code: result.code,
    orderId: result.orderId || input.orderId,
    removedDocId: result.removedDocId,
    removed: result.removed,
    skipped: result.skipped,
    commit: r.sha
  }
}
