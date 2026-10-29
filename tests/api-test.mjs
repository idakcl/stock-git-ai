// 端到端回归：直接调 handleApi，用线上真实数据当底，验证
//   「存一张采购单」这条主链路在紧凑化 + 字段瘦身 + 按年分片之后仍然正确且不再重复写。
// 跑法：node tests/api-test.mjs   （纯 Node，不需要浏览器）
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi } from '../api/routes.js'
import { issueToken } from '../api/auth.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw'
}
const DATA_DIR = new URL('../../data/', import.meta.url)
const FILES = ['items', 'suppliers', 'customers', 'purchases', 'sales', 'stock', 'refunds', 'receipts', 'payment-vouchers', 'logs']
let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (String(e && e.message || e)).split('\n').join('\n      ')) }
}

function seed() {
  const initial = {}
  for (const f of FILES) {
    const p = new URL(`${f}.json`, DATA_DIR)
    if (existsSync(p)) initial[`${f}.json`] = readFileSync(p, 'utf8')
    else initial[`${f}.json`] = f === 'stock' ? '{}' : '[]'
  }
  return makeFakeRepo(initial)
}

const bytes = (s) => new TextEncoder().encode(s).length
const call = async (path, method, token, body) => {
  const req = new Request(`https://worker.test/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://worker.test' },
    body: body ? JSON.stringify(body) : undefined
  })
  const res = await handleApi(req, new URL(req.url), env)
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data && data.error || ''}`)
  return data
}

let repo = seed()
let token = ''
let purchases = []
const NEW_ORDER = {
  id: 'C202610291200000001', date: '2026-10-29', supplier: 'S00001',
  total: 120, paid: 0, received: 0,
  items: [{ code: 'P00001', qty: 2, price: 60, total: 120, name: '测试三通', unit: '个' }],
  payments: []
}

console.log('\n读：迁移前')
await t('鉴权后的 GET /purchases 能读全量', async () => {
  token = await issueToken(env)
  purchases = await call('/purchases', 'GET', token)
  assert.ok(Array.isArray(purchases) && purchases.length > 400, `应读到真实采购单全量，实际 ${purchases && purchases.length}`)
  assert.ok(!repo.has('.split-yearly.json'), '还没迁移过')
})

console.log('\n写：存一张新采购单（触发整仓迁移）')
await t('POST /purchases 成功并把单据存下来', async () => {
  const r = await call('/purchases', 'POST', token, { purchases: [...purchases, NEW_ORDER] })
  assert.equal(r.ok, true)
  const after = await call('/purchases', 'GET', token)
  assert.equal(after.length, purchases.length + 1, '新单必须落库')
  assert.ok(after.some(o => o.id === NEW_ORDER.id))
})

await t('迁移结果：两个集合都切成年片、旧整表删除、标记落库', async () => {
  const names = repo.names()
  assert.ok(names.some(n => /^purchases-\d{4}\.json$/.test(n)), 'purchases 年片')
  assert.ok(names.includes('purchases-2026.json'), '新单落在 2026 片')
  assert.ok(names.some(n => /^sales-\d{4}\.json$/.test(n)), 'sales 必须同批切走')
  assert.ok(!names.includes('purchases.json') && !names.includes('sales.json'), '旧整表已删')
  assert.deepEqual(JSON.parse(repo.read('.split-yearly.json')), { purchases: true, sales: true })
})

await t('落库文件全部是紧凑 JSON（无缩进换行）', async () => {
  for (const n of repo.names().filter(x => x.endsWith('.json'))) {
    const c = repo.read(n)
    assert.ok(!/^\s{2}"/m.test(c), `${n} 仍是缩进 JSON`)
  }
})

await t('商品档案里的空字段被瘦身掉', async () => {
  const items = JSON.parse(repo.read('items.json'))
  for (const key of ['package', 'warning', 'remark', 'photos', 'saleCustomers', 'priceWholesale', 'priceInstaller', 'purchaseHistory']) {
    const bad = items.filter(i => key in i && (i[key] === 0 || i[key] === '' || (Array.isArray(i[key]) && !i[key].length)))
    assert.equal(bad.length, 0, `items.json 里不应保留空字段 ${key}（${bad.length} 条）`)
  }
  const kept = items.filter(i => i.photos && i.photos.length)
  if (kept.length) assert.ok(true)
})

await t('瘦身+紧凑化的实测体积收益', async () => {
  const before = bytes(readFileSync(new URL('items.json', DATA_DIR), 'utf8'))
  const after = bytes(repo.read('items.json'))
  console.log(`      items.json ${Math.round(before / 1024)}KB → ${Math.round(after / 1024)}KB（-${Math.round((1 - after / before) * 100)}%）`)
  assert.ok(after < before * 0.8, '至少要比原来小 20%')
})

console.log('\n再写：幂等与增量')
await t('原样再保存一次不产生任何新提交', async () => {
  const current = await call('/purchases', 'GET', token)
  const commits = repo.log().length
  const puts = repo.calls.PUT || 0
  await call('/purchases', 'POST', token, { purchases: current })
  assert.equal(repo.log().length, commits, `不该有新提交，实际新增 ${repo.log().length - commits} 条：${repo.log().slice(commits).join(' | ')}`)
  assert.equal(repo.calls.PUT - puts, 0, '不该发出任何内容写')
})

await t('改一张历史单据：只重写它那一年的片', async () => {
  const current = await call('/purchases', 'GET', token)
  const target = current.find(o => /^2021-/.test(String(o.date)) && Number(o.total) > 0)
  assert.ok(target, '真实数据里要有 2021 年的单')
  const commits = repo.log().length
  const puts = repo.calls.PUT || 0
  const gets = repo.calls.GET || 0
  const next = current.map(o => o.id === target.id ? { ...o, remark: '改一笔备注' } : o)
  await call('/purchases', 'POST', token, { purchases: next })
  const newCommits = repo.log().length - commits
  const newPuts = repo.calls.PUT - puts
  const newGets = repo.calls.GET - gets
  console.log(`      改 1 张历史单：新增提交 ${newCommits} 个、内容写 ${newPuts} 次、读请求 ${newGets} 次`)
  assert.ok(newCommits <= 2, `只应重写年片（外加派生写回），实际 ${newCommits}`)
  // Workers 免费版每个请求最多 50 个子请求：一次存单的读请求数必须留足余量
  assert.ok(newGets < 40, `一次存单的读请求 ${newGets} 次，逼近 50 子请求上限`)
  assert.ok(repo.read('purchases-2021.json').includes('改一笔备注'))
})

await t('派生数据仍正确：库存与商品历史价能算出来', async () => {
  const stock = JSON.parse(repo.read('stock.json'))
  assert.ok(Object.keys(stock).length > 100, '库存快照要有内容')
  const gets = repo.calls.GET || 0
  const hist = await call('/purchase-history', 'GET', token)
  const used = (repo.calls.GET || 0) - gets
  console.log(`      最重的只读接口 /purchase-history 用了 ${used} 个读请求`)
  assert.ok(Object.keys(hist).length > 0, '历史采购价按需派生可用')
  assert.ok(used < 45, `读请求 ${used} 次，逼近 Workers 免费版 50 子请求上限`)
})

console.log('\n退货退款（已分片的库走单次 git 提交路径）')
const REQ = 'e2e-refund-test-req-0001'
let returnId = ''
await t('新建采购退货：退货单落进它自己那一年的片，旧整表不会复活', async () => {
  const all = await call('/purchases', 'GET', token)
  const src = all.find(o => /^2021-/.test(String(o.date)) && Number(o.total) > 0 && Array.isArray(o.items) && o.items.length)
  assert.ok(src, '真实数据里要有可退的 2021 年采购单')
  const commits = repo.log().length
  // 退货日期取原单日期（补录场景）：退货单因此落在 2021 片的中段，
  // 能同时检验「退款写入的次序必须与存储层 canon 次序一致」
  const r = await call('/refunds', 'POST', token, {
    action: 'create', kind: 'purchase', sourceOrderId: src.id, date: src.date,
    reason: '端到端测试退货', lines: [{ index: 0, qty: 1 }], mode: 'pending', requestId: REQ
  })
  assert.equal(r.ok, true)
  returnId = r.code
  assert.ok(/^CT-/.test(String(returnId)), `退货单号应为 CT- 前缀，实际 ${returnId}`)
  const year = String(src.date).slice(0, 4)
  const piece = JSON.parse(repo.read(`purchases-${year}.json`))
  assert.ok(piece.some(o => o.id === returnId && o.sourceOrderId === src.id), `退货单必须在 ${year} 年片里`)
  assert.ok(!repo.has('purchases.json'), '退款不能把已删除的旧整表写回来')
  assert.deepEqual(JSON.parse(repo.read('.split-yearly.json')), { purchases: true, sales: true }, '标记不变')
  console.log(`      一次退货：新增提交 ${repo.log().length - commits} 个`)
  const logs = JSON.parse(repo.read('logs.json'))
  assert.equal(logs[logs.length - 1].action, 'create')
})

await t('同一 requestId 重放：判定为重复且不再提交', async () => {
  const commits = repo.log().length
  const r = await call('/refunds', 'POST', token, {
    action: 'create', kind: 'purchase', sourceOrderId: 'whatever', date: '2026-10-29',
    reason: '端到端测试退货', lines: [{ index: 0, qty: 1 }], mode: 'pending', requestId: REQ
  })
  assert.equal(r.duplicate, true, '重放必须识别为重复')
  assert.equal(repo.log().length, commits, '重复请求不应产生提交')
})

await t('退货后仍能读全量，且退货单只有一份', async () => {
  const all = await call('/purchases', 'GET', token)
  const hits = all.filter(o => o.id === returnId)
  assert.equal(hits.length, 1, '退货单不能既在旧整表又在年片里')
  assert.ok(Number(hits[0].total) < 0)
})

await t('退款写入的年片与存储层口径一致：原样重存不再重写', async () => {
  const current = await call('/purchases', 'GET', token)
  const commits = repo.log().length
  await call('/purchases', 'POST', token, { purchases: current })
  assert.equal(repo.log().length, commits, '退款刚写完的年片，次序/格式必须已经和存储层一致')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
