// AI-API 限流：按密钥 + 全局两道滑动窗口。
// 跑法：node tests/rate-limit-test.mjs
import assert from 'node:assert/strict'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi } from '../api/routes.js'
import { sha256 } from '../api/ai-keys.js'
import { resetRateLimits } from '../api/rate-limit.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const KEY_A = 'ai_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const KEY_B = 'ai_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const keyRecord = async (id, name, raw) => ({
  id, name, prefix: raw.slice(0, 16), hash: await sha256(raw),
  scopes: ['read:catalog'], createdAt: '2026-01-01T00:00:00.000Z', revokedAt: '', expiresAt: null
})

const SEED = {
  'items.json': '[]', 'suppliers.json': '[]', 'customers.json': '[]',
  'purchases.json': '[]', 'sales.json': '[]', 'stock.json': '{}', 'logs.json': '[]',
  'ai-keys.json': JSON.stringify([await keyRecord('AK1', '脚本A', KEY_A), await keyRecord('AK2', '脚本B', KEY_B)])
}

const makeEnv = (extra = {}) => ({
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ALLOWED_ORIGINS: 'https://worker.test',
  AI_RATE_LIMIT: '2', AI_RATE_GLOBAL: '100', ...extra
})

const call = async (env, key, path = '/api/ai/v1/schema') => {
  const req = new Request(`https://worker.test${path}`, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Origin: 'https://worker.test' }
  })
  const res = await handleApi(req, new URL(req.url), env)
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers }
}

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')) }
}

console.log('\nAI 限流：纯函数口径')
await t('窗口内超过上限即拒绝，并给出 retryAfter', async () => {
  resetRateLimits()
  const { hit } = await import('../api/rate-limit.js')
  const now = 1_000_000
  assert.equal(hit('k', 2, 60000, now).ok, true)
  assert.equal(hit('k', 2, 60000, now + 1).ok, true)
  const third = hit('k', 2, 60000, now + 2)
  assert.equal(third.ok, false)
  assert.ok(third.retryAfter >= 1 && third.retryAfter <= 60)
  // 窗口滑过去之后恢复
  assert.equal(hit('k', 2, 60000, now + 60001).ok, true)
})

await t('不同 id 各自计数，limit<=0 视为不限流', async () => {
  resetRateLimits()
  const { hit } = await import('../api/rate-limit.js')
  const now = 2_000_000
  hit('a', 1, 60000, now)
  assert.equal(hit('a', 1, 60000, now + 1).ok, false)
  assert.equal(hit('b', 1, 60000, now + 1).ok, true, 'A 被限流不能牵连 B')
  for (let i = 0; i < 5; i++) assert.equal(hit('c', 0, 60000, now).ok, true, '0 = 关闭限流')
})

console.log('\nAI 限流：接口口径')
const env = makeEnv()
makeFakeRepo(SEED)
resetRateLimits()

await t('同一把密钥超过每分钟配额 → 429，带 Retry-After', async () => {
  resetRateLimits()
  const a1 = await call(env, KEY_A)
  const a2 = await call(env, KEY_A)
  const a3 = await call(env, KEY_A)
  assert.equal(a1.status, 200)
  assert.equal(a2.status, 200)
  assert.equal(a3.status, 429)
  assert.match(a3.data.error, /过于频繁/)
  assert.ok(Number(a3.headers.get('Retry-After')) >= 1)
})

await t('被限流的密钥不影响别的密钥', async () => {
  const b = await call(env, KEY_B)
  assert.equal(b.status, 200)
})

await t('全局配额独立生效（多把密钥也烧不穿）', async () => {
  resetRateLimits()
  const tight = makeEnv({ AI_RATE_LIMIT: '10', AI_RATE_GLOBAL: '2' })
  const a1 = await call(tight, KEY_A)
  const b1 = await call(tight, KEY_B)
  const a2 = await call(tight, KEY_A)
  assert.equal(a1.status, 200)
  assert.equal(b1.status, 200)
  assert.equal(a2.status, 429)
  assert.match(a2.data.error, /全站 2 次/)
})

await t('无效密钥仍是 401（限流不掩盖鉴权）', async () => {
  const r = await call(makeEnv(), 'ai_live_notarealkey0000000000000000')
  assert.equal(r.status, 401)
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
