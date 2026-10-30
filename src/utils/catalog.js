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

// ---- 行级多级折扣（折扣链）----
// 与整单折扣链（account.js 的 discountRatesOf / effectiveRateOf）同一概念，但作用在明细行上。
// 数据结构：行上可带 discountRates: number[]（级联），向后兼容旧单级 discountRate 标量。
// 为什么不在行上只存 discountRates 数组：过账时行数据原样搬进正式单据（utils/orders.js orderToOrderDoc），
// 正式单据的 resolveLine 只读 discountRate 标量。把等效乘积同步写进 discountRate，保证「过账后金额不变数」。

// 规范化行折扣链：优先取 discountRates 数组，回退旧 discountRate 标量，非法项剔除。
// 纯函数、不引浏览器 API，Worker 端可安全 import。
export function lineDiscountRatesOf(line) {
  const rates = line?.discountRates
  if (Array.isArray(rates) && rates.length) {
    const valid = rates.map(Number).filter(r => Number.isFinite(r) && r > 0 && r <= 1)
    if (valid.length) return valid
  }
  const r = Number(line?.discountRate)
  // 这里允许 0：normalizeRate 的既有口径里 discountRate=0 表示「整行全免」，
  // 若按链的规则剔掉 0，行折扣输入框填 0 会静默变回原价（金额凭空多出一笔）
  if (Number.isFinite(r) && r >= 0 && r <= 1) return [r]
  return []
}

// 行等效折扣率：折扣链连乘；无折扣返回 1（1＝不打折）。
// 与 account.js 的 effectiveRateOf 同一口径，但作用于单行。
// 末位 round4：连乘会产生浮点尘（0.9×0.8=0.7200000000000001），
// 不收敛会让行金额与整单金额对不上账。
export function lineEffectiveRate(line) {
  const rates = lineDiscountRatesOf(line)
  if (!rates.length) return 1
  return round4(rates.reduce((a, b) => a * b, 1))
}

// 把一组级联折扣率应用到行上：返回 { discountRate, discountRates, discount, total }
// 其中 discountRate = 等效乘积（向后兼容旧字段），discountRates = 原始链（供展示/编辑）。
// gross 是行原价（qty × price），discount 是减免金额，total 是折后小计。
// 纯函数，不修改入参。
export function applyLineRates(line, rates, gross) {
  const g = round2(Number(gross || 0))
  const valid = (rates || []).map(Number).filter(r => Number.isFinite(r) && r > 0 && r <= 1)
  const eff = valid.length ? valid.reduce((a, b) => a * b, 1) : 1
  const rate = round4(Math.min(1, Math.max(0, eff)))
  const discount = round2(g * (1 - rate))
  return {
    discountRate: rate,
    discountRates: valid.length ? valid.slice() : [],
    discount,
    total: Math.max(0, round2(g - discount))
  }
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
