const GITHUB_API = 'https://api.github.com/repos'

function b64(s) { return btoa(unescape(encodeURIComponent(s))) }
function b64d(s) { return decodeURIComponent(escape(atob(s))) }

export async function gh(req, env, method = 'GET', body) {
  const headers = {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    'User-Agent': 'stock-git-ai-worker/1.0'
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

  // GitHub /contents 对大于 1MB 的文件只返回 sha/size，content 为空字符串。
  // 若此时静默返回 []，下一次 writeJSON 就会用空数组把整份数据仓覆盖掉 —— 历史数据全丢。
  // 因此先改用 git blob API 取真实内容；仍取不到就抛错，宁可报错也绝不静默变空。
  if (!content && data.sha && data.size > 0) {
    const blob = await gh(`/git/blobs/${data.sha}`, env, 'GET')
    if (blob && blob.encoding === 'base64' && blob.content) content = b64d(blob.content)
  }
  if (!content) {
    // 只有文件确实为空（size 为 0，如新建仓库）才允许当作空数组
    if (!data.size) return []
    throw new Error(`读取 ${file} 失败：GitHub 返回空内容但文件有 ${data.size} 字节，已中止以避免覆盖数据`)
  }
  try {
    return JSON.parse(content)
  } catch (e) {
    throw new Error(`读取 ${file} 失败：内容不是合法 JSON（${e.message}），已中止以避免覆盖数据`)
  }
}

export async function writeJSON(env, file, data, message) {
  const payload = JSON.stringify(data, null, 2)
  const body = {
    message: message || `update ${file}`,
    content: b64(payload),
    branch: env.GITHUB_BRANCH || 'main'
  }
  // 网络异常或 GitHub 5xx/429 时重试一次（重试前重新拉取 sha，避免过期）；
  // 409 不重试——它意味着 GET sha 与 PUT 之间确实有人并发写过该文件，
  // 重试会用本端的旧全量覆盖对方刚写入的内容（丢数据），宁可报错让用户重开单据；
  // 其余 4xx（鉴权/参数问题）重试无意义，直接抛出
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let existing = null
      try {
        existing = await gh(`/contents/${file}`, env, 'GET')
        body.sha = existing.sha
      } catch {
        // 文件不存在，不传 sha
        delete body.sha
      }
      // 内容逐字节相同就不提交：保存一张单据要派生写回 items/suppliers/stock/purchases/sales 等
      // 最多 6 个文件，其中 items.json 约 0.9MB、purchases.json 约 0.5MB，
      // 重复提交同样内容只会放大 GitHub 写入压力（限流/超时概率），没有任何收益
      if (existing && existing.encoding === 'base64' && typeof existing.content === 'string'
        && existing.content && b64d(existing.content) === payload) {
        return { skipped: true, sha: existing.sha }
      }
      if (existing && ['purchases.json', 'sales.json', 'customers.json', 'suppliers.json'].includes(file)) {
        let current = existing
        if (!current.content && current.size > 0) current = await gh(`/git/blobs/${current.sha}`, env)
        if (!current.content) throw new Error('资金保护校验无法读取原数据，已中止')
        const before = JSON.parse(b64d(current.content))
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
        if (file === 'purchases.json' || file === 'sales.json') {
          const parentIds = new Set(before.filter(o => o.sourceOrderId).map(o => o.sourceOrderId))
          for (const old of before) {
            const next = data.find(o => o.id === old.id)
            const returnLocked = Number(old.total) < 0 || String(old.type || '').endsWith('-return')
            if (returnLocked) {
              const financial = o => { const { photos, remark, ...rest } = o; return rest }
              if (!next || !same(financial(old), financial(next))) throw new Error(`退货单 ${old.id} 只允许在退货退款页面操作，请刷新`)
            }
            if (parentIds.has(old.id)) {
              if (!next || ['items', 'total', 'discount', 'discountRate', 'discountRates', 'customer', 'supplier'].some(k => !same(old[k], next[k]))) throw new Error(`原单 ${old.id} 已有关联退货，不允许修改货款或删除`)
            }
            if ((old.settlements || []).length && (!next || !same(old.settlements, next.settlements))) throw new Error(`单据 ${old.id} 核销已更新，请刷新后重试`)
          }
        } else {
          const field = file === 'customers.json' ? 'deposits' : 'advances'
          for (const old of before) {
            const protectedRows = (old[field] || []).filter(p => p.voucher?.startsWith('HX-'))
            if (!protectedRows.length) continue
            const next = data.find(p => p.code === old.code)
            if (!next || protectedRows.some(p => !(next[field] || []).some(n => same(n, p)))) throw new Error('退货转余额记录已更新，请刷新后重试')
          }
        }
      }
      return await gh(`/contents/${file}`, env, 'PUT', body)
    } catch (e) {
      const msg = String(e && e.message || e)
      const status = Number((/GitHub (\d{3})/.exec(msg) || [])[1])
      const retryable = !status || status >= 500 || status === 429
      if (attempt === 2 || !retryable) throw e
      await new Promise(r => setTimeout(r, status === 429 ? 1500 : 600))
    }
  }
}
