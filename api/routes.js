import { readJSON, writeJSON } from './github.js'

function json(res, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  })
}

function extractData(text) {
  try {
    const obj = JSON.parse(text)
    return normalizeImport(obj)
  } catch {
    return parseFreeText(text)
  }
}

function normalizeImport(obj) {
  const out = { items: [], suppliers: [], customers: [], purchases: [], sales: [], stock: {} }
  if (Array.isArray(obj.items)) out.items = obj.items
  if (Array.isArray(obj.suppliers)) out.suppliers = obj.suppliers
  if (Array.isArray(obj.customers)) out.customers = obj.customers
  if (Array.isArray(obj.purchases)) out.purchases = obj.purchases
  if (Array.isArray(obj.sales)) out.sales = obj.sales
  if (obj.stock && typeof obj.stock === 'object') out.stock = obj.stock
  return out
}

function parseFreeText(text) {
  const out = { items: [], suppliers: [], customers: [], purchases: [], sales: [], stock: {} }
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  for (const line of lines) {
    if (line.startsWith('商品:') || line.startsWith('商品：')) {
      const parts = line.replace(/^商品[:：]\s*/, '').split(/[,，\s]+/).filter(Boolean)
      out.items.push({ code: parts[0] || '', name: parts[1] || '', unit: parts[2] || '' })
    } else if (line.startsWith('供应商:') || line.startsWith('供应商：')) {
      const parts = line.replace(/^供应商[:：]\s*/, '').split(/[,，\s]+/).filter(Boolean)
      out.suppliers.push({ code: parts[0] || '', name: parts[1] || '' })
    } else if (line.startsWith('客户:') || line.startsWith('客户：')) {
      const parts = line.replace(/^客户[:：]\s*/, '').split(/[,，\s]+/).filter(Boolean)
      out.customers.push({ code: parts[0] || '', name: parts[1] || '' })
    }
  }
  return out
}

// 从采购单/销售单推导：商品与供应商的关系链接、历史采购价/销售价、库存
export function derive(items, suppliers, purchases, sales) {
  items = (items || []).map(i => ({ ...i }))
  suppliers = (suppliers || []).map(s => ({ ...s }))
  const nameToCode = {}
  suppliers.forEach(s => { if (s.name) nameToCode[s.name] = s.code })

  const ensureSupplier = (name) => {
    let s = suppliers.find(x => x.name && name && x.name === name)
    if (!s) {
      let max = 0
      for (const x of suppliers) { const m = /^S(\d{5})$/.exec(x.code || ''); if (m) max = Math.max(max, parseInt(m[1], 10)) }
      const code = 'S' + String(max + 1).padStart(5, '0')
      s = { code, name: name || '', products: [] }
      suppliers.push(s)
    }
    return s
  }

  const itemByCode = {}
  const itemByName = {}
  items.forEach(i => { if (i.code) itemByCode[i.code] = i; if (i.name) itemByName[i.name] = i })

  const ensureItem = (code, name) => {
    let it = (code && itemByCode[code]) || (name && itemByName[name])
    if (!it) {
      let max = 0
      for (const x of items) { const m = /^P(\d{5})$/.exec(x.code || ''); if (m) max = Math.max(max, parseInt(m[1], 10)) }
      const code = 'P' + String(max + 1).padStart(5, '0')
      it = { code, name: name || code || '', unit: '', cost: 0, price: 0, warning: 0 }
      items.push(it)
    }
    it.suppliers = it.suppliers || []
    it.purchaseHistory = []
    it.saleHistory = []
    if (code) itemByCode[code] = it
    if (name) itemByName[name] = it
    return it
  }

  // 历史由单据「重建」（幂等），不从已有 history 追加
  const purchaseHist = {}
  const saleHist = {}
  for (const p of (purchases || [])) {
    const supName = p.supplier || ''
    let sCode = nameToCode[supName]
    if (!sCode) { const s = ensureSupplier(supName); sCode = s.code; nameToCode[supName] = sCode }
    for (const l of (p.items || [])) {
      const it = ensureItem(l.code, l.name)
      if (!it.suppliers.includes(sCode)) it.suppliers.push(sCode)
      ;(purchaseHist[it.code] = purchaseHist[it.code] || []).push({
        id: p.id,
        date: p.date, supplier: sCode, supplierName: supName,
        qty: Number(l.qty || 0), price: Number(l.price || 0), total: Number(l.total || 0)
      })
      if (l.price != null) it.cost = Number(l.price)
    }
  }
  for (const s of (sales || [])) {
    for (const l of (s.items || [])) {
      const it = ensureItem(l.code, l.name)
      ;(saleHist[it.code] = saleHist[it.code] || []).push({
        id: s.id,
        date: s.date, customer: s.customer || '',
        qty: Number(l.qty || 0), price: Number(l.price || 0), total: Number(l.total || 0)
      })
      if (l.price != null) it.price = Number(l.price)
    }
  }
  for (const it of items) {
    it.purchaseHistory = purchaseHist[it.code] || []
    it.saleHistory = saleHist[it.code] || []
  }

  // 双向链接：供应商.products 由商品.suppliers 反推
  for (const s of suppliers) {
    s.products = items.filter(i => (i.suppliers || []).includes(s.code)).map(i => i.code)
  }
  return { items, suppliers }
}

export function rebuildStock(purchases, sales, items) {
  const stock = {}
  const costByCode = {}
  for (const p of (purchases || [])) {
    for (const l of (p.items || [])) {
      const code = l.code
      stock[code] = stock[code] || { qty: 0, cost: 0 }
      stock[code].qty += Number(l.qty || 0)
      if (l.price != null) costByCode[code] = Number(l.price)
    }
  }
  for (const s of (sales || [])) {
    for (const l of (s.items || [])) {
      const code = l.code
      stock[code] = stock[code] || { qty: 0, cost: 0 }
      stock[code].qty -= Number(l.qty || 0)
    }
  }
  const itemCost = {}
  ;(items || []).forEach(i => { itemCost[i.code] = i.cost })
  for (const code in stock) stock[code].cost = costByCode[code] != null ? costByCode[code] : (itemCost[code] || 0)
  return stock
}

async function syncDerived(env, { purchases, sales }) {
  const [items, suppliers, curP, curS] = await Promise.all([
    readJSON(env, 'items.json'),
    readJSON(env, 'suppliers.json'),
    readJSON(env, 'purchases.json'),
    readJSON(env, 'sales.json')
  ])
  const p = purchases != null ? purchases : curP
  const s = sales != null ? sales : curS
  const { items: newItems, suppliers: newSuppliers } = derive(items, suppliers, p, s)
  const stock = rebuildStock(p, s, newItems)
  await writeJSON(env, 'items.json', newItems, 'derive items')
  await writeJSON(env, 'suppliers.json', newSuppliers, 'derive suppliers')
  await writeJSON(env, 'stock.json', stock, 'derive stock')
}

export async function handleApi(req, url, env) {
  const path = url.pathname.replace(/^\/api/, '') || '/'
  const method = req.method

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    })
  }

  try {
    if (path === '/items' && method === 'GET') return json(await readJSON(env, 'items.json'))
    if (path === '/suppliers' && method === 'GET') return json(await readJSON(env, 'suppliers.json'))
    if (path === '/customers' && method === 'GET') return json(await readJSON(env, 'customers.json'))
    if (path === '/purchases' && method === 'GET') return json(await readJSON(env, 'purchases.json'))
    if (path === '/sales' && method === 'GET') return json(await readJSON(env, 'sales.json'))
    if (path === '/stock' && method === 'GET') return json(await readJSON(env, 'stock.json'))
    if (path === '/logs' && method === 'GET') return json(await readJSON(env, 'logs.json'))

    if (method === 'POST') {
      const body = await req.json()

      if (path === '/items') {
        await writeJSON(env, 'items.json', body.items || [], 'update items')
        return json({ ok: true })
      }
      if (path === '/suppliers') {
        await writeJSON(env, 'suppliers.json', body.suppliers || [], 'update suppliers')
        return json({ ok: true })
      }
      if (path === '/customers') {
        await writeJSON(env, 'customers.json', body.customers || [], 'update customers')
        return json({ ok: true })
      }
      if (path === '/purchases') {
        const purchases = body.purchases || []
        await writeJSON(env, 'purchases.json', purchases, 'update purchases')
        await syncDerived(env, { purchases })
        return json({ ok: true })
      }
      if (path === '/sales') {
        const sales = body.sales || []
        await writeJSON(env, 'sales.json', sales, 'update sales')
        await syncDerived(env, { sales })
        return json({ ok: true })
      }
      if (path === '/stock') {
        await writeJSON(env, 'stock.json', body.stock || {}, 'update stock')
        return json({ ok: true })
      }
      if (path === '/import') {
        const text = typeof body.text === 'string' ? body.text : ''
        if (!text.trim()) return json({ error: '导入内容为空' }, 400)

        const parsed = extractData(text)
        const results = []
        for (const key of ['items', 'suppliers', 'customers', 'purchases', 'sales']) {
          if (parsed[key]?.length) {
            await writeJSON(env, `${key}.json`, parsed[key], `ai import ${key}`)
            results.push({ key, count: parsed[key].length })
          }
        }
        if (Object.keys(parsed.stock).length) {
          await writeJSON(env, 'stock.json', parsed.stock, 'ai import stock')
          results.push({ key: 'stock', count: Object.keys(parsed.stock).length })
        }

        if ((parsed.purchases && parsed.purchases.length) || (parsed.sales && parsed.sales.length)) {
          await syncDerived(env, { purchases: parsed.purchases, sales: parsed.sales })
          results.push({ key: 'derived', count: 3 })
        }

        const logs = await readJSON(env, 'logs.json')
        logs.push({ time: new Date().toISOString(), source: 'ai', results })
        await writeJSON(env, 'logs.json', logs, 'append log')

        return json({ ok: true, results })
      }
    }

    return json({ error: 'Not Found' }, 404)
  } catch (e) {
    return json({ error: e.message || String(e) }, 500)
  }
}
