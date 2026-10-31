// AI-API 密钥：签发、校验、吊销，以及「这把钥匙上次什么时候用过」。
//
// 三条红线：
//   · 明文只在生成那一刻返回一次，落库只存 SHA-256 与显示前缀；数据仓泄露也拿不到可用密钥。
//   · 密钥管理只走登录态（管理员），AI 自己永远不能签发 / 吊销 / 提权。
//   · 鉴权失败不透露「是没这把钥匙还是过期了」，统一一句话，避免被枚举。
import { readJSON, writeJSON } from './github.js'
import { isAiScope, AI_SCOPES, AI_ALL_SCOPE_IDS } from '../src/utils/aiScopes.js'

const KEY_FILE = 'ai-keys.json'
const USAGE_FILE = 'ai-usage.json'
const MAX_KEYS = 20          // 同时生效的上限，够用且便于审计
const MAX_RECORDS = 60       // 含已吊销的历史记录，超出后清理最老的吊销记录
const CACHE_MS = 15000       // 密钥缓存：吊销最多 15 秒后生效（比每次回源 GitHub 便宜得多）
const USAGE_FLUSH_MS = 3600 * 1000

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e }

const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)))
  return hex(digest)
}

function randomString(bytes = 24) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  // 拒绝采样会有偏，但这里是要一把不可猜的随机串，偏差不影响安全性
  return [...buf].map(b => chars[b % chars.length]).join('')
}

const sameText = (a, b) => {
  const x = String(a || ''), y = String(b || '')
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0)
  return diff === 0
}

// 按数据仓隔离的缓存：同一个 isolate 里可能先后处理不同仓库（测试与本地），不能串
const cache = new Map()
const cacheId = (env) => `${env.GITHUB_OWNER || ''}/${env.GITHUB_REPO || ''}`
export function invalidateKeyCache(env) {
  if (env) cache.delete(cacheId(env))
  else cache.clear()
}

async function readRaw(env, { fresh = false } = {}) {
  const id = cacheId(env)
  const hit = cache.get(id)
  if (!fresh && hit && hit.at + CACHE_MS > Date.now()) return hit.list
  let list = []
  try {
    const v = await readJSON(env, KEY_FILE)
    list = Array.isArray(v) ? v : []
  } catch (e) {
    // 还没建过密钥：文件不存在是正常状态；其它读取失败必须暴露，不能当成「没有钥匙」放行
    if (!/GitHub 404/.test(String((e && e.message) || e))) throw e
  }
  cache.set(id, { at: Date.now(), list })
  return list
}

export const readKeys = (env) => readRaw(env)
export const readKeysFresh = (env) => readRaw(env, { fresh: true })

const publicView = (rec) => ({
  id: rec.id, name: rec.name, prefix: rec.prefix,
  scopes: rec.scopes || [], createdAt: rec.createdAt,
  expiresAt: rec.expiresAt || null, revokedAt: rec.revokedAt || ''
})

export function isExpired(rec, now = Date.now()) {
  return !!rec.expiresAt && Date.parse(rec.expiresAt) <= now
}
export const isActive = (rec, now = Date.now()) => !rec.revokedAt && !isExpired(rec, now)

function normalizeScopes(scopes) {
  const list = [...new Set((Array.isArray(scopes) ? scopes : []).map(s => String(s || '').trim()).filter(Boolean))]
  const unknown = list.filter(s => !isAiScope(s))
  if (unknown.length) fail(`未知权限：${unknown.join('、')}`)
  // 固定按目录顺序落库：同一组权限无论勾选顺序如何，存的都是同一份，便于比对与审计
  return AI_ALL_SCOPE_IDS.filter(id => list.includes(id))
}

const normalizeName = (name) => {
  const v = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (!v) fail('请填写密钥名称（给谁用）')
  return v
}

// 永久 = null；其余按天算，上限 365 天
export function expiresAtOf(days, now = Date.now()) {
  if (days === null || days === undefined || days === '' || days === 'never' || Number(days) === 0) return null
  const n = Number(days)
  if (!Number.isFinite(n) || n < 1 || n > 365) fail('有效期应在 1~365 天之间，或选择「永久」')
  return new Date(now + Math.round(n) * 24 * 3600 * 1000).toISOString()
}

async function persist(env, list, message) {
  // 清理策略：已吊销超过 30 天的记录可以删，保留最近的用于「谁什么时候被吊销」的追溯
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000
  let out = list.filter(k => !(k.revokedAt && Date.parse(k.revokedAt) < cutoff))
  if (out.length > MAX_RECORDS) out = out.slice(-MAX_RECORDS)
  await writeJSON(env, KEY_FILE, out, message)
  cache.set(cacheId(env), { at: Date.now(), list: out })
  return out
}

export async function listKeys(env) {
  const list = await readRaw(env, { fresh: true })
  const usage = await readUsage(env, { fresh: true })
  return [...list]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(k => ({ ...publicView(k), active: isActive(k), usage: usage[k.id] || null }))
}

export async function createKey(env, { name, scopes, expiresInDays } = {}) {
  const list = await readRaw(env, { fresh: true })
  const active = list.filter(k => isActive(k))
  if (active.length >= MAX_KEYS) fail(`最多同时保留 ${MAX_KEYS} 把生效中的密钥，请先吊销不用的`)
  const clean = normalizeScopes(scopes)
  if (!clean.length) fail('至少要勾选一项权限')
  const raw = `ai_live_${randomString(28)}`
  const record = {
    id: `AK${randomString(8)}`,
    name: normalizeName(name),
    prefix: raw.slice(0, 16),
    hash: await sha256(raw),
    scopes: clean,
    createdAt: new Date().toISOString(),
    createdBy: 'admin',
    expiresAt: expiresAtOf(expiresInDays),
    revokedAt: '',
    note: ''
  }
  list.push(record)
  await persist(env, list, `ai: create key ${record.name}`)
  return { key: raw, record: publicView(record) }
}

export async function updateKey(env, { id, name, scopes, expiresInDays } = {}) {
  const list = await readRaw(env, { fresh: true })
  const rec = list.find(k => k.id === id)
  if (!rec) fail('密钥不存在，可能已被删除', 404)
  if (rec.revokedAt) fail('密钥已吊销，请重新生成一把')
  const next = { ...rec }
  if (name !== undefined) next.name = normalizeName(name)
  if (scopes !== undefined) {
    const clean = normalizeScopes(scopes)
    if (!clean.length) fail('至少要勾选一项权限')
    next.scopes = clean
  }
  if (expiresInDays !== undefined) next.expiresAt = expiresAtOf(expiresInDays)
  next.updatedAt = new Date().toISOString()
  const i = list.findIndex(k => k.id === id)
  list[i] = next
  await persist(env, list, `ai: update key ${next.name}`)
  return publicView(next)
}

export async function revokeKey(env, { id } = {}) {
  const list = await readRaw(env, { fresh: true })
  const rec = list.find(k => k.id === id)
  if (!rec) fail('密钥不存在，可能已被删除', 404)
  if (rec.revokedAt) return publicView(rec)
  rec.revokedAt = new Date().toISOString()
  await persist(env, list, `ai: revoke key ${rec.name}`)
  return publicView(rec)
}

// ---- 使用记录（单独一个文件） ----
// 为什么不把 lastUsedAt 写回 ai-keys.json：那是安全文件，一次并发覆盖就可能把刚吊销的钥匙写活。
// 统计放独立文件，最坏只丢一次计数，永远不会影响鉴权结果。
async function readUsage(env, { fresh = false } = {}) {
  const id = `usage:${cacheId(env)}`
  const hit = cache.get(id)
  if (!fresh && hit && hit.at + CACHE_MS > Date.now()) return hit.value
  let value = {}
  try {
    const v = await readJSON(env, USAGE_FILE)
    value = v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch (e) {
    if (!/GitHub 404/.test(String((e && e.message) || e))) return {}
  }
  cache.set(id, { at: Date.now(), value })
  return value
}

export async function noteUsage(env, rec, kind = 'read') {
  try {
    const usage = await readUsage(env)
    const cur = usage[rec.id] || { reads: 0, writes: 0, lastUsedAt: '' }
    const key = kind === 'write' ? 'writes' : 'reads'
    // 读调用每小时最多落一次盘：否则每问一句都往数据仓提交一次，成本比业务本身还高
    if (kind !== 'write' && cur.lastUsedAt && Date.now() - Date.parse(cur.lastUsedAt) < USAGE_FLUSH_MS) {
      cur[key] += 1
      usage[rec.id] = cur
      cache.set(`usage:${cacheId(env)}`, { at: Date.now(), value: usage })
      return
    }
    usage[rec.id] = { ...cur, [key]: cur[key] + 1, lastUsedAt: new Date().toISOString() }
    await writeJSON(env, USAGE_FILE, usage, `ai: usage ${rec.name}`)
    cache.set(`usage:${cacheId(env)}`, { at: Date.now(), value: usage })
  } catch { /* 统计失败不影响本次调用 */ }
}

// ---- 鉴权 ----
export function keyFromRequest(req, url) {
  const h = req.headers.get('Authorization') || ''
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  if (m && /^ai_live_/.test(m[1])) return m[1].trim()
  const q = url && url.searchParams.get('key')
  if (q && /^ai_live_/.test(q)) return q.trim()
  return ''
}

// 返回 { key, scopes } 或抛 401。失败信息刻意笼统。
export async function authenticateAi(req, url, env) {
  const raw = keyFromRequest(req, url)
  if (!raw) fail('缺少 AI 密钥：请在请求头带 Authorization: Bearer <key>（或 ?key=）', 401)
  const hash = await sha256(raw)
  const list = await readKeys(env)
  const rec = list.find(k => k.hash && sameText(k.hash, hash))
  if (!rec || !isActive(rec)) fail('密钥无效、已过期或已吊销', 401)
  return { key: rec, scopes: new Set(rec.scopes || []) }
}

export function assertScope(ctx, scope) {
  if (!scope) return
  if (!ctx.scopes.has(scope)) {
    const need = AI_SCOPES.find(s => s.id === scope)
    fail(`这把密钥没有「${need ? need.label : scope}」权限（${scope}）`, 403)
  }
}
