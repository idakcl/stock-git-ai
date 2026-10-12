// 单据商品种类数（按编码去重，无编码时按名称）
export function orderKindCount(order) {
  return new Set((order?.items || []).map(i => i.code || i.name || '')).size
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
