export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (url.pathname === '/test') {
      try {
        const res = await fetch('https://api.github.com/repos/idakcl/stock-git-ai-data/contents/items.json', {
          headers: {
            Authorization: `token ${env.GITHUB_TOKEN}`,
            'Content-Type': 'application/json'
          }
        })
        const body = await res.text()
        return new Response(JSON.stringify({ status: res.status, body: body.slice(0, 300) }), {
          headers: { 'Content-Type': 'application/json' }
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          headers: { 'Content-Type': 'application/json' }
        })
      }
    }
    return new Response('ok')
  }
}
