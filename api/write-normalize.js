// 写入口的规范化：所有整表写入（含备份恢复、导入）都必须过这两道，
// 否则同一种脏结构会从不同路径重新长回数据仓。
// 从 api/routes.js 抽出来单独放，是因为备份恢复（api/restore.js）也要用，
// 而 routes 需要 import restore —— 留在 routes 里会形成循环依赖。

// 近乎恒空的字段不写进数据仓：省字节、省解析 CPU、也省 git 历史。
// 判定标准很保守 —— 只删「读侧一律当 falsy 处理」的字段，删了不会改变任何显示结果：
//   Stock.vue 用 item.warning || 0、Items.vue 用 Number(i.warning || 0)、
//   ProductTable.vue 用 v-if="row.package" / fmt(row.priceWholesale)，
//   SalesDetail/PurchaseDetail 把 base.package 直接铺进明细行（undefined 与 '' 显示一致）。
// 注意 cost / price 不在名单里：0 是合法业务值，不能删。
// items.json 里这 7 个字段实测占 40KB / 208KB（19.4%），其中 warning、remark 非空率为 0%。
const ITEM_EMPTY_FIELDS = ['package', 'warning', 'priceWholesale', 'priceInstaller', 'remark', 'saleCustomers', 'photos']
export function pruneItem(it) {
  if (!it || typeof it !== 'object') return it
  const out = { ...it }
  for (const k of ITEM_EMPTY_FIELDS) {
    const v = out[k]
    const empty = v === undefined || v === null || v === '' || v === 0
      || (typeof v === 'number' && !Number.isFinite(v))
      || (Array.isArray(v) && v.length === 0)
    if (empty) delete out[k]
  }
  return out
}

// 规范化单据收付款字段，杜绝「实付漏算」缺陷：
// ensurePayments 规定 payments 数组一旦存在（即使为空）即为权威数据、不再回退旧字段，
// 因此「payments 是空数组 + 实付躺在旧 paid/received 字段」会让实收被算成 0，
// 产生幽灵欠款（C202610251227400005：实付 1830.25 被漏算，未付合计虚增 1830.25）。
// 这种结构多来自外部导入或旧版本数据；写入前统一转成一笔正式流水，任何途径都不能再产生。
// 注意：正常删光付款记录时 payments=[] 且旧字段为 0，不满足转换条件，不会被误造流水
export function normalizeOrderPayments(order, legacyField) {
  if (!order || typeof order !== 'object') return order
  // 负数旧字段（退货单 paid = -8618 表示已退款）同样要转成正式流水，备注「历史退款」
  const legacy = Number(order[legacyField] || 0)
  if (Array.isArray(order.payments) && order.payments.length === 0 && legacy !== 0 && Number.isFinite(legacy)) {
    const amount = Math.round(legacy * 100) / 100
    return {
      ...order,
      payments: [{ date: order.date || '', amount, remark: amount < 0 ? '历史退款' : '历史实付', time: '' }]
    }
  }
  // 前端的一次性流水定位标记（mid，以及旧版遗留的 _new）：只用于「本次收付款 → 资金单据编号」
  // 的内存内匹配，落库前一律剥离。数据仓是 AI 直读的口径来源，不能出现只有前端代码看得懂的一次性字段；
  // 浏览器里可能还挂着旧版打包产物在写 _new，所以这里两个都剥，避免脏字段沉淀进数据仓。
  if (Array.isArray(order.payments) && order.payments.some(p => p && ('mid' in p || '_new' in p))) {
    return { ...order, payments: order.payments.map(({ mid, _new, ...p }) => p) }
  }
  return order
}
