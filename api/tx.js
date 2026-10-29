// 事务基座：「固定 Git 快照读 + 一次提交写多个文件」。
// 退款（api/refunds.js）、订单过账（api/orders.js）、单据变更（api/amends.js）共用这一套，
// 语义逐条对齐，避免同一个坑在三个入口各修一遍：
//   · 分片集合以 .split-yearly.json 标记为权威，读写都落到 purchases-2025.json 这一族文件；
//   · 单个分片读失败一律中止（当成「这一年没有单」会把整片清空）；
//   · 只写真正变化的文件，logs 仅在有变化时追加；
//   · 提交带 baseCommit/baseTree 基线校验，分支被别处推进就失败，绝不自动重放。
import { gh, commitFiles } from './github.js'
import { SPLIT_KEYS, bucketName, bucketOf, isBucketFile, readMarker, sortOrders } from './storage.js'

const decodeBlob = (content) => JSON.parse(
  new TextDecoder().decode(Uint8Array.from(atob(String(content).replace(/\s/g, '')), c => c.charCodeAt(0))))

// 列目录：按年分片后要找 purchases-2025.json 这一族文件；logs/ 目录下的日志分片不属于集合
function bucketNamesAt(treeByName, key) {
  return [...treeByName.keys()]
    .filter(name => !name.startsWith('logs/') && isBucketFile(key, name))
    .map(name => ({ name, sha: treeByName.get(name) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
}

// 读取一份固定快照。keys 里的集合按权威口径读出；optional 允许缺失（新集合上线时文件还不存在）。
export async function openTransaction(env, keys, { optional = [] } = {}) {
  const branch = env.GITHUB_BRANCH || 'main'
  const ref = await gh(`/git/ref/heads/${encodeURIComponent(branch)}`, env)
  const parent = ref.object.sha
  const commit = await gh(`/git/commits/${parent}`, env)
  const fullTree = await gh(`/git/trees/${commit.tree.sha}?recursive=1`, env)
  const treeByName = new Map((fullTree.tree || []).filter(t => t.type === 'blob').map(t => [t.path, t.sha]))
  const split = await readMarker(env)

  const readAtRef = async (path) => {
    const sha = treeByName.get(path)
    if (!sha) throw new Error(`${path} 不存在，已中止`)
    const blob = await gh(`/git/blobs/${sha}`, env)
    return decodeBlob(blob.content)
  }

  const state = {}
  await Promise.all(keys.map(async key => {
    if (SPLIT_KEYS.has(key) && split[key]) {
      const buckets = bucketNamesAt(treeByName, key)
      const parts = await Promise.all(buckets.map(m => readAtRef(m.name).catch(e => {
        throw new Error(`${m.name} 读取失败（${e.message || e}），已中止以避免覆盖单据`)
      })))
      state[key] = sortOrders(parts.reduce((acc, arr) => acc.concat(Array.isArray(arr) ? arr : []), []))
      return
    }
    if (!treeByName.has(`${key}.json`)) {
      // 只有明确声明 optional 的新集合（refunds / orders）允许缺失；主数据缺失必须报错
      if (optional.includes(key)) { state[key] = []; return }
      throw new Error(`${key}.json 不存在，已中止`)
    }
    state[key] = await readAtRef(`${key}.json`)
    if (key !== 'stock' && !Array.isArray(state[key])) throw new Error(`${key}.json 格式错误`)
  }))

  // keys 原样带出去：commitTransaction 只按这份清单落库。
  // derive() 的返回值里还有 history / saleHistory 两个「按需派生、不落库」的键，
  // 若按 next 的键名反推要写哪些文件，会给库里凭空多出 history.json（≈390KB）这种巨型文件。
  return { env, branch, parent, baseTree: commit.tree.sha, treeByName, split, state, keys }
}

// 把 next 相对 state 的差异提交成一次 commit。
// logEntry 传对象则追加到 logs.json（仅在确实有写入时），与退款链路同一口径。
export async function commitTransaction(tx, { next, message, logEntry }) {
  const { env, parent, baseTree, treeByName, split, state, keys } = tx
  const target = (keys || Object.keys(next)).filter(k => k !== 'logs')
  const changed = target.filter(k => JSON.stringify(next[k]) !== JSON.stringify(state[k]))
  const anySplit = [...SPLIT_KEYS].some(k => split[k])
  const set = []
  const remove = []

  if (!anySplit) {
    // 库里还没做过分片迁移：整表覆盖
    for (const k of changed) set.push({ path: `${k}.json`, content: JSON.stringify(next[k], null, 0) })
  } else {
    const byBucket = (key, list) => {
      const m = new Map()
      for (const o of list) {
        const name = bucketName(key, bucketOf(o))
        if (!m.has(name)) m.set(name, [])
        m.get(name).push(o)
      }
      return m
    }
    for (const key of keys) {
      if (!SPLIT_KEYS.has(key) || !split[key]) continue
      // 两边都先排成存储层的 canon 次序：新单是 push 到末尾的，不排序会和下次保存的次序不同，
      // 白多一次「内容相同但顺序不同」的重写
      const before = byBucket(key, sortOrders(state[key] || []))
      const after = byBucket(key, sortOrders(next[key] || []))
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        const a = before.get(name) || []
        const b = after.get(name) || []
        if (JSON.stringify(a) === JSON.stringify(b)) continue
        set.push({ path: name, content: JSON.stringify(b, null, 0) })
      }
      // 迁移残留的旧整表：这次提交顺手删干净，避免 AI 直读时读到过期整表
      if (treeByName.has(`${key}.json`)) remove.push(`${key}.json`)
    }
    for (const k of changed) {
      if (SPLIT_KEYS.has(k)) continue
      set.push({ path: `${k}.json`, content: JSON.stringify(next[k], null, 0) })
    }
  }

  if (!set.length && !remove.length) return { unchanged: true, changed: [] }
  if (logEntry) {
    const logs = [...(state.logs || []), { time: new Date().toISOString(), ...logEntry }].slice(-200)
    set.push({ path: 'logs.json', content: JSON.stringify(logs, null, 0) })
  }
  const sha = await commitFiles(env, { set, remove, message, baseCommit: parent, baseTree })
  return { sha, changed }
}
