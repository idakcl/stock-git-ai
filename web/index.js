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
//   5. 统一用「规范 GET Request」作为缓存 key（method=GET + url + 固定的 accept 头），
//      保证 GET 的 put 与 POST 的 delete 精确匹配（避免请求头差异导致删除失效）。
const GET_TTL = 15

function cacheKey(url) {
  return new Request(url.toString(), { method: 'GET', headers: { accept: 'application/json' } })
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)

    if (url.pathname.startsWith('/api/')) {
      // AI-API：响应内容随密钥权限（scope）而变，而 Authorization 不参与边缘缓存键 ——
      // 一旦缓存，A 密钥查到的结果会被 B 密钥直接读到（越权泄露）。因此这条路径完全绕开缓存层。
      // 调用日志同理：缓存 15s 会看到「刚调用却查不到」，排障时最需要它实时。
      if (url.pathname.startsWith('/api/ai/') || url.pathname === '/api/ai-logs') return handleApi(req, url, env)

      // ---- GET：边缘缓存优先 ----
      if (req.method === 'GET') {
        try {
          const hit = await caches.default.match(cacheKey(url))
          if (hit) {
            const h = new Headers(hit.headers)
            h.set('X-Cache', 'HIT')
            return new Response(hit.body, { status: hit.status, headers: h })
          }
        } catch (_) { /* 缓存不可用则忽略，回源 */ }

        const res = await handleApi(req, url, env)
        if (res.status === 200) {
          const h = new Headers(res.headers)
          h.set('Cache-Control', `public, s-maxage=${GET_TTL}, stale-while-revalidate=30`)
          h.set('X-Cache', 'MISS')
          const out = new Response(res.body, { status: res.status, headers: h })
          try { await caches.default.put(cacheKey(url), out.clone()) } catch (_) { /* 存失败不影响返回 */ }
          return out
        }
        return res
      }

      // ---- POST：写后主动失效对应 GET 缓存 ----
      if (req.method === 'POST') {
        const res = await handleApi(req, url, env)
        if (res.status === 200) {
          try { await caches.default.delete(cacheKey(url)) } catch (_) { /* best-effort */ }
        }
        return res
      }

      // OPTIONS 预检等其它方法：直接透传
      return handleApi(req, url, env)
    }

    return env.ASSETS.fetch(req)
  }
}
