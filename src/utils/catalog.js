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
export function aggregateByItem(orders, items, { withOrders = false } = {}) {
  const nameMap = itemNameMap(items)
  const agg = {}
  for (const o of (orders || [])) {
    const seen = new Set()
    for (const i of (o.items || [])) {
      const key = i.code || i.name || ''
      if (!agg[key]) {
        agg[key] = withOrders
          ? { code: i.code || '', name: lineDisplayName(i, nameMap), orders: 0, qty: 0, amount: 0 }
          : { code: i.code || '', name: lineDisplayName(i, nameMap), qty: 0, amount: 0 }
      }
      const g = agg[key]
      if (withOrders && !seen.has(key)) { g.orders += 1; seen.add(key) }
      g.qty += Number(i.qty || 0)
      g.amount += Number(i.total || 0)
    }
  }
  return Object.values(agg).sort((a, b) => b.amount - a.amount)
}

export function ensureCatalogItem(items, input, index = 0) {
  const text = String(input.code || input.name || '').trim()
  if (!text) return { items, item: null }
  const found = items.find(i => i.code === text || i.name === text)
  if (found) return { items, item: found }
  const item = {
    code: 'N' + Date.now().toString(36).toUpperCase() + index,
    name: input.name || text,
    unit: input.unit || '',
    cost: Number(input.cost || input.price || 0),
    price: Number(input.price || 0),
    warning: 0
  }
  return { items: [...items, item], item }
}

export function resolveLine(items, line, index = 0) {
  const result = ensureCatalogItem(items, line, index)
  if (!result.item) return result
  return {
    items: result.items,
    line: {
      code: result.item.code,
      name: result.item.name,
      qty: Number(line.qty || 0),
      price: Number(line.price || result.item.price || 0),
      total: Number(line.qty || 0) * Number(line.price || result.item.price || 0)
    }
  }
}
