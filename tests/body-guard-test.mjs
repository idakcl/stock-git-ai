// Worker 入口闸门：请求体体积与媒体类型。
// 只测「被挡下」的部分——它们发生在任何 GitHub 读取之前，所以不需要造数据仓。
// 跑法：node tests/body-guard-test.mjs
import assert from 'node:assert/strict'
import worker from '../web/index.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ALLOWED_ORIGINS: 'https://worker.test',
  ASSETS: { async fetch() { return new Response('<html>', { status: 200 }) } }
}
globalThis.caches = { default: { async match() { return undefined }, async put() {}, async delete() {} } }

const post = (path, { type = 'application/json', body = '{}', headers = {} } = {}) => worker.fetch(
  new Request(`https://w.test${path}`, { method: 'POST', headers: { 'Content-Type': type, ...headers }, body }),
  env
)

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')) }
}

console.log('\n请求体闸门')
await t('非 JSON 的 POST 在入口即 415（跨站表单发不出 application/json）', async () => {
  const res = await post('/api/login', { type: 'application/x-www-form-urlencoded', body: 'password=x' })
  assert.equal(res.status, 415)
  assert.match((await res.json()).error, /application\/json/)
})

await t('缺 Content-Type 也拒绝', async () => {
  const res = await worker.fetch(new Request('https://w.test/api/login', { method: 'POST', body: '{}' }), env)
  assert.equal(res.status, 415)
})

await t('JSON 带 charset 仍然放行（不误伤正常前端）', async () => {
  const res = await post('/api/login', { type: 'application/json; charset=utf-8', body: '{}' })
  // 没有密码/数据仓，业务层会报错，但绝不能是闸门的 413/415
  assert.ok(res.status !== 415 && res.status !== 413, `不应被闸门拦下，实际 ${res.status}`)
})

await t('Content-Length 超限 → 413，且不读业务数据', async () => {
  const res = await post('/api/sales', { headers: { 'Content-Length': String(9 * 1024 * 1024) }, body: '{}' })
  assert.equal(res.status, 413)
  assert.match((await res.json()).error, /过大/)
})

await t('分块传输（无 Content-Length）按流计数，超限同样 413', async () => {
  // 9MB 的流式请求体：Node 的 Request 会自己算 content-length，所以这里显式删掉再测流式分支
  const chunk = new Uint8Array(1024 * 1024).fill(32)
  let sent = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= 9) { controller.close(); return }
      sent++
      controller.enqueue(chunk)
    }
  })
  const req = new Request('https://w.test/api/sales', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stream,
    duplex: 'half'
  })
  req.headers.delete('content-length')
  const res = await worker.fetch(req, env)
  assert.equal(res.status, 413)
})

await t('上传接口只接受 multipart', async () => {
  const res = await post('/api/upload', { type: 'application/json', body: '{}' })
  assert.equal(res.status, 415)
  assert.match((await res.json()).error, /multipart/)
})

await t('静态资源不受影响（照常返回页面）', async () => {
  const res = await worker.fetch(new Request('https://w.test/'), env)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY')
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
