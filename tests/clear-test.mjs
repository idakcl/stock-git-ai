// 清空业务数据（/api/clear）的回归测试：不用真实数据，全部用假仓库种子。
// 覆盖：密码/二次确认闸门、一次提交、库存按剩余单据重算、孤儿单据改名、审计日志必留。
import assert from 'node:assert/strict'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi } from '../api/routes.js'
import { issueToken } from '../api/auth.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', APP_PASSWORD: 'correct-password'
}

const item = (code, name, cost) => ({ code, name, unit: '个', cost })
const sale = (id, customer, code, qty, price, date = '2026-10-20') => ({
  id, date, customer, total: qty * price, received: qty * price, paid: 0,
  items: [{ code, qty, price, total: qty * price }], payments: []
})
const purchase = (id, supplier, code, qty, price, date = '2026-10-01') => ({
  id, date, supplier, total: qty * price, paid: qty * price, received: 0,
  items: [{ code, qty, price, total: qty * price }], payments: []
})

function seed() {
  return makeFakeRepo({
    'items.json': JSON.stringify([item('P1', '三通', 10), item('P2', '弯头', 20)]),
    'suppliers.json': JSON.stringify([{ code: 'S1', name: '甲供货', products: [] }]),
    'customers.json': JSON.stringify([{ code: 'C1', name: '乙客户', deposits: [] }]),
    'purchases.json': JSON.stringify([purchase('CG1', '甲供货', 'P1', 10, 12)]),
    'sales.json': JSON.stringify([sale('XS1', '乙客户', 'P1', 3, 30)]),
    'receipts.json': JSON.stringify([{ id: 'SK1', date: '2026-10-20', party: '乙客户', amount: 90 }]),
    'payment-vouchers.json': JSON.stringify([{ id: 'FK1', date: '2026-10-01', party: '甲供货', amount: 120 }]),
    'stock.json': JSON.stringify({ P1: { qty: 7, cost: 12 } }),
    'logs.json': JSON.stringify([{ time: '2026-10-01T00:00:00.000Z', source: 'orders', action: 'post' }])
  })
}

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')) }
}

let repo, token
const call = async (path, method, body, tok = token) => {
  const req = new Request(`https://w.test/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Origin: 'https://w.test', 'CF-Connecting-IP': '1.2.3.4' },
    body: body ? JSON.stringify(body) : undefined
  })
  const res = await handleApi(req, new URL(req.url), env)
  return { status: res.status, data: await res.json().catch(() => null) }
}
const read = async (file) => JSON.parse(await repo.read(file))
const commits = () => repo.log().length

console.log('\n清空入口：闸门')
repo = seed(); token = await issueToken(env)

await t('未带票据直接调 /clear 被拒', async () => {
  const r = await call('/clear', 'POST', { target: 'sales', password: 'correct-password', confirm: 'CLEAR' }, '')
  assert.equal(r.status, 401)
  assert.equal((await read('sales.json')).length, 1, '数据不能动')
})

await t('密码错误 → 403（不用 401，避免前端把它当成会话失效而登出），且不动数据', async () => {
  const r = await call('/clear', 'POST', { target: 'sales', password: 'wrong', confirm: 'CLEAR' })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /密码/)
  assert.equal((await read('sales.json')).length, 1)
})

await t('没有 confirm=CLEAR → 400，且不动数据（防误调）', async () => {
  const r = await call('/clear', 'POST', { target: 'sales', password: 'correct-password' })
  assert.equal(r.status, 400)
  assert.equal((await read('sales.json')).length, 1)
})

await t('未知 target → 400，不产生任何提交', async () => {
  const before = await commits()
  const r = await call('/clear', 'POST', { target: 'everything', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 400)
  assert.equal(await commits(), before)
})

console.log('\n清空入口：单表')
await t('清空销售单：一次提交、单据清空、库存按剩余采购重算', async () => {
  const before = await commits()
  const r = await call('/clear', 'POST', { target: 'sales', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  assert.equal(r.data.counts.sales, 1)
  assert.equal(await commits(), before + 1, '必须是一次提交，不能逐表写')
  assert.equal((await read('sales.json')).length, 0)
  assert.equal((await read('purchases.json')).length, 1, '采购单不能被牵连')
  const stock = await read('stock.json')
  assert.equal(stock.P1.qty, 10, '卖掉的 3 个要回到库存')
  assert.equal(stock.P1.cost, 12)
})

await t('清空销售单不是静默删除：日志里能查到 target/条数/来源', async () => {
  const logs = await read('logs.json')
  const last = logs[logs.length - 1]
  assert.equal(last.source, 'clear')
  assert.equal(last.action, 'clear')
  assert.equal(last.target, 'sales')
  assert.match(last.detail, /sales=1/)
  assert.equal(last.ip, '1.2.3.4')
  assert.ok(logs.length >= 2, '原有日志不能被清掉')
})

console.log('\n清空入口：档案类')
await t('清空客户：档案清空，名下销售单保留并打「(已删除客户)」前缀', async () => {
  repo = seed(); token = await issueToken(env)
  const r = await call('/clear', 'POST', { target: 'customers', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  assert.equal((await read('customers.json')).length, 0)
  const sales = await read('sales.json')
  assert.equal(sales.length, 1, '单据必须保留')
  assert.equal(sales[0].customer, '(已删除客户) 乙客户')
})

await t('清空商品：不因为还留着单据就把商品重新造回来', async () => {
  repo = seed(); token = await issueToken(env)
  const r = await call('/clear', 'POST', { target: 'items', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  assert.equal((await read('items.json')).length, 0, '服务端不得调 derive 反填商品')
  assert.equal((await read('sales.json')).length, 1, '单据保留')
})

console.log('\n清空入口：全清')
await t('清空全部：七类归零、一次提交、库存归零、日志保留并追加', async () => {
  repo = seed(); token = await issueToken(env)
  const before = await commits()
  const r = await call('/clear', 'POST', { target: 'all', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  for (const f of ['items.json', 'customers.json', 'suppliers.json', 'purchases.json', 'sales.json', 'receipts.json', 'payment-vouchers.json']) {
    assert.equal((await read(f)).length, 0, `${f} 应清空`)
  }
  assert.deepEqual(await read('stock.json'), {})
  const names = repo.names()
  assert.ok(!names.some(n => /^(purchases|sales)-\d{4}\.json$/.test(n)), '分片模式下不能留下旧年片')
  assert.equal(await commits(), before + 1, '全清也必须是一次提交')
  const logs = await read('logs.json')
  assert.ok(logs.some(l => l.source === 'clear' && l.target === 'all'))
})

await t('重复清空已空库：不产生空提交（幂等）', async () => {
  const before = await commits()
  const r = await call('/clear', 'POST', { target: 'all', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  assert.equal(r.data.unchanged, true)
  assert.equal(await commits(), before, '没有变化就不该再提交一次')
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
