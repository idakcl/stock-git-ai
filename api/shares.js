// 外链分享：把一张销售单 / 采购单 / 订单生成为「只读」公开链接。
//
// 设计要点：
//   · 分享只存「指向哪张单」的元数据（shares.json），不复制单据内容：
//     单据改了、作废了、删了，分享页立刻跟着变（作废/删除即 404），不会出现两份数据。
//   · token 是唯一凭据（长随机串），只有拿到链接的人能看；接口在登录校验之前放行，
//     但只返回脱敏后的展示数据——不含成本价、内部单号、收付款流水、照片等内部信息。
//   · 有效期 expiresAt 为 ISO 时间或 null（长期有效）；过期返回 410，取消即从集合里删除。
//   · 同一张单只保留一条有效分享：重复生成返回已有链接，避免同一单据散落多个 token。
import { readJSON } from './github.js'
import { readCollection, writeCollection } from './storage.js'
import {
  allocateNetOf, discountAmountOf, discountRatesTextOf, discountedTotalOf, effectiveRateOf,
  grossOf, isVoided, paidSumOf, payableOf, receivableOf, receivedSumOf, round2
} from '../src/utils/account.js'
import { itemNameMap, lineDisplayName, normalizeRate } from '../src/utils/catalog.js'
import { orderAmount, orderDepositSum, orderStatusText } from '../src/utils/orders.js'
import { isReturn } from '../src/utils/refunds.js'

// 存储层接收「集合键」而不是文件名：非分片集合自动落到 shares.json
const SHARES_KEY = 'shares'
const KINDS = new Set(['sale', 'purchase', 'order'])
const MAX_SHARES = 500
const DAY_MS = 24 * 3600 * 1000

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e }
const notFound = (message = '分享链接不存在或已失效') => fail(message, 404)

async function readOptionalArray(env, file) {
  try {
    const v = await readJSON(env, file)
    return Array.isArray(v) ? v : []
  } catch (e) {
    if (/GitHub 404/.test(String((e && e.message) || e))) return []
    throw e
  }
}

const readItems = async (env) => readOptionalArray(env, 'items.json').catch(() => [])

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

const isExpired = (share, now = Date.now()) => {
  if (!share || !share.expiresAt) return false
  const t = Date.parse(share.expiresAt)
  return Number.isFinite(t) && t <= now
}

// 有效期天数 → ISO 时间：0 / 空 = 长期有效；其余按「现在 + N 天」精确到时刻
function expiryFromDays(days, now = Date.now()) {
  if (days == null || days === '') return null
  const d = Number(days)
  if (!Number.isFinite(d) || d <= 0) return null
  if (d > 3650) fail('有效期不能超过 3650 天')
  return new Date(now + d * DAY_MS).toISOString()
}

async function loadDoc(env, kind, docId) {
  if (kind === 'order') {
    return (await readOptionalArray(env, 'orders.json')).find(o => o && o.id === docId) || null
  }
  const list = await readCollection(env, kind === 'sale' ? 'sales' : 'purchases')
  return (list || []).find(o => o && o.id === docId) || null
}

export function docLabelOf(kind, doc) {
  if (kind === 'order') return doc && doc.kind === 'purchase' ? '采购订单' : '销售订单'
  if (kind === 'sale') return isReturn(doc) ? '销售退货单' : '销售单'
  return isReturn(doc) ? '采购退货单' : '采购单'
}

function partyOf(kind, doc) {
  if (kind === 'order') return (doc.kind === 'purchase' ? doc.supplier : doc.customer) || ''
  return (kind === 'sale' ? doc.customer : doc.supplier) || ''
}

function amountOf(kind, doc) {
  if (kind === 'order') return orderAmount(doc)
  return grossOf(doc)
}

function shareView(share, doc, now = Date.now()) {
  const kind = share.kind
  return {
    token: share.token,
    kind,
    docId: share.docId,
    createdAt: share.createdAt || '',
    expiresAt: share.expiresAt || null,
    expired: isExpired(share, now),
    docLabel: doc ? docLabelOf(kind, doc) : '单据',
    party: doc ? partyOf(kind, doc) : '',
    date: doc ? doc.date || '' : '',
    amount: doc ? amountOf(kind, doc) : 0,
    status: doc
      ? (kind === 'order' ? orderStatusText(doc.status) : (isVoided(doc) ? '作废' : (isReturn(doc) ? '退款' : '正常')))
      : '已删除',
    missing: !doc,
    voided: !!doc && isVoided(doc)
  }
}

function findActive(shares, kind, docId, now = Date.now()) {
  return (shares || []).find(s => s && s.kind === kind && s.docId === docId && !isExpired(s, now)) || null
}

/** 列表：带单据摘要，供「外链分享」管理页展示；已删除/作废的单据也要列出来（可取消） */
export async function listShares(env) {
  const shares = (await readCollection(env, SHARES_KEY)).filter(s => s && s.token && KINDS.has(s.kind) && s.docId)
  if (!shares.length) return []
  const [sales, purchases, orders] = await Promise.all([
    readCollection(env, 'sales').catch(() => []),
    readCollection(env, 'purchases').catch(() => []),
    readOptionalArray(env, 'orders.json')
  ])
  const index = new Map()
  for (const d of sales) index.set(`sale:${d.id}`, d)
  for (const d of purchases) index.set(`purchase:${d.id}`, d)
  for (const d of orders) index.set(`order:${d.id}`, d)
  return shares
    .map(s => shareView(s, index.get(`${s.kind}:${s.docId}`)))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}

export async function shareOperation(env, input) {
  const action = input && input.action
  const shares = (await readCollection(env, SHARES_KEY)).filter(s => s && s.token)
  const now = Date.now()

  if (action === 'create') {
    const kind = String(input.kind || '')
    const docId = String(input.docId || '').trim()
    if (!KINDS.has(kind)) fail('不支持的分享类型')
    if (!docId) fail('缺少单据号')
    const doc = await loadDoc(env, kind, docId)
    if (!doc) fail('单据不存在，无法分享', 404)
    if (isVoided(doc)) fail('单据已作废，不能分享', 409)
    const exists = findActive(shares, kind, docId, now)
    if (exists) return { ok: true, share: shareView(exists, doc, now), reused: true }
    if (shares.length >= MAX_SHARES) fail(`分享数量已达 ${MAX_SHARES} 条上限，请先取消部分分享`)
    // 清掉同单据的过期记录：同一张单只保留一条分享，避免管理页越积越多
    const kept = shares.filter(s => !(s.kind === kind && s.docId === docId))
    const share = { token: newToken(), kind, docId, createdAt: new Date(now).toISOString(), expiresAt: expiryFromDays(input.days, now) }
    await writeCollection(env, SHARES_KEY, [...kept, share], `share ${kind} ${docId}`)
    return { ok: true, share: shareView(share, doc, now) }
  }

  if (action === 'cancel') {
    const token = String(input.token || '')
    if (!token) fail('缺少分享标识')
    const next = shares.filter(s => s.token !== token)
    if (next.length === shares.length) fail('该分享不存在或已取消', 404)
    await writeCollection(env, SHARES_KEY, next, 'cancel share')
    return { ok: true }
  }

  if (action === 'update') {
    const token = String(input.token || '')
    const idx = shares.findIndex(s => s.token === token)
    if (idx < 0) fail('该分享不存在或已取消', 404)
    const expiresAt = expiryFromDays(input.days, now)
    if (shares[idx].expiresAt === expiresAt) return { ok: true, share: shareView(shares[idx], await loadDoc(env, shares[idx].kind, shares[idx].docId), now) }
    const next = shares.slice()
    next[idx] = { ...shares[idx], expiresAt }
    await writeCollection(env, SHARES_KEY, next, 'update share expiry')
    return { ok: true, share: shareView(next[idx], await loadDoc(env, next[idx].kind, next[idx].docId), now) }
  }

  fail('不支持的分享操作')
}

// 公开读取：只返回展示所需字段；不含成本、内部收付款流水、照片、供应商挂靠等内部信息
export async function readPublicShare(env, token) {
  const t = String(token || '').trim()
  if (!/^[a-f0-9]{24,64}$/.test(t)) throw notFound()
  const shares = await readCollection(env, SHARES_KEY)
  const share = (shares || []).find(s => s && s.token === t)
  if (!share) throw notFound()
  if (isExpired(share)) fail('分享链接已过期', 410)
  const doc = await loadDoc(env, share.kind, share.docId)
  if (!doc) throw notFound('单据已删除，分享已失效')
  if (isVoided(doc)) throw notFound('单据已作废，分享已失效')
  const items = await readItems(env)
  return buildPayload(share, doc, items)
}

function buildPayload(share, doc, items) {
  const kind = share.kind
  const isOrder = kind === 'order'
  const nameMap = itemNameMap(items)
  const itemMap = new Map((items || []).map(i => [i.code, i]))
  const lines = Array.isArray(doc.items) ? doc.items : []
  const lineTotals = lines.map(l => round2(Number(l.total || 0)))
  const rate = effectiveRateOf(doc)
  const nets = allocateNetOf(lineTotals, rate)
  const rows = lines.map((l, i) => {
    const qty = Number(l.qty || 0)
    const price = Number(l.price || 0)
    const gross = round2(qty * price)
    const r = normalizeRate(l, gross)
    const discount = isOrder ? round2(gross * (1 - r)) : round2(Number(l.discount || 0))
    return {
      code: l.code || '',
      name: lineDisplayName(l, nameMap),
      unit: (itemMap.get(l.code) || {}).unit || l.unit || '',
      qty,
      price,
      discountRate: r,
      discount,
      total: lineTotals[i],
      net: nets[i],
      hasDiscount: discount > 0
    }
  })
  const gross = round2(lines.reduce((s, l) => s + round2(Number(l.qty || 0) * Number(l.price || 0)), 0))
  const total = round2(lineTotals.reduce((s, v) => s + v, 0))
  const due = isOrder ? orderAmount(doc) : grossOf(doc)
  const paid = isOrder ? orderDepositSum(doc) : (kind === 'sale' ? receivedSumOf(doc) : paidSumOf(doc))
  const unpaid = isOrder ? Math.max(0, round2(due - paid)) : (kind === 'sale' ? receivableOf(doc) : payableOf(doc))
  return {
    readOnly: true,
    kind,
    share: { token: share.token, createdAt: share.createdAt || '', expiresAt: share.expiresAt || null },
    doc: {
      id: doc.id,
      no: doc.no && doc.no !== doc.id ? doc.no : '',
      date: doc.date || '',
      party: partyOf(kind, doc),
      partyLabel: kind === 'order'
        ? (doc.kind === 'purchase' ? '供应商' : '客户')
        : (kind === 'sale' ? '客户' : '供应商'),
      docLabel: docLabelOf(kind, doc),
      status: isOrder ? orderStatusText(doc.status) : (isReturn(doc) ? '退货单' : '正常'),
      remark: doc.remark || '',
      isReturn: !isOrder && isReturn(doc)
    },
    lines: rows,
    totals: {
      gross,
      lineDiscount: round2(gross - total),
      total,
      rateText: discountRatesTextOf(doc),
      discountAmount: isOrder ? Math.max(0, round2(total * (1 - rate))) : discountAmountOf(doc),
      discountedTotal: isOrder ? round2(total * rate) : discountedTotalOf(doc),
      discount: round2(Number(doc.discount || 0)),
      due,
      paid,
      unpaid,
      hasLineDiscount: rows.some(r => r.hasDiscount),
      hasOrderDiscount: Boolean(discountRatesTextOf(doc))
    }
  }
}
