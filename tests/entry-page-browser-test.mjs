// 新页面开单（需求：新增销售/采购/订单时，增加一个按钮，在新的页面打开）
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/entry-page-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'
// 订单金额用与前端/服务端同一份口径函数核算，不用来路不明的 total 字段
import { orderAmount } from '../src/utils/orders.js'

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
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  // 记录 POST 请求体，验证「页面版开单」走的还是列表页那套保存链路
  posts: []
})

async function open(path, state) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  await context.route('**/api/**', async route => {
    // 关键：Vite 的 /src/api/index.js 也会命中这个通配，必须先按真实路径放行，
    // 否则前端模块被 fulfill 成 JSON，页面直接白屏
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    const key = pathname.slice(5)
    const send = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    if (request.method() === 'GET') return send(key === 'session' ? { ok: true } : (state[key] ?? []))
    // Playwright 的 Request 没有 json()：POST body 用 postData() 拿字符串再解析
    let body = null
    try { body = JSON.parse(request.postData() || 'null') } catch { /* 非 JSON 请求体不影响断言 */ }
    state.posts.push({ key, body })
    return send({ ok: true })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  return { page, context, state, errors }
}

const form = (page) => page.locator('.el-dialog:visible').first()

// 整页模式：Element Plus 的 fullscreen 会加 is-fullscreen 类，宽高都铺满
async function assertFullscreen(page, message) {
  const dlg = form(page)
  await dlg.waitFor()
  const cls = await dlg.getAttribute('class')
  assert.match(cls || '', /is-fullscreen/, message)
  const box = await dlg.boundingBox()
  assert.ok(box.width > 1300, `整页开单表单应铺满屏幕宽度，实际 ${box.width}`)
  assert.ok(box.height > 900, `整页开单表单应铺满屏幕高度，实际 ${box.height}`)
}

// 往来单位与商品都是 el-select：placeholder 不在 input 属性上，必须点开后选下拉项
async function pickParty(page, dlg, name) {
  await dlg.locator('.el-form-item', { hasText: '客户' }).locator('.el-select input').first().click()
  await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: name }).first().click()
  await page.waitForTimeout(150)
}

async function addLine(page, dlg, productName) {
  await dlg.locator('.quick-add-select input').click()
  await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: productName }).first().click()
  await page.waitForTimeout(200)
}

// 关掉表单后 Element Plus 有离场动画，等到节点真的不见再断言
async function waitFormGone(page) {
  await page.locator('.el-dialog:visible').first().waitFor({ state: 'detached', timeout: 5000 })
}

// 「新页面开单」必须是真·新开浏览器标签页（window.open）：那部分由 tests/entry-newtab-browser-test.mjs 覆盖，
// 本文件只管整页表单自身：/xxx/new 直达、表单继承、保存链路、出口文案。
console.log('\n销售单：整页开单（/sales/new）')

await t('直接访问 /sales/new：数据取齐后自动开整页表单，出口文案是「返回」', async () => {
  const { page, context, errors } = await open('/sales/new', seed())
  try {
    await assertFullscreen(page, '直接访问也应得到整页表单')
    assert.equal(await page.getByRole('button', { name: '返回' }).count(), 1, '整页模式底部按钮应为「返回」')
    assert.equal(await page.getByRole('button', { name: '取消' }).count(), 0)
    // 整页模式不显示右上角 ×：出口只留「返回」一个，避免两条语义不同的关闭路径
    assert.equal(await page.locator('.el-dialog__headerbtn:visible').count(), 0, '整页模式不应出现 × 关闭按钮')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('整页表单继承明细勾选框与批量操作（与弹窗同一份组件）', async () => {
  const { page, context } = await open('/sales/new', seed())
  try {
    const dlg = form(page)
    assert.equal(await dlg.locator('.el-table__header th .el-checkbox').count(), 1, '整页表单也应有全选勾选框')
    assert.equal(await dlg.getByRole('button', { name: /批量设置折扣/ }).count(), 1)
    assert.equal(await dlg.getByRole('button', { name: /批量删除/ }).count(), 1)
  } finally { await context.close() }
})

await t('整页表单填一行保存：仍走列表页的 POST /sales 链路，存完自动回列表', async () => {
  const state = seed()
  const { page, context } = await open('/sales/new', state)
  try {
    const dlg = form(page)
    await pickParty(page, dlg, '客户甲')
    await addLine(page, dlg, '管件')
    await dlg.locator('.lines-scroll .el-input-number input').first().fill('2')
    await dlg.getByRole('button', { name: '保存出库' }).click()
    await page.waitForURL('**/sales')
    await waitFormGone(page)
    const salePost = state.posts.find(p => p.key === 'sales')
    assert.ok(salePost, '应提交整表 POST /sales（而不是另写一套页面版保存）')
    const saved = (salePost.body.sales || []).find(x => x.customer === '客户甲')
    assert.ok(saved, '保存的单据应带上刚填的客户')
    assert.equal(Number(saved.total), 200, '单价 100 × 数量 2 = 200')
    assert.equal((saved.items || []).length, 1, '明细只有一行商品')
    assert.ok(await page.getByRole('button', { name: '新增销售' }).isVisible(), '存完应回到列表')
  } finally { await context.close() }
})

await t('「返回」退回列表：列表重新可见，地址回到 /sales', async () => {
  const { page, context } = await open('/sales/new', seed())
  try {
    await page.getByRole('button', { name: '返回' }).click()
    await page.waitForURL('**/sales')
    await waitFormGone(page)
    assert.ok(await page.getByRole('button', { name: '新增销售' }).isVisible(), '列表应重新可见')
  } finally { await context.close() }
})

console.log('\n采购单与订单：同一套整页开单')

await t('/purchases/new 整页开单：表单铺满、列表隐藏、出口为「返回」', async () => {
  const { page, context, errors } = await open('/purchases/new', seed())
  try {
    await assertFullscreen(page, '采购整页开单')
    assert.equal(await page.locator('.card-header').count(), 0)
    assert.equal(await page.getByRole('button', { name: '返回' }).count(), 1)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('/orders/new 整页开单：表单铺满，保存仍走 POST /orders 的 save 操作', async () => {
  const state = seed()
  const { page, context, errors } = await open('/orders/new', state)
  try {
    await assertFullscreen(page, '订单整页开单')
    assert.equal(await page.locator('.card-header').count(), 0)
    assert.equal(await page.getByRole('button', { name: '返回' }).count(), 1)
    const dlg = form(page)
    await pickParty(page, dlg, '客户甲')
    await addLine(page, dlg, '弯头')
    await dlg.locator('.lines-scroll .el-input-number input').first().fill('3')
    await page.getByRole('button', { name: '保存订单' }).click()
    await page.waitForURL('**/orders')
    await waitFormGone(page)
    const orderPost = state.posts.find(p => p.key === 'orders')
    assert.ok(orderPost, '订单必须走既有的 orderOperation（POST /orders），不是另写一套')
    assert.equal(orderPost.body.action, 'save')
    // 单头没有 total 字段（订单金额一律由 orderAmount 现算，前后端同一口径）
    assert.equal(orderAmount(orderPost.body.order), 600, '3 件 × 200 单价 = 600')
    assert.equal(orderPost.body.order.items[0].total, 600, '行小计同口径')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('列表页点「新建订单」仍是普通弹窗（不整页），两条入口互不干扰', async () => {
  const { page, context } = await open('/orders', seed())
  try {
    await page.getByRole('button', { name: '新建订单' }).click()
    const dlg = form(page)
    await dlg.waitFor()
    const cls = await dlg.getAttribute('class')
    assert.doesNotMatch(cls || '', /is-fullscreen/, '弹窗模式不应是整页')
    assert.equal(await page.getByRole('button', { name: '取消' }).count(), 1, '弹窗模式仍是「取消」')
  } finally { await context.close() }
})

await browser.close()
console.log(`\n全部 ${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
process.exit(fail ? 1 : 0)
