// 整页开单（原「新页面开单」）：按钮已按需求去掉，只保留 /sales/new 这类路由，
// 用书签或外链直接打开时仍得到「无应用外壳 + 铺满屏幕的表单」。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/entry-newtab-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'

const BASE = 'http://127.0.0.1:5173'
const systemChrome = ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => existsSync(p))
const browser = await chromium.launch(systemChrome ? { headless: true, executablePath: systemChrome } : { headless: true })
let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}

const seed = () => ({
  sales: [],
  purchases: [],
  orders: [],
  items: [
    { code: 'P00001', name: '管件', unit: '个', price: 100, cost: 50 },
    { code: 'P00002', name: '弯头', unit: '个', price: 200, cost: 100 }
  ],
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }]
})

async function open(path, state = seed()) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  await context.route('**/api/**', async route => {
    // 关键：Vite 的 /src/api/index.js 也会命中这个通配，必须先按真实路径放行
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    const key = pathname.slice(5)
    const send = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    if (request.method() === 'GET') return send(key === 'session' ? { ok: true } : (state[key] ?? []))
    return send({ ok: true })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  return { page, context, errors }
}

const form = (page) => page.locator('.el-dialog:visible').first()

async function assertFullscreen(page, message) {
  const dlg = form(page)
  await dlg.waitFor()
  const cls = await dlg.getAttribute('class')
  assert.match(cls || '', /is-fullscreen/, message)
  const box = await dlg.boundingBox()
  assert.ok(box.width > 1300, `整页开单表单应铺满屏幕宽度，实际 ${box.width}`)
  assert.ok(box.height > 900, `整页开单表单应铺满屏幕高度，实际 ${box.height}`)
}

console.log('\n列表页：三个「新页面开单」按钮都已去掉')

for (const [path, label] of [['/sales', '销售'], ['/purchases', '采购'], ['/orders', '订单']]) {
  await t(`${path} 列表页没有「新页面开单」按钮，新增按钮仍在`, async () => {
    const { page, context, errors } = await open(path)
    try {
      assert.equal(await page.getByRole('button', { name: '新页面开单' }).count(), 0, '「新页面开单」按钮应已去掉')
      const addName = path === '/orders' ? '新建订单' : (path === '/sales' ? '新增销售' : '新增采购')
      assert.ok(await page.getByRole('button', { name: addName }).isVisible(), `「${addName}」按钮应仍在`)
      assert.deepEqual(errors, [], `${label}页不应有运行时报错`)
    } finally { await context.close() }
  })
}

console.log('\n整页开单路由仍可用（书签 / 外链直接打开）')

for (const [path, menu] of [['/sales/new', '销售'], ['/purchases/new', '采购'], ['/orders/new', '订单']]) {
  await t(`直接访问 ${path} → 无应用外壳 + 表单铺满屏幕`, async () => {
    const { page, context, errors } = await open(path)
    try {
      assert.equal(await page.locator('.el-menu').count(), 0, `${menu}整页开单不应渲染侧边菜单`)
      assert.equal(await page.locator('.el-aside').count(), 0, `${menu}整页开单不应渲染侧边栏`)
      await assertFullscreen(page, `${menu}整页开单表单应为 fullscreen`)
      assert.deepEqual(errors, [], `${menu}整页开单不应有运行时报错`)
    } finally { await context.close() }
  })
}

await t('整页开单里点「返回」→ 回到列表页（关不掉标签页时 replace）', async () => {
  const { page, context } = await open('/sales/new')
  try {
    await assertFullscreen(page, '整页开单应有 fullscreen 表单')
    await page.getByRole('button', { name: '返回' }).click()
    await page.waitForTimeout(600)
    // 脚本没打开这个标签页，window.close() 无效 → backToList 退回列表路由
    if (!page.isClosed()) {
      assert.ok(page.url().endsWith('/sales'), `应退回 /sales，实际 ${page.url()}`)
      assert.ok(await page.getByRole('button', { name: '新增销售' }).isVisible(), '列表页的「新增销售」应可见')
    }
  } finally { await context.close().catch(() => {}) }
})

await browser.close()
console.log(`\n全部 ${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
process.exit(fail ? 1 : 0)
