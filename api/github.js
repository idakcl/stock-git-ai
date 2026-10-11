const GITHUB_API = 'https://api.github.com/repos'

function b64(s) { return btoa(unescape(encodeURIComponent(s))) }
function b64d(s) { return decodeURIComponent(escape(atob(s))) }

export async function gh(req, env, method = 'GET', body) {
  const headers = {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json'
  }
  const opts = { method, headers }
  if (body) opts.body = JSON.stringify(body)
  const url = `${GITHUB_API}/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${req}`
  const res = await fetch(url, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${data.message || res.statusText}`)
  return data
}

export async function readJSON(env, file) {
  const data = await gh(`/contents/${file}`, env, 'GET')
  let content = ''
  if (data.encoding === 'base64') content = b64d(data.content)
  else if (typeof data.content === 'string') content = data.content
  try { return JSON.parse(content || '[]') } catch { return [] }
}

export async function writeJSON(env, file, data, message) {
  const payload = JSON.stringify(data, null, 2)
  const body = {
    message: message || `update ${file}`,
    content: b64(payload),
    branch: env.GITHUB_BRANCH || 'main'
  }
  try {
    const existing = await gh(`/contents/${file}`, env, 'GET')
    body.sha = existing.sha
  } catch {
    // 文件不存在，不传 sha
  }
  return gh(`/contents/${file}`, env, 'PUT', body)
}
