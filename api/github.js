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

// 一次 git 提交完成多文件的「改 + 增 + 删」，原子生效。
// 为什么不用 base_tree：GitHub 的 POST /git/trees 实测拒绝删除条目 ——
//   { path, content: null } → 422 "Must supply either tree.sha or tree.content.
//   Request will be rejected if both are present."
// （整仓迁移就是这么每次都静默失败的）。base_tree 本身也不能和删除共存。
// 可行写法：把基线提交的**根 tree** 整份列出来，未变动的条目按 sha 原样引用（不重传内容），
// 变动的条目带 content，要删的条目干脆不列 —— 提交的是完整树，不是补丁。
// 并发保护：commit 的 parent 固定为基线提交，再 PATCH refs 且 force:false；
// 基线之后分支若已被别人推进，直接中止（否则会以「新数据为祖先」的姿态静默覆盖对方的写）。
export async function commitFiles(env, { set, remove = [], message, baseCommit, baseTree }) {
  const branch = env.GITHUB_BRANCH || 'main'
  const ref = await gh(`/git/ref/heads/${encodeURIComponent(branch)}`, env)
  const head = ref.object.sha
  const base = baseCommit || head
  if (baseCommit && baseCommit !== head) {
    throw new Error(`数据仓已被其他操作更新（${baseCommit.slice(0, 8)} → ${head.slice(0, 8)}），本次保存已中止，请刷新后重试`)
  }
  let treeSha = baseTree
  if (!treeSha) treeSha = (await gh(`/git/commits/${base}`, env)).tree.sha
  const root = await gh(`/git/trees/${treeSha}`, env)
  const overwrite = new Map((set || []).map(e => [e.path, e]))
  const gone = new Set(remove)
  const entries = []
  for (const e of (root.tree || [])) {
    if (overwrite.has(e.path) || gone.has(e.path)) continue
    entries.push({ path: e.path, mode: e.mode, type: e.type, sha: e.sha })
  }
  for (const e of (set || [])) entries.push({ path: e.path, mode: e.mode || '100644', type: 'blob', content: e.content })
  const newTree = await gh('/git/trees', env, 'POST', { tree: entries })
  const created = await gh('/git/commits', env, 'POST', { message, tree: newTree.sha, parents: [base] })
  await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, env, 'PATCH', { sha: created.sha, force: false })
  return created.sha
}

// 读取 + 保留原文。writeJSON 的 opts.known 用的就是这里的 content，
// 一次读、一次比对，省掉「为拿 sha 再 GET 一遍」的重复请求与重复解析。
export async function readJSONWithRaw(env, file) {
  const data = await gh(`/contents/${file}`, env, 'GET')
  let content = ''
  if (data.encoding === 'base64') content = b64d(data.content)
  else if (typeof data.content === 'string') content = data.content

  // GitHub /contents 对大于 1MB 的文件只返回 sha/size，content 为空字符串。
  // 若此时静默返回 []，下一次 writeJSON 就会用空数组把整份数据仓覆盖掉 —— 历史数据全丢。
  // 因此先改用 git blob API 取真实内容；仍取不到就抛错，宁可报错也绝不静默变空。
  if (!content && data.sha && data.size > 0) {
    // blob 读取本身的失败不能冒泡成 404：上层用 404 判断「文件还没创建」，
    // 把「文件在、内容取不到」误判成「文件不存在」就等于授权了一次空表覆盖
    try {
      const blob = await gh(`/git/blobs/${data.sha}`, env, 'GET')
      if (blob && blob.encoding === 'base64' && blob.content) content = b64d(blob.content)
    } catch { /* 落到下面的抛错分支 */ }
  }
  if (!content) {
    // 只有文件确实为空（size 为 0，如新建仓库）才允许当作空数组
    if (!data.size) return { value: [], content: '', sha: data.sha }
    throw new Error(`读取 ${file} 失败：GitHub 返回空内容但文件有 ${data.size} 字节，已中止以避免覆盖数据`)
  }
  try {
    return { value: JSON.parse(content), content, sha: data.sha }
  } catch (e) {
    throw new Error(`读取 ${file} 失败：内容不是合法 JSON（${e.message}），已中止以避免覆盖数据`)
  }
}

export async function readJSON(env, file) {
  return (await readJSONWithRaw(env, file)).value
}

// 数据仓一律写紧凑 JSON（不缩进）。
// 实测同一份数据 compact 比 pretty 小 31%–41%（purchases 608→371KB、items 310→208KB、
// suppliers 33→19KB），而体积同时决定：GitHub 内容请求的字节数、Worker 解析 CPU、git 历史增速。
// 代价是文件人工不可读、git diff 一行就是整条记录；数据仓本来就是给程序与 AI 读的，不给人读。
export function serialize(data) {
  return JSON.stringify(data, null, 0)
}

export async function writeJSON(env, file, data, message, opts = {}) {
  const payload = serialize(data)
  // 资金保护对「按年分片后的单据文件」同样必须生效：分片只是把同一批单据拆到不同文件，
  // 每个文件内部仍是「该片旧单据 vs 该片新单据」的整组比对，校验语义与整表完全一致。
  // 漏掉这一条，退货单锁、关联单锁、核销锁在分片库上就全部失效（可直接改金额保存）。
  const isDocFile = /^(?:purchases|sales)(?:-\d{4})?\.json$/.test(file)
  const isPartyFile = /^(?:customers|suppliers)\.json$/.test(file)
  const protectedFile = isDocFile || isPartyFile
  // opts.known = 调用方本轮刚读到的该文件原文 { content, sha }（见 readJSONWithRaw）。
  // 传进来就复用：省掉一次「只为拿 sha」的 GET 和一次整文件 base64 解码。
  // 复用范围仅限「同一条读取链」：写单张单据时 syncDerived 刚把全表读进内存，
  // 拿那份原文做 sha 与资金保护校验，与重新回读等价，安全性不打折；
  // 重试轮一律回源取新 sha（并发写必须由新 sha 暴露成 409，不能拿旧 known 蒙过去）。
  const known = opts.known || null
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
    const useKnown = attempt === 1 ? known : null
    try {
      let existing = null
      if (useKnown && typeof useKnown.content === 'string' && useKnown.sha) {
        existing = { sha: useKnown.sha, encoding: 'base64', content: b64(useKnown.content) }
        body.sha = useKnown.sha
      } else {
        try {
          existing = await gh(`/contents/${file}`, env, 'GET')
          body.sha = existing.sha
        } catch {
          // 文件不存在，不传 sha
          delete body.sha
        }
      }
      // 内容逐字节相同就不提交：保存一张单据要派生写回 items/suppliers/stock/purchases/sales 等
      // 最多 6 个文件；重复提交同样内容只会放大 GitHub 写入压力（限流/超时概率），没有任何收益
      if (existing && typeof existing.content === 'string' && existing.content
        && b64d(existing.content) === payload) {
        return { skipped: true, sha: existing.sha }
      }
      if (existing && protectedFile) {
        let current = existing
        if (!current.content && current.size > 0) current = await gh(`/git/blobs/${current.sha}`, env)
        if (!current.content) throw new Error('资金保护校验无法读取原数据，已中止')
        const before = JSON.parse(b64d(current.content))
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
        if (isDocFile) {
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

// 列目录：按年分片后要找到 purchases-2025.json 这一族文件。
// 数据仓是平铺结构，一次列根目录即可拿到全部文件名与 sha。
export async function listFiles(env) {
  const data = await gh(`/contents/`, env, 'GET')
  return Array.isArray(data) ? data : []
}
