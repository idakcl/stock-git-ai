import { gh, commitFiles } from './github.js'
import { applyRefundOperation, backfillHistoricalRefunds } from '../src/utils/refunds.js'
import { SPLIT_KEYS, bucketName, bucketOf, isBucketFile, readMarker, sortOrders } from './storage.js'

const keys = ['items', 'suppliers', 'customers', 'purchases', 'sales', 'refunds', 'stock', 'logs']

// 单据按年分片后，purchases.json / sales.json 可能已经不存在了。
// 退款走的是「一次 git 提交写多个文件」，读与写都必须跟着分片口径走，
// 否则要么读不到数据（409/404），要么把新退货单写进一个已经没有权威的空文件里 —— 单据直接消失。
function bucketNamesAt(treeByName, key) {
  return [...treeByName.keys()]
    .filter(name => !name.startsWith('logs/') && isBucketFile(key, name))
    .map(name => ({ name, sha: treeByName.get(name) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
}

function decodeBlob(content) {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(content.replace(/\s/g, '')), c => c.charCodeAt(0))))
}

// 固定提交快照读取；订单、库存、退款凭证在一个 Git commit 中发布，失败不重放。
export async function refundTransaction(env, input, derive, rebuildStock) {
  const branch = env.GITHUB_BRANCH || 'main'
  const ref = await gh(`/git/ref/heads/${encodeURIComponent(branch)}`, env)
  const parent = ref.object.sha
  const commit = await gh(`/git/commits/${parent}`, env)
  const fullTree = await gh(`/git/trees/${commit.tree.sha}?recursive=1`, env)
  // treeByName: 路径 → blob sha（Git Trees 返回的是对象数组，这里只留 sha 这一列）
  const treeByName = new Map((fullTree.tree || []).filter(t => t.type === 'blob').map(t => [t.path, t.sha]))
  // 与存储层同一个判据：标记里记了这个集合，分片才是权威
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
        // 单个分片读失败不能当成「这一年没有单」——那会让下一次写库把这一片整片清空
        throw new Error(`${m.name} 读取失败（${e.message || e}），已中止以避免覆盖单据`)
      })))
      state[key] = sortOrders(parts.reduce((acc, arr) => acc.concat(Array.isArray(arr) ? arr : []), []))
      return
    }
    if (!treeByName.has(`${key}.json`)) {
      // 只有后期新增的资金/退款文件允许缺失；主数据缺失必须照常报错
      if (key === 'refunds') { state[key] = []; return }
      throw new Error(`${key}.json 不存在，已中止`)
    }
    state[key] = await readAtRef(`${key}.json`)
    if (key !== 'stock' && !Array.isArray(state[key])) throw new Error(`${key}.json 格式错误`)
  }))

  const result = input.action === 'backfill' ? backfillHistoricalRefunds(state) : applyRefundOperation(state, input)
  if (result.duplicate) return { ok: true, code: result.code, duplicate: true }
  const next = result.state
  if (input.action !== 'backfill') {
    Object.assign(next, derive(next.items, next.suppliers, next.purchases, next.sales, next.customers))
    next.stock = rebuildStock(next.purchases, next.sales, next.items)
  }

  // 库里还没做过分片迁移：写整表（紧凑 JSON），只有真变了的文件才进提交
  const anySplit = [...SPLIT_KEYS].some(k => split[k])
  if (!anySplit) {
    const set = keys.filter(k => JSON.stringify(next[k]) !== JSON.stringify(state[k])).map(k => ({
      path: `${k}.json`, content: JSON.stringify(next[k], null, 0)
    }))
    if (!set.length) return { ok: true, codes: result.codes || [], unchanged: true }
    const logs = [...state.logs, { time: new Date().toISOString(), source: 'refund', action: input.action, code: result.code, codes: result.codes }].slice(-200)
    set.push({ path: 'logs.json', content: JSON.stringify(logs, null, 0) })
    // baseCommit/baseTree：本轮读的是 parent 这个固定快照，提交必须落在同一个基线上
    const sha = await commitFiles(env, {
      set,
      message: `refund: ${input.action} ${result.code || (result.codes || []).join(', ')}`,
      baseCommit: parent, baseTree: commit.tree.sha
    })
    return { ok: true, code: result.code, returnId: result.returnId, codes: result.codes, commit: sha }
  }

  // 已分片：整表文件不再写入（若还在则一并删除），单据改动落到对应年片。
  // 年片是「整片覆盖」语义，所以只要这一年有任何一张单变化，就整片重写 ——
  // 真实数据里最大一片 81KB，整表 371KB，这正是分片要省的那笔开销。
  const byBucket = (key, list) => {
    const m = new Map()
    for (const o of list) {
      const name = bucketName(key, bucketOf(o))
      if (!m.has(name)) m.set(name, [])
      m.get(name).push(o)
    }
    return m
  }
  const set = []
  const remove = []
  for (const key of SPLIT_KEYS) {
    if (!split[key]) continue
    // 两边都先排成存储层的 canon 次序（退货单是 push 到末尾的，直接落片会和下次保存的次序不同，
    // 白多一次「内容相同但顺序不同」的重写）
    const before = byBucket(key, sortOrders(state[key]))
    const after = byBucket(key, sortOrders(next[key]))
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(name) || []
      const b = after.get(name) || []
      if (JSON.stringify(a) === JSON.stringify(b)) continue
      set.push({ path: name, content: JSON.stringify(b, null, 0) })
    }
    // 迁移残留的旧整表：这次提交顺手删干净，避免 AI 直读时读到过期整表
    if (treeByName.has(`${key}.json`)) remove.push(`${key}.json`)
  }
  for (const k of keys) {
    if (SPLIT_KEYS.has(k)) continue
    if (k === 'logs') continue
    if (JSON.stringify(next[k]) === JSON.stringify(state[k])) continue
    set.push({ path: `${k}.json`, content: JSON.stringify(next[k], null, 0) })
  }
  const logs = [...state.logs, { time: new Date().toISOString(), source: 'refund', action: input.action, code: result.code, codes: result.codes }].slice(-200)
  if (set.length) set.push({ path: 'logs.json', content: JSON.stringify(logs, null, 0) })
  if (!set.length && !remove.length) return { ok: true, codes: result.codes || [], unchanged: true }

  const sha = await commitFiles(env, {
    set, remove,
    message: `refund: ${input.action} ${result.code || (result.codes || []).join(', ')}`,
    baseCommit: parent, baseTree: commit.tree.sha
  })
  return { ok: true, code: result.code, returnId: result.returnId, codes: result.codes, commit: sha }
}
