// 清空业务数据：服务端唯一入口。
//
// 为什么必须放在服务端：
//   原来的「清空」是前端先登录、再逐张表 POST 空数组。这套做法有两个问题：
//   1. 它不是一次事务 —— 七张表分七个请求，中途失败会留下「销售单清了、收款单没清」的半截数据；
//   2. 前端登录拿到的票据本身就是管理员权限，密码校验形同虚设（任何持票人直接 POST 空数组即可），
//      而且操作不留痕，事后无法回答「谁在什么时候清掉了什么」。
//   本入口把「密码二次校验 + 一次提交 + 审计日志」收在一起，语义上等价于一次「清空单据」，
//   而不是七个独立的整表覆盖。
//
// 边界（务必如实理解，不要当成安全边界）：
//   · 持有管理员票据的人依然可以直接 POST /api/items {items:[]} 清掉一张表 —— 本入口不改变这一点，
//     真正的边界是票据权限本身；
//   · 本入口的价值是：意图确认（必须手输 CLEAR）、单次原子提交、以及必然留下审计记录。
//   · 因此系统里没有「静默真删除」：清空之后 logs 里一定能查到 time/target/条数/发起 IP。
import { checkLogin } from './auth.js'
import { openTransaction, commitTransaction } from './tx.js'

// 可清空的目标 → 对应的集合。范围与原前端 ClearData 保持一致（7 类），
// 不顺手扩大到 refunds/orders：清空范围一旦悄悄变大，用户按旧印象操作就会丢更多数据。
const TARGETS = {
  all: ['items', 'customers', 'suppliers', 'sales', 'purchases', 'receipts', 'payment-vouchers'],
  items: ['items'],
  customers: ['customers'],
  suppliers: ['suppliers'],
  sales: ['sales'],
  purchases: ['purchases'],
  receipts: ['receipts'],
  'payment-vouchers': ['payment-vouchers']
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

  // 一次固定快照读。以下三类总是要读：
  //   · items / purchases / sales：库存必须按「清空后的剩余单据」重算，只读被清的那张表会把库存算成空；
  //   · stock / logs：清完立刻落新库存与审计记录。
  // 没被改动的集合在 commitTransaction 里按内容比对后不会写回，所以多读不产生额外提交。
  const keys2 = [...new Set([...keys, 'items', 'purchases', 'sales', 'stock', 'logs'])]
  const tx = await openTransaction(env, keys2, {
    optional: ['receipts', 'payment-vouchers']
  })
  const next = { ...tx.state }
  const counts = {}

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
  }
  if (keys.includes('suppliers')) {
    next.purchases = (next.purchases || []).map(o => ({ ...o }))
    counts.orphanPurchases = markOrphans(next.purchases, 'supplier', '已删除供应商')
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
