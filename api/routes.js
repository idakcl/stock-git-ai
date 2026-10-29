import { readJSON, writeJSON, readJSONWithRaw, serialize } from './github.js'
import { readCollection, readCollectionWithRaw, writeCollection, sortOrders, SPLIT_KEYS } from './storage.js'
import { refundTransaction } from './refunds.js'
import { checkLogin, verifyToken, bearer, corsHeaders } from './auth.js'
import { diffImport, isValidImportKey } from '../src/utils/dedupe.js'

function json(req, env, res, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req, env) }
  })
}

// 资金单据集合（receipts.json / payment-vouchers.json）是后期新增的文件，
// 老数据仓里可能根本不存在，GitHub 对不存在的路径返回 404 并由 readJSON 抛错。
// 若直接让它冒泡，「来往账」「收付款单」两个页面会整体读失败：页面看起来就是「没有任何信息」，
// 欠款金额明明算得出来却显示空白。因此这两个文件按「可为空」处理，首次开单时自动创建。
// 仅限这两个文件：单据、商品、档案等主数据缺失必须照常报错——
// 写接口语义是整表覆盖，把读失败当成空数组，下一次写入就等于把全量数据清空。
async function readOptionalArray(env, file) {
  try {
    return await readJSON(env, file)
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (/GitHub 404/.test(msg)) return []
    throw e
  }
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

// 从采购单/销售单推导：商品与供应商/客户的关系链接、历史采购价/销售价、库存。
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
    if (code) itemByCode[code] = it
    if (name) itemByName[name] = it
    return it
  }

  // 历史由单据「重建」（幂等），不从已有 history 追加
  const purchaseHist = {}
  const saleHist = {}
  // 每个商品只保留去重后的成交客户名，供商品页「按客户筛选」；完整销售历史改由
  // GET /api/sale-history 按需返回，避免 items.json 随累计销售行数无限增长。
  const saleCustomerMap = {}
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
        qty: num(l.qty), price: money2(l.price), total: money2(l.total),
        return: num(l.qty) < 0 || undefined
      })
      // 退货行（红字）不更新商品档案进价：退货价可能与原单进价不一致（如原单促销价、退货按原价），
      // 用它覆盖 it.cost 会污染成本档案；同理历史价里带 return:true 标记，商品页默认过滤。
      if (l.price != null && Number.isFinite(Number(l.price)) && num(l.qty) >= 0) it.cost = money2(l.price)
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
        qty: num(l.qty), price: money2(l.price), total: money2(l.total),
        return: num(l.qty) < 0 || undefined
      })
      if (s.customer) (saleCustomerMap[it.code] = saleCustomerMap[it.code] || new Set()).add(s.customer)
      // 退货行（红字）不更新商品档案售价：退货价≠原单成交价时会污染售价档案
      if (l.price != null && Number.isFinite(Number(l.price)) && num(l.qty) >= 0) it.price = money2(l.price)
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
    // 销售历史不再内嵌 items.json：只保留去重后的成交客户名供筛选，
    // 完整明细由 GET /api/sale-history 按需返回，避免文件随累计销售行数增长。
    delete it.saleHistory
    if (saleCustomerMap[it.code] && saleCustomerMap[it.code].size) {
      it.saleCustomers = [...saleCustomerMap[it.code]]
    } else {
      delete it.saleCustomers
    }
    // 历史采购价不再内嵌进 items.json：它 100% 可由 purchases.json 重建，且只有商品行「展开历史价」才用得到。
    // 实测 1559 个商品 / 2492 行历史 ≈ 390KB，占整个 items.json 的 41%——过去每存一张单都要整表重写这 390KB，
    // 纯属浪费（一次存单要顺序重写 items/suppliers/stock/purchases/sales 五个文件）。
    // 改由 GET /api/purchase-history 按需返回（派生结果随本函数一起产出，口径完全一致），存量数据在此一并清除。
    delete it.purchaseHistory
  }

  // 双向链接：供应商.products 由商品.suppliers 反推
  for (const s of suppliers) {
    s.products = items.filter(i => (i.suppliers || []).includes(s.code)).map(i => i.code)
  }
  // history：{ 商品编码: [历史采购行] }，供 GET /api/purchase-history 按需返回
  // saleHistory：{ 商品编码: [历史销售行] }，供 GET /api/sale-history 按需返回
  // 落库前统一瘦身：近乎恒空的字段不占字节（见 pruneItem）
  return {
    items: items.map(pruneItem),
    suppliers,
    customers,
    purchases,
    sales,
    history: purchaseHist,
    saleHistory: saleHist
  }
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
      if (num2(l.qty) >= 0 && l.price != null && Number.isFinite(Number(l.price))) costByCode[code] = Number(l.price)
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

// 派生写回。known 是「本轮已经读过的文件原文快照」（readCollectionWithRaw / writeCollection 的产物），
// 复用它可以省掉每个文件「只为拿 sha 再读一遍」的 GET + base64 解码（实测约占一次存单读侧成本的一半）。
// 同时先比内存：派生结果与库里现值逐字节相同就整条跳过这次写。
async function syncDerived(env, { purchases, sales, known }) {
  const provided = new Map((known || []).map(k => [k.file, k]))
  const knownOf = (file) => {
    const k = provided.get(file)
    return k && k.sha ? { content: k.content, sha: k.sha } : null
  }
  // 读现值：known 里有就用，没有才回源
  const readOnce = async (file) => {
    const k = provided.get(file)
    if (k && k.sha) return { content: k.content, value: JSON.parse(k.content), sha: k.sha }
    const r = await readJSONWithRaw(env, file)
    provided.set(file, { file, content: r.content, sha: r.sha })
    return r
  }
  const [itemsR, suppliersR, customersR, stockR] = await Promise.all([
    readOnce('items.json'),
    readOnce('suppliers.json'),
    readOnce('customers.json'),
    readOnce('stock.json')
  ])
  // 单据：本次入参就是全量权威（前端整表回传）；未参与本次操作的另一类由存储层读库
  const pState = purchases != null
    ? { value: purchases, content: null, sha: null }                 // 调用方刚落库，内容 = 入参
    : await readCollectionWithRaw(env, 'purchases')
  const sState = sales != null
    ? { value: sales, content: null, sha: null }
    : await readCollectionWithRaw(env, 'sales')
  if (purchases == null) for (const k of (pState.known || [])) provided.set(k.file, k)
  if (sales == null) for (const k of (sState.known || [])) provided.set(k.file, k)

  const items = itemsR.value, suppliers = suppliersR.value, customers = customersR.value
  const p = pState.value, s = sState.value
  const derived = derive(items, suppliers, p, s, customers)
  const { items: newItems, suppliers: newSuppliers, customers: newCustomers, purchases: newP, sales: newS } = derived
  // derive 是「由单据全量重建」的纯函数，正常情况下不可能把非空档案推导成空。
  // 一旦出现，说明上游读取异常（例如 GitHub 对大文件返回空内容），
  // 此时宁可报错中止，也不能把空数组写回去覆盖真实数据。
  if (items.length && !newItems.length) {
    throw new Error('派生结果为空，疑似上游数据读取异常，已中止以避免覆盖商品档案')
  }
  const stock = rebuildStock(p, s, newItems)
  // unchanged(现值原文, 新数据)：现值原文缺失（本轮没读过，比如刚被调用方写过）
  // 一律按「可能要写」处理，交给存储层自己比。
  const unchanged = (state, data) => typeof state.content === 'string' && state.content === serialize(data)
  // 三个文件顺序写入，无跨文件事务：中途失败时前面的文件已落库。
  // derive 是纯函数（由单据重建），重新保存一次采购单/销售单即可自动修复，故失败时给出明确修复指引。
  try {
    if (!unchanged(itemsR, newItems)) {
      await writeJSON(env, 'items.json', newItems, 'derive items', { known: knownOf('items.json') })
    }
    if (!unchanged(suppliersR, newSuppliers)) {
      await writeJSON(env, 'suppliers.json', newSuppliers, 'derive suppliers', { known: knownOf('suppliers.json') })
    }
    if (!unchanged(stockR, stock)) {
      await writeJSON(env, 'stock.json', stock, 'derive stock', { known: knownOf('stock.json') })
    }
    // 客户：仅当销售单里出现了名单中原本没有的新客户时才写回，
    // 避免每次保存销售单都给 customers.json 产生一条内容不变的空提交
    if (newCustomers.length > customers.length && !unchanged(customersR, newCustomers)) {
      await writeJSON(env, 'customers.json', newCustomers, 'derive customers', { known: knownOf('customers.json') })
    }
    // 回写修正后的单据：存量乱码编码（N…）已改写为正式 P 编码。
    // p/s 为本次全量（传入的整表或读库现值），derive 仅就地修正 line.code，不增删条目，幂等安全
    if (!unchanged(pState, newP)) {
      await writeCollection(env, 'purchases', newP, 'derive fix purchase codes', { known: [...provided.values()] })
    }
    if (!unchanged(sState, newS)) {
      await writeCollection(env, 'sales', newS, 'derive fix sale codes', { known: [...provided.values()] })
    }
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
    // 历史采购价：按需派生（不再内嵌 items.json，见 derive 中的说明）。
    // 只在商品行「展开历史价」时请求一次；结果与 derive 完全同源，不存在两套口径。
    if (path === '/purchase-history' && method === 'GET') {
      const [items, suppliers, purchases, sales, customers] = await Promise.all([
        readJSON(env, 'items.json'),
        readJSON(env, 'suppliers.json'),
        readCollection(env, 'purchases'),
        readCollection(env, 'sales'),
        readJSON(env, 'customers.json')
      ])
      return json(req, env, derive(items, suppliers, purchases, sales, customers).history)
    }
    // 历史销售价：商品行展开时按需返回，口径与 derive 一致
    if (path === '/sale-history' && method === 'GET') {
      const [items, suppliers, purchases, sales, customers] = await Promise.all([
        readJSON(env, 'items.json'),
        readJSON(env, 'suppliers.json'),
        readCollection(env, 'purchases'),
        readCollection(env, 'sales'),
        readJSON(env, 'customers.json')
      ])
      return json(req, env, derive(items, suppliers, purchases, sales, customers).saleHistory)
    }
    if (path === '/suppliers' && method === 'GET') return json(req, env, await readJSON(env, 'suppliers.json'))
    if (path === '/customers' && method === 'GET') return json(req, env, await readJSON(env, 'customers.json'))
    if (path === '/purchases' && method === 'GET') return json(req, env, await readCollection(env, 'purchases'))
    if (path === '/sales' && method === 'GET') return json(req, env, await readCollection(env, 'sales'))
    if (path === '/receipts' && method === 'GET') return json(req, env, await readOptionalArray(env, 'receipts.json'))
    if (path === '/payment-vouchers' && method === 'GET') return json(req, env, await readOptionalArray(env, 'payment-vouchers.json'))
    if (path === '/refunds' && method === 'GET') return json(req, env, await readOptionalArray(env, 'refunds.json'))
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
        // 整表覆盖前先剥掉历史采购价：items.json 已不再保存该字段，
        // 老前端/导入数据把旧数组带回来时也不该让它重新长回去（derive 会在下次存单时再清一次）
        // 再统一 pruneItem：与 derive 落库口径一致，否则手改一次商品就把空字段写回去了
        const newItems = (body.items || []).map(({ purchaseHistory, ...it }) => pruneItem(it))
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
      // 退款业务只接收操作指令，不允许整表覆盖退款凭证。
      if (path === '/refunds') {
        return json(req, env, await refundTransaction(env, body, derive, rebuildStock))
      }
      if (path === '/purchases') {
        // 写入端规范化：见 normalizeOrderPayments——堵住「payments 空数组 + 旧 paid」实付漏算缺陷
        // sortOrders：与存储层落库次序同一口径，派生（库存/历史价）才不会因次序不同而每次算出不同结果
        const purchases = sortOrders((body.purchases || []).map(p => normalizeOrderPayments(p, 'paid')))
        const w = await writeCollection(env, 'purchases', purchases, 'update purchases')
        await syncDerived(env, { purchases, known: w.known })
        return json(req, env, { ok: true })
      }
      if (path === '/sales') {
        const sales = sortOrders((body.sales || []).map(s => normalizeOrderPayments(s, 'received')))
        const w = await writeCollection(env, 'sales', sales, 'update sales')
        await syncDerived(env, { sales, known: w.known })
        return json(req, env, { ok: true })
      }
      // 数据整理：重跑一次全量 derive 并写回，把历史单据里残留的乱码编码（N…）改回正式 P 编码，
      // 同时重建商品历史价、库存、供应商链接。等价于把每张单据各保存一次，但一次请求完成。
      // derive 仅就地修正 line.code 与重建派生字段，不增删条目、不改金额/数量，幂等安全
      if (path === '/normalize' && method === 'POST') {
        const [items, suppliers, customers, purchases, sales] = await Promise.all([
          readJSON(env, 'items.json'),
          readJSON(env, 'suppliers.json'),
          readJSON(env, 'customers.json'),
          readCollection(env, 'purchases'),
          readCollection(env, 'sales')
        ])
        const derived = derive(items, suppliers, purchases, sales, customers)
        // derive 是「由单据全量重建」的纯函数，正常情况下不可能把非空档案推导成空。
        // 一旦出现，说明上游读取异常，宁可报错中止，也不能把空数组写回去覆盖真实数据
        if (items.length && !derived.items.length) {
          throw new Error('派生结果为空，疑似上游数据读取异常，已中止以避免覆盖商品档案')
        }
        const stock = rebuildStock(derived.purchases, derived.sales, derived.items)
        try {
          await writeJSON(env, 'items.json', derived.items, 'normalize items')
          await writeJSON(env, 'suppliers.json', derived.suppliers, 'normalize suppliers')
          await writeJSON(env, 'stock.json', stock, 'normalize stock')
          // 客户：仅当销售单里出现了名单中原本没有的新客户时才写回
          if (derived.customers.length > customers.length) {
            await writeJSON(env, 'customers.json', derived.customers, 'normalize customers')
          }
          // 回写修正后的单据：存量乱码编码（N…）已改写为正式 P 编码
          await writeCollection(env, 'purchases', derived.purchases, 'normalize fix purchase codes')
          await writeCollection(env, 'sales', derived.sales, 'normalize fix sale codes')
        } catch (e) {
          throw new Error(`数据整理失败（${e.message || e}），未改动任何数据`)
        }
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
        if (parsed.purchases && parsed.purchases.length) parsed.purchases = sortOrders(parsed.purchases.map(p => normalizeOrderPayments(p, 'paid')))
        if (parsed.sales && parsed.sales.length) parsed.sales = sortOrders(parsed.sales.map(s => normalizeOrderPayments(s, 'received')))
        const results = []
        // 单据导入后 syncDerived 要复用这批「写后现状」，免得再把整表读第二遍
        const importedKnown = []
        for (const key of ['items', 'suppliers', 'customers', 'purchases', 'sales', 'receipts', 'payment-vouchers']) {
          const arr = parsed[key]
          if (!Array.isArray(arr) || !arr.length) continue
          if (arr.length > 5000) {
            return json(req, env, { error: `${key} 超过 5000 条上限，请分批导入` }, 400)
          }
          if (arr.some(x => !x || typeof x !== 'object' || Array.isArray(x))) {
            return json(req, env, { error: `${key} 中存在非对象记录，已中止导入` }, 400)
          }
          // items 导入同样剥掉历史采购价：该字段已由「按需派生」接管，不再进 items.json
          const payload = key === 'items' ? arr.map(({ purchaseHistory, ...it }) => pruneItem(it)) : arr
          const w = await writeCollection(env, key, payload, `ai import ${key}`)
          if (key === 'purchases' || key === 'sales') importedKnown.push(...w.known)
          results.push({ key, count: arr.length })
        }
        // 库存是采购/销售的派生数据，导入时不再直接写入（与 /stock 禁止直写的策略一致），
        // 由下面的 syncDerived 按单据重建，避免与单据脱节产生漂移

        // 关键：只把「本次确实导入了」的单据类型传给 syncDerived。
        // 若把空数组传进去，会用空销售重算 → 库存只加不减、商品销售历史被清空。
        const pImport = (parsed.purchases && parsed.purchases.length) ? parsed.purchases : undefined
        const sImport = (parsed.sales && parsed.sales.length) ? parsed.sales : undefined
        if (pImport || sImport) {
          await syncDerived(env, { purchases: pImport, sales: sImport, known: importedKnown })
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

        const existing = await readCollection(env, key)
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
        const stripped = key === 'items' ? finalAdded.map(({ purchaseHistory, ...it }) => pruneItem(it)) : finalAdded
        const merged = SPLIT_KEYS.has(key)
          ? sortOrders((existing || []).concat(stripped))
          : (existing || []).concat(stripped)
        const wMerged = await writeCollection(env, key, merged, `merge import ${key}`)

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
        if (key === 'purchases') await syncDerived(env, { purchases: merged, known: wMerged.known })
        if (key === 'sales') await syncDerived(env, { sales: merged, known: wMerged.known })

        const logs = await readJSON(env, 'logs.json')
        logs.push({ time: new Date().toISOString(), source: 'merge', key, ...stats })
        await writeJSON(env, 'logs.json', logs.slice(-200), 'append log')

        return json(req, env, { ok: true, ...stats, total: merged.length })
      }
    }

    return json(req, env, { error: 'Not Found' }, 404)
  } catch (e) {
    return json(req, env, { error: e.message || String(e) }, e.status === 400 ? 400 : /GitHub (409|422)/.test(e.message || '') ? 409 : 500)
  }
}
