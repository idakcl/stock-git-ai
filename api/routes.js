import { readJSON, writeJSON } from './github.js'
import { checkLogin, verifyToken, bearer, corsHeaders } from './auth.js'
import { diffImport, isValidImportKey } from '../src/utils/dedupe.js'

function json(req, env, res, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req, env) }
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
  const out = { items: [], suppliers: [], customers: [], purchases: [], sales: [], receipts: [], 'payment-vouchers': [], stock: {} }
  if (Array.isArray(obj.items)) out.items = obj.items
  if (Array.isArray(obj.suppliers)) out.suppliers = obj.suppliers
  if (Array.isArray(obj.customers)) out.customers = obj.customers
  if (Array.isArray(obj.purchases)) out.purchases = obj.purchases
  if (Array.isArray(obj.sales)) out.sales = obj.sales
  if (Array.isArray(obj.receipts)) out.receipts = obj.receipts
  if (Array.isArray(obj['payment-vouchers'])) out['payment-vouchers'] = obj['payment-vouchers']
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

// 从采购单/销售单推导：商品与供应商/客户的关系链接、历史采购价/销售价、库存
// 商品、供应商、客户三类主数据，凡是在单据里首次出现的新名字，都会在此自动建档：
//   ensureItem（采购+销售明细）→ 商品
//   ensureSupplier（采购单供应商）→ 供应商
//   ensureCustomer（销售单客户）→ 客户
// 已存在的档案只会被补全派生字段（如供应商.products），不会被改写或删除。
export function derive(items, suppliers, purchases, sales, customers) {
  items = (items || []).map(i => ({ ...i }))
  suppliers = (suppliers || []).map(s => ({ ...s }))
  customers = (customers || []).map(c => ({ ...c }))
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

  // 销售单里的客户只是个名字字符串，保存销售单时按名字匹配、缺失则自动建档，
  // 保证「客户名单」与「销售单」不再两套独立数据（以前新客户只进销售单、不进名单）。
  const custNameToCode = {}
  customers.forEach(c => { if (c.name) custNameToCode[c.name] = c.code })
  const ensureCustomer = (name) => {
    let c = customers.find(x => x.name && name && x.name === name)
    if (!c) {
      let max = 0
      for (const x of customers) { const m = /^C(\d{5})$/.exec(x.code || ''); if (m) max = Math.max(max, parseInt(m[1], 10)) }
      const code = 'C' + String(max + 1).padStart(5, '0')
      c = { code, name: name || '', contact: '', phone: '', remark: '' }
      customers.push(c)
      custNameToCode[name] = code
    }
    return c
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
  // 数值清洗：非数字（空串/乱码）统一归 0，金额统一保留 2 位，
  // 消除 5×1.91=9.549999999999999 这类浮点残留在数据仓里沉淀
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
  const money2 = (v) => Math.round(num(v) * 100) / 100
  // 按日期升序遍历：保证商品成本价/售价取自「日期最新」的单据，
  // 而不是数组里的最后一条（数组顺序取决于录入先后，未必与日期一致）
  const byDateAsc = (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.id || '').localeCompare(String(b.id || ''))
  const orderedPurchases = [...(purchases || [])].sort(byDateAsc)
  const orderedSales = [...(sales || [])].sort(byDateAsc)
  for (const p of orderedPurchases) {
    const supName = p.supplier || ''
    let sCode = nameToCode[supName]
    if (!sCode) { const s = ensureSupplier(supName); sCode = s.code; nameToCode[supName] = sCode }
    for (const l of (p.items || [])) {
      const it = ensureItem(l.code, l.name)
      // 修正存量乱码编码（N… 等无效编码）：回写为解析到的正式 P 编码，
      // 保证后续按 code 关联主数据、商品库改名/改单位即时联动
      if (l.code !== it.code) l.code = it.code
      if (!it.suppliers.includes(sCode)) it.suppliers.push(sCode)
      ;(purchaseHist[it.code] = purchaseHist[it.code] || []).push({
        id: p.id,
        date: p.date, supplier: sCode, supplierName: supName,
        qty: num(l.qty), price: money2(l.price), total: money2(l.total)
      })
      if (l.price != null && Number.isFinite(Number(l.price))) it.cost = money2(l.price)
    }
  }
  for (const s of orderedSales) {
    const custName = s.customer || ''
    if (custName) ensureCustomer(custName)
    for (const l of (s.items || [])) {
      const it = ensureItem(l.code, l.name)
      // 修正存量乱码编码（N… 等无效编码）：回写为解析到的正式 P 编码
      if (l.code !== it.code) l.code = it.code
      ;(saleHist[it.code] = saleHist[it.code] || []).push({
        id: s.id,
        date: s.date, customer: s.customer || '',
        qty: num(l.qty), price: money2(l.price), total: money2(l.total)
      })
      if (l.price != null && Number.isFinite(Number(l.price))) it.price = money2(l.price)
    }
  }
  // 历史价按时间倒序（最近优先）；同日按单号倒序（单号内含录入时间）
  const byTimeDesc = (a, b) => {
    const d = String(b.date || '').localeCompare(String(a.date || ''))
    return d || String(b.id || '').localeCompare(String(a.id || ''))
  }
  for (const k in purchaseHist) purchaseHist[k].sort(byTimeDesc)
  for (const k in saleHist) saleHist[k].sort(byTimeDesc)
  for (const it of items) {
    // 取消「零售价」独立字段：零售价即售价（price）。存量数据若仍有 priceRetail，
    // 并入 price（售价优先；售价缺失则用零售价补），随后删除该字段，避免冗余字段长期漂移
    if (it && 'priceRetail' in it) {
      const retail = Number(it.priceRetail) || 0
      if (!Number(it.price) && retail) it.price = retail
      delete it.priceRetail
    }
    it.purchaseHistory = purchaseHist[it.code] || []
    it.saleHistory = saleHist[it.code] || []
  }

  // 双向链接：供应商.products 由商品.suppliers 反推
  for (const s of suppliers) {
    s.products = items.filter(i => (i.suppliers || []).includes(s.code)).map(i => i.code)
  }
  return { items, suppliers, customers, purchases, sales }
}

export function rebuildStock(purchases, sales, items) {
  const stock = {}
  const costByCode = {}
  // 缺编码或数量非数字的行无法归属到具体商品：直接跳过。
  // 否则会全部归到 "undefined" 这个键下，库存与成本全部算错（且 NaN 序列化成 null 污染后续计算）
  const num2 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
  for (const p of (purchases || [])) {
    for (const l of (p.items || [])) {
      const code = l.code
      if (!code) continue
      stock[code] = stock[code] || { qty: 0, cost: 0 }
      stock[code].qty += num2(l.qty)
      if (l.price != null && Number.isFinite(Number(l.price))) costByCode[code] = Number(l.price)
    }
  }
  for (const s of (sales || [])) {
    for (const l of (s.items || [])) {
      const code = l.code
      if (!code) continue
      stock[code] = stock[code] || { qty: 0, cost: 0 }
      stock[code].qty -= num2(l.qty)
    }
  }
  const itemCost = {}
  ;(items || []).forEach(i => { itemCost[i.code] = i.cost })
  for (const code in stock) stock[code].cost = costByCode[code] != null ? costByCode[code] : (itemCost[code] || 0)
  return stock
}

// 规范化单据收付款字段，杜绝「实付漏算」缺陷：
// ensurePayments 规定 payments 数组一旦存在（即使为空）即为权威数据、不再回退旧字段，
// 因此「payments 是空数组 + 实付躺在旧 paid/received 字段」会让实收被算成 0，
// 产生幽灵欠款（B202610251227400005：实付 1830.25 被漏算，未付合计虚增 1830.25）。
// 这种结构多来自外部导入或旧版本数据；写入前统一转成一笔正式流水，任何途径都不能再产生。
// 注意：正常删光付款记录时 payments=[] 且旧字段为 0，不满足转换条件，不会被误造流水
export function normalizeOrderPayments(order, legacyField) {
  if (!order || typeof order !== 'object') return order
  if (Array.isArray(order.payments) && order.payments.length === 0 && Number(order[legacyField] || 0) > 0) {
    const amount = Math.round(Number(order[legacyField]) * 100) / 100
    return {
      ...order,
      payments: [{ date: order.date || '', amount, remark: '历史实付', time: '' }]
    }
  }
  return order
}

async function syncDerived(env, { purchases, sales }) {
  const [items, suppliers, curP, curS, customers] = await Promise.all([
    readJSON(env, 'items.json'),
    readJSON(env, 'suppliers.json'),
    readJSON(env, 'purchases.json'),
    readJSON(env, 'sales.json'),
    readJSON(env, 'customers.json')
  ])
  const p = purchases != null ? purchases : curP
  const s = sales != null ? sales : curS
  const { items: newItems, suppliers: newSuppliers, customers: newCustomers, purchases: newP, sales: newS } = derive(items, suppliers, p, s, customers)
  // derive 是「由单据全量重建」的纯函数，正常情况下不可能把非空档案推导成空。
  // 一旦出现，说明上游读取异常（例如 GitHub 对大文件返回空内容），
  // 此时宁可报错中止，也不能把空数组写回去覆盖真实数据。
  if (items.length && !newItems.length) {
    throw new Error('派生结果为空，疑似上游数据读取异常，已中止以避免覆盖商品档案')
  }
  const stock = rebuildStock(p, s, newItems)
  // 三个文件顺序写入，无跨文件事务：中途失败时前面的文件已落库。
  // derive 是纯函数（由单据重建），重新保存一次采购单/销售单即可自动修复，故失败时给出明确修复指引。
  try {
    await writeJSON(env, 'items.json', newItems, 'derive items')
    await writeJSON(env, 'suppliers.json', newSuppliers, 'derive suppliers')
    await writeJSON(env, 'stock.json', stock, 'derive stock')
    // 客户：仅当销售单里出现了名单中原本没有的新客户时才写回，
    // 避免每次保存销售单都给 customers.json 产生一条内容不变的空提交
    if (newCustomers.length > customers.length) {
      await writeJSON(env, 'customers.json', newCustomers, 'derive customers')
    }
    // 回写修正后的单据：存量乱码编码（N…）已改写为正式 P 编码。
    // p/s 为本次全量（传入的整表或读库现值），derive 仅就地修正 line.code，不增删条目，幂等安全
    await writeJSON(env, 'purchases.json', newP, 'derive fix purchase codes')
    await writeJSON(env, 'sales.json', newS, 'derive fix sale codes')
  } catch (e) {
    throw new Error(`派生数据同步失败（${e.message || e}）。单据本身已保存；请重新保存一次该采购单/销售单，系统会自动重建商品链接、历史价与库存`)
  }
}

export async function handleApi(req, url, env) {
  const path = url.pathname.replace(/^\/api/, '') || '/'
  const method = req.method

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req, env) })
  }

  // 登录接口：唯一无需会话即可访问的写接口
  if (path === '/login' && method === 'POST') {
    try {
      const body = await req.json()
      const r = await checkLogin(req, env, body)
      if (r.ok) return json(req, env, { ok: true, token: r.token, expiresIn: r.expiresIn })
      if (r.misconfigured) return json(req, env, { error: '服务端未配置登录密钥，请联系管理员' }, 500)
      if (r.lockedFor) return json(req, env, { error: `登录尝试过多，请 ${r.lockedFor} 秒后重试` }, 429)
      return json(req, env, { error: `密码错误，还可尝试 ${r.remain} 次` }, 401)
    } catch (e) {
      return json(req, env, { error: e.message || '登录失败' }, 500)
    }
  }
  // 会话状态查询（前端启动时判断是否需要重新登录）
  if (path === '/session' && method === 'GET') {
    return json(req, env, { ok: await verifyToken(bearer(req), env) })
  }

  // 其余接口一律要求登录态
  if (!(await verifyToken(bearer(req), env))) {
    return json(req, env, { error: '未登录或登录已过期' }, 401)
  }

  try {
    if (path === '/items' && method === 'GET') return json(req, env, await readJSON(env, 'items.json'))
    if (path === '/suppliers' && method === 'GET') return json(req, env, await readJSON(env, 'suppliers.json'))
    if (path === '/customers' && method === 'GET') return json(req, env, await readJSON(env, 'customers.json'))
    if (path === '/purchases' && method === 'GET') return json(req, env, await readJSON(env, 'purchases.json'))
    if (path === '/sales' && method === 'GET') return json(req, env, await readJSON(env, 'sales.json'))
    if (path === '/receipts' && method === 'GET') return json(req, env, await readJSON(env, 'receipts.json'))
    if (path === '/payment-vouchers' && method === 'GET') return json(req, env, await readJSON(env, 'payment-vouchers.json'))
    if (path === '/stock' && method === 'GET') return json(req, env, await readJSON(env, 'stock.json'))
    if (path === '/logs' && method === 'GET') return json(req, env, await readJSON(env, 'logs.json'))

    // 图片/单据照片上传：转发到图床，authCode 保存在 Worker Secret，不暴露给前端
    if (path === '/upload' && method === 'POST') {
      if (!env.IMGBED_AUTH_CODE) return json(req, env, { error: '未配置图床密钥 IMGBED_AUTH_CODE' }, 500)
      const form = await req.formData()
      const file = form.get('file')
      if (!file) return json(req, env, { error: '缺少文件' }, 400)
      // 限制大小与类型：避免超大文件拖垮 Worker、避免非图片内容被塞进图床
      const MAX_UPLOAD = 10 * 1024 * 1024
      if (typeof file.size === 'number' && file.size > MAX_UPLOAD) {
        return json(req, env, { error: '图片不能超过 10MB' }, 400)
      }
      if (file.type && !/^image\//i.test(file.type)) {
        return json(req, env, { error: '只允许上传图片文件' }, 400)
      }
      const fd = new FormData()
      fd.append('file', file)
      const upstream = `https://netpan.1234.nyc.mn/upload?authCode=${encodeURIComponent(env.IMGBED_AUTH_CODE)}&returnFormat=full`
      const res = await fetch(upstream, { method: 'POST', body: fd, signal: AbortSignal.timeout(25000) })
      const data = await res.json().catch(() => ({}))
      const src = Array.isArray(data) ? (data[0] && data[0].src) : data.src
      // 校验返回值：只接受 http(s) 链接，防止异常内容被当作图片地址存进单据
      if (!src || typeof src !== 'string' || !/^https?:\/\//i.test(src)) {
        return json(req, env, { error: '图床上传失败' }, 502)
      }
      return json(req, env, { url: src })
    }

    if (method === 'POST') {
      const body = await req.json()

      if (path === '/items') {
        const newItems = body.items || []
        await writeJSON(env, 'items.json', newItems, 'update items')
        // 商品改了挂靠供应商后，必须同步供应商档案里的商品列表：
        // products 是派生字段，原本只在保存采购/销售单时重算，
        // 会造成「商品库看得到这家供应商、供应商详情页却显示没有商品」。
        try {
          const suppliers = await readJSON(env, 'suppliers.json')
          const synced = (suppliers || []).map(s => ({
            ...s,
            products: newItems.filter(i => (i.suppliers || []).includes(s.code)).map(i => i.code)
          }))
          await writeJSON(env, 'suppliers.json', synced, 'sync supplier products')
        } catch (e) {
          return json(req, env, { error: `商品已保存，但供应商的商品列表同步失败（${e.message || e}）。请重新保存一次商品，系统会自动重建` }, 500)
        }
        return json(req, env, { ok: true })
      }
      if (path === '/suppliers') {
        await writeJSON(env, 'suppliers.json', body.suppliers || [], 'update suppliers')
        return json(req, env, { ok: true })
      }
      if (path === '/customers') {
        await writeJSON(env, 'customers.json', body.customers || [], 'update customers')
        return json(req, env, { ok: true })
      }
      // 收款单/付款单：纯资金单据，不触发 syncDerived（不影响库存/商品派生数据）
      if (path === '/receipts') {
        await writeJSON(env, 'receipts.json', body.receipts || [], 'update receipts')
        return json(req, env, { ok: true })
      }
      if (path === '/payment-vouchers') {
        await writeJSON(env, 'payment-vouchers.json', body['payment-vouchers'] || [], 'update payment-vouchers')
        return json(req, env, { ok: true })
      }
      if (path === '/purchases') {
        // 写入端规范化：见 normalizeOrderPayments——堵住「payments 空数组 + 旧 paid」实付漏算缺陷
        const purchases = (body.purchases || []).map(p => normalizeOrderPayments(p, 'paid'))
        await writeJSON(env, 'purchases.json', purchases, 'update purchases')
        await syncDerived(env, { purchases })
        return json(req, env, { ok: true })
      }
      if (path === '/sales') {
        const sales = (body.sales || []).map(s => normalizeOrderPayments(s, 'received'))
        await writeJSON(env, 'sales.json', sales, 'update sales')
        await syncDerived(env, { sales })
        return json(req, env, { ok: true })
      }
      // 库存是采购/销售的派生数据（由 rebuildStock 全量重算），禁止直接覆盖，
      // 否则会与单据脱节产生漂移——需要修正请改为重新保存对应单据，由系统重建。
      if (path === '/stock') {
        return json(req, env, { error: '库存为派生数据，不支持直接写入；请重新保存采购单/销售单由系统自动重建' }, 403)
      }
      if (path === '/import') {
        const text = typeof body.text === 'string' ? body.text : ''
        if (!text.trim()) return json(req, env, { error: '导入内容为空' }, 400)

        // 体积与条数上限：避免超大文本拖垮 Worker（CPU 超时/OOM），
        // 也避免一次脏数据把整个数据仓覆盖
        if (text.length > 1024 * 1024) {
          return json(req, env, { error: '导入内容超过 1MB，请分批导入' }, 400)
        }

        const parsed = extractData(text)
        // 导入同样过一遍规范化：外部 JSON 常带「payments:[] + 旧 paid/received」结构，
        // 原样落库会造成实付漏算、幽灵欠款（与保存接口同一缺陷，同一修法）
        if (parsed.purchases && parsed.purchases.length) parsed.purchases = parsed.purchases.map(p => normalizeOrderPayments(p, 'paid'))
        if (parsed.sales && parsed.sales.length) parsed.sales = parsed.sales.map(s => normalizeOrderPayments(s, 'received'))
        const results = []
        for (const key of ['items', 'suppliers', 'customers', 'purchases', 'sales', 'receipts', 'payment-vouchers']) {
          const arr = parsed[key]
          if (!Array.isArray(arr) || !arr.length) continue
          if (arr.length > 5000) {
            return json(req, env, { error: `${key} 超过 5000 条上限，请分批导入` }, 400)
          }
          if (arr.some(x => !x || typeof x !== 'object' || Array.isArray(x))) {
            return json(req, env, { error: `${key} 中存在非对象记录，已中止导入` }, 400)
          }
          await writeJSON(env, `${key}.json`, arr, `ai import ${key}`)
          results.push({ key, count: arr.length })
        }
        // 库存是采购/销售的派生数据，导入时不再直接写入（与 /stock 禁止直写的策略一致），
        // 由下面的 syncDerived 按单据重建，避免与单据脱节产生漂移

        // 关键：只把「本次确实导入了」的单据类型传给 syncDerived。
        // 若把空数组传进去，会用空销售重算 → 库存只加不减、商品销售历史被清空。
        const pImport = (parsed.purchases && parsed.purchases.length) ? parsed.purchases : undefined
        const sImport = (parsed.sales && parsed.sales.length) ? parsed.sales : undefined
        if (pImport || sImport) {
          await syncDerived(env, { purchases: pImport, sales: sImport })
          results.push({ key: 'derived', count: 3 })
        }

        const logs = await readJSON(env, 'logs.json')
        logs.push({ time: new Date().toISOString(), source: 'ai', results })
        // 只保留最近 200 条：日志无上限增长会让文件突破 GitHub 的读取上限
        await writeJSON(env, 'logs.json', logs.slice(-200), 'append log')

        return json(req, env, { ok: true, results })
      }
      // 分类合并导入：单类数据按主键与库内现有记录比对去重后「追加」，
      // 不覆盖、不删除已有数据（与上面 /import 的整表覆盖语义互补：
      // 那个面向 AI 全量导入，这个面向人工补录/换设备迁移/外部数据合并）。
      // 前端导入前会用同一份 dedupe 逻辑先做预览，两边口径一致。
      if (path === '/import-merge') {
        const key = typeof body.key === 'string' ? body.key : ''
        const records = body.records
        if (!isValidImportKey(key)) {
          return json(req, env, { error: `不支持的导入类型：${key || '（未提供）'}` }, 400)
        }
        if (!Array.isArray(records) || !records.length) {
          return json(req, env, { error: '导入内容为空' }, 400)
        }
        if (records.length > 5000) {
          return json(req, env, { error: '单次导入超过 5000 条上限，请分批导入' }, 400)
        }
        if (records.some(x => !x || typeof x !== 'object' || Array.isArray(x))) {
          return json(req, env, { error: '存在非对象记录，已中止导入' }, 400)
        }

        const existing = await readJSON(env, `${key}.json`)
        const { added, skippedKey, skippedName, invalid } = diffImport(key, records, existing || [])
        const stats = {
          added: added.length,
          skippedKey: skippedKey.length,
          skippedName: skippedName.length,
          invalid: invalid.length
        }
        // 全部重复/无效时不必写库，直接回结果（前端预览与这里可能因并发略有差异，以这里为准）
        if (!added.length) {
          return json(req, env, { ok: true, ...stats, total: (existing || []).length })
        }
        // 单据类落库前过一遍收付款规范化：与 /purchases、/sales、/import 同一缺陷同一修法，
        // 杜绝「payments 空数组 + 旧 paid/received」造成实付漏算、幽灵欠款
        const finalAdded = (key === 'purchases' || key === 'sales')
          ? added.map(o => normalizeOrderPayments(o, key === 'purchases' ? 'paid' : 'received'))
          : added
        const merged = (existing || []).concat(finalAdded)
        await writeJSON(env, `${key}.json`, merged, `merge import ${key}`)

        if (key === 'items') {
          // 与 POST /items 同策略：商品导入后重算供应商档案里的商品列表（products 是派生字段）
          try {
            const suppliers = await readJSON(env, 'suppliers.json')
            const synced = (suppliers || []).map(s => ({
              ...s,
              products: merged.filter(i => (i.suppliers || []).includes(s.code)).map(i => i.code)
            }))
            await writeJSON(env, 'suppliers.json', synced, 'sync supplier products after merge import')
          } catch (e) {
            return json(req, env, { error: `商品已导入，但供应商的商品列表同步失败（${e.message || e}）。请重新保存一次商品，系统会自动重建` }, 500)
          }
        }
        // 采购/销售单导入后必须按全部单据重算派生数据（商品链接、历史价、库存、客户档案）；
        // 只传本次合并后的完整数组，另一类单据由 syncDerived 读库内现值，互不影响
        if (key === 'purchases') await syncDerived(env, { purchases: merged })
        if (key === 'sales') await syncDerived(env, { sales: merged })

        const logs = await readJSON(env, 'logs.json')
        logs.push({ time: new Date().toISOString(), source: 'merge', key, ...stats })
        await writeJSON(env, 'logs.json', logs.slice(-200), 'append log')

        return json(req, env, { ok: true, ...stats, total: merged.length })
      }
    }

    return json(req, env, { error: 'Not Found' }, 404)
  } catch (e) {
    return json(req, env, { error: e.message || String(e) }, 500)
  }
}
