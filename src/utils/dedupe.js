// 分类导入去重：前端「导入前预览比对」与 Worker 后端「落库前比对」共用同一份纯函数，
// 保证用户看到的预览结果与服务端实际写入结果口径一致（web/index.js 已有跨目录 import 先例）。
//
// 主键口径：
//   商品/客户/供应商 → code（编码）
//   采购单/销售单   → id（单号）
// 客户/供应商额外按 name 查重：历史上出现过 S00001/S00039 同名多码、
// 把一家供应商拆成两份档案的事故，名称相同即视为同一家，防止导入时再拆一次。
//
// diffImport 只做比对、不写任何数据：
//   added       —— 通过去重、可以追加的记录
//   skippedKey  —— 主键与库内或本批次已接收记录重复，跳过
//   skippedName —— 名称与库内或本批次已接收记录重复，跳过（仅客户/供应商）
//   invalid     —— 非对象或主键为空的记录：[{ record, reason }]
// 文件内部重复同样去重（batchKeys/batchNames），不会把同一文件里的重复记录写两份。

export const IMPORT_KEYS = ['items', 'customers', 'suppliers', 'purchases', 'sales']

const KEY_FIELDS = {
  items: 'code',
  customers: 'code',
  suppliers: 'code',
  purchases: 'id',
  sales: 'id'
}

// 这些类型在主键之外还按名称查重
const NAME_CHECK_KEYS = ['customers', 'suppliers']

export function isValidImportKey(key) {
  return IMPORT_KEYS.includes(key)
}

export function keyFieldOf(key) {
  return KEY_FIELDS[key] || 'code'
}

function normStr(v) {
  return v == null ? '' : String(v).trim()
}

export function diffImport(key, incoming, existing) {
  const field = keyFieldOf(key)
  const byName = NAME_CHECK_KEYS.includes(key)
  const existingKeys = new Set()
  const existingNames = new Set()
  for (const e of existing || []) {
    if (!e || typeof e !== 'object') continue
    const k = normStr(e[field])
    if (k) existingKeys.add(k)
    if (byName) {
      const n = normStr(e.name)
      if (n) existingNames.add(n)
    }
  }

  const added = []
  const skippedKey = []
  const skippedName = []
  const invalid = []
  const batchKeys = new Set()
  const batchNames = new Set()

  for (const rec of incoming || []) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      invalid.push({ record: rec, reason: '不是有效的记录（应为 JSON 对象）' })
      continue
    }
    const k = normStr(rec[field])
    if (!k) {
      invalid.push({ record: rec, reason: field === 'id' ? '缺少单号' : '缺少编码' })
      continue
    }
    if (existingKeys.has(k) || batchKeys.has(k)) {
      skippedKey.push(rec)
      continue
    }
    if (byName) {
      const n = normStr(rec.name)
      if (n && (existingNames.has(n) || batchNames.has(n))) {
        skippedName.push(rec)
        continue
      }
      if (n) batchNames.add(n)
    }
    batchKeys.add(k)
    added.push(rec)
  }

  return { added, skippedKey, skippedName, invalid }
}

// 宽容解析导入内容：兼容多种常见导出形态，统一取出记录数组
//   裸数组            [{...}, {...}]
//   { data: [...] }   本页分类导出的格式
//   { <key>: [...] }  如 { items: [...] }
//   { data: { <key>: [...] } }  全量备份里按 key 取
// 解析不了返回 null
export function extractRecords(key, text) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (Array.isArray(obj)) return obj
  if (!obj || typeof obj !== 'object') return null
  if (Array.isArray(obj.data)) return obj.data
  if (Array.isArray(obj[key])) return obj[key]
  if (obj.data && typeof obj.data === 'object' && Array.isArray(obj.data[key])) return obj.data[key]
  return null
}
