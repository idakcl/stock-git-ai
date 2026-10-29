// 假 GitHub：内存里实现 Worker 用到的那几段 API，用来验证存储层与迁移安全。
// 覆盖 /contents 读写删与列目录、/git/ref、/git/commits、/git/trees、/git/blobs。
// 语义刻意照抄真实 API：
//   · >1MB 的文件不返回 content（只有 sha/size）
//   · PUT 带 sha 但 sha 不符 → 409；DELETE 同理
//   · 创建 commit 对象不移动分支，只有 PATCH /git/ref 才移动（force:false 时必须是当前 head 的子提交）
export function makeFakeRepo(initial = {}, { inlineLimit = 1024 * 1024, blobFail = false } = {}) {
  // tree 是当前分支快照：{ path: content }
  const tree = {}
  for (const [k, v] of Object.entries(initial)) tree[k] = typeof v === 'string' ? v : JSON.stringify(v)

  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
  const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8')
  const shaOf = (s) => {
    let h = 0
    for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0
    return h.toString(16).padStart(8, '0') + '0'.repeat(32)
  }

  let seq = 0
  let refSha = 'root'
  const commits = [{ sha: 'root', message: 'initial', parents: [], tree: { ...tree } }]
  const trees = new Map([['root-tree', { ...tree }]])
  let treeSeq = 0
  const calls = {}

  // 记录一个提交对象；move=true 时才把分支挪过去（模拟 Contents API 的「提交即上分支」）
  function addCommit(t, message, parents, move) {
    const sha = 'c' + (++seq)
    commits.push({ sha, message, parents: parents || [refSha], tree: { ...t } })
    if (move) {
      refSha = sha
      for (const k of Object.keys(tree)) delete tree[k]
      Object.assign(tree, t)
    }
    return sha
  }

  const respond = (status, body) => ({ ok: status < 400, status, json: async () => body })

  async function fetch(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase()
    const path = new URL(url).pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '')
    const body = opts.body ? JSON.parse(opts.body) : null
    calls[method] = (calls[method] || 0) + 1

    if (path.startsWith('/contents')) {
      const name = decodeURIComponent(path.slice('/contents'.length)).replace(/^\//, '')
      if (method === 'GET') {
        if (!name) {
          return respond(200, Object.keys(tree).sort().map(n => ({ name: n, path: n, type: 'file', sha: shaOf(tree[n]) })))
        }
        if (!(name in tree)) return respond(404, { message: 'Not Found' })
        const c = tree[name]
        const big = c.length > inlineLimit
        return respond(200, {
          name, path: name, sha: shaOf(c), size: c.length,
          encoding: big ? null : 'base64',
          content: big ? '' : b64(c)
        })
      }
      if (method === 'PUT') {
        const next = unb64(body.content)
        if (body.sha && (name in tree) && shaOf(tree[name]) !== body.sha) return respond(409, { message: 'sha could not be found' })
        if (body.sha && !(name in tree)) return respond(422, { message: 'file does not exist' })
        addCommit({ ...tree, [name]: next }, body.message, null, true)
        return respond(201, { content: { sha: shaOf(next) } })
      }
      if (method === 'DELETE') {
        if (!(name in tree)) return respond(404, { message: 'Not Found' })
        if (body.sha && shaOf(tree[name]) !== body.sha) return respond(409, { message: 'out of date' })
        const t = { ...tree }
        delete t[name]
        addCommit(t, body.message, null, true)
        return respond(200, {})
      }
    }

    // GET 用单数 /git/ref/{ref}，PATCH 用复数 /git/refs/{ref} —— 真实 API 就是这两个路径
    if (path.startsWith('/git/ref/heads/') || path.startsWith('/git/refs/heads/')) {
      if (method === 'GET') return respond(200, { object: { sha: refSha } })
      if (method === 'PATCH') {
        const mine = commits.find(c => c.sha === body.sha)
        if (!mine) return respond(422, { message: 'no such commit' })
        if (mine.parents[0] !== refSha && body.force === false) return respond(422, { message: 'cannot force update' })
        refSha = body.sha
        for (const k of Object.keys(tree)) delete tree[k]
        Object.assign(tree, mine.tree)
        return respond(200, { object: { sha: refSha } })
      }
    }

    if (path.startsWith('/git/commits')) {
      const sha = path.split('/').pop()
      if (method === 'GET') {
        const c = commits.find(x => x.sha === sha)
        if (!c) return respond(404, { message: 'Not Found' })
        const tsha = 't-' + sha
        trees.set(tsha, c.tree)
        return respond(200, { sha, tree: { sha: tsha } })
      }
      if (method === 'POST') {
        const t = trees.get(body.tree)
        if (!t) return respond(422, { message: 'tree not found' })
        return respond(201, { sha: addCommit(t, body.message, body.parents, false) })
      }
    }

    if (path.startsWith('/git/trees')) {
      const sha = path.split('/').pop()
      if (method === 'GET') {
        const t = trees.get(sha)
        if (!t) return respond(404, { message: 'Not Found' })
        return respond(200, { sha, tree: Object.entries(t).map(([p, c]) => ({ path: p, type: 'blob', sha: shaOf(c) })) })
      }
      if (method === 'POST') {
        const base = body.base_tree ? { ...(trees.get(body.base_tree) || {}) } : { ...tree }
        for (const e of (body.tree || [])) {
          if (e.content === null || e.content === undefined) delete base[e.path]
          else base[e.path] = e.content
        }
        const tsha = 'ntree-' + (++treeSeq)
        trees.set(tsha, base)
        return respond(201, { sha: tsha })
      }
    }

    if (path.startsWith('/git/blobs/')) {
      const sha = path.split('/').pop()
      const entry = Object.entries(tree).find(([, c]) => shaOf(c) === sha)
      if (!entry) return respond(404, { message: 'Not Found' })
      // 模拟「blob 也取不到内容」的异常，用来验证读取失败绝不静默变空
      if (blobFail) return respond(404, { message: 'Not Found' })
      return respond(200, { encoding: 'base64', content: b64(entry[1]) })
    }

    throw new Error(`fake GitHub 未实现：${method} ${path}`)
  }

  globalThis.fetch = fetch
  return {
    calls,
    tree: () => ({ ...tree }),
    read: (p) => (p in tree ? tree[p] : undefined),
    has: (p) => p in tree,
    names: () => Object.keys(tree).sort(),
    log: () => commits.map(c => c.message),
    // 并发模拟：外部直接改库（绕过被测代码），用来验证 sha/force 兜底
    poke: (p, content) => { tree[p] = typeof content === 'string' ? content : JSON.stringify(content) },
    head: () => refSha
  }
}
