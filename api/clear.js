// 清空业务数据：服务端唯一入口。
//
// 为什么必须放在服务端：
//   原来的「清空」是前端先登录、再逐张表 POST 空数组。这套做法有两个问题：
//   1. 它不是一次事务 —— 七张表分七个请求，中途失败会留下「销售单清了、收款单没清」的半截数据；
//   2. 前端登录拿到的票据本身就是管理员权限，密码校验形同虚设（任何持票人直接 POST 空数组即可），
//      而且操作不留痕，事后无法回答「谁在什么时候清掉了什么」。
//   本入口把「密码二次校验 + 一次提交 + 审计日志」收在一起，语义上等价于一次「清空单据」，
//   而不是多张表各自覆盖。
//
// 范围（2026-11-01 owner 拍板）：
//   · 单据：销售单 / 采购单 / 收款单 / 付款单 / 退款单 / 商品 / 客户 / 供应商，清空即整表清；
//   · 订单：不清表。已过账的订单退回「未过账」（原单据已清，不会重复占用库存与应收），
//     未过账订单原样保留——订单本身就是「还没成交的草稿」，删掉等于抹掉业务痕迹；
//   · 退款单清空时连带回滚它留下的痕迹（退货单上的负向流水、被抵扣单据的核销记录、
//     客户预存/供应商预付流水），否则会留下「退过款却查不到凭证」的脏账。
//
// 边界（务必如实理解，不要当成安全边界）：
//   · 持有管理员票据的人依然可以直接 POST /api/items {items:[]} 清掉一张表 —— 本入口不改变这一点，
//     真正的边界是票据权限本身；
//   · 本入口的价值是：意图确认（必须手输 CLEAR）、单次原子提交、以及必然留下审计记录。
//   · 因此系统里没有「静默真删除」：清空之后 logs 里一定能查到 time/target/条数/发起 IP。
import { checkLogin } from './auth.js'
import { openTransaction, commitTransaction } from './tx.js'
import { syncPayments } from '../src/utils/account.js'
import { POSTED, DRAFT } from '../src/utils/orders.js'

// 可清空的目标 → 对应的集合。
// 2026-11-01 owner 拍板把范围补齐到「全部业务单据」：退款单（refunds）也在这里清。
// 订单（orders）不整表清空——订单是草稿痕迹，硬清掉就再也说不清「那张单去哪了」；
// 清空销售/采购/全部时，已过账订单退回「未过账」，未过账订单原样保留。
const TARGETS = {
  all: ['items', 'customers', 'suppliers', 'sales', 'purchases', 'receipts', 'payment-vouchers', 'refunds'],
  items: ['items'],
  customers: ['customers'],
  suppliers: ['suppliers'],
  sales: ['sales'],
  purchases: ['purchases'],
  receipts: ['receipts'],
  'payment-vouchers': ['payment-vouchers'],
  refunds: ['refunds']
}

// 清空 customer/supplier 档案后，名下单据保留但要打上「(已删除客户)」前缀，
// 否则报表里会出现一批没有档案、名字还在的往来单位，汇总与筛选都对不上。
function markOrphans(list, field, tag) {
  const prefix = `(${tag}) `
  let changed = 0
  for (const o of (list || [])) {
    const name = String(o && o[field] || '').trim()
    if (name && !name.startsWith(prefix)) {
      o[field] = prefix + name
      changed += 1
    }
  }
  return changed
}

// 退款凭证会在别处留下三类痕迹：退货单上的负向流水、被抵扣单据上的核销记录、
// 客户预存 / 供应商预付流水。只清凭证不清痕迹，会得到「账上退过款、却查不到退款单」的脏数据，
// 所以清退款单时把这些痕迹一并回滚，并按剩余流水重算收付与结清状态。
function revertRefundTraces(state, codes) {
  if (!codes.size) return 0
  let changed = 0
  const hit = x => codes.has(x && x.voucher)
  for (const key of ['sales', 'purchases']) {
    const settleKind = key === 'sales' ? 'receivable' : 'payable'
    state[key] = (state[key] || []).map(o => {
      const payments = o.payments || []
      const settlements = o.settlements || []
      if (!payments.some(hit) && !settlements.some(hit)) return o
      changed += 1
      return syncPayments({
        ...o,
        payments: payments.filter(p => !hit(p)),
        settlements: settlements.filter(s => !hit(s))
      }, settleKind)
    })
  }
  for (const [key, field] of [['customers', 'deposits'], ['suppliers', 'advances']]) {
    if (!Array.isArray(state[key])) continue
    state[key] = state[key].map(p => {
      const list = p[field] || []
      if (!list.some(hit)) return p
      changed += 1
      return { ...p, [field]: list.filter(x => !hit(x)) }
    })
  }
  return changed
}

// 清掉销售/采购单据后，指向它们的已过账订单必须退回「未过账」：
// 单据已经不在了，订单还标着「已过账」只会卡死（改不了、也撤不了）。
function resetPostedOrders(orders, kinds, now) {
  let changed = 0
  const list = (orders || []).map(o => {
    if (!o || !kinds.includes(o.kind) || o.status !== POSTED) return o
    changed += 1
    return { ...o, status: DRAFT, postedOrderId: '', postedAt: '', updatedAt: now }
  })
  return { list, changed }
}

export async function clearTransaction(req, env, input, rebuildStock) {
  const target = String(input && input.target || '')
  const keys = TARGETS[target]
  if (!keys) throw Object.assign(new Error('不支持的清空目标'), { status: 400 })
  if (String(input && input.confirm || '') !== 'CLEAR') {
    throw Object.assign(new Error('清空需要二次确认：请在确认框里输入 CLEAR'), { status: 400 })
  }

  // 密码二次校验复用登录逻辑：常量时间比较 + 失败节流，但不采用返回的票据。
  const pass = String(input && input.password || '')
  if (!pass) throw Object.assign(new Error('请输入管理密码'), { status: 400 })
  const r = await checkLogin(req, env, { password: pass })
  if (r.lockedFor) throw Object.assign(new Error(`尝试过多，请 ${r.lockedFor} 秒后重试`), { status: 429 })
  if (!r.ok) {
    if (r.misconfigured) throw Object.assign(new Error('服务端未配置登录密钥，请联系管理员'), { status: 500 })
    throw Object.assign(new Error('管理密码错误'), { status: 403 })
  }

  // 一次固定快照读。以下总是要读：
  //   · items / purchases / sales：库存必须按「清空后的剩余单据」重算，只读被清的那张表会把库存算成空；
  //   · customers / suppliers：退款回滚要落在预存/预付流水上，清退款单必须能改到档案；
  //   · orders：清销售/采购后已过账订单要退回未过账；
  //   · refunds / stock / logs：退款回滚、新库存、审计记录。
  // 没被改动的集合在 commitTransaction 里按内容比对后不会写回，所以多读不产生额外提交。
  const keys2 = [...new Set([...keys, 'items', 'purchases', 'sales', 'customers', 'suppliers',
    'stock', 'logs', 'refunds', 'orders'])]
  const tx = await openTransaction(env, keys2, {
    optional: ['receipts', 'payment-vouchers', 'refunds', 'orders']
  })
  const next = { ...tx.state }
  const counts = {}
  const now = new Date().toISOString()

  for (const key of keys) {
    counts[key] = Array.isArray(tx.state[key]) ? tx.state[key].length : 0
    next[key] = []
  }
  // 清客户/供应商只清档案，单据保留并打「(已删除…)」前缀（与原前端行为一致）。
  // 先按行浅拷贝：next 只是 tx.state 的浅拷贝，就地改对象会连 state 一起改掉，
  // commitTransaction 比对内容时看不出差异，改名就写不进去了。
  if (keys.includes('customers')) {
    next.sales = (next.sales || []).map(o => ({ ...o }))
    counts.orphanSales = markOrphans(next.sales, 'customer', '已删除客户')
    // 客户档案清掉后，退款单上的往来单位同样会变成「没有档案、名字还在」，一并打前缀。
    next.refunds = (next.refunds || []).map(v => ({ ...v }))
    counts.orphanRefundsCustomers = markOrphans(next.refunds.filter(v => v.direction === 'to_customer'), 'party', '已删除客户')
  }
  if (keys.includes('suppliers')) {
    next.purchases = (next.purchases || []).map(o => ({ ...o }))
    counts.orphanPurchases = markOrphans(next.purchases, 'supplier', '已删除供应商')
    next.refunds = (next.refunds || tx.state.refunds || []).map(v => ({ ...v }))
    counts.orphanRefundsSuppliers = markOrphans(next.refunds.filter(v => v.direction === 'from_supplier'), 'party', '已删除供应商')
  }

  // 退款单：清「全部/退款单」时全清；清销售单 / 采购单时只回滚对应方向的退款，
  // 因为另一方向的退款还牵着没被清的那张表。
  const refundScope = keys.includes('refunds') ? (() => true)
    : keys.includes('sales') ? (v => v && v.direction === 'to_customer')
      : keys.includes('purchases') ? (v => v && v.direction === 'from_supplier')
        : null
  if (refundScope) {
    const allRefunds = tx.state.refunds || []
    const removed = allRefunds.filter(refundScope)
    if (removed.length) counts.refunds = removed.length
    if (!keys.includes('refunds') && removed.length && allRefunds.length !== removed.length) {
      counts.refundsKept = allRefunds.length - removed.length
    }
    // 只有确实要动退款单时才写这个集合：目标表里本来没有 refunds.json 时，
    // 清销售单不该顺手创建一个空文件。
    if (keys.includes('refunds') || removed.length) {
      next.refunds = allRefunds.filter(v => !refundScope(v))
    }
    // 被清掉的单据已经不在 next 里，回滚只作用于还留着的账（预存/预付、其他单据的核销记录）。
    const traced = revertRefundTraces(next, new Set(removed.map(v => v.code)))
    if (traced) counts.refundTraces = traced
  }

  // 订单不清表：只把指向已清单据的「已过账」订单退回未过账，未过账订单原样保留。
  const orderKinds = [
    ...(keys.includes('sales') ? ['sale'] : []),
    ...(keys.includes('purchases') ? ['purchase'] : [])
  ]
  if (orderKinds.length) {
    const reset = resetPostedOrders(tx.state.orders, orderKinds, now)
    next.orders = reset.list
    if (reset.changed) counts.ordersReset = reset.changed
  }

  next.stock = rebuildStock(next.purchases, next.sales, next.items)

  const detail = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')
  const out = await commitTransaction(tx, {
    next,
    message: `clear: ${target} (${detail})`,
    logEntry: {
      source: 'clear',
      action: 'clear',
      target,
      detail,
      ip: req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown'
    }
  })
  return { ok: true, target, counts, unchanged: !!out.unchanged, commit: out.sha || '' }
}
