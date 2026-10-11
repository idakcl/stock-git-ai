import { handleApi } from '../api/routes.js'

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

function extOf(path) {
  const m = path.match(/\.[^.\/]+$/)
  return m ? m[0].toLowerCase() : ''
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)

    if (url.pathname.startsWith('/api/')) {
      return handleApi(req, url, env)
    }

    const ct = CONTENT_TYPES[extOf(url.pathname)]

    if (ct) {
      const asset = await env.ASSETS.fetch(
        new Request(req.url, { cf: { cacheTtl: 0, bypassCache: true } })
      )
      if (asset.status === 200) {
        const headers = new Headers(asset.headers)
        headers.set('Content-Type', ct)
        return new Response(asset.body, { status: asset.status, headers })
      }
      return asset
    }

    const index = await env.ASSETS.fetch(
      new Request(`${url.origin}/index.html`, { cf: { cacheTtl: 0, bypassCache: true } })
    )
    const headers = new Headers(index.headers)
    headers.set('Content-Type', 'text/html; charset=utf-8')
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    return new Response(index.body, { status: index.status, headers })
  }
}
