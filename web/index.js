import { handleApi } from '../api/routes.js'

export default {
  async fetch(req, env) {
    const url = new URL(req.url)

    if (url.pathname.startsWith('/api/')) {
      return handleApi(req, url, env)
    }

    return env.ASSETS.fetch(req)
  }
}
