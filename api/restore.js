// 备份恢复：一次密码校验 + 一次 git 提交，把整库换回备份里的样子。
//
// 为什么不是「前端逐表保存」：
//   旧实现从浏览器依次 POST items → suppliers → customers → purchases → sales → receipts …
//   每一张表各提交一次。中途任一步失败（网络、409、GitHub 抖动）就停在「商品是新备份、
//   单据还是旧的」这种半截状态，既不能回滚也没法自己修。而且整条链路**不要求密码**——
//   任何拿到登录态的人点一下就能覆盖全库。
//
// 这里的口径：
//   · 密码二次校验（与会话无关）：恢复是破坏性操作，和「清空数据」同一级别；
//   · 全部集合在一次 commitFiles 里落地，要么全生效、要么全不生效；
//   · 故意不走 derive()：备份就是权威现状，不能因为派生把商品编码/历史价改一遍；
//     但库存是纯派生值，必须按恢复后的单据重算，否则库存与单据脱节；
//   · 资金保护（assertSafeWrite 的退货锁/核销锁等）不适用：恢复的语义就是整库替换，
//     这些锁保护的是「日常写入口」，在这里拦下只会让人无法恢复备份。
import { passwordMatches } from './auth.js'
import { openTransaction, commitTransaction } from './tx.js'
import { sortOrders } from './storage.js'
import { pruneItem, normalizeOrderPayments } from './write-normalize.js'
import { normalizeProfile } from './profile.js'

// 备份可包含的集合。core 是必须有的 —— 缺一张主表就拒绝，避免把库恢复成半截。
const CORE_KEYS = ['items', 'suppliers', 'customers', 'purchases', 'sales']
const ARRAY_KEYS = ['items', 'suppliers', 'customers', 'purchases', 'sales',
  'receipts', 'payment-vouchers', 'orders', 'refunds', 'order-templates', 'shares']
// 一次性写入的上限：正常库远低于此；超过基本可以判定是拿错文件或恶意构造
const MAX_ROWS = 20000

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e }

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

function cleanArray(key, arr) {
  if (arr.length > MAX_ROWS) fail(`备份里 ${key} 有 ${arr.length} 条，超过单次恢复上限 ${MAX_ROWS} 条`)
  const bad = arr.findIndex(x => !isPlainObject(x))
  if (bad >= 0) fail(`备份里 ${key} 第 ${bad + 1} 条不是对象，已中止恢复`)
  if (key === 'items') {
    // 与 /items 同一口径：剥掉历史采购价（已改为按需派生）、剪掉恒空字段
    return arr.map(({ purchaseHistory, ...it }) => pruneItem(it))
  }
  if (key === 'purchases') return sortOrders(arr.map(x => normalizeOrderPayments(x, 'paid')))
  if (key === 'sales') return sortOrders(arr.map(x => normalizeOrderPayments(x, 'received')))
  return arr
}

// 读取现有集合（事务快照）→ 用备份替换 → 重算库存 → 一次提交。
export async function restoreTransaction(env, body, rebuildStock) {
  const password = String((body && body.password) || '')
  if (!(await passwordMatches(env, password, { fresh: true }))) {
    fail('密码错误，本次未写入任何数据', 403)
  }
  const data = body && body.data
  if (!isPlainObject(data)) fail('备份内容格式不正确（缺少 data 对象）')

  const missing = CORE_KEYS.filter(k => !Array.isArray(data[k]))
  if (missing.length) fail(`备份不完整，缺少：${missing.join('、')}`)

  const replace = {}
  const counts = {}
  for (const key of ARRAY_KEYS) {
    if (!Array.isArray(data[key])) continue      // 旧备份没有的集合（收款单/订单/退款…）保持库内现状
    const list = cleanArray(key, data[key])
    replace[key] = list
    counts[key] = list.length
  }

  const keys = ['items', 'suppliers', 'customers', 'purchases', 'sales', 'stock', 'logs',
    ...ARRAY_KEYS.filter(k => !CORE_KEYS.includes(k)), 'profile']
  const tx = await openTransaction(env, keys, {
    optional: ['receipts', 'payment-vouchers', 'orders', 'refunds', 'order-templates', 'shares', 'profile']
  })

  const next = { ...tx.state, ...replace }
  if (isPlainObject(data.profile)) {
    next.profile = normalizeProfile(data.profile)
    counts.profile = 1
  }
  // 库存是派生值：恢复后必须按备份里的单据重算，绝不能让旧库存留着
  next.stock = rebuildStock(next.purchases, next.sales, next.items)

  const result = await commitTransaction(tx, {
    next,
    message: 'restore from backup',
    logEntry: { source: 'restore', counts }
  })
  return { ok: true, counts, changed: result.changed || [], unchanged: !!result.unchanged }
}
