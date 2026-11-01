// B1 回归：边缘缓存必须绑身份，未登录不得命中；静态资源必须带安全头。
// 跑法：node tests/worker-cache-test.mjs （纯 Node，不需要浏览器）
import assert from 'node:assert/strict'
import { makeFakeRepo } from './fake-github.mjs'
import worker from '../web/index.js'
import { issueToken } from '../api/auth.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw'
}

// 内存版 Cache API：key 就是 Request.url（含 ?__ck=<摘要>）
const store = new Map()
globalThis.caches = {
  default: {
    async match(req) {
      const r = store.get(req.url)
      if (!r) return undefined
      return new Response(r.body, { status: r.status, headers: r.headers })
    },
    async put(req, res) {
      store.set(req.url, { status: res.status, headers: [...res.headers], body: await res.text() })
    },
    async delete(req) { store.delete(req.url) }
  }
}
const assets = {
  async fetch() {
    return new Response('<!doctype html><title>t</title>', { status: 200, headers: { 'Content-Type': 'text/html' } })
  }
}
const call = (path, method, token, body) => worker.fetch(new Request(`https://w.test${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined
}), { ...env, ASSETS: assets })

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (String(e && e.message || e).split('\n').join('\n      '))) }
}
const seed = () => makeFakeRepo({
  'items.json': JSON.stringify([{ code: 'P00001', name: '管件', unit: '个', cost: 8, price: 10 }]),
  'suppliers.json': '[]', 'customers.json': '[]', 'purchases.json': '[]',
  'sales.json': JSON.stringify([{ id: 'X1', date: '2026-10-01', customer: '甲', total: 100, items: [], payments: [], received: 0, settle: '挂账' }]),
  'stock.json': '{}', 'refunds.json': '[]', 'receipts.json': '[]', 'payment-vouchers.json': '[]', 'logs.json': '[]'
})

const repo = seed()
store.clear()
const tokenA = await issueToken(env, 'admin', 3600 * 1000)
const tokenB = await issueToken(env, 'admin', 3600 * 1000)

console.log('\n边缘缓存')
await t('登录态 GET 会命中缓存（提速仍在）', async () => {
  const r1 = await call('/api/sales', 'GET', tokenA)
  assert.equal(r1.status, 200)
  assert.equal(r1.headers.get('X-Cache'), 'MISS')
  const r2 = await call('/api/sales', 'GET', tokenA)
  assert.equal(r2.status, 200)
  assert.equal(r2.headers.get('X-Cache'), 'HIT')
})

await t('未登录打同一 URL 必须 401，不得读到缓存', async () => {
  const r = await call('/api/sales', 'GET', null)
  assert.equal(r.status, 401, `实际 ${r.status}`)
  const body = await r.text()
  assert.ok(!body.includes('"X1"'), '响应体里不应出现业务数据')
})

await t('换一把（不同）令牌不得命中别人的缓存', async () => {
  const r = await call('/api/sales', 'GET', tokenB)
  assert.notEqual(r.headers.get('X-Cache'), 'HIT')
})

await t('写后同一会话读到的必须是新值', async () => {
  const current = await (await call('/api/sales', 'GET', tokenA)).json()
  const next = [...current, { id: 'X2', date: '2026-10-02', customer: '乙', total: 20, items: [], payments: [], received: 0, settle: '挂账' }]
  const w = await call('/api/sales', 'POST', tokenA, { sales: next })
  assert.equal(w.status, 200)
  const after = await (await call('/api/sales', 'GET', tokenA)).json()
  assert.ok(after.some(o => o.id === 'X2'), '写后读必须是新值')
})

await t('未登录请求不会写入缓存条目', async () => {
  for (const k of store.keys()) assert.ok(k.includes('__ck='), `出现了未绑身份的缓存键：${k}`)
})

console.log('\n静态资源安全头')
await t('首页带 CSP / HSTS / XFO / nosniff / Referrer-Policy', async () => {
  const r = await call('/', 'GET', null)
  assert.equal(r.status, 200)
  assert.match(String(r.headers.get('Content-Security-Policy')), /default-src 'self'/)
  assert.match(String(r.headers.get('Content-Security-Policy')), /frame-ancestors 'none'/)
  assert.equal(r.headers.get('X-Frame-Options'), 'DENY')
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(r.headers.get('Referrer-Policy'), 'no-referrer')
  assert.match(String(r.headers.get('Strict-Transport-Security')), /max-age=\d+/)
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
