// AI-API 调用日志：谁、什么时候、调了哪个接口、结果如何。
//
// 为什么要缓冲：GitHub 数据仓一次提交就是一次写入配额消耗。
// 每个请求都提交一条，AI 问十句话就把配额烧掉一半，而且并发写容易 409。
// 所以先在 isolate 内存里攒着，满 40 条或距上次落盘超过 60 秒再合并写一次。
// 代价是最新一分钟的记录可能还没落盘；管理员打开「调用日志」时会强制冲刷一次。
//
// 日志只用于排障与审计，不是账本：
//   · 写坏的日志绝不影响业务请求（失败只丢日志）；
//   · 只保留最近 7 天、最多 1500 条，超出自动丢弃最老的；
//   · 不记录请求体（可能含单价、客户信息），只记路径、状态、耗时、单号。
import { readJSON, writeJSON } from './github.js'

const FILE = 'ai-logs.json'
const MAX_ENTRIES = 1500
const KEEP_DAYS = 7
const FLUSH_MS = 60 * 1000
const FLUSH_SIZE = 40
const MAX_BUFFER = 400          // 长时间落盘失败时，内存里最多攒这么多，防止打爆 Worker
const MAX_ERROR = 200

const buffers = new Map()
const bufferId = (env) => `${env.GITHUB_OWNER || ''}/${env.GITHUB_REPO || ''}`

function bufOf(env) {
  const id = bufferId(env)
  let b = buffers.get(id)
  if (!b) { b = { entries: [], at: Date.now(), flushing: false }; buffers.set(id, b) }
  return b
}

export function resetAiLogs(env) {
  if (env) buffers.delete(bufferId(env))
  else buffers.clear()
}

// 路径里可能带 ?key=，绝不能原样落库；顺手截断，避免超长 query 撑大日志
export function logPathOf(path, url) {
  const parts = []
  for (const [k, v] of url.searchParams) {
    if (k === 'key') continue
    parts.push(`${k}=${v}`)
  }
  const q = parts.join('&')
  return (q ? `${path}?${q}` : path).slice(0, 120)
}

export function makeAiLog({ method, path, key, status, startedAt, requestId, code, error }) {
  return {
    at: new Date().toISOString(),
    ms: Math.max(0, Date.now() - startedAt),
    method,
    path,
    key: key ? key.name : '',
    keyId: key ? key.id : '',
    status,
    requestId: requestId || '',
    code: code || '',
    error: error ? String(error).slice(0, MAX_ERROR) : ''
  }
}

export async function recordAiLog(env, entry) {
  const buf = bufOf(env)
  buf.entries.push(entry)
  if (buf.entries.length > MAX_BUFFER) buf.entries.splice(0, buf.entries.length - MAX_BUFFER)
  if (buf.flushing) return
  const due = Date.now() - buf.at >= FLUSH_MS || buf.entries.length >= FLUSH_SIZE
  if (!due) return
  await flushAiLogs(env)
}

export async function flushAiLogs(env) {
  const buf = bufOf(env)
  if (buf.flushing || !buf.entries.length) return
  buf.flushing = true
  const batch = buf.entries.slice()
  try {
    let list = []
    try {
      const v = await readJSON(env, FILE)
      list = Array.isArray(v) ? v : []
    } catch (e) {
      // 第一次调用时文件还不存在，属于正常情况
      if (!/GitHub 404/.test(String((e && e.message) || e))) throw e
    }
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000
    const merged = [...list, ...batch]
      .filter(e => e && e.at && Date.parse(e.at) >= cutoff)
      .slice(-MAX_ENTRIES)
    await writeJSON(env, FILE, merged, `ai: logs +${batch.length}`)
    // 只删掉这次成功落盘的批次：期间新进来的日志留在缓冲里等下一轮
    buf.entries.splice(0, batch.length)
    buf.at = Date.now()
  } catch {
    // 落盘失败（限流 / 409 / 网络）不重试、不抛：把时间戳推进一下，避免每个请求都去撞墙
    buf.at = Date.now()
  } finally {
    buf.flushing = false
  }
}

// 管理端读取：先把缓冲刷一次，保证刚发生的事能看见
export async function listAiLogs(env, url) {
  await flushAiLogs(env)
  let list = []
  try {
    const v = await readJSON(env, FILE)
    list = Array.isArray(v) ? v : []
  } catch (e) {
    if (!/GitHub 404/.test(String((e && e.message) || e))) throw e
  }
  const q = url ? url.searchParams : new URLSearchParams()
  const keyId = String(q.get('keyId') || '').trim()
  const keyName = String(q.get('key') || '').trim().toLowerCase()
  const status = String(q.get('status') || '').trim()      // ok | error | 具体状态码
  const search = String(q.get('q') || '').trim().toLowerCase()
  const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 100))

  let rows = list
  if (keyId) rows = rows.filter(e => e.keyId === keyId)
  if (keyName) rows = rows.filter(e => String(e.key || '').toLowerCase().includes(keyName))
  if (status === 'ok') rows = rows.filter(e => e.status < 400)
  else if (status === 'error') rows = rows.filter(e => e.status >= 400)
  else if (/^\d{3}$/.test(status)) rows = rows.filter(e => e.status === Number(status))
  if (search) {
    rows = rows.filter(e => `${e.method} ${e.path} ${e.code} ${e.error} ${e.requestId}`.toLowerCase().includes(search))
  }

  const total = rows.length
  const slice = rows.slice(-limit).reverse()
  return { logs: slice, total, retainedDays: KEEP_DAYS, max: MAX_ENTRIES }
}
