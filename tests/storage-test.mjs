// 存储层回归：整表读写、按年迁移、幂等跳过、删除单据、迁移原子性与资金保护。
// 跑法：node tests/storage-test.mjs   （纯 Node，不需要浏览器）
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { makeFakeRepo } from './fake-github.mjs'
import { readCollectionWithRaw, writeCollection, bucketOf, bucketize, SPLIT_KEYS } from '../api/storage.js'
import { serialize } from '../api/github.js'

// Worker 侧用的浏览器全局，Node 里补齐
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = { GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main' }
let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}

const P = (id, date, extra = {}) => ({ id, date, supplier: 'S00001', total: 100, items: [{ code: 'P00001', qty: 1, price: 100, total: 100 }], ...extra })
const S = (id, date, extra = {}) => ({ id, date, customer: 'C00001', total: 50, items: [{ code: 'P00001', qty: 1, price: 50, total: 50 }], ...extra })

// ---- 归年规则 ----
console.log('\n归年规则')
await t('date 优先', () => assert.equal(bucketOf(P('C202501011200000001', '2025-03-08')), '2025'))
await t('12 月也归对本年', () => assert.equal(bucketOf(P('C202512312359590001', '2025-12-31')), '2025'))
await t('date 缺失时退到单号里的年份', () => assert.equal(bucketOf(P('C202507171200000001', '')), '2025'))
await t('两者都没有 → 0000 兜底，不丢单', () => assert.equal(bucketOf({ id: 'X-legacy', date: '' }), '0000'))
await t('分桶保持顺序', () => assert.deepEqual([...bucketize([P('C1', '2024-05-01'), P('C2', '2025-01-01'), P('C3', '2024-06-01')]).keys()], ['2024', '2025']))

// ---- 未迁移：一切走旧整表 ----
console.log('\n未迁移（无标记）')
let repo = makeFakeRepo({ 'purchases.json': JSON.stringify([P('C202501011200000001', '2025-01-01')]), 'sales.json': '[]' })
await t('读到的就是旧整表', async () => {
  const r = await readCollectionWithRaw(env, 'purchases')
  assert.equal(r.value.length, 1)
  assert.equal(r.known[0].file, 'purchases.json')
})
await t('写一次即触发整仓迁移：两集合一起切、旧表删除、标记落库', async () => {
  repo = makeFakeRepo({
    'purchases.json': JSON.stringify([P('C202401011200000001', '2024-01-05'), P('C202502011200000001', '2025-02-05')]),
    'sales.json': JSON.stringify([S('X202501101200000001', '2025-01-10')]),
    'items.json': '[]', 'stock.json': '{}', 'logs.json': '[]'
  })
  await writeCollection(env, 'purchases', [
    P('C202401011200000001', '2024-01-05'), P('C202502011200000001', '2025-02-05'), P('C202503011200000001', '2025-03-05')
  ], 'test write')
  const names = repo.names()
  assert.ok(names.includes('purchases-2024.json'), 'purchases 2024 片')
  assert.ok(names.includes('purchases-2025.json'), 'purchases 2025 片（本次新增的单也在一起）')
  assert.ok(names.includes('sales-2025.json'), 'sales 也要同批切走，否则退款写进 sales.json 的新单会被分片读忽略')
  assert.ok(!names.includes('purchases.json'), '旧整表已删除')
  assert.ok(!names.includes('sales.json'), 'sales 旧整表已删除')
  assert.deepEqual(JSON.parse(repo.read('.split-yearly.json')), { purchases: true, sales: true })
})

// ---- 已分片：日常读写 ----
console.log('\n已分片（日常）')
const seeded = async (over = {}) => makeFakeRepo({
  '.split-yearly.json': JSON.stringify({ purchases: true, sales: true }),
  'purchases-2024.json': JSON.stringify([P('C202406011200000001', '2024-06-01')]),
  'purchases-2025.json': JSON.stringify([P('C202501011200000001', '2025-01-05'), P('C202502011200000001', '2025-02-05')]),
  'sales-2025.json': JSON.stringify([S('X202501101200000001', '2025-01-10')]),
  'items.json': '[]', 'stock.json': '{}', 'logs.json': '[]',
  ...over
})

await t('合并读：跨年按日期升序', async () => {
  repo = await seeded()
  const v = (await readCollectionWithRaw(env, 'purchases')).value
  assert.deepEqual(v.map(o => o.id), ['C202406011200000001', 'C202501011200000001', 'C202502011200000001'])
})

await t('幂等：原样重写不产生任何提交', async () => {
  repo = await seeded()
  const r = await readCollectionWithRaw(env, 'purchases')
  const before = repo.log().length
  const callsBefore = repo.calls.PUT || 0
  await writeCollection(env, 'purchases', r.value, 'no change', { known: r.known })
  assert.equal(repo.log().length, before, '不应有新提交')
  assert.equal((repo.calls.PUT || 0), callsBefore, 'known 命中时连 PUT 都不该发出')
})

await t('只重写变了的那一年', async () => {
  repo = await seeded()
  const r = await readCollectionWithRaw(env, 'purchases')
  const before = repo.log().length
  const callsBefore = repo.calls.PUT || 0
  const next = r.value.map(o => o.date.startsWith('2025') ? { ...o, total: 888 } : o)
  await writeCollection(env, 'purchases', next, 'edit 2025', { known: r.known })
  assert.equal(repo.log().length - before, 1, '只应提交一次')
  assert.equal(repo.calls.PUT - callsBefore, 1, '只应发出一次内容写')
  assert.equal(JSON.parse(repo.read('purchases-2025.json')).find(o => o.id === 'C202501011200000001').total, 888)
  assert.equal(JSON.parse(repo.read('purchases-2024.json'))[0].total, 100, '未变的年片不动')
})

await t('删掉某年最后一张单 → 该片写成空数组，不能残留', async () => {
  repo = await seeded()
  const r = await readCollectionWithRaw(env, 'purchases')
  const next = r.value.filter(o => !o.date.startsWith('2024'))
  await writeCollection(env, 'purchases', next, 'del 2024', { known: r.known })
  assert.deepEqual(JSON.parse(repo.read('purchases-2024.json')), [], '旧片要被清空而不是留着')
  const after = (await readCollectionWithRaw(env, 'purchases')).value
  assert.deepEqual(after.map(o => o.id), ['C202501011200000001', 'C202502011200000001'], '重读不能再冒出已删的单')
})

await t('改期跨年：旧年清空、新年接管', async () => {
  repo = await seeded()
  const r = await readCollectionWithRaw(env, 'purchases')
  const next = r.value.map(o => o.id === 'C202406011200000001' ? { ...o, date: '2025-02-20' } : o)
  await writeCollection(env, 'purchases', next, 'move 2024→2025', { known: r.known })
  assert.deepEqual(JSON.parse(repo.read('purchases-2024.json')), [])
  assert.equal(JSON.parse(repo.read('purchases-2025.json')).length, 3)
})

await t('known 回传的是写后 sha：连续两次改写不会自撞 409', async () => {
  repo = await seeded()
  let r = await readCollectionWithRaw(env, 'purchases')
  let w = await writeCollection(env, 'purchases', r.value.map(o => ({ ...o, total: 1 })), 'w1', { known: r.known })
  w = await writeCollection(env, 'purchases', r.value.map(o => ({ ...o, total: 2 })), 'w2', { known: w.known })
  w = await writeCollection(env, 'purchases', r.value.map(o => ({ ...o, total: 3 })), 'w3', { known: w.known })
  assert.equal(JSON.parse(repo.read('purchases-2025.json')).find(o => o.id === 'C202501011200000001').total, 3)
  void w
})

// ---- 分片收益实测（真实数据） ----
console.log('\n分片收益（真实数据）')
const bytes = (s) => new TextEncoder().encode(s).length
await t('真实 416 张采购单切片：单次保存的提交体积从整表降到当年', async () => {
  const raw = readFileSync(new URL('../../data/purchases.json', import.meta.url), 'utf8')
  const orders = JSON.parse(raw)
  repo = makeFakeRepo({ 'purchases.json': serialize(orders), 'sales.json': '[]', 'items.json': '[]', 'stock.json': '{}', 'logs.json': '[]' })
  const whole = bytes(serialize(orders))
  await writeCollection(env, 'purchases', orders, 'seed')     // 触发迁移
  const parts = repo.names().filter(n => /^purchases-\d{4}\.json$/.test(n))
  const perBucket = parts.map(n => [n, bytes(repo.read(n))]).sort((a, b) => b[1] - a[1])
  const biggest = perBucket[0][1]
  console.log(`      整表 ${Math.round(whole / 1024)}KB → ${parts.length} 个年片，最大一片 ${Math.round(biggest / 1024)}KB`)
  assert.ok(biggest < whole / 2, '改一年的单，提交体积应远小于整表')
})

await t('读全量的子请求数远小于 Workers 免费版 50 的上限', async () => {
  const before = repo.calls.GET || 0
  const v = (await readCollectionWithRaw(env, 'purchases')).value
  const used = (repo.calls.GET || 0) - before
  console.log(`      全量读 ${v.length} 张单用了 ${used} 个子请求（1 标记 + 1 列目录 + ${v.length ? 'N' : 0} 片）`)
  assert.ok(v.length > 400, '真实数据要真的读回来了')
  assert.ok(used < 30, `子请求数 ${used} 必须留足余量：同一次请求里还要读 items/suppliers/customers/stock`)
})

// ---- 资金保护 ----
console.log('\n资金保护（分片后仍须生效）')
await t('分片写仍会拦截「退货单被直接改写」', async () => {
  const ret = { id: 'C202501201200000009', date: '2025-01-20', supplier: 'S00001', total: -50, type: 'purchase-return', items: [{ code: 'P00001', qty: -1, price: 50, total: -50 }] }
  repo = await seeded({ 'purchases-2025.json': JSON.stringify([P('C202501011200000001', '2025-01-05'), ret]) })
  const r = await readCollectionWithRaw(env, 'purchases')
  const tampered = r.value.map(o => o.id === ret.id ? { ...o, total: -1 } : o)
  await assert.rejects(
    () => writeCollection(env, 'purchases', tampered, 'tamper', { known: r.known }),
    /退货单 .* 只允许在退货退款页面操作/
  )
})

await t('分片写仍会拦截「有退货的原单被改货款」', async () => {
  const ret = { id: 'C202501201200000009', date: '2025-01-20', supplier: 'S00001', total: -50, type: 'purchase-return', sourceOrderId: 'C202501011200000001', items: [{ code: 'P00001', qty: -1, price: 50, total: -50 }] }
  repo = await seeded({ 'purchases-2025.json': JSON.stringify([P('C202501011200000001', '2025-01-05'), ret]) })
  const r = await readCollectionWithRaw(env, 'purchases')
  const tampered = r.value.map(o => o.id === 'C202501011200000001' ? { ...o, total: 999 } : o)
  await assert.rejects(
    () => writeCollection(env, 'purchases', tampered, 'tamper parent', { known: r.known }),
    /已有关联退货/
  )
})

await t('并发写入：known 过期必须 409 而不是覆盖对方数据', async () => {
  repo = await seeded()
  const r = await readCollectionWithRaw(env, 'purchases')
  repo.poke('purchases-2025.json', JSON.stringify([P('C202501011200000001', '2025-01-05', { total: 777 })]))
  await assert.rejects(
    () => writeCollection(env, 'purchases', r.value.map(o => ({ ...o, total: 1 })), 'stale write', { known: r.known }),
    /GitHub 409/
  )
  assert.equal(JSON.parse(repo.read('purchases-2025.json'))[0].total, 777, '对方写入的内容必须还在')
})

// ---- 大文件 ----
console.log('\n大文件（>1MB）')
await t('GitHub 不返回 content 时走 blob 回退，且不会被当成空表覆盖', async () => {
  const big = Array.from({ length: 9000 }, (_, i) => P('C202501011200' + String(i).padStart(4, '0'), '2025-01-05'))
  repo = makeFakeRepo({ 'purchases.json': serialize(big), 'sales.json': '[]' }, { inlineLimit: 1024 * 1024 })
  const r = await readCollectionWithRaw(env, 'purchases')
  assert.equal(r.value.length, 9000, '必须真读到内容')
  assert.ok(r.content.length > 1024 * 1024, '回退取到的必须是大文件原文，不是空串')
  assert.ok((repo.calls.GET || 0) >= 2, 'contents + blob 两次读')
})

await t('读取失败绝不静默变空：writeJSON 会用真实原文比对而不是直接覆盖', async () => {
  // contents 不返回 content（inlineLimit=0）且 blob 也取不到 → 只能报错，不能当成空表写回去
  repo = makeFakeRepo({ 'purchases.json': serialize([P('C202501011200000001', '2025-01-05')]) },
    { inlineLimit: 0, blobFail: true })
  await assert.rejects(() => readCollectionWithRaw(env, 'purchases'), /已中止以避免覆盖数据/)
})

// ---- 非分片集合 ----
console.log('\n非分片集合')
await t('items 等档案集合保持整表语义', async () => {
  repo = makeFakeRepo({ 'items.json': JSON.stringify([{ code: 'P00001', name: '三通', unit: '个', cost: 2.72, price: 3 }]) })
  const r = await readCollectionWithRaw(env, 'items')
  assert.equal(r.known[0].file, 'items.json')
  assert.ok(!SPLIT_KEYS.has('items'))
  await writeCollection(env, 'items', [...r.value, { code: 'P00002', name: '弯头' }], 'add item', { known: r.known })
  assert.equal(JSON.parse(repo.read('items.json')).length, 2)
  assert.ok(!repo.has('.split-yearly.json'), '非分片集合不触发迁移')
})

await t('空字段瘦身只作用于商品档案，不动单据', async () => {
  const { pruneItem } = await import('../api/routes.js')
  assert.deepEqual(pruneItem({ code: 'P1', name: 'a', warning: 0, remark: '', package: '', photos: [], cost: 0, price: 0 }), { code: 'P1', name: 'a', cost: 0, price: 0 })
  assert.equal(pruneItem({ code: 'P1', package: '90个/件' }).package, '90个/件', '有值必须保留')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
