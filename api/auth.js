// 会话鉴权：登录签发 HMAC 票据 + 全站 API 校验
// 为什么不用 JWT 库：Worker 环境内置 Web Crypto，自签 HMAC-SHA256 足够，且零依赖。
// token 格式：base64url(payload).base64url(signature)
// payload 内含过期时间(exp)、签发时间(iat)、主题(sub)，签名密钥来自 Worker Secret(SESSION_SECRET)
const enc = new TextEncoder()

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

export async function issueToken(env, user = 'admin', ttlMs = 12 * 3600 * 1000) {
  const now = Date.now()
  const payload = JSON.stringify({ sub: user, iat: now, exp: now + ttlMs })
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
    return payload.exp > Date.now()
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

  if (!env.APP_PASSWORD) return { ok: false, misconfigured: true }
  const pass = String((body && body.password) || '')
  if (!timingSafeEqual(pass, env.APP_PASSWORD)) {
    const fails = noteFailure(key)
    const remain = MAX_FAIL - fails
    return { ok: false, remain: remain > 0 ? remain : 0 }
  }
  noteSuccess(key)
  const remember = body && body.remember
  const ttlMs = remember ? 30 * 24 * 3600 * 1000 : 12 * 3600 * 1000
  return { ok: true, token: await issueToken(env, 'admin', ttlMs), expiresIn: ttlMs }
}

// 从请求中取出 bearer token
export function bearer(req) {
  const h = req.headers.get('Authorization') || ''
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1] : ''
}

// CORS 白名单：只允许自家域名（不再对全网开放读取）
export function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || ''
  const allow = (env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const okOrigin = allow.includes(origin) ? origin : (allow[0] || '')
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
