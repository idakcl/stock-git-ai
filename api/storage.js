// 集合存储层：把「整表一个 JSON 文件」升级为「按年一个 JSON 文件」。
//
// 为什么要分片（实测数据说话）：
//   purchases.json 紧凑化后仍有 329KB / 416 张单，占整个数据仓的大头。每次保存一张单
//   都要把这 329KB 整表重读、重编码、重新提交一次 —— GitHub 侧一次内容写、
//   git 历史里一份新 blob、Worker 侧一次整文件 base64 解码 + JSON.parse。
//   单据只会越来越多，这条成本线性上涨，而且是「每次开单都要付一次」。
//
// 为什么切到「年」而不是「月」（这是量出来的，不是随手定的）：
//   真实 416 张采购单按月切 = 92 个文件，读一次全量要发 92 个子请求；
//   Workers 免费版每个请求的子请求上限是 50（未配 limits.subrequests 就是这个默认值），
//   月片会把读请求直接顶爆 —— 不是慢，是报错。
//   按季切 = 36 个文件，加上 items/suppliers/customers/stock 的读取已经贴着 50 的天花板，
//   再涨两年就超。按年切 = 10 个文件（2019–2026），单片最大 72KB：
//   读侧子请求 12 个（标记 + 列目录 + 10 片），写侧一次提交只重写当年那一片。
//   年片大小随业务量线性涨，但涨到需要再细分时（>1MB）读取会走 git blob 回退，
//   仍可用；真要换粒度，只改 bucketOf / isBucketFile 两处（分片规则只在这个文件里）。
//
// 迁移安全（这是本文件存在的核心理由）：
//   数据仓里可能同时存在「旧整表 purchases.json」和「新分片 purchases-2025.json」，
//   谁是权威必须有唯一判据，否则崩溃窗口里会把两份数据叠加或丢一半。
//   判据 = 标记文件 .split-yearly.json 里是否记录了该集合：
//     · 未记录 → 旧整表是唯一权威，分片文件一律忽略（哪怕已经写了几片）
//     · 已记录 → 分片是唯一权威，旧整表只是迁移残留（删除；删不掉也不影响正确性）
//   顺序：写完全部分片 → 写标记（提交点）→ 删旧整表，三步压进同一次 git 提交。
//   任意一步崩溃都停在「标记未写 = 旧整表仍然有效」这一侧，永远不会读到半截分片。
import { readJSONWithRaw, writeJSON, listFiles, serialize, commitFiles } from './github.js'

const MARKER_FILE = '.split-yearly.json'
const UNKNOWN_BUCKET = '0000'             // 日期缺失/畸形时的兜底分片，保证不丢单据
const MAX_BUCKETS = 60                    // 60 年；超出即报错，避免无上限拉爆 Worker 子请求数

// 只有这两类单据按年分片：它们是唯一「只增不减」的大集合。
// 商品/供应商/客户/凭证是档案类，量级小且互相引用，分片收益低、复杂度高，不动。
export const SPLIT_KEYS = new Set(['purchases', 'sales'])

const bucketName = (key, bucket) => `${key}-${bucket}.json`
// purchases-2025.json → 2025；不是本族文件返回 null
const bucketOfName = (key, name) => (name.length > key.length + 1 && name.endsWith('.json') && name.startsWith(`${key}-`)
  ? name.slice(key.length + 1, -5) : null)
const isBucketFile = (key, name) => {
  const b = bucketOfName(key, name)
  return !!b && /^\d{4}$/.test(b)
}

// 单据归属年份：优先 date（YYYY-MM-DD），退化到单号里的日期，再兜底 UNKNOWN_BUCKET
// 单号格式 = 前缀(1) + YYYYMMDD(8) + HHMMSS(6) + 当日流水(4)，见 src/utils/code.js genOrderId
export function bucketOf(order) {
  const m = /^(\d{4})-\d{2}/.exec(String(order && order.date || ''))
  if (m) return m[1]
  const d = /^.(20\d{2})\d{14}$/.exec(String(order && order.id || ''))
  if (d) return d[1]
  return UNKNOWN_BUCKET
}

// 按年分桶；桶内保持传入顺序（前端整表回传，顺序即展示顺序）
export function bucketize(list) {
  const buckets = new Map()
  for (const o of (list || [])) {
    const b = bucketOf(o)
    if (!buckets.has(b)) buckets.set(b, [])
    buckets.get(b).push(o)
  }
  return buckets
}

function joinSorted(a, b) {
  const an = String(a.date || ''), bn = String(b.date || '')
  if (an !== bn) return an < bn ? -1 : 1
  const ai = String(a.id || ''), bi = String(b.id || '')
  if (ai !== bi) return ai < bi ? -1 : 1
  return 0
}

// 单据的唯一次序：日期升序、同日按单号升序。
// 读侧合并各片时用它，写侧落库前也用它 —— 两边必须同一口径，否则
// 「读回来原样再存一次」会因次序不同把每个片都重写一遍（实测 10 个片重写 9 个），
// 既白烧 GitHub 内容写配额，也让「内容没变就不提交」这条优化彻底失效。
export function sortOrders(list) {
  return [...(list || [])].sort(joinSorted)
}

// 404 是「还没迁移过」的正常初始态，不能冒泡成页面报错
async function readJsonOrEmpty(env, file) {
  try {
    return await readJSONWithRaw(env, file)
  } catch (e) {
    if (/GitHub 404/.test(String(e && e.message || e))) return { value: [], content: '', sha: null }
    throw e
  }
}

async function readMarker(env) {
  const { value } = await readJsonOrEmpty(env, MARKER_FILE)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

// 分片文件名从列目录结果里挑：数据仓是平铺结构，一次列根目录就够
async function bucketFileNames(env, key) {
  const files = await listFiles(env)
  const names = files.filter(f => f.type !== 'dir' && isBucketFile(key, f.name)).map(f => f.name).sort()
  if (names.length > MAX_BUCKETS) {
    throw new Error(`${key} 按年分片已达 ${names.length} 个（上限 ${MAX_BUCKETS}），请先合并旧年份再操作`)
  }
  return names
}

function knownMapOf(known) {
  const m = new Map()
  for (const k of (known || [])) if (k && k.file) m.set(k.file, k)
  return m
}

// writeJSON 的返回里取「写完后的 sha」：提交成功是 { content: { sha } }，跳过提交是 { skipped, sha }。
// 回传给调用方的必须是这个新 sha —— 旧 sha 再拿去写第二次只会撞 409，
// 而 409 在业务上等于「你保存的内容已经过时」，是假报错。
function shaAfterWrite(r) {
  if (!r) return null
  return (r.content && r.content.sha) || r.sha || null
}

// 读集合：分片权威时并发读全部年片并按日期合并；否则读旧整表。
// 返回的 known 必须一路带回给 writeCollection —— 那是「免二次回读」的唯一凭据。
// content 是「本轮读到的现值」的整表口径，只用于 unchanged 比对：
//   未分片 → 就是文件的原文；已分片 → 是合并排序后的紧凑 JSON（不是任何单个文件的原文，
//   绝不能当 known 传给 writeJSON，那里必须用 known 里的逐文件原文）。
export async function readCollectionWithRaw(env, key) {
  if (!SPLIT_KEYS.has(key)) {
    const r = await readJsonOrEmpty(env, `${key}.json`)
    return { value: r.value, content: r.content, known: [{ file: `${key}.json`, content: r.content, sha: r.sha }] }
  }
  const marker = await readMarker(env)
  if (!marker[key]) {
    const r = await readJsonOrEmpty(env, `${key}.json`)
    return { value: r.value, content: r.content, known: [{ file: `${key}.json`, content: r.content, sha: r.sha }] }
  }
  const names = await bucketFileNames(env, key)
  if (!names.length) return { value: [], content: '[]', known: [] }
  const raws = await Promise.all(names.map(n => readJsonOrEmpty(env, n)))
  const value = raws
    .map(r => r.value)
    .reduce((acc, arr) => acc.concat(Array.isArray(arr) ? arr : []), [])
    .sort(joinSorted)
  return { value, content: serialize(value), known: raws.map((r, i) => ({ file: names[i], content: r.content, sha: r.sha })) }
}

export async function readCollection(env, key) {
  return (await readCollectionWithRaw(env, key)).value
}

// 写集合并返回本轮各文件的「写后现状」known（内容 + 新 sha），
// 供 syncDerived 写回同一路径时既免再读一遍、又不会拿旧 sha 撞 409。
// opts.known：调用方刚用 readCollectionWithRaw 读到的现状；不给就退回「自己读」的老行为。
export async function writeCollection(env, key, list, message, opts = {}) {
  const provided = knownMapOf(opts.known)
  // 单据按 canon 次序落库（见 sortOrders）：与读侧合并次序一致，
  // 「读回来原样再存一次」才能真正命中「内容相同跳过」，而不是整仓重写
  if (SPLIT_KEYS.has(key)) list = sortOrders(list)

  if (!SPLIT_KEYS.has(key)) {
    const file = `${key}.json`
    const before = provided.get(file) || await readJsonOrEmpty(env, file)
    const r = await writeJSON(env, file, list, message,
      { known: before.sha ? { content: before.content, sha: before.sha } : null })
    return { known: [{ file, content: serialize(list), sha: shaAfterWrite(r) || before.sha }], r }
  }

  const marker = await readMarker(env)

  // 尚未分片：权威是旧整表，先按整表写（资金保护校验照常生效），
  // 再顺手把整个数据仓切成年片。切片失败不影响已落库数据，下次保存会再切一次，
  // 但必须出声（console.warn）——曾经就是这里静默吞掉 422，导致迁移永远没发生过
  if (!marker[key]) {
    const file = `${key}.json`
    const before = provided.get(file) || await readJsonOrEmpty(env, file)
    const r = await writeJSON(env, file, list, message,
      { known: before.sha ? { content: before.content, sha: before.sha } : null })
    await migrateRepoToBuckets(env, { [key]: list }).catch(e => console.warn(
      `单据按年迁移失败（数据仍在旧整表里，仍是权威，下次保存会再试）：${String(e && e.message || e)}`))
    return { known: [{ file, content: serialize(list), sha: shaAfterWrite(r) || before.sha }], r }
  }

  // 已分片：逐年比对，只有内容真的变了的年片才提交
  const names = await bucketFileNames(env, key)
  const buckets = bucketize(list)
  // 库里有、新数据里没有的年份（单据被删或改期移出）：写成空数组。
  // 不写的话那些单据会残留在旧片里，下次读又冒出来，表现为「删不掉」
  for (const name of names) {
    const b = bucketOfName(key, name)
    if (!buckets.has(b)) buckets.set(b, [])
  }
  const known = []
  for (const [bucket, rows] of [...buckets].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const file = bucketName(key, bucket)
    const before = provided.get(file) || await readJsonOrEmpty(env, file)
    const r = await writeJSON(env, file, rows, message,
      { known: before.sha ? { content: before.content, sha: before.sha } : null })
    known.push({ file, content: serialize(rows), sha: shaAfterWrite(r) || before.sha })
  }
  // 把没被本次改写覆盖到的其他片（内容未变、没进循环）也带上写后现状，
  // 让 syncDerived 拿到的是完整的一轮现状快照
  if (known.length) {
    const covered = new Set(known.map(k => k.file))
    for (const name of names) {
      if (covered.has(name)) continue
      const k = provided.get(name)
      if (k && k.sha) known.push({ file: name, content: k.content, sha: k.sha })
    }
  }
  return { known }
}

// 迁移专用：把「全部分片 + 标记 + 删除旧整表」压进同一次 git 提交。
// collections: { purchases: { list, existed }, sales: { list, existed } }
//   list = 该集合当前全部单据；existed = 旧整表文件是否真的在库里（决定要不要发删除）
// 为什么必须原子：分片和标记分两次提交时，中间崩溃会留下
// 「标记已写 = 分片是权威」但「分片只写了一半」的状态，那批单据就真的没了。
// 压进一次提交后，这个状态要么整体存在、要么整体不存在，不存在半截。
//
// 为什么两个集合一起迁：分开迁会留下「purchases 已分片、sales 还在整表」的中间态，
// 而退款走单次 git 提交直接写 purchases / sales 两侧文件 ——
// 那时它写进 sales.json 的新退货单会被读路径（已认分片）忽略，等于单据凭空消失。
//
// 为什么空表也要打标记：否则一张空单据集合永远处于「未迁移」，每次保存都重试迁移。
// 落地方式见 github.js 的 commitFiles（完整树 + 不列删除项），一次提交原子生效。
async function commitRepoMigration(env, collections) {
  const marker = await readMarker(env)
  const set = []
  const remove = []
  let files = 0
  const keys = Object.keys(collections || {})
  if (!keys.length) return null
  for (const key of keys) {
    const { list, existed } = collections[key]
    for (const [bucket, rows] of [...bucketize(list)].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      set.push({ path: bucketName(key, bucket), content: serialize(rows) })
      files++
    }
    // 旧整表在同一提交里删除；库里本来就没有就不列（GitHub 对不存在路径的删除会报错）
    if (existed) remove.push(`${key}.json`)
    marker[key] = true
  }
  set.push({ path: MARKER_FILE, content: serialize(marker) })
  return await commitFiles(env, {
    set, remove,
    message: `migrate ${keys.join(' & ')} to yearly splits (${files} files)`
  })
}

// 整仓一次性迁移：把库里现存的单据全部切成年片。失败不致命 —— 权威仍是旧整表，下次保存会再试。
// overrides 传入「调用方内存里已经有的那份全量」，避免刚写完又要为一整张 329KB 表回读一遍。
async function migrateRepoToBuckets(env, overrides = {}) {
  const read = async (key) => {
    if (Array.isArray(overrides[key])) return { value: overrides[key], sha: 'in-memory' }
    return await readJsonOrEmpty(env, `${key}.json`)
  }
  const [p, s] = await Promise.all([read('purchases'), read('sales')])
  return await commitRepoMigration(env, {
    purchases: { list: Array.isArray(p.value) ? p.value : [], existed: !!p.sha },
    sales: { list: Array.isArray(s.value) ? s.value : [], existed: !!s.sha }
  })
}

// —— 供退款等「多文件单次提交」路径复用的分片口径 ——
export { MARKER_FILE, bucketName, bucketOfName, isBucketFile, readMarker, commitRepoMigration }
