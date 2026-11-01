// 字段级留痕：整表保存时对比「提交前」与「提交后」的同号单据，只挑出真正变了的字段。
//
// 为什么要它：logs.json 原来只记「谁在什么时候保存了哪张单」（动作级），
// 金额被改成多少、客户有没有换，只能去翻 git 提交。对账要追「客单价什么时候被改过」，
// 动作级日志答不了。这里只记摘要（字段 → 改前/改后），不复制整张单据，
// 日志仍然只保留最近 200 条，不会把 logs.json 撑大。
//
// 口径：
//   · 只比较固定白名单字段，避免 photos / 时间戳这类高频但无审计价值的变动刷屏；
//   · 明细只比「行数」与「明细合计」，逐行改动会体现在单头金额上，需要全文的展开日志即可；
//   · 新建与移除各记一条（fields 用特殊键 _new / _deleted 表示），不展开内容。
const FIELDS = [
  ['date', '日期'],
  ['status', '状态'],
  ['settle', '结算'],
  ['customer', '客户'],
  ['supplier', '供应商'],
  ['total', '金额'],
  ['discount', '优惠'],
  ['received', '实收'],
  ['paid', '实付'],
  ['remark', '备注']
]
const MONEY = new Set(['total', 'discount', 'received', 'paid'])
const LABELS = Object.fromEntries(FIELDS)

const str = (v) => (v == null ? '' : String(v))
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const sameNum = (a, b) => Math.abs(num(a) - num(b)) < 0.005
const clip = (v, max = 60) => {
  const s = str(v)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// 只保留有意义的字段变化；返回 null 表示这张单没变
function fieldDiff(prev, doc) {
  const fields = {}
  for (const [key, label] of FIELDS) {
    if (!(key in doc) && !(key in prev)) continue
    if (MONEY.has(key)) {
      if (sameNum(prev[key], doc[key])) continue
      fields[key] = { label, from: num(prev[key]), to: num(doc[key]) }
    } else {
      if (str(prev[key]) === str(doc[key])) continue
      fields[key] = { label, from: clip(prev[key]), to: clip(doc[key]) }
    }
  }
  const beforeLines = Array.isArray(prev.items) ? prev.items.length : 0
  const afterLines = Array.isArray(doc.items) ? doc.items.length : 0
  if (beforeLines !== afterLines) {
    fields.items = { label: '明细行数', from: beforeLines, to: afterLines }
  }
  return Object.keys(fields).length ? fields : null
}

/**
 * @param {Array} before 提交前的全量单据
 * @param {Array} after  提交后的全量单据
 * @param {'sale'|'purchase'|'order'} kind
 * @param {{limit?:number}} opts 最多记录多少张单（默认 20）
 * @returns {{changed:number, docs:Array<{id:string, fields:object}>}|null}
 */
export function diffDocuments(before, after, kind, opts = {}) {
  const old = new Map()
  for (const d of (before || [])) if (d && d.id != null) old.set(String(d.id), d)
  const seen = new Set()
  const docs = []
  for (const d of (after || [])) {
    if (!d || d.id == null) continue
    const id = String(d.id)
    seen.add(id)
    const prev = old.get(id)
    if (!prev) {
      docs.push({ id, kind, fields: { _new: { label: '新建' } } })
      continue
    }
    const fields = fieldDiff(prev, d)
    if (fields) docs.push({ id, kind, fields })
  }
  for (const [id, d] of old) {
    if (seen.has(id)) continue
    docs.push({ id, kind, fields: { _deleted: { label: '移除' } } })
  }
  if (!docs.length) return null
  const limit = Math.max(1, Number(opts.limit) || 20)
  return { changed: docs.length, docs: docs.slice(0, limit) }
}

// 把一条 docs 摘要压成一句话，供 /logs 列表直接读：
//   金额 1,000 → 900、客户 甲 → 乙
export function diffText(doc) {
  const fields = (doc && doc.fields) || {}
  const parts = []
  for (const [key, v] of Object.entries(fields)) {
    if (!v) continue
    if (key === '_new') parts.push('新建')
    else if (key === '_deleted') parts.push('移除')
    else if (!v.label) parts.push(key)
    else if (MONEY.has(key)) parts.push(`${v.label} ${fmt(v.from)} → ${fmt(v.to)}`)
    else parts.push(`${v.label} ${v.from || '空'} → ${v.to || '空'}`)
  }
  return parts.join('、') || '无字段变化'
}

export function diffLabel(key) {
  return LABELS[key] || key
}

function fmt(v) {
  const n = num(v)
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}
