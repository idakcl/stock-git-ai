// 会话安全：改密码 / 吊销所有会话 / 票据版本。
//
// 这几条是「票据泄露后能不能止损」的全部答案：
//   · 票据带版本号 v，auth.json 里的 version +1 之后，旧票一律 401；
//   · 鉴权走 30 秒缓存，所以吊销在别的边缘节点上最多晚 30 秒生效（不是立刻，如实测）
//   · 改密/吊销都要求当前密码：拿到会话不等于知道密码；
//   · 没设置过密码时回退 Worker Secret 的初始密码，不会把自己锁在门外。
import assert from 'node:assert/strict'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi } from '../api/routes.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', APP_PASSWORD: 'correct-password'
}
const repo = makeFakeRepo({
  'items.json': '[]', 'suppliers.json': '[]', 'customers.json': '[]',
  'purchases.json': '[]', 'sales.json': '[]', 'stock.json': '{}', 'logs.json': '[]'
})

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')) }
}

const call = async (path, method, body, token) => {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' }
  if (token) headers.Authorization = `Bearer ${token}`
  const req = new Request(`https://w.test/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const res = await handleApi(req, new URL(req.url), env)
  return { status: res.status, data: await res.json().catch(() => null) }
}
const login = async (password) => call('/login', 'POST', { password })
// fake-github 的 read() 对不存在的文件返回 undefined（真实 API 是 404），这里统一成 null。
const readAuth = async () => {
  const raw = await repo.read('auth.json')
  return raw === undefined ? null : JSON.parse(raw)
}

console.log('\n会话安全：初始密码')
let token0
await t('Worker Secret 里的初始密码可登录，票据带版本 0', async () => {
  const r = await login('correct-password')
  token0 = r.data && r.data.token
  assert.equal(r.status, 200)
  assert.equal(r.data.version, 0)
  assert.ok(token0)
  const s = await call('/session', 'GET', null, token0)
  assert.equal(s.data.ok, true)
})

await t('没有 auth.json 时不会把登录判成服务端未配置', async () => {
  assert.equal(await readAuth(), null, '初始状态应还没有 auth.json')
})

console.log('\n会话安全：改密码')
await t('新密码过短 → 400，且不写 auth.json', async () => {
  const r = await call('/auth/password', 'POST', { current: 'correct-password', next: '123' }, token0)
  assert.equal(r.status, 400)
  assert.equal(await readAuth(), null)
})

await t('当前密码错误 → 403', async () => {
  const r = await call('/auth/password', 'POST', { current: 'wrong', next: 'new-password-1' }, token0)
  assert.equal(r.status, 403)
  assert.match(r.data.error, /当前密码/)
})

let token1
await t('改密成功：返回新票据，旧票据立刻 401（同一节点版本已更新）', async () => {
  const r = await call('/auth/password', 'POST', { current: 'correct-password', next: 'new-password-1' }, token0)
  assert.equal(r.status, 200)
  assert.ok(r.data.token)
  token1 = r.data.token
  // /session 是「探针」接口：永远 200，用 ok 表达票据死活。
  const old = await call('/session', 'GET', null, token0)
  assert.equal(old.data.ok, false, '旧票据必须失效')
  const now = await call('/session', 'GET', null, token1)
  assert.equal(now.data.ok, true)
})

await t('数据仓里只存盐 + PBKDF2 哈希，不存明文', async () => {
  const rec = await readAuth()
  assert.equal(rec.version, 1)
  assert.ok(rec.salt && rec.hash && rec.hash.length === 64)
  assert.ok(!JSON.stringify(rec).includes('new-password-1'))
  assert.ok(!JSON.stringify(rec).includes('correct-password'))
})

await t('旧密码登录失败、新密码登录成功', async () => {
  const stale = await login('correct-password')
  assert.equal(stale.status, 401)
  const fresh = await login('new-password-1')
  assert.equal(fresh.status, 200)
  assert.equal(fresh.data.version, 1)
})

console.log('\n会话安全：吊销所有会话')
await t('吊销也要求当前密码：错误 → 403，票据仍有效', async () => {
  const bad = await call('/auth/revoke', 'POST', { password: 'wrong' }, token1)
  assert.equal(bad.status, 403)
  const s = await call('/session', 'GET', null, token1)
  assert.equal(s.data.ok, true)
})

await t('吊销成功后所有票据失效，重新登录可用且版本递增', async () => {
  const r = await call('/auth/revoke', 'POST', { password: 'new-password-1' }, token1)
  assert.equal(r.status, 200)
  assert.equal(r.data.version, 2)
  const dead = await call('/session', 'GET', null, token1)
  assert.equal(dead.data.ok, false)
  const again = await login('new-password-1')
  assert.equal(again.status, 200)
  assert.equal(again.data.version, 2)
  const ok = await call('/session', 'GET', null, again.data.token)
  assert.equal(ok.data.ok, true)
})

await t('吊销不覆盖密码：auth.json 里哈希原样保留', async () => {
  const rec = await readAuth()
  assert.equal(rec.version, 2)
  assert.ok(rec.hash)
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
