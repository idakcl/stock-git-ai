import { handleApi } from '../api/routes.js'

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)

    if (url.pathname.startsWith('/api/')) {
      return handleApi(req, url, env)
    }

    // 静态资源：先尝试直接命中
    const asset = await env.ASSETS.fetch(
      new Request(req.url, { cf: { cacheTtl: 0, bypassCache: true } })
    )
    if (asset.status === 200) {
      return asset
    }

    // SPA 回退：返回 index.html
    const index = await env.ASSETS.fetch(
      new Request(`${url.origin}/index.html`, { cf: { cacheTtl: 0, bypassCache: true } })
    )
    if (index.status === 200) {
      const headers = new Headers(index.headers)
      headers.set('Content-Type', 'text/html; charset=utf-8')
      headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
      return new Response(index.body, { status: 200, headers })
    }

    return new Response('Not Found', { status: 404 })
  }
}
