// AI-API 页面回归：菜单入口、新建密钥（最大权限/永久）、一次性密钥展示、改权限、吊销。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/ai-api-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'
import { AI_ALL_SCOPE_IDS } from '../src/utils/aiScopes.js'

const BASE = 'http://127.0.0.1:5173'
const systemChrome = ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => existsSync(p))
const browser = await chromium.launch(systemChrome ? { headless: true, executablePath: systemChrome } : { headless: true })

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}

const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await new Promise(r => setTimeout(r, 60))
  }
  return null
}

const keys = []
const posts = []
const NEW_KEY = 'ai_live_testkey0123456789abcdefgh'

const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
await context.route('**/api/**', async route => {
  const request = route.request()
  const pathname = new URL(request.url()).pathname
  if (!pathname.startsWith('/api/')) return route.continue()
  const send = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
  if (pathname === '/api/session') return send({ ok: true })
  if (pathname === '/api/sales' || pathname === '/api/purchases' || pathname === '/api/orders') return send([])
  if (pathname === '/api/ai-keys' && request.method() === 'GET') return send({ keys })
  if (pathname === '/api/ai-logs') {
    return send({
      total: 2, retainedDays: 7, max: 1500,
      logs: [
        { at: new Date().toISOString(), ms: 42, method: 'POST', path: '/sales?x=1', key: '采购助手', keyId: 'AKTEST0001', status: 200, requestId: 'abcdefghijklmnop', code: 'X202601011200000001', error: '' },
        { at: new Date().toISOString(), ms: 3, method: 'GET', path: '/items', key: '', keyId: '', status: 401, requestId: '', code: '', error: '密钥无效、已过期或已吊销' }
      ]
    })
  }
  if (pathname === '/api/ai-keys' && request.method() === 'POST') {
    const body = JSON.parse(request.postData() || '{}')
    posts.push(body)
    if (body.action === 'create') {
      const record = {
        id: 'AKTEST0001', name: body.name, prefix: NEW_KEY.slice(0, 16),
        scopes: body.scopes, createdAt: new Date().toISOString(),
        expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400000).toISOString() : null,
        revokedAt: '', active: true
      }
      keys.unshift(record)
      return send({ key: NEW_KEY, record })
    }
    if (body.action === 'update') {
      const row = keys.find(k => k.id === body.id)
      if (row) { row.scopes = body.scopes; row.name = body.name }
      return send({ key: keys.find(k => k.id === body.id) })
    }
    if (body.action === 'revoke') {
      const row = keys.find(k => k.id === body.id)
      if (row) { row.revokedAt = new Date().toISOString(); row.active = false }
      return send({ key: row })
    }
    return send({ error: 'unknown' })
  }
  return send({})
})

const page = await context.newPage()
const go = async (path) => page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })

await t('左侧菜单有「AI-API」并可进入页面', async () => {
  await go('/')
  const menu = page.locator('.el-menu').getByText('AI-API', { exact: true })
  assert.ok(await menu.count(), '菜单里应有 AI-API')
  await menu.first().click()
  await page.waitForURL('**/ai-api')
  await until(() => page.locator('h3, .title b').filter({ hasText: 'AI-API' }).count())
  assert.ok(await page.locator('.title b', { hasText: 'AI-API' }).count())
})

await t('空列表显示引导文案', async () => {
  const empty = page.locator('.el-table__empty-text')
  await empty.waitFor({ state: 'visible' })
  assert.match(await empty.textContent(), /新建密钥/)
})

await t('新建：选最大权限 + 永久，签发后一次性显示密钥', async () => {
  await page.getByRole('button', { name: '新建密钥' }).click()
  const dialog = page.locator('.el-dialog').filter({ hasText: '新建 AI 密钥' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByPlaceholder(/给谁用/).fill('采购助手')
  // 最大权限预设
  await dialog.locator('.preset-row button', { hasText: '最大权限' }).click()
  assert.match(await dialog.locator('.scope-summary').textContent(), /最大权限/)
  // 逐项微调：点整行也能取消/重新勾选
  const costRow = dialog.locator('.scope-item', { hasText: '看进价与毛利' })
  await costRow.click()
  assert.match(await dialog.locator('.scope-summary').textContent(), /已选\s*13\s*\//)
  await costRow.click()
  assert.match(await dialog.locator('.scope-summary').textContent(), /最大权限/)
  // 永久
  await dialog.locator('.el-radio-button', { hasText: '永久' }).click()
  await dialog.getByRole('button', { name: '签发' }).click()

  const created = page.locator('.el-dialog').filter({ hasText: '密钥已生成' })
  await created.waitFor({ state: 'visible' })
  assert.equal((await created.locator('.key-box code').textContent()).trim(), NEW_KEY)
  assert.match(await created.locator('.key-link').textContent(), /\/api\/ai\/v1\/schema\?key=ai_live_/)
  const post = posts.find(p => p.action === 'create')
  assert.equal(post.name, '采购助手')
  assert.equal(post.expiresInDays, 0)
  assert.equal(post.scopes.length, AI_ALL_SCOPE_IDS.length, '最大权限应勾满全部业务权限')
  assert.ok(!post.scopes.some(s => /key|password|backup|clear/i.test(s)), '不得包含密钥管理/改密码/备份/清空')
})

await t('复制使用说明给出成功提示', async () => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
  await page.getByRole('button', { name: '复制使用说明' }).click()
  const msg = await until(() => page.locator('.el-message').filter({ hasText: '使用说明已复制' }).count())
  assert.ok(msg, '应提示已复制')
})

await t('关闭后列表显示名称、最大权限标签、永久', async () => {
  await page.getByRole('button', { name: '我已保存，关闭' }).click()
  const row = page.locator('.el-table__body tr', { hasText: '采购助手' })
  await row.waitFor({ state: 'visible' })
  assert.match(await row.textContent(), /最大权限/)
  assert.match(await row.textContent(), /永久/)
  assert.match(await row.textContent(), /有效/)
})

await t('改权限：取消最大权限后只保留勾选项', async () => {
  await page.locator('.el-table__body tr', { hasText: '采购助手' }).getByRole('button', { name: '改权限' }).click()
  const dialog = page.locator('.el-dialog').filter({ hasText: '修改密钥权限' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.locator('.preset-row button', { hasText: '只读问答' }).click()
  assert.match(await dialog.locator('.scope-summary').textContent(), /已选\s*4\s*\/\s*14/)
  await dialog.getByRole('button', { name: '保存' }).click()
  const post = await until(() => posts.find(p => p.action === 'update'))
  assert.ok(post)
  assert.equal(post.scopes.length, 4)
})

await t('吊销：确认后状态变为已吊销且不再显示操作按钮', async () => {
  await page.locator('.el-table__body tr', { hasText: '采购助手' }).getByRole('button', { name: '吊销' }).click()
  const box = page.locator('.el-message-box')
  await box.waitFor({ state: 'visible' })
  await box.getByRole('button', { name: '确认吊销' }).click()
  const row = page.locator('.el-table__body tr', { hasText: '采购助手' })
  const ok = await until(async () => /已吊销/.test(await row.textContent()))
  assert.ok(ok, '状态应变为已吊销')
  assert.equal(await row.getByRole('button', { name: '吊销' }).count(), 0)
})

await t('调用日志：抽屉展示记录、状态与错误', async () => {
  await page.getByRole('button', { name: '调用日志' }).click()
  const drawer = page.locator('.el-drawer').filter({ hasText: 'AI 调用日志' })
  await drawer.waitFor({ state: 'visible' })
  const okRow = drawer.locator('.el-table__body tr', { hasText: '采购助手' })
  await okRow.waitFor({ state: 'visible' })
  assert.match(await okRow.textContent(), /POST \/sales/)
  assert.match(await okRow.textContent(), /200/)
  assert.match(await okRow.textContent(), /X202601011200000001/)
  const errRow = drawer.locator('.el-table__body tr', { hasText: '未认证' })
  assert.match(await errRow.textContent(), /401/)
  assert.match(await errRow.textContent(), /密钥无效/)
  assert.match(await drawer.locator('.log-total').textContent(), /共 2 条/)
  assert.match(await drawer.locator('.log-foot').textContent(), /保留最近 7 天/)
})

console.log(`\n${pass} 通过，${fail} 失败`)
await browser.close()
if (fail) process.exit(1)
