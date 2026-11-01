// 会话鉴权：登录签发 HMAC 票据 + 全站 API 校验
// 为什么不用 JWT 库：Worker 环境内置 Web Crypto，自签 HMAC-SHA256 足够，且零依赖。
// token 格式：base64url(payload).base64url(signature)
// payload 内含过期时间(exp)、签发时间(iat)、主题(sub)，签名密钥来自 Worker Secret(SESSION_SECRET)
import { gh, writeJSON } from './github.js'

const enc = new TextEncoder()
// 密码与会话版本存在数据仓（私有）里的 auth.json：
//   { version, salt, hash, iterations, updatedAt }
// 为什么放数据仓而不是 KV：本项目没有绑定 KV/DO，而“改了密码/吊销后旧票据立刻失效”
// 必须有一个所有边缘节点都能读到的权威值。数据仓本来就是唯一持久层，读它一次 30 秒缓存。
const SESSIONS_FILE = 'auth.json'
const AUTH_CACHE_MS = 30 * 1000
const MIN_PASSWORD = 8
const ITERATIONS = 12000

const b64url = (buf) => {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64urlDecode = (str) => {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : ''
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// 常量时间比较：避免通过响应耗时差别逐字节猜出正确值
function timingSafeEqual(a, b) {
  const x = String(a), y = String(b)
  const len = Math.max(x.length, y.length)
  let diff = x.length ^ y.length
  for (let i = 0; i < len; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0)
  return diff === 0
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return await crypto.subtle.sign('HMAC', key, enc.encode(message))
}

const toHex = (bytes) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
const fromHex = (hex) => new Uint8Array((String(hex).match(/../g) || []).map(h => parseInt(h, 16)))

async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations, hash: 'SHA-256' }, key, 256)
  return toHex(new Uint8Array(bits))
}

// 读 auth.json。fresh=true 用于登录/改密这类「必须看到最新值」的场合；
// 其余路径走 30 秒缓存，避免每个 API 请求都打一次 GitHub。
// 404 = 还没设置过密码（回退 APP_PASSWORD）；其他错误沿用上一次已知值（GitHub 抖动不该把所有人踢下线），
// 但如果这次进程还从没成功读过，就**抛错**（fail-closed）：宁可让请求 401，也不能因为读不到版本号
// 而把「已吊销的旧票」当成有效。
let authCache = { at: 0, value: undefined }
async function readAuth(env, fresh = false) {
  if (!fresh && authCache.value !== undefined && authCache.at && Date.now() - authCache.at < AUTH_CACHE_MS) {
    return authCache.value
  }
  try {
    const data = await gh(`/contents/${SESSIONS_FILE}`, env)
    let content = ''
    if (data.encoding === 'base64') content = atob(String(data.content || '').replace(/\s/g, ''))
    else if (typeof data.content === 'string') content = data.content
    const value = content ? JSON.parse(content) : null
    authCache = { at: Date.now(), value }
    return value
  } catch (e) {
    if (/GitHub 404/.test(String(e && e.message))) {
      authCache = { at: Date.now(), value: null }
      return null
    }
    if (authCache.at && authCache.value !== undefined) return authCache.value
    throw e
  }
}

// 当前会话版本：票据里带 v，v 与这里不一致即视为已吊销。
export async function sessionVersion(env) {
  const rec = await readAuth(env)
  return Number(rec && rec.version || 0)
}

// 校验密码：设置过密码就用数据仓里的 PBKDF2 记录，否则回退到 Worker Secret 里的初始密码。
export async function passwordMatches(env, password, { fresh = true } = {}) {
  const rec = await readAuth(env, fresh)
  if (rec && rec.hash) {
    const got = await pbkdf2(password, rec.salt, Number(rec.iterations) || ITERATIONS)
    return timingSafeEqual(got, rec.hash)
  }
  return !!env.APP_PASSWORD && timingSafeEqual(String(password || ''), env.APP_PASSWORD)
}

function newSalt() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

// 改密码：要求当前密码（会话在手不等于知道密码），成功后版本 +1，
// 于是「改了密码，别的设备还挂着旧票据」这件事在 30 秒内自动消失。
export async function changePassword(env, input) {
  const current = String((input && input.current) || '')
  const next = String((input && input.next) || '')
  if (next.length < MIN_PASSWORD) {
    throw Object.assign(new Error(`新密码至少 ${MIN_PASSWORD} 位`), { status: 400 })
  }
  if (!(await passwordMatches(env, current))) {
    throw Object.assign(new Error('当前密码错误'), { status: 403 })
  }
  const prev = await readAuth(env, true) || { version: 0 }
  const salt = newSalt()
  const hash = await pbkdf2(next, salt, ITERATIONS)
  const record = {
    version: Number(prev.version || 0) + 1,
    salt, hash, iterations: ITERATIONS,
    updatedAt: new Date().toISOString()
  }
  await writeJSON(env, SESSIONS_FILE, record, 'update password')
  authCache = { at: Date.now(), value: record }
  return record.version
}

// 吊销所有会话：不动密码，只把版本 +1。当前设备重新登录即可，其他设备全部失效。
export async function revokeSessions(env, input) {
  const current = String((input && input.password) || '')
  if (!(await passwordMatches(env, current))) {
    throw Object.assign(new Error('密码错误'), { status: 403 })
  }
  const prev = await readAuth(env, true) || { version: 0 }
  const record = {
    ...(prev.hash ? { salt: prev.salt, hash: prev.hash, iterations: prev.iterations } : {}),
    version: Number(prev.version || 0) + 1,
    updatedAt: new Date().toISOString()
  }
  await writeJSON(env, SESSIONS_FILE, record, 'revoke sessions')
  authCache = { at: Date.now(), value: record }
  return record.version
}

export async function issueToken(env, user = 'admin', ttlMs = 12 * 3600 * 1000, version = 0) {
  const now = Date.now()
  const payload = JSON.stringify({ sub: user, iat: now, exp: now + ttlMs, v: Number(version || 0) })
  const sig = await hmac(env.SESSION_SECRET, payload)
  return `${b64url(enc.encode(payload))}.${b64url(sig)}`
}

export async function verifyToken(token, env) {
  if (!token || !env.SESSION_SECRET) return false
  const parts = String(token).split('.')
  if (parts.length !== 2) return false
  const [p, s] = parts
  try {
    const expect = await hmac(env.SESSION_SECRET, new TextDecoder().decode(b64urlDecode(p)))
    if (!timingSafeEqual(s, b64url(expect))) return false
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)))
    if (!payload || typeof payload.exp !== 'number') return false
    if (payload.exp <= Date.now()) return false
    // 版本号对不上＝这张票已被「改密码 / 吊销所有会话」作废。
    // 旧版本签发的票没有 v，按 0 处理：没改过密码前它们继续有效，改过之后一并失效。
    return Number(payload.v || 0) === await sessionVersion(env)
  } catch {
    return false
  }
}

// 登录失败节流：同一来源连续失败过多时临时锁定，缓解暴力破解
// Worker 无持久存储，计数存活于 isolate 内；Cloudflare 多边缘节点各自计数，
// 单点上限略松，但足以拖慢脚本化爆破，配合强密码足够。
const attempts = new Map()
const MAX_FAIL = 6
const LOCK_MS = 15 * 60 * 1000

function clientKey(req) {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown'
}

export function lockRemaining(key) {
  const rec = attempts.get(key)
  if (!rec || !rec.lockedUntil) return 0
  const left = rec.lockedUntil - Date.now()
  if (left <= 0) { attempts.delete(key); return 0 }
  return Math.ceil(left / 1000)
}

export function noteFailure(key) {
  const rec = attempts.get(key) || { fails: 0 }
  rec.fails += 1
  if (rec.fails >= MAX_FAIL) rec.lockedUntil = Date.now() + LOCK_MS
  attempts.set(key, rec)
  return rec.fails
}

export function noteSuccess(key) {
  attempts.delete(key)
}

export async function checkLogin(req, env, body) {
  const key = clientKey(req)
  const locked = lockRemaining(key)
  if (locked > 0) return { ok: false, lockedFor: locked }

  const pass = String((body && body.password) || '')
  // 密码来源：数据仓里的 PBKDF2 记录优先（应用内改过密码），否则用 Worker Secret 的初始密码。
  // 未配置任何密码时才算服务端配置错误。
  const rec = await readAuth(env, true)
  if (!(rec && rec.hash) && !env.APP_PASSWORD) return { ok: false, misconfigured: true }
  const ok = await passwordMatches(env, pass, { fresh: true })
  if (!ok) {
    const fails = noteFailure(key)
    const remain = MAX_FAIL - fails
    return { ok: false, remain: remain > 0 ? remain : 0 }
  }
  noteSuccess(key)
  const remember = body && body.remember
  const ttlMs = remember ? 30 * 24 * 3600 * 1000 : 12 * 3600 * 1000
  const version = Number(rec && rec.version || 0)
  return { ok: true, token: await issueToken(env, 'admin', ttlMs, version), expiresIn: ttlMs, version }
}

// 从请求中取出 bearer token
export function bearer(req) {
  const h = req.headers.get('Authorization') || ''
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1] : ''
}

// CORS 白名单：只允许自家域名（不再对全网开放读取）。
// 本地开发不强制配置 ALLOWED_ORIGINS：白名单为空时才放行 localhost / 127.0.0.1，
// 一旦配置了白名单就只认配置（生产环境必须配置，localhost 不再被隐式放行）。
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
export function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || ''
  const allow = (env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const devOrigin = !allow.length && LOCAL_ORIGIN.test(origin)
  const okOrigin = allow.includes(origin) ? origin : (devOrigin ? origin : (allow[0] || ''))
  return {
    'Access-Control-Allow-Origin': okOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    // 简易加固：禁止被嵌套、关闭 MIME 嗅探
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  }
}
