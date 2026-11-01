import { handleApi } from '../api/routes.js'

// Phase 0：读边缘缓存（零风险提速，不动数据层与写路径）
// 设计要点：
//   1. GET /api/* 命中 CF 边缘缓存（Cache API 同边缘 + s-maxage 全局双层），<10ms 返回，不再回源 GitHub；
//      响应头加 Cache-Control: s-maxage=15, stale-while-revalidate=30 —— 15s 内直接命中，
//      30s 内可返回陈旧副本同时后台回源更新，进一步削峰。
//   2. POST /api/* 写成功后，主动 delete 对应 GET 缓存（best-effort），写后立刻读到最新，
//      把「最多 15s 陈旧窗口」降到 ≈0（同边缘连续读写场景）。
//   3. 缓存层与数据权威源（GitHub）解耦：写永远直接落 GitHub，缓存只是只读副本，
//      TTL 一到必回源，不会产生分叉或永久不一致；AI 直读 GitHub 也不受影响。
//   4. 所有 cache 操作均包 try/catch：缓存层（本地/边缘）不可用时静默降级为回源，绝不影响主业务。
//   5. 缓存 key 必须「绑身份」：Authorization 不参与 CF 的默认缓存键，只按 URL 缓存会让
//      未登录请求（或换一把密钥的请求）读到别人的 200 响应。这里把 token 的 SHA-256 摘要
//      拼进 key，并让未登录请求完全不参与缓存（既不读也不写）。
//      代价：不同设备/会话各存一份，写后只有本会话的缓存被立刻失效，其他设备最多陈旧 15s。
//      想彻底关掉提速（每个 GET 都回源 GitHub），把 CACHE_SCOPE 改成 'off' 即可。
const GET_TTL = 15
const CACHE_SCOPE = 'session'

async function tokenDigest(auth) {
  const token = String(auth || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return ''
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(buf).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// 未登录（无 token）一律返回 null：不读缓存、不写缓存，请求直接进鉴权，避免任何串号可能。
async function cacheKey(url, auth) {
  if (CACHE_SCOPE === 'off') return null
  const digest = await tokenDigest(auth)
  if (!digest) return null
  const u = new URL(url.toString())
  u.searchParams.set('__ck', digest)
  return new Request(u.toString(), { method: 'GET', headers: { accept: 'application/json' } })
}

// 静态资源（HTML/JS/CSS）的安全头：API 侧 corsHeaders 里有 XFO/nosniff，
// 但登录表单本身是静态页，必须由这里补，否则那几条保护不到承载票据的那张页面。
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; " +
    "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
}

function withSecurityHeaders(res) {
  const h = new Headers(res.headers)
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)

    if (url.pathname.startsWith('/api/')) {
      // AI-API：响应内容随密钥权限（scope）而变，而 Authorization 不参与边缘缓存键 ——
      // 一旦缓存，A 密钥查到的结果会被 B 密钥直接读到（越权泄露）。因此这条路径完全绕开缓存层。
      // 调用日志同理：缓存 15s 会看到「刚调用却查不到」，排障时最需要它实时。
      if (url.pathname.startsWith('/api/ai/') || url.pathname === '/api/ai-logs') return handleApi(req, url, env, ctx)

      const auth = req.headers.get('Authorization')

      // ---- GET：边缘缓存优先（仅限已登录，且按 token 摘要分区）----
      if (req.method === 'GET') {
        const key = await cacheKey(url, auth)
        if (key) {
          try {
            const hit = await caches.default.match(key)
            if (hit) {
              const h = new Headers(hit.headers)
              h.set('X-Cache', 'HIT')
              return new Response(hit.body, { status: hit.status, headers: h })
            }
          } catch (_) { /* 缓存不可用则忽略，回源 */ }
        }

        const res = await handleApi(req, url, env)
        if (res.status === 200 && key) {
          const h = new Headers(res.headers)
          h.set('Cache-Control', `private, s-maxage=${GET_TTL}, stale-while-revalidate=30`)
          h.set('X-Cache', 'MISS')
          const out = new Response(res.body, { status: res.status, headers: h })
          try { await caches.default.put(key, out.clone()) } catch (_) { /* 存失败不影响返回 */ }
          return out
        }
        return res
      }

      // ---- POST：写后主动失效本会话对应的 GET 缓存 ----
      if (req.method === 'POST') {
        const res = await handleApi(req, url, env)
        if (res.status === 200) {
          const key = await cacheKey(url, auth)
          if (key) { try { await caches.default.delete(key) } catch (_) { /* best-effort */ } }
        }
        return res
      }

      // OPTIONS 预检等其它方法：直接透传
      return handleApi(req, url, env, ctx)
    }

    // 静态资源：补安全头（CSP / HSTS / XFO / nosniff / Referrer-Policy）
    const asset = await env.ASSETS.fetch(req)
    return withSecurityHeaders(asset)
  }
}
