// AI 写入主数据时的资金闸门：预存款 / 预付款流水的余额口径必须与 POST /deposits 一致。
// 背景：同一笔钱有两套规则——界面抵扣会查余额，AI 走 /master 带负数流水却只查「非零」，
// 可以把客户余额写成 -99999。这里钉死三条：扣成负数必须 409、正好扣到 0 允许、
// 同一请求里「先充后抵」按顺序累加。
import assert from 'node:assert/strict'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi } from '../api/routes.js'
import { issueToken } from '../api/auth.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw',
  ALLOWED_ORIGINS: 'https://worker.test'
}

const SEED = {
  'items.json': JSON.stringify([{ code: 'P00001', name: '三通', unit: '个', cost: 8, price: 12 }]),
  'suppliers.json': JSON.stringify([{ code: 'S00001', name: '供应商甲', products: [], advances: [] }]),
  'customers.json': JSON.stringify([
    { code: 'C00001', name: '客户甲', contact: '', phone: '', remark: '', deposits: [{ id: 'd1', date: '2026-01-01', amount: 100 }] },
    { code: 'C00002', name: '客户乙', contact: '', phone: '', remark: '', deposits: [] }
  ]),
  'purchases.json': '[]',
  'sales.json': '[]',
  'orders.json': '[]',
  'receipts.json': '[]',
  'payment-vouchers.json': '[]',
  'stock.json': JSON.stringify({ P00001: { qty: 0, cost: 8 } }),
  'logs.json': '[]'
}

let repo = makeFakeRepo(SEED)
let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')) }
}

const token = await issueToken(env)
const keyData = await (async () => {
  const req = new Request('https://worker.test/api/ai-keys', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://worker.test' },
    body: JSON.stringify({ action: 'create', name: '资金闸门测试', scopes: ['read:catalog', 'write:master', 'write:deposits'], expiresInDays: 0 })
  })
  const res = await handleApi(req, new URL(req.url), env)
  return res.json()
})()
const aiKey = keyData.key

const call = async (path, { method = 'GET', body, key = aiKey } = {}) => {
  const req = new Request(`https://worker.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Origin: 'https://worker.test' },
    body: body ? JSON.stringify(body) : undefined
  })
  const res = await handleApi(req, new URL(req.url), env)
  return { status: res.status, data: await res.json().catch(() => null) }
}
const ok = async (path, opts) => {
  const r = await call(path, opts)
  if (r.status !== 200) throw new Error(`${path} → ${r.status} ${r.data && r.data.error || ''}`)
  return r.data
}
const depositsOf = (code) => JSON.parse(repo.read('customers.json')).find(c => c.code === code).deposits
const commits = () => repo.log().length
let n = 0
const rid = () => `ai-balance-test-${String(++n).padStart(4, '0')}-xxxxxxxx`

console.log('\nAI 建档带流水：余额闸门')
await t('抵扣超过余额 → 409，且一个字节都不写', async () => {
  const before = commits()
  const r = await call('/api/ai/master', {
    method: 'POST',
    body: { requestId: rid(), type: 'customer', customer: { name: '客户甲', deposits: [{ amount: -150 }] } }
  })
  assert.equal(r.status, 409, `应 409，实际 ${r.status} ${r.data && r.data.error}`)
  assert.match(r.data.error, /余额不足/)
  assert.match(r.data.error, /100\.00/)
  assert.equal(await commits(), before, '被拦下的请求不能产生提交')
  assert.equal(depositsOf('C00001').length, 1, '流水不能被改动')
})

await t('正好扣到 0 → 允许，返回 balance 0', async () => {
  const r = await call('/api/ai/master', {
    method: 'POST',
    body: { requestId: rid(), type: 'customer', customer: { name: '客户甲', deposits: [{ amount: -100 }] } }
  })
  assert.equal(r.status, 200, r.data && r.data.error)
  assert.equal(r.data.balance, 0)
  assert.equal(depositsOf('C00001').length, 2)
})

await t('余额已为 0 时再抵扣 → 409（不能靠「分两次」绕过）', async () => {
  const r = await call('/api/ai/master', {
    method: 'POST',
    body: { requestId: rid(), type: 'customer', customer: { name: '客户甲', deposits: [{ amount: -1 }] } }
  })
  assert.equal(r.status, 409)
  assert.match(r.data.error, /余额不足/)
})

await t('同一请求里「先充 50 再抵 50」按顺序累加 → 允许', async () => {
  const r = await call('/api/ai/master', {
    method: 'POST',
    body: { requestId: rid(), type: 'customer', customer: { name: '客户甲', deposits: [{ amount: 50 }, { amount: -50 }] } }
  })
  assert.equal(r.status, 200, r.data && r.data.error)
  assert.equal(r.data.balance, 0)
})

await t('同一请求里「先抵 10 再充 10」且当前余额为 0 → 409（顺序即账实）', async () => {
  const r = await call('/api/ai/master', {
    method: 'POST',
    body: { requestId: rid(), type: 'customer', customer: { name: '客户甲', deposits: [{ amount: -10 }, { amount: 10 }] } }
  })
  assert.equal(r.status, 409)
})

await t('新客户建档时直接写负数流水 → 409（不能凭空造负余额）', async () => {
  const r = await call('/api/ai/master', {
    method: 'POST',
    body: { requestId: rid(), type: 'customer', customer: { name: '新客户丙', deposits: [{ amount: -5 }] } }
  })
  assert.equal(r.status, 409)
  assert.ok(!repo.read('customers.json').includes('新客户丙'), '被拦下时不能留下半截建档')
})

console.log('\n两条路同一口径')
await t('界面 /deposits 抵扣超余额同样 409，措辞同一口径', async () => {
  const r = await call('/api/ai/deposits', {
    method: 'POST',
    body: { requestId: rid(), type: 'customer', action: 'deduct', party: '客户乙', amount: 1 }
  })
  assert.equal(r.status, 409)
  assert.match(r.data.error, /余额不足/)
})

await t('供应商预付款走同一条闸门（advances）', async () => {
  const r = await call('/api/ai/master', {
    method: 'POST',
    body: { requestId: rid(), type: 'supplier', supplier: { name: '供应商甲', advances: [{ amount: -20 }] } }
  })
  assert.equal(r.status, 409)
  assert.match(r.data.error, /预付款余额不足/)
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
