// AI-API：给外部 AI（或脚本）用的「按密钥限权」接口。
//
// 与登录态接口的区别只有两点，其余口径完全对齐：
//   1. 凭据是 ai_live_... 密钥，权限由签发时勾选的 scope 决定；
//   2. 只开放「操作型」写接口，绝不提供整表覆盖（POST /sales 传全量那种）。
//      整表覆盖一旦被模型写错一个字段，丢的是整段历史；操作型接口最坏只错一张单，且可作废。
//
// 金额一律服务端重算：AI 只提供「商品编码 + 数量（+ 可选单价/折扣）」，单价默认取商品档案，
// 行金额、整单合计、应收应付全部由本文件算，不信任 AI 传来的 total。
// 所有写接口都要求 requestId（16~80 位字母数字/短横线），重试复用同一个值 → 不会重复开单。
import { readJSON } from './github.js'
import { readCollection } from './storage.js'
import { openTransaction, commitTransaction } from './tx.js'
import { corsHeaders } from './auth.js'
import { authenticateAi, assertScope, noteUsage } from './ai-keys.js'
import { recordAiLog, makeAiLog, logPathOf } from './ai-logs.js'
import { AI_ENDPOINTS, AI_SCOPE_GROUPS, AI_PRESETS } from '../src/utils/aiScopes.js'
import { genOrderId, nextEntityCode } from '../src/utils/code.js'
import { todayCN } from '../src/utils/time.js'
import { round2, receivableOf, payableOf, grossOf, receivedSumOf, paidSumOf, isVoided, syncPayments } from '../src/utils/account.js'
import { orderAmount, isUnposted } from '../src/utils/orders.js'
import { orderTransaction } from './orders.js'
import { refundTransaction } from './refunds.js'
import { voidTransaction } from './voids.js'
import { templateOperation, listTemplates } from './templates.js'
import { readProfile } from './profile.js'
import { depositWrite } from './ai-deposits.js'
import { paymentWrite } from './ai-payments.js'
import { amendTransaction } from './amends.js'
import { listShares, shareOperation } from './shares.js'

const V1 = '/api/ai/v1'
const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50
const MAX_LINES = 200

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e }

const json = (req, env, body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json',
    // 响应随密钥权限而变，且 Authorization 不参与边缘缓存键：必须禁止任何一层缓存
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    ...corsHeaders(req, env)
  }
})

// requestId 与退款业务同一约束：可重试、可幂等、不可伪造空串
function requestIdOf(input) {
  const id = String((input && input.requestId) || '').trim()
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(id)) {
    fail('缺少有效请求标识 requestId（16~80 位字母、数字或短横线；重试时请复用同一个值）')
  }
  return id
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))

function dateFilter(list, from, to) {
  if (from && !isDate(from)) fail('from 日期格式应为 YYYY-MM-DD')
  if (to && !isDate(to)) fail('to 日期格式应为 YYYY-MM-DD')
  return (list || []).filter(o => {
    const d = String(o && o.date || '')
    return (!from || d >= from) && (!to || d <= to)
  })
}

// 分页：cursor 就是「下一段的起始下标」，足够简单且无状态（Worker 不保存会话）
function paginate(list, url) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT))
  const start = Math.max(0, Math.floor(Number(url.searchParams.get('cursor')) || 0))
  const slice = list.slice(start, start + limit)
  const next = start + slice.length
  return { total: list.length, nextCursor: next < list.length ? String(next) : null, slice }
}

const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000

function itemView(it, stock, withCost) {
  const s = stock[it.code] || {}
  const out = {
    code: it.code, name: it.name, unit: it.unit || '',
    price: Number(it.price || 0),
    spec: it.spec || it.package || '',
    stock: Number(s.qty || 0),
    warning: Number(it.warning || 0)
  }
  // 进价/成本是底价：只有明确勾了「看进价与毛利」才返回
  if (withCost) out.cost = Number(it.cost || s.cost || 0)
  return out
}

function docView(o, kind) {
  const isSale = kind === 'sale'
  return {
    id: o.id,
    date: o.date || '',
    party: o[isSale ? 'customer' : 'supplier'] || '',
    total: round2(Number(o.total || 0)),
    gross: grossOf(o),
    paid: isSale ? receivedSumOf(o) : paidSumOf(o),
    unpaid: isSale ? receivableOf(o) : payableOf(o),
    settle: o.settle || '',
    status: o.status || '',
    remark: o.remark || '',
    createdAt: o.createdAt || '',
    createdBy: o.createdBy || ''
  }
}

// 资金单据（收款单 / 付款单）：新集合可能还没创建，缺失按空表处理
async function readOptionalArray(env, file) {
  try {
    const v = await readJSON(env, file)
    return Array.isArray(v) ? v : []
  } catch (e) {
    if (/GitHub 404/.test(String((e && e.message) || e))) return []
    throw e
  }
}

async function readVouchers(url, env) {
  const type = String(url.searchParams.get('type') || 'all')
  if (!['all', 'receivable', 'payable'].includes(type)) fail('type 只能是 all / receivable / payable')
  const [receipts, pays] = await Promise.all([
    readOptionalArray(env, 'receipts.json'),
    readOptionalArray(env, 'payment-vouchers.json')
  ])
  const from = String(url.searchParams.get('from') || '')
  const to = String(url.searchParams.get('to') || '')
  if (from && !isDate(from)) fail('from 日期格式应为 YYYY-MM-DD')
  if (to && !isDate(to)) fail('to 日期格式应为 YYYY-MM-DD')
  const party = String(url.searchParams.get('party') || '').trim()
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
  let list = [
    ...receipts.map(v => ({ ...v, kind: 'receivable' })),
    ...pays.map(v => ({ ...v, kind: 'payable' }))
  ]
  if (type !== 'all') list = list.filter(v => v.kind === type)
  list = list.filter(v => {
    const d = String(v.date || '')
    if (from && d < from) return false
    if (to && d > to) return false
    if (party && v.party !== party) return false
    if (q) {
      const hay = [v.code, v.party, v.remark, ...(v.items || []).map(it => it.orderId)].join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
  list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.code || '').localeCompare(String(a.code || '')))
  const { total, nextCursor, slice } = paginate(list, url)
  return {
    total,
    nextCursor,
    vouchers: slice.map(v => ({
      code: v.code || '',
      kind: v.kind,
      category: v.category || 'normal',
      party: v.party || '',
      date: v.date || '',
      total: round2(Number(v.total || 0)),
      remark: v.remark || '',
      createdAt: v.createdAt || '',
      items: (v.items || []).map(it => ({
        orderId: it.orderId || '', orderType: it.orderType || '',
        amount: round2(Number(it.amount || 0)), settle: it.settle || '', note: it.note || ''
      }))
    }))
  }
}

// ---- 读接口 ----

async function readItems(url, env, ctx) {
  const [items, stock] = await Promise.all([
    readJSON(env, 'items.json'),
    readJSON(env, 'stock.json').catch(e => {
      if (/GitHub 404/.test(String(e && e.message || e))) return {}
      throw e
    })
  ])
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
  const withCost = ctx.scopes.has('read:cost')
  let list = (items || []).filter(it => !q || String(it.code || '').toLowerCase().includes(q) || String(it.name || '').toLowerCase().includes(q))
  list = list.map(it => itemView(it, stock || {}, withCost))
  const { total, nextCursor, slice } = paginate(list, url)
  return { total, nextCursor, items: slice }
}

async function readStock(url, env, ctx) {
  const [items, stock] = await Promise.all([
    readJSON(env, 'items.json'),
    readJSON(env, 'stock.json').catch(e => {
      if (/GitHub 404/.test(String(e && e.message || e))) return {}
      throw e
    })
  ])
  const withCost = ctx.scopes.has('read:cost')
  const low = url.searchParams.get('low') === '1'
  const nameOf = new Map((items || []).map(i => [i.code, i]))
  let list = Object.keys(stock || {}).map(code => {
    const it = nameOf.get(code) || { code, name: code, unit: '', warning: 0 }
    const out = { code, name: it.name, unit: it.unit || '', qty: Number((stock[code] || {}).qty || 0) }
    if (withCost) out.cost = Number((stock[code] || {}).cost || it.cost || 0)
    return out
  })
  if (low) list = list.filter(r => r.qty <= 0)
  list.sort((a, b) => a.qty - b.qty || String(a.code).localeCompare(String(b.code)))
  const { total, nextCursor, slice } = paginate(list, url)
  return { total, nextCursor, items: slice }
}

async function readOrders(url, env) {
  let orders = []
  try { orders = await readJSON(env, 'orders.json') } catch (e) {
    if (!/GitHub 404/.test(String(e && e.message || e))) throw e
  }
  const status = String(url.searchParams.get('status') || '')
  const party = String(url.searchParams.get('party') || '').trim()
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
  const include = url.searchParams.get('include') === 'lines'
  let list = dateFilter(orders || [], url.searchParams.get('from'), url.searchParams.get('to'))
  if (status) {
    const wantDraft = status === 'draft' || status === '未过账'
    list = list.filter(o => (wantDraft ? isUnposted(o.status) : o.status === '已过账'))
  }
  list = list.filter(o => !party || o.customer === party || o.supplier === party)
  list = list.filter(o => !q || String(o.id || '').toLowerCase().includes(q))
  list = list.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id || '').localeCompare(String(a.id || '')))
  const { total, nextCursor, slice } = paginate(list, url)
  return {
    total,
    nextCursor,
    orders: slice.map(o => {
      const out = {
        id: o.id, kind: o.kind, date: o.date || '',
        party: o[o.kind === 'purchase' ? 'supplier' : 'customer'] || '',
        status: isUnposted(o.status) ? '未过账' : '已过账',
        postedOrderId: o.postedOrderId || '',
        amount: orderAmount(o),
        remark: o.remark || '',
        createdAt: o.createdAt || ''
      }
      if (include) out.items = (o.items || []).map(l => ({ code: l.code, name: l.name, unit: l.unit || '', qty: Number(l.qty || 0), price: Number(l.price || 0), total: Number(l.total || 0) }))
      return out
    })
  }
}

async function readDocs(kind, url, env) {
  const list = await readCollection(env, kind === 'sale' ? 'sales' : 'purchases')
  const partyKey = kind === 'sale' ? 'customer' : 'supplier'
  const party = String(url.searchParams.get('party') || '').trim()
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
  const type = String(url.searchParams.get('type') || '')
  const include = url.searchParams.get('include') === 'lines'
  let rows = dateFilter(list, url.searchParams.get('from'), url.searchParams.get('to'))
  if (party) rows = rows.filter(o => o[partyKey] === party)
  if (q) rows = rows.filter(o => String(o.id || '').toLowerCase().includes(q))
  if (type === 'return') rows = rows.filter(o => Number(o.total) < 0 || String(o.type || '').endsWith('-return'))
  if (type === 'normal') rows = rows.filter(o => !(Number(o.total) < 0 || String(o.type || '').endsWith('-return')))
  rows = rows.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id || '').localeCompare(String(a.id || '')))
  const { total, nextCursor, slice } = paginate(rows, url)
  return {
    total,
    nextCursor,
    docs: slice.map(o => {
      const out = docView(o, kind)
      if (include) out.items = (o.items || []).map(l => ({ code: l.code, name: l.name, unit: l.unit || '', qty: Number(l.qty || 0), price: Number(l.price || 0), total: Number(l.total || 0) }))
      return out
    })
  }
}

function partyBalance(type, name, sales, purchases) {
  const docs = type === 'supplier' ? purchases : sales
  let gross = 0, paid = 0, unpaid = 0, open = 0
  for (const o of docs) {
    if (o[type === 'supplier' ? 'supplier' : 'customer'] !== name) continue
    if (isVoided(o)) continue
    const g = grossOf(o)
    const p = type === 'supplier' ? paidSumOf(o) : receivedSumOf(o)
    const u = type === 'supplier' ? payableOf(o) : receivableOf(o)
    gross = round2(gross + g); paid = round2(paid + p); unpaid = round2(unpaid + u)
    if (Math.abs(u) > 1e-6) open += 1
  }
  return { gross, paid, unpaid, open }
}

async function readParties(url, env) {
  const type = String(url.searchParams.get('type') || 'customer')
  if (!['customer', 'supplier'].includes(type)) fail('type 只能是 customer 或 supplier')
  const [customers, suppliers, sales, purchases] = await Promise.all([
    readJSON(env, 'customers.json'),
    readJSON(env, 'suppliers.json'),
    readCollection(env, 'sales'),
    readCollection(env, 'purchases')
  ])
  const source = type === 'supplier' ? suppliers : customers
  const onlyOpen = url.searchParams.get('open') === '1'
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
  const rows = (source || []).map(p => {
    const b = partyBalance(type, p.name, sales, purchases)
    return {
      type, code: p.code || '', name: p.name || '',
      contact: p.contact || '', phone: p.phone || '',
      balance: b.unpaid, total: b.gross, paid: b.paid, openDocs: b.open,
      // 预存款 / 预付款可用余额：AI 判断能不能抵扣、要不要充值先看这个
      prepaid: round2(((type === 'supplier' ? p.advances : p.deposits) || []).reduce((s, f) => s + Number(f && f.amount || 0), 0))
    }
  }).filter(r => (!onlyOpen || Math.abs(r.balance) > 1e-6)
    && (!q || String(r.name).toLowerCase().includes(q) || String(r.code).toLowerCase().includes(q)))
  rows.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance) || String(a.name).localeCompare(String(b.name)))
  const { total, nextCursor, slice } = paginate(rows, url)
  return { total, nextCursor, parties: slice }
}

async function readLedger(url, env) {
  const party = String(url.searchParams.get('party') || '').trim()
  if (!party) fail('请提供 party（往来单位名称）')
  const type = String(url.searchParams.get('type') || 'customer')
  if (!['customer', 'supplier'].includes(type)) fail('type 只能是 customer 或 supplier')
  const [profiles, sales, purchases] = await Promise.all([
    readJSON(env, type === 'supplier' ? 'suppliers.json' : 'customers.json'),
    readCollection(env, 'sales'),
    readCollection(env, 'purchases')
  ])
  const profile = (profiles || []).find(p => p.name === party)
  if (!profile) fail(`${type === 'supplier' ? '供应商' : '客户'}「${party}」不存在`, 404)
  const docs = (type === 'supplier' ? purchases : sales).filter(o => o[type === 'supplier' ? 'supplier' : 'customer'] === party)
  const rows = docs
    .slice()
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.id || '').localeCompare(String(b.id || '')))
    .map(o => docView(o, type === 'supplier' ? 'purchase' : 'sale'))
  const sum = (k) => round2(rows.reduce((s, r) => s + Number(r[k] || 0), 0))
  const deposits = type === 'supplier'
    ? round2((profile.advances || []).reduce((s, d) => s + Number(d.amount || 0), 0))
    : round2((profile.deposits || []).reduce((s, d) => s + Number(d.amount || 0), 0))
  return {
    party: profile.name,
    type,
    code: profile.code || '',
    contact: profile.contact || '',
    phone: profile.phone || '',
    balance: sum('unpaid'),
    prepaid: deposits,
    count: rows.length,
    totals: { gross: sum('gross'), paid: sum('paid'), unpaid: sum('unpaid') },
    docs: rows
  }
}

async function readSummary(url, env, ctx) {
  const from = url.searchParams.get('from') || ''
  const to = url.searchParams.get('to') || ''
  const [sales, purchases, orders] = await Promise.all([
    readCollection(env, 'sales'),
    readCollection(env, 'purchases'),
    readJSON(env, 'orders.json').catch(e => {
      if (/GitHub 404/.test(String(e && e.message || e))) return []
      throw e
    })
  ])
  const s = dateFilter(sales, from, to).filter(o => !isVoided(o))
  const p = dateFilter(purchases, from, to).filter(o => !isVoided(o))
  const revenue = round2(s.reduce((acc, o) => acc + grossOf(o), 0))
  const purchaseAmount = round2(p.reduce((acc, o) => acc + grossOf(o), 0))
  const receivableDocs = (sales || []).filter(o => !isVoided(o) && receivableOf(o) > 1e-6)
  const payableDocs = (purchases || []).filter(o => !isVoided(o) && payableOf(o) > 1e-6)
  const out = {
    from, to,
    sales: { count: s.length, amount: revenue, collected: round2(s.reduce((acc, o) => acc + receivedSumOf(o), 0)) },
    purchases: { count: p.length, amount: purchaseAmount, paid: round2(p.reduce((acc, o) => acc + paidSumOf(o), 0)) },
    orders: {
      count: (orders || []).length,
      drafts: (orders || []).filter(o => isUnposted(o.status)).length
    },
    receivable: { total: round2(receivableDocs.reduce((acc, o) => acc + receivableOf(o), 0)), openCount: receivableDocs.length },
    payable: { total: round2(payableDocs.reduce((acc, o) => acc + payableOf(o), 0)), openCount: payableDocs.length }
  }
  // 毛利只看「勾了看进价」的密钥；成本按商品档案当前 cost，不追溯历史成本
  if (ctx.scopes.has('read:cost')) {
    const items = await readJSON(env, 'items.json')
    const costOf = new Map((items || []).map(i => [i.code, Number(i.cost || 0)]))
    let cost = 0
    for (const o of s) for (const l of (o.items || [])) cost += Number(l.qty || 0) * (costOf.get(l.code) || 0)
    out.cost = round2(cost)
    out.margin = round2(revenue - cost)
  }
  return out
}

// ---- 写接口 ----

// 直接开单：服务端按商品档案重算每一行，客户/供应商必须已建档（防手滑造出新名字）。
function buildDirectDoc(kind, input, state, keyName, requestId, now) {
  const isSale = kind === 'sale'
  const partyKey = isSale ? 'customer' : 'supplier'
  const partyLabel = isSale ? '客户' : '供应商'
  const party = String(input[partyKey] || '').trim()
  if (!party) fail(`请填写${partyLabel}名称（${partyKey}）`)
  const parties = isSale ? (state.customers || []) : (state.suppliers || [])
  if (!parties.some(p => p.name === party)) {
    fail(`${partyLabel}「${party}」还没有档案；请先用 POST /api/ai/v1/master 建档，或使用已有名称`)
  }
  const date = input.date ? String(input.date) : todayCN()
  if (!isDate(date)) fail('date 格式应为 YYYY-MM-DD')
  const raw = Array.isArray(input.items) ? input.items : []
  if (!raw.length) fail('至少要有 1 行商品明细（items）')
  if (raw.length > MAX_LINES) fail(`单张单据最多 ${MAX_LINES} 行明细`)
  const byCode = new Map((state.items || []).map(i => [i.code, i]))
  const lines = raw.map((l, i) => {
    if (!l || typeof l !== 'object') fail(`第 ${i + 1} 行明细不是合法对象`)
    const code = String(l.code || '').trim()
    const it = byCode.get(code)
    if (!it) fail(`第 ${i + 1} 行商品编码「${code || '（空）'}」不在商品库；请先查 GET /api/ai/v1/items`)
    const qty = Number(l.qty)
    if (!(qty > 0)) fail(`第 ${i + 1} 行数量必须大于 0`)
    const fallback = Number(isSale ? it.price : it.cost) || 0
    const price = l.price == null || l.price === '' ? fallback : Number(l.price)
    if (!Number.isFinite(price) || price < 0) fail(`第 ${i + 1} 行单价不能为负`)
    const rate = l.discountRate == null ? 1 : Number(l.discountRate)
    if (!(rate >= 0 && rate <= 1)) fail(`第 ${i + 1} 行折扣率必须在 0~1 之间（1＝不打折）`)
    const gross = round2(qty * price)
    const total = Math.max(0, round2(gross - round2(gross * (1 - rate))))
    return { code: it.code, name: it.name, unit: it.unit || '', qty, price, discountRate: round4(rate), discount: round2(gross - total), total }
  })
  const list = isSale ? (state.sales || []) : (state.purchases || [])
  const discount = round2(Number(input.discount || 0))
  if (discount < 0) fail('整单优惠 discount 不能为负')
  const total = round2(lines.reduce((s, l) => s + l.total, 0))
  const doc = {
    id: genOrderId(isSale ? 'X' : 'C', list, date),
    [partyKey]: party,
    date,
    items: lines,
    total,
    discount,
    discountRates: [],
    discountRate: 1,
    payments: [],
    [isSale ? 'received' : 'paid']: 0,
    settle: '挂账',
    remark: String(input.remark || '').slice(0, 500),
    photos: Array.isArray(input.photos) ? input.photos.filter(p => /^https?:\/\//i.test(String(p))).slice(0, 20) : [],
    createdBy: `ai:${keyName}`,
    aiRequestId: requestId,
    createdAt: now
  }
  // 结算状态按金额判定（全站口径）：0 元单直接结清，其余挂账
  return syncPayments(doc, isSale ? 'receivable' : 'payable')
}

async function createDirectDoc(kind, input, env, ctx, deps, requestId) {
  const tx = await openTransaction(env, ['items', 'suppliers', 'customers', 'purchases', 'sales', 'stock', 'logs'])
  const now = new Date().toISOString()
  const dup = [...(tx.state.sales || []), ...(tx.state.purchases || [])].find(o => o.aiRequestId === requestId)
  if (dup) return { ok: true, duplicate: true, id: dup.id, kind }
  const doc = buildDirectDoc(kind, input, tx.state, ctx.key.name, requestId, now)
  const next = { ...tx.state }
  if (kind === 'sale') next.sales = [...(tx.state.sales || []), doc]
  else next.purchases = [...(tx.state.purchases || []), doc]
  Object.assign(next, deps.derive(next.items, next.suppliers, next.purchases, next.sales, next.customers))
  next.stock = deps.rebuildStock(next.purchases, next.sales, next.items)
  const r = await commitTransaction(tx, {
    next,
    message: `ai: create ${kind} ${doc.id} by ${ctx.key.name}`,
    logEntry: { source: 'ai', action: `create-${kind}`, code: doc.id, key: ctx.key.name, keyId: ctx.key.id }
  })
  return { ok: true, id: doc.id, kind, amount: grossOf(doc), commit: r.unchanged ? undefined : r.sha }
}

const ITEM_FIELDS = ['name', 'unit', 'price', 'cost', 'warning', 'package', 'spec', 'priceWholesale', 'priceInstaller', 'remark', 'barcode']
// 商品照片与「供应商挂靠」不是标量，单独校验（照片只收 http(s) 链接，供应商只收已存在的编码）
const PARTY_FIELDS = ['name', 'contact', 'phone', 'address', 'remark']
const MAX_PHOTOS = 20
const MAX_ITEM_SUPPLIERS = 50

function applyMaster(state, input) {
  const type = String(input.type || '')
  const action = String(input.action || 'upsert')
  if (!['item', 'customer', 'supplier'].includes(type)) fail('type 只能是 item / customer / supplier')
  if (!['upsert', 'delete'].includes(action)) fail('action 只能是 upsert 或 delete')
  const listKey = type === 'item' ? 'items' : type === 'customer' ? 'customers' : 'suppliers'
  const list = Array.isArray(state[listKey]) ? state[listKey].slice() : []
  const data = (input[type] && typeof input[type] === 'object') ? input[type] : {}
  const code = String(data.code || input.code || '').trim()
  const name = String(data.name || input.name || '').trim()
  const idx = code
    ? list.findIndex(x => x.code === code)
    : name ? list.findIndex(x => x.name === name) : -1
  // upsert 时显式给了编码却不存在：多半是 AI 猜错了编码，静默新建一个别的编码只会让人更困惑
  if (action === 'upsert' && code && idx < 0) {
    fail(`${type} 编码「${code}」不存在；新增请只填 name，编码由系统自动生成`, 404)
  }

  if (action === 'delete') {
    if (idx < 0) fail(`${type} 不存在`, 404)
    const target = list[idx]
    if (type === 'item') {
      const used = [...(state.sales || []), ...(state.purchases || []), ...(state.orders || [])]
        .some(o => (o.items || []).some(l => l.code === target.code))
      if (used) fail(`商品「${target.name}」已被单据引用，不能删除；请改名或停用`, 409)
    } else {
      const partyKey = type === 'customer' ? 'customer' : 'supplier'
      const used = [...(state.sales || []), ...(state.purchases || [])].some(o => o[partyKey] === target.name)
      if (used) fail(`${type === 'customer' ? '客户' : '供应商'}「${target.name}」已被单据引用，不能删除`, 409)
      const flows = type === 'customer' ? target.deposits : target.advances
      if ((flows || []).length) fail(`「${target.name}」还有预${type === 'customer' ? '存' : '付'}款流水，不能删除`, 409)
    }
    list.splice(idx, 1)
    return { next: { ...state, [listKey]: list }, code: target.code, name: target.name }
  }

  // upsert：有 code 按 code、否则按名字匹配；都没有就新建（code 自动生成）
  const nextRecord = idx >= 0 ? { ...list[idx] } : {}
  const fields = type === 'item' ? ITEM_FIELDS : PARTY_FIELDS
  for (const f of fields) {
    if (!(f in data)) continue
    const v = data[f]
    if (['price', 'cost', 'warning', 'priceWholesale', 'priceInstaller'].includes(f)) {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) fail(`${f} 必须是非负数字`)
      nextRecord[f] = round2(n)
    } else {
      nextRecord[f] = String(v == null ? '' : v).trim().slice(0, f === 'remark' || f === 'address' ? 200 : 80)
    }
  }
  // 商品照片 / 供应商挂靠：数组类字段单独处理，避免被上面的 String() 变成 "[object Object]"
  if (type === 'item') {
    if ('photos' in data) {
      if (!Array.isArray(data.photos)) fail('photos 必须是图片链接数组')
      nextRecord.photos = data.photos
        .map(p => String(p || '').trim())
        .filter(p => /^https?:\/\//i.test(p))
        .slice(0, MAX_PHOTOS)
      if (data.photos.length && !nextRecord.photos.length) fail('photos 里没有合法的 http(s) 图片链接')
    }
    if ('suppliers' in data) {
      if (!Array.isArray(data.suppliers)) fail('suppliers 必须是供应商编码数组')
      const codes = data.suppliers.map(x => String(x || '').trim()).filter(Boolean)
      if (codes.length > MAX_ITEM_SUPPLIERS) fail(`供应商最多 ${MAX_ITEM_SUPPLIERS} 个`)
      const known = new Set((state.suppliers || []).map(x => x.code))
      const unknown = codes.filter(x => !known.has(x))
      if (unknown.length) fail(`供应商编码不存在：${unknown.join('、')}（请先用 POST /master 建档）`, 404)
      nextRecord.suppliers = [...new Set(codes)]
    }
  }
  if (!String(nextRecord.name || '').trim()) fail('name 不能为空')
  if (idx < 0) {
    // 新档：编码自动生成，避免 AI 猜编码导致主键冲突
    const prefix = type === 'item' ? 'P' : type === 'customer' ? 'C' : 'S'
    nextRecord.code = nextEntityCode(list, prefix, 5)
    if (type === 'item') {
      nextRecord.price = Number(nextRecord.price || 0)
      nextRecord.cost = Number(nextRecord.cost || 0)
      nextRecord.unit = nextRecord.unit || ''
      nextRecord.suppliers = []
    } else {
      nextRecord[type === 'customer' ? 'deposits' : 'advances'] = []
    }
    list.push(nextRecord)
  } else {
    list[idx] = nextRecord
  }
  return { next: { ...state, [listKey]: list }, code: nextRecord.code, name: nextRecord.name }
}

async function masterWrite(input, env, ctx, deps) {
  const tx = await openTransaction(env, ['items', 'suppliers', 'customers', 'purchases', 'sales', 'orders', 'stock', 'logs'], { optional: ['orders'] })
  const now = new Date().toISOString()
  const { next, code, name } = applyMaster(tx.state, input)
  Object.assign(next, deps.derive(next.items, next.suppliers, next.purchases, next.sales, next.customers))
  next.stock = deps.rebuildStock(next.purchases, next.sales, next.items)
  const r = await commitTransaction(tx, {
    next,
    message: `ai: master ${input.action || 'upsert'} ${input.type} ${code} by ${ctx.key.name}`.trim(),
    logEntry: { source: 'ai', action: `master-${input.action || 'upsert'}`, type: input.type, code, key: ctx.key.name, keyId: ctx.key.id, at: now }
  })
  return { ok: true, type: input.type, action: input.action || 'upsert', code, name, commit: r.unchanged ? undefined : r.sha }
}

async function uploadImage(req, env) {
  if (!env.IMGBED_AUTH_CODE) fail('未配置图床密钥 IMGBED_AUTH_CODE', 500)
  const form = await req.formData()
  const file = form.get('file')
  if (!file) fail('缺少文件（multipart 字段名 file）')
  const MAX_UPLOAD = 10 * 1024 * 1024
  if (typeof file.size === 'number' && file.size > MAX_UPLOAD) fail('图片不能超过 10MB')
  if (file.type && !/^image\//i.test(file.type)) fail('只允许上传图片文件')
  const fd = new FormData()
  fd.append('file', file)
  const upstream = `https://netpan.1234.nyc.mn/upload?authCode=${encodeURIComponent(env.IMGBED_AUTH_CODE)}&returnFormat=full`
  const res = await fetch(upstream, { method: 'POST', body: fd, signal: AbortSignal.timeout(25000) })
  const data = await res.json().catch(() => ({}))
  const src = Array.isArray(data) ? (data[0] && data[0].src) : data.src
  if (!src || typeof src !== 'string' || !/^https?:\/\//i.test(src)) fail('图床上传失败', 502)
  return { url: src }
}

function schemaFor(env, ctx) {
  return {
    version: 1,
    baseUrl: V1,
    key: { name: ctx.key.name, scopes: [...ctx.scopes], expiresAt: ctx.key.expiresAt || null },
    scopes: AI_SCOPE_GROUPS,
    presets: AI_PRESETS,
    endpoints: AI_ENDPOINTS.map(e => ({ ...e, allowed: !e.scope || ctx.scopes.has(e.scope) })),
    notes: [
      '所有接口都需要在请求头带 Authorization: Bearer <密钥>（也支持 ?key=，但不推荐，容易留在日志里）。',
      '金额由服务端按商品档案重算；AI 只需给商品编码（code）、数量（qty），可选 price 与 discountRate。',
      '所有写接口都必须带 requestId（16~80 位字母/数字/短横线），网络重试时复用同一个值，服务端据此保证不重复开单。',
      '直接开单（POST /sales、/purchases）要求客户/供应商已建档；新单位请先用 POST /master 建档。',
      '草稿订单不占库存、不进应收应付；只有 POST /orders 的 action=post 才会生成正式单据（需要 write:post）。',
      '库存是单据的派生数据，不能直接改写；改错请用作废 / 退货接口。',
      '预存款 / 预付款充值（POST /deposits）会同时生成一张收 / 付款单；抵扣不能超过当前余额，写错请用相反方向冲回，流水可用 flowId 编辑/删除（已开资金单据的金额不可改）。',
      '收付款（POST /payments）只能记不超过未收 / 未付的金额并自动生成收 / 付款单；多出的钱请用 /deposits 记成预存款 / 预付款。',
      '改已开单据用 POST /amends（原单不动，减少的生成退货单、增加的生成补差单）；作废后不能再用原单号开新单。',
      '权限不足返回 403，密钥无效/过期/吊销返回 401；错误信息不会透露密钥是否存在。'
    ]
  }
}

// 订单草稿同样由服务端补全：AI 只要给 kind + 往来单位 + [商品编码, 数量]，
// 名称/单价/行金额/合计全部按商品档案算，validateOrder 的「金额与数量×单价×折扣不符」就不会被 AI 的算术误差触发。
function normalizeDraftOrder(order, items) {
  const kind = order.kind
  if (!['sale', 'purchase'].includes(kind)) return order
  const partyKey = kind === 'purchase' ? 'supplier' : 'customer'
  const byCode = new Map((items || []).map(i => [i.code, i]))
  const date = isDate(order.date) ? order.date : todayCN()
  const lines = (Array.isArray(order.items) ? order.items : []).map((l, i) => {
    if (!l || typeof l !== 'object') fail(`第 ${i + 1} 行明细不是合法对象`)
    const it = byCode.get(String(l.code || '').trim())
    if (!it) fail(`第 ${i + 1} 行商品编码「${l.code || '（空）'}」不在商品库；请先查 GET /api/ai/v1/items`)
    const qty = Number(l.qty)
    if (!(qty > 0)) fail(`第 ${i + 1} 行数量必须大于 0（订单不支持负数）`)
    const fallback = Number(kind === 'sale' ? it.price : it.cost) || 0
    const price = l.price == null || l.price === '' ? fallback : Number(l.price)
    if (!Number.isFinite(price) || price < 0) fail(`第 ${i + 1} 行单价不能为负`)
    const rate = l.discountRate == null ? 1 : Number(l.discountRate)
    if (!(rate >= 0 && rate <= 1)) fail(`第 ${i + 1} 行折扣率必须在 0~1 之间（1＝不打折）`)
    const gross = round2(qty * price)
    const total = Math.max(0, round2(gross - round2(gross * (1 - rate))))
    return { code: it.code, name: it.name, unit: it.unit || '', qty, price, discountRate: round4(rate), discount: round2(gross - total), total }
  })
  return {
    ...order,
    [partyKey]: String(order[partyKey] || '').trim(),
    date,
    items: lines,
    total: round2(lines.reduce((s, l) => s + l.total, 0)),
    discount: round2(Number(order.discount || 0))
  }
}

export async function handleAi(req, url, env, deps) {
  const started = Date.now()
  const method = req.method
  const path = url.pathname.startsWith(V1) ? url.pathname.slice(V1.length) || '/' : url.pathname.replace(/^\/api\/ai/, '')
  const logPath = logPathOf(path, url)

  // 日志是旁路：写失败只丢一条记录，绝不影响这次调用本身返回什么
  const writeLog = (status, payload, meta = {}) => recordAiLog(env, makeAiLog({
    method,
    path: logPath,
    key: meta.key || null,
    status,
    startedAt: started,
    requestId: meta.requestId,
    code: meta.code,
    error: status >= 400 ? (payload && payload.error) || '' : ''
  })).catch(() => {})

  let ctx
  try {
    ctx = await authenticateAi(req, url, env)
  } catch (e) {
    const status = e.status || 401
    // 鉴权失败也要留痕：否则「谁在用错密钥、被拒了多少次」完全不可见
    await writeLog(status, { error: e.message })
    return json(req, env, { error: e.message || '密钥无效' }, status)
  }

  const finish = async (payload, status = 200, meta = {}) => {
    await writeLog(status, payload, { key: ctx.key, ...meta })
    return json(req, env, payload, status)
  }

  try {
    if (method === 'GET') {
      let body
      if (path === '/schema' || path === '/') body = schemaFor(env, ctx)
      else if (path === '/items') { assertScope(ctx, 'read:catalog'); body = await readItems(url, env, ctx) }
      else if (path === '/stock') { assertScope(ctx, 'read:catalog'); body = await readStock(url, env, ctx) }
      else if (path === '/orders') { assertScope(ctx, 'read:docs'); body = await readOrders(url, env) }
      else if (path === '/sales') { assertScope(ctx, 'read:docs'); body = await readDocs('sale', url, env) }
      else if (path === '/purchases') { assertScope(ctx, 'read:docs'); body = await readDocs('purchase', url, env) }
      else if (path === '/parties') { assertScope(ctx, 'read:parties'); body = await readParties(url, env) }
      else if (path === '/ledger') { assertScope(ctx, 'read:parties'); body = await readLedger(url, env) }
      else if (path === '/summary') { assertScope(ctx, 'read:reports'); body = await readSummary(url, env, ctx) }
      else if (path === '/profile') { assertScope(ctx, 'read:profile'); body = { profile: await readProfile(env) } }
      else if (path === '/vouchers') { assertScope(ctx, 'read:vouchers'); body = await readVouchers(url, env) }
      else if (path === '/shares') { assertScope(ctx, 'write:shares'); body = { shares: await listShares(env) } }
      else if (path === '/templates') { assertScope(ctx, 'write:templates'); body = { templates: await listTemplates(env) } }
      else return finish({ error: `未知接口：GET ${path}` }, 404)
      await noteUsage(env, ctx.key, 'read')
      return finish(body)
    }

    if (method !== 'POST') return finish({ error: `不支持的请求方法 ${method}` }, 405)

    const body = await req.json().catch(() => { fail('请求体必须是 JSON') })

    if (path === '/orders') {
      assertScope(ctx, 'write:draft')
      const action = String(body.action || '')
      if (!['save', 'remark', 'delete', 'post', 'unpost'].includes(action)) fail('action 只能是 save / remark / delete / post / unpost')
      if (action === 'post' || action === 'unpost') assertScope(ctx, 'write:post')
      const requestId = requestIdOf(body)
      const input = { ...body, requestId }
      if (action === 'save') {
        const order = { ...(body.order || {}), aiRequestId: requestId, createdBy: `ai:${ctx.key.name}` }
        delete order.status
        delete order.postedOrderId
        const items = await readJSON(env, 'items.json')
        input.order = normalizeDraftOrder(order, items)
      }
      const result = await orderTransaction(env, input, deps.derive, deps.rebuildStock)
      await noteUsage(env, ctx.key, 'write')
      return finish(result, 200, { requestId, code: result.code || result.id || (result.order && result.order.id) })
    }

    if (path === '/sales' || path === '/purchases') {
      assertScope(ctx, 'write:docs')
      const requestId = requestIdOf(body)
      const result = await createDirectDoc(path === '/sales' ? 'sale' : 'purchase', body, env, ctx, deps, requestId)
      await noteUsage(env, ctx.key, 'write')
      return finish(result, 200, { requestId, code: result.id })
    }

    if (path === '/refunds') {
      assertScope(ctx, 'write:refunds')
      const requestId = requestIdOf(body)
      // AI 只允许「新建退货 / 核销」，不允许 restore / backfill 这类整表覆盖
      if (!['create', 'settle'].includes(String(body.action || ''))) fail('action 只能是 create 或 settle')
      const result = await refundTransaction(env, body, deps.derive, deps.rebuildStock)
      await noteUsage(env, ctx.key, 'write')
      return finish(result, 200, { requestId, code: result.code || result.id })
    }

    if (path === '/voids') {
      assertScope(ctx, 'write:voids')
      const result = await voidTransaction(env, body, deps.derive, deps.rebuildStock)
      await noteUsage(env, ctx.key, 'write')
      return finish(result, 200, { code: result.code || result.id })
    }

    if (path === '/master') {
      assertScope(ctx, 'write:master')
      const requestId = String(body.requestId || '').trim()
      if (requestId && !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) fail('requestId 需为 16~80 位字母、数字或短横线')
      const result = await masterWrite(body, env, ctx, deps)
      await noteUsage(env, ctx.key, 'write')
      return finish(result, 200, { requestId, code: result.code })
    }

    if (path === '/payments') {
      assertScope(ctx, 'write:payments')
      const requestId = requestIdOf(body)
      const result = await paymentWrite(body, env, ctx, requestId)
      await noteUsage(env, ctx.key, 'write')
      return finish(result, 200, { requestId, code: result.voucher })
    }

    if (path === '/amends') {
      assertScope(ctx, 'write:amend')
      // 复用页面的变更事务：requestId 已内置幂等，原单不动，减少的生成退货单、增加的生成补差单
      if (!['sale', 'purchase'].includes(String(body.kind || ''))) fail('kind 只能是 sale 或 purchase')
      if (!String(body.sourceOrderId || '').trim()) fail('请提供原单号 sourceOrderId')
      const requestId = requestIdOf(body)
      const result = await amendTransaction(env, { ...body, requestId }, deps.derive, deps.rebuildStock)
      await noteUsage(env, ctx.key, 'write')
      return finish(result, 200, { requestId, code: result.code })
    }

    if (path === '/shares') {
      assertScope(ctx, 'write:shares')
      const result = await shareOperation(env, body)
      await noteUsage(env, ctx.key, 'write')
      return finish(result, 200, { code: result.share && result.share.token })
    }

    if (path === '/deposits') {
      assertScope(ctx, 'write:deposits')
      const requestId = requestIdOf(body)
      const result = await depositWrite(body, env, ctx, requestId)
      await noteUsage(env, ctx.key, 'write')
      return finish(result, 200, { requestId, code: result.voucher || result.party.code })
    }

    if (path === '/templates') {
      assertScope(ctx, 'write:templates')
      const result = await templateOperation(env, body)
      await noteUsage(env, ctx.key, 'write')
      return finish(result, 200, { code: result.code || result.name })
    }

    if (path === '/upload') {
      assertScope(ctx, 'write:upload')
      const result = await uploadImage(req, env)
      await noteUsage(env, ctx.key, 'write')
      return finish(result)
    }

    return finish({ error: `未知接口：POST ${path}` }, 404)
  } catch (e) {
    const status = [400, 403, 404, 409, 422, 429, 500, 502].includes(e.status) ? e.status
      : /GitHub (409|422)/.test(String(e.message || '')) ? 409 : 500
    return finish({ error: e.message || String(e) }, status)
  }
}
