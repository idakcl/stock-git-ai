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
        await writeJSON(env, 'purchases.json', body.purchases || [], 'update purchases')
        return json({ ok: true })
      }
      if (path === '/sales') {
        await writeJSON(env, 'sales.json', body.sales || [], 'update sales')
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
