// 派生数据写回：必须是一次提交（2026-11-01 收敛）。
//
// 背景：保存一张单据要同时更新 items / suppliers / customers / stock 与单据编码修正。
// 旧实现按文件逐个 writeJSON，中途失败会停在半截（商品改了、库存没改），对账就再也对不上。
// 这里守住四件事：
//   1. 单据一次提交 + 派生一次提交，派生侧不再拆成 4~6 次；
//   2. 内容没变化时 0 次提交（币重保存不放大写压力）；
//   3. 换写路径不能绕过资金保护（退货单/关联单/核销锁）；
//   4. 保存商品与供应商商品列表合并为一次提交。
import assert from 'node:assert/strict'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi } from '../api/routes.js'
import { issueToken } from '../api/auth.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', APP_PASSWORD: 'pw'
}

const item = (code, name, extra = {}) => ({ code, name, unit: '个', cost: 10, ...extra })

// 已经按年分片的库：避免把「首次迁移」的提交算进来
function seed() {
  return makeFakeRepo({
    'items.json': JSON.stringify([item('P1', '三通')]),
    'suppliers.json': JSON.stringify([{ code: 'S1', name: '甲供货', products: [] }]),
    'customers.json': JSON.stringify([{ code: 'C1', name: '乙客户', deposits: [] }]),
    'purchases-2026.json': JSON.stringify([]),
    'sales-2026.json': JSON.stringify([]),
    '.split-yearly.json': JSON.stringify({ purchases: true, sales: true }),
    'stock.json': JSON.stringify({}),
    'logs.json': JSON.stringify([])
  })
}

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')) }
}

let repo, token
const call = async (path, method, body) => {
  const req = new Request(`https://w.test/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: body ? JSON.stringify(body) : undefined
  })
  const res = await handleApi(req, new URL(req.url), env)
  return { status: res.status, data: await res.json().catch(() => null) }
}
const read = async (file) => JSON.parse(await repo.read(file))
const commits = () => repo.log().length

const sale = (id, extra = {}) => ({
  id, date: '2026-10-20', customer: '乙客户', total: 90, received: 0, paid: 0,
  items: [{ code: 'P1', qty: 3, price: 30, total: 90 }], payments: [], ...extra
})

repo = seed(); token = await issueToken(env)

console.log('\n派生写回：一次提交')
await t('保存一张销售单＝单据 1 次 + 派生 1 次提交（派生不再逐文件写）', async () => {
  const before = commits()
  const r = await call('/sales', 'POST', { sales: [sale('XS1')] })
  assert.equal(r.status, 200)
  assert.equal(commits() - before, 2, '单据一次、派生一次')
  assert.equal((await read('sales-2026.json')).length, 1)
  assert.equal((await read('stock.json')).P1.qty, -3, '库存在同一次派生提交里更新')
})

await t('原样重存同一张单：0 次提交（内容没变就不写 git）', async () => {
  const before = commits()
  const r = await call('/sales', 'POST', { sales: [sale('XS1')] })
  assert.equal(r.status, 200)
  assert.equal(commits(), before)
})

await t('保存商品：商品与「供应商的商品列表」同一次提交', async () => {
  const before = commits()
  const r = await call('/items', 'POST', {
    items: [item('P1', '三通'), item('P2', '弯头', { suppliers: ['S1'] })]
  })
  assert.equal(r.status, 200)
  assert.equal(commits() - before, 1, '两个文件必须一起落地')
  assert.deepEqual((await read('suppliers.json'))[0].products, ['P2'])
})

console.log('\n派生写回：换路径不绕过资金保护')
await t('直接改写退货单金额：被资金保护拦下，且不落库', async () => {
  const ret = sale('XT1', { type: 'sale-return', total: -30, items: [{ code: 'P1', qty: -1, price: 30, total: -30 }] })
  await call('/sales', 'POST', { sales: [sale('XS1'), ret] })
  const before = commits()
  const hacked = { ...ret, total: -60, items: [{ code: 'P1', qty: -2, price: 30, total: -60 }] }
  const r = await call('/sales', 'POST', { sales: [sale('XS1'), hacked] })
  assert.equal(r.status, 500)
  assert.match(r.data.error, /退货单 XT1 只允许在退货退款页面操作/)
  assert.equal(commits(), before, '被拦下的写入不得产生提交')
  const sales = await read('sales-2026.json')
  assert.equal(sales.find(o => o.id === 'XT1').total, -30, '库里仍是原值')
})

console.log('\n派生写回：数据整理')
await t('/normalize 一次提交把乱码编码改回正式编码，再跑一次 0 提交', async () => {
  repo = seed(); token = await issueToken(env)
  const broken = sale('XS2', { items: [{ code: 'N9', name: '三通', qty: 3, price: 30, total: 90 }] })
  await call('/sales', 'POST', { sales: [broken] })
  const before = commits()
  const r = await call('/normalize', 'POST', {})
  assert.equal(r.status, 200)
  assert.ok(commits() - before <= 1, '整理必须一次提交')
  const sales = await read('sales-2026.json')
  assert.equal(sales[0].items[0].code, 'P1', '乱码编码应被改成正式编码')
  const after = commits()
  const again = await call('/normalize', 'POST', {})
  assert.equal(again.status, 200)
  assert.equal(commits(), after, '幂等：没有可改的就不提交')
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
