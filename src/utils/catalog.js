// 单据商品种类数（按编码去重，无编码时按名称）
export function orderKindCount(order) {
  return new Set((order?.items || []).map(i => i.code || i.name || '')).size
}

// 商品编码 → 主数据当前名 索引
export function itemNameMap(items) {
  const map = {}
  ;(items || []).forEach(i => { if (i && i.code) map[i.code] = i.name || '' })
  return map
}

// 单据明细行的显示名：优先商品主数据当前名（改名后全站即时生效），
// 主数据缺失（商品被删等）时回退单据快照名，再回退编码
export function lineDisplayName(line, nameMap) {
  if (!line) return ''
  const current = line.code && nameMap && nameMap[line.code]
  return current || line.name || line.code || ''
}

// 整单按编码刷新商品显示名（仅显示层使用，不修改存储数据）
export function withCurrentNames(order, items) {
  const map = itemNameMap(items)
  if (!order || !Array.isArray(order.items)) return order
  return {
    ...order,
    items: order.items.map(l => {
      const name = lineDisplayName(l, map)
      return name === l.name ? l : { ...l, name }
    })
  }
}

// 按商品汇总单据明细：按编码分组（商品改名不裂行），显示主数据当前名
// withOrders: 是否统计「覆盖单数」（同一单内同一编码只计一次）
// lastDate: 该商品在筛选范围内最近一次出现的单据日期（供报表按时间排序）
export function aggregateByItem(orders, items, { withOrders = false } = {}) {
  const nameMap = itemNameMap(items)
  const agg = {}
  for (const o of (orders || [])) {
    const seen = new Set()
    const oDate = o.date || ''
    for (const i of (o.items || [])) {
      const key = i.code || i.name || ''
      if (!agg[key]) {
        agg[key] = withOrders
          ? { code: i.code || '', name: lineDisplayName(i, nameMap), orders: 0, qty: 0, amount: 0, lastDate: '' }
          : { code: i.code || '', name: lineDisplayName(i, nameMap), qty: 0, amount: 0, lastDate: '' }
      }
      const g = agg[key]
      if (withOrders && !seen.has(key)) { g.orders += 1; seen.add(key) }
      g.qty += Number(i.qty || 0)
      g.amount += Number(i.total || 0)
      if (oDate && oDate > g.lastDate) g.lastDate = oDate
    }
  }
  return Object.values(agg).sort((a, b) => b.amount - a.amount)
}

// 新商品建档时分配编码：传入 nextCodeFn 则用其生成正式编码（如 P00001），
// 否则回退到旧的临时乱码编码（保持对其他调用方的兼容）。
export function ensureCatalogItem(items, input, index = 0, nextCodeFn = null) {
  const text = String(input.code || input.name || '').trim()
  if (!text) return { items, item: null }
  const found = items.find(i => i.code === text || i.name === text)
  if (found) return { items, item: found }
  const code = nextCodeFn ? nextCodeFn() : ('N' + Date.now().toString(36).toUpperCase() + index)
  const item = {
    code,
    name: input.name || text,
    unit: input.unit || '',
    suppliers: [],
    cost: Number(input.cost || input.price || 0),
    price: Number(input.price || 0),
    warning: 0
  }
  return { items: [...items, item], item }
}

// 两位小数四舍五入：消除 5×1.91=9.549999… 这类浮点残留
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100
// 比率保留 4 位小数（0.01% 粒度）：既避免旧金额换算出 0.6666666666666667 这种长串，
// 也保证换算后行金额与原来的折扣金额分文不差
const round4 = (v) => Math.round((Number(v) + Number.EPSILON) * 10000) / 10000

// 折扣率归一化：1＝原价（不打折），0.9＝九折。
// 兼容旧数据：早期行内折扣是「金额」（discount，元），按本行原价换算成比率；
// 空值/非数字按 1（不打折）处理，避免清空输入被误读成「整行免费」。
export function normalizeRate(line, gross) {
  const r = Number(line && line.discountRate)
  if (line && line.discountRate != null && Number.isFinite(r)) return round4(Math.min(1, Math.max(0, r)))
  const amt = Number(line && line.discount || 0)
  if (gross > 0 && amt > 0) return round4(Math.min(1, Math.max(0, 1 - Math.min(amt, gross) / gross)))
  return 1
}

export function resolveLine(items, line, index = 0, nextCodeFn = null) {
  const result = ensureCatalogItem(items, line, index, nextCodeFn)
  if (!result.item) return result
  const qty = Number(line.qty || 0)
  const price = Number(line.price || result.item.price || 0)
  const gross = round2(qty * price)
  const rate = normalizeRate(line, gross)
  // 折扣只减钱、不改单价：成本价/历史价仍取原单价 price
  const discount = round2(gross * (1 - rate))
  return {
    items: result.items,
    line: {
      code: result.item.code,
      name: result.item.name,
      qty,
      price,
      discountRate: rate,
      discount,
      total: Math.max(0, round2(gross - discount))
    }
  }
}
