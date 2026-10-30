// 新页面开单 → 新开浏览器标签页（window.open）交互测试
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

async function open(path, state) {
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
  return { page, context, state, errors }
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

console.log('\n销售：列表 → 新标签页开单')

await t('在 /sales 列表页点「新页面开单」→ 新开标签页，URL 以 /sales/new 结尾', async () => {
  const { page, context } = await open('/sales', seed())
  try {
    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: '新页面开单' }).click()
    ])
    await newPage.waitForLoadState('networkidle')
    assert.ok(newPage.url().endsWith('/sales/new'), `新标签页 URL 应以 /sales/new 结尾，实际：${newPage.url()}`)
  } finally { await context.close() }
})

await t('新标签页内没有应用外壳（无侧边菜单），开单弹窗 fullscreen', async () => {
  const { page, context } = await open('/sales', seed())
  try {
    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: '新页面开单' }).click()
    ])
    await newPage.waitForLoadState('networkidle')
    // 无应用外壳：侧边菜单不渲染
    assert.equal(await newPage.locator('.el-menu').count(), 0, '新标签页不应渲染侧边菜单')
    assert.equal(await newPage.locator('.el-aside').count(), 0, '新标签页不应渲染侧边栏')
    assert.equal(await newPage.locator('.header').count(), 0, '新标签页不应渲染顶栏')
    // 开单弹窗 fullscreen
    await assertFullscreen(newPage, '新标签页开单弹窗应为 fullscreen')
  } finally { await context.close() }
})

await t('原标签页仍停留在列表页（URL 不含 /new，列表 el-card 仍可见）', async () => {
  const { page, context } = await open('/sales', seed())
  try {
    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: '新页面开单' }).click()
    ])
    await newPage.waitForLoadState('networkidle')
    // 原标签页 URL 不变
    assert.ok(page.url().endsWith('/sales'), `原标签页应停留在 /sales，实际：${page.url()}`)
    assert.ok(!page.url().includes('/new'), '原标签页 URL 不应含 /new')
    // 列表 el-card 仍可见
    assert.ok(await page.locator('.el-card').first().isVisible(), '原标签页列表卡片应仍可见')
    assert.ok(await page.getByRole('button', { name: '新增销售' }).isVisible(), '原标签页「新增销售」按钮应仍可见')
  } finally { await context.close() }
})

console.log('\n采购与订单：同一套新标签页开单')

await t('/purchases 列表页点「新页面开单」→ 新标签页只有开单窗口', async () => {
  const { page, context } = await open('/purchases', seed())
  try {
    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: '新页面开单' }).click()
    ])
    await newPage.waitForLoadState('networkidle')
    assert.ok(newPage.url().endsWith('/purchases/new'), `新标签页 URL 应以 /purchases/new 结尾，实际：${newPage.url()}`)
    assert.equal(await newPage.locator('.el-menu').count(), 0, '采购新标签页不应渲染侧边菜单')
    await assertFullscreen(newPage, '采购新标签页开单弹窗应为 fullscreen')
  } finally { await context.close() }
})

await t('/orders 列表页点「新页面开单」→ 新标签页只有开单窗口', async () => {
  const { page, context } = await open('/orders', seed())
  try {
    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: '新页面开单' }).click()
    ])
    await newPage.waitForLoadState('networkidle')
    assert.ok(newPage.url().endsWith('/orders/new'), `新标签页 URL 应以 /orders/new 结尾，实际：${newPage.url()}`)
    assert.equal(await newPage.locator('.el-menu').count(), 0, '订单新标签页不应渲染侧边菜单')
    await assertFullscreen(newPage, '订单新标签页开单弹窗应为 fullscreen')
  } finally { await context.close() }
})

console.log('\n新标签页「返回」→ 关闭标签页')

await t('新标签页里点「返回」→ 该标签页被关闭（page.isClosed()）', async () => {
  const { page, context } = await open('/sales', seed())
  try {
    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: '新页面开单' }).click()
    ])
    await newPage.waitForLoadState('networkidle')
    await assertFullscreen(newPage, '新标签页应有 fullscreen 表单')
    // 点「返回」按钮（OrderEditDialog 在 standalone 模式下把「取消」改为「返回」）
    await newPage.getByRole('button', { name: '返回' }).click()
    // 等待标签页关闭（window.close() 由 backToList 触发）
    await newPage.waitForEvent('close', { timeout: 5000 }).catch(() => {})
    // Playwright 的 page.isClosed() 在页面关闭后返回 true
    assert.ok(newPage.isClosed(), '新标签页应已被关闭')
  } finally { await context.close() }
})

await browser.close()
console.log(`\n全部 ${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
process.exit(fail ? 1 : 0)
