// 订单模板：保存（需求 5 的线上 bug）+ 订单页「从模板导入」（需求 6）
//
// 需求 5 的两个成因，各自对应一条断言：
//   · TemplateFormDialog 以前 emit 的是 'save'，父组件监听 @saved —— POST 从来没发出去；
//   · /api/templates 返回的是 { templates: [...] } 包裹结构（与 /shares 一致），
//     前端把整个对象丢给 el-table :data，列表永远空白 —— 看着就像「保存不了」。
// 另有一条守住 templateAmount：模板行只有 qty/price/discountRate，没有 total，
// 必须先补出 total 再交给 orderAmount，否则列表金额显示 ¥ 0.00。
//
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/templates-import-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
const { chromium } = createRequire(import.meta.url)('playwright')
// 金额用与服务端同一份口径函数核算，不在测试里另算一套
import { orderAmount } from '../src/utils/orders.js'
import { todayCN } from '../src/utils/time.js'

// 模板：管件 3×100 原价 + 弯头 2×200 打九折 → 300 + 360 = 660
const tplSeed = () => ({
  id: 'T0001', name: '常用管件组合', kind: 'sale',
  createdAt: '2026-10-20T02:00:00.000Z', updatedAt: '2026-10-20T02:00:00.000Z',
  items: [
    { code: 'P00001', name: '管件', unit: '个', qty: 3, price: 100, discountRate: 1 },
    { code: 'P00002', name: '弯头', unit: '个', qty: 2, price: 200, discountRate: 0.9 }
  ]
})

const seed = (over = {}) => ({
  sales: [], purchases: [], orders: [],
  items: [
    { code: 'P00001', name: '管件', unit: '个', price: 100, cost: 50 },
    { code: 'P00002', name: '弯头', unit: '个', price: 200, cost: 100 }
  ],
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  profile: {}, shares: [], templates: [], posts: [], ...over
})

const BASE = 'http://127.0.0.1:5173'
const systemChrome = ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => existsSync(p))
const browser = await chromium.launch(systemChrome ? { headless: true, executablePath: systemChrome } : { headless: true })

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}

async function open(path, state = seed()) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  await context.route('**/api/**', async route => {
    // 必须放行 vite 的 /src/api/*.js 模块：它们也命中这个通配，fulfill 成 JSON 会白屏
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    const key = pathname.slice(5)
    const send = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    if (request.method() === 'GET') {
      if (key === 'session') return send({ ok: true })
      if (key === 'profile') return send(state.profile ?? {})
      if (key === 'shares') return send({ shares: state.shares ?? [] })
      // 模板接口的真实形状：包裹结构，不是裸数组
      if (key === 'templates') return send({ templates: state.templates ?? [] })
      return send(state[key] ?? [])
    }
    let body = null
    try { body = JSON.parse(request.postData() || 'null') } catch { /* 非 JSON 请求体不影响断言 */ }
    state.posts.push({ key, body })
    // 让「保存后列表出现新行」这条断言能成立：把新建的模板塞回假数据库
    if (key === 'templates' && body?.action === 'create') {
      state.templates.unshift({ ...body.template, id: 'T9999', createdAt: new Date().toISOString() })
    }
    return send(key === 'templates' ? { ok: true, template: state.templates[0] } : { ok: true })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  return { page, context, state, errors }
}

const visibleDialog = (page) => page.locator('.el-dialog:visible').last()
const tplDialog = (page) => page.locator('.el-dialog:visible').filter({ hasText: /新建模板|编辑模板/ }).first()

// 拦下打印窗口：拿到那份 HTML 字符串，而不是真去弹系统打印框
const capturePrint = (page) => page.evaluate(() => {
  window.__printed = null
  window.open = () => {
    const doc = { write: html => { window.__printed = html }, close() {} }
    return { document: doc, focus() {}, print() {} }
  }
})
const printed = (page) => page.evaluate(() => window.__printed)

// 模板明细行：列序是 商品(select) / 数量 / 单价 / 折扣
async function setLine(page, index, values) {
  const row = tplDialog(page).locator('.lines-scroll .el-table__row').nth(index)
  const inputs = row.locator('input')
  for (const [pos, text] of Object.entries(values)) {
    await inputs.nth(Number(pos)).fill(text)
  }
  await page.waitForTimeout(150)
}

async function quickAdd(page, name) {
  await tplDialog(page).locator('.quick-add-select input').click()
  await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: name }).first().click()
  await page.waitForTimeout(200)
}

console.log('\n订单模板：列表渲染与保存（需求 5）')

await t('接口给 {templates:[…]}：列表要渲染出行，金额按订单口径＝660（不是 ¥ 0.00）', async () => {
  const { page, context, errors } = await open('/templates', seed({ templates: [tplSeed()] }))
  try {
    const row = page.locator('.el-table__row').filter({ hasText: '常用管件组合' }).first()
    await row.waitFor()
    assert.equal(await page.locator('.el-table__row').count(), 1, '应渲染出 1 行模板')
    assert.match(await row.innerText(), /2/, '商品数列＝2')
    assert.match(await row.innerText(), /¥\s*660\.00/, '金额＝300＋360，模板行没有 total 也要算对')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('新建模板点「保存」→ 发出 POST /templates（action=create，带完整明细）并回到列表', async () => {
  const state = seed()
  const { page, context, errors } = await open('/templates', state)
  try {
    await page.getByRole('button', { name: '新建模板' }).click()
    const dlg = tplDialog(page)
    await dlg.waitFor()
    await dlg.locator('.el-form-item').filter({ hasText: '模板名称' }).locator('input').first().fill('管件标准包')
    await quickAdd(page, '管件')
    await setLine(page, 0, { 1: '3' })
    await dlg.getByRole('button', { name: '保存' }).click()
    const post = state.posts.find(p => p.key === 'templates')
    assert.ok(post, '点保存必须发出 POST /templates（emit 名必须是 saved，否则父组件收不到）')
    assert.equal(post.body.action, 'create')
    assert.equal(post.body.template.name, '管件标准包')
    assert.equal(post.body.template.kind, 'sale')
    assert.equal(post.body.template.items.length, 1)
    assert.equal(post.body.template.items[0].code, 'P00001')
    assert.equal(Number(post.body.template.items[0].qty), 3)
    assert.equal(Number(post.body.template.items[0].price), 100)
    // 弹窗应在保存后关闭，列表里出现刚存的模板
    await dlg.waitFor({ state: 'detached', timeout: 5000 })
    await page.locator('.el-table__row').filter({ hasText: '管件标准包' }).first().waitFor()
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('编辑已有模板保存 → POST action=update 且带上原 id', async () => {
  const state = seed({ templates: [tplSeed()] })
  const { page, context } = await open('/templates', state)
  try {
    const row = page.locator('.el-table__row').filter({ hasText: '常用管件组合' }).first()
    await row.waitFor()
    await row.getByRole('button', { name: '编辑' }).click()
    const dlg = tplDialog(page)
    await dlg.waitFor()
    // 打开时必须回填既有明细：编辑态一开始就该有 2 行
    assert.equal(await dlg.locator('.lines-scroll .el-table__row').count(), 2, '编辑弹窗要带出模板原有 2 行')
    await dlg.locator('.el-form-item').filter({ hasText: '模板名称' }).locator('input').first().fill('常用管件组合 V2')
    await dlg.getByRole('button', { name: '保存' }).click()
    const post = state.posts.find(p => p.key === 'templates')
    assert.ok(post, '编辑保存同样要发出 POST')
    assert.equal(post.body.action, 'update')
    assert.equal(post.body.id, 'T0001', 'update 必须带原模板 id')
    assert.equal(post.body.template.name, '常用管件组合 V2')
  } finally { await context.close() }
})

await t('没填名称就点保存：前端拦下，不发 POST', async () => {
  const state = seed()
  const { page, context } = await open('/templates', state)
  try {
    await page.getByRole('button', { name: '新建模板' }).click()
    const dlg = tplDialog(page)
    await dlg.waitFor()
    await dlg.getByRole('button', { name: '保存' }).click()
    await page.waitForTimeout(300)
    assert.deepEqual(state.posts.filter(p => p.key === 'templates'), [], '校验没过就不该提交')
    assert.equal(await dlg.count(), 1, '校验失败时弹窗不应关闭')
  } finally { await context.close() }
})

console.log('\n模板打印：A4 / A5 / 空表')

await t('打印：A4 landscape，明细带数量单价小计，合计用 xl（正文的 1.2 倍加粗）', async () => {
  const { page, context } = await open('/templates', seed({ templates: [tplSeed()] }))
  try {
    await capturePrint(page)
    await page.locator('.el-table__row').filter({ hasText: '常用管件组合' }).first().getByRole('button', { name: '打印', exact: true }).click()
    const html = await printed(page)
    assert.match(html, /size: A4 landscape/, '默认纸张应是 A4 横向')
    assert.match(html, /订单模板 · 常用管件组合/)
    assert.match(html, /<th[^>]*>数量<\/th>/)
    assert.match(html, /<th[^>]*>小计<\/th>/)
    assert.match(html, /¥ 660\.00/, '合计要按订单口径算出来')
    assert.match(html, /\.fields \.f\.xl \{ font-size: 13\.2px; font-weight: 800/, '合计字号＝正文 1.2 倍并加粗')
  } finally { await context.close() }
})

await t('打印(A5) / 空表(A5)：@page size 换成 A5 landscape', async () => {
  const { page, context } = await open('/templates', seed({ templates: [tplSeed()] }))
  try {
    await capturePrint(page)
    const row = page.locator('.el-table__row').filter({ hasText: '常用管件组合' }).first()
    await row.getByRole('button', { name: '打印(A5)' }).click()
    assert.match(await printed(page), /size: A5 landscape/, 'A5 按钮要打印 A5 版面')
    await row.getByRole('button', { name: '空表(A5)' }).click()
    assert.match(await printed(page), /size: A5 landscape/, '空表也能出 A5')
  } finally { await context.close() }
})

await t('空表：只留编码/商品名称/单位，不出现数量、单价、小计与任何金额', async () => {
  const { page, context } = await open('/templates', seed({ templates: [tplSeed()] }))
  try {
    await capturePrint(page)
    await page.locator('.el-table__row').filter({ hasText: '常用管件组合' }).first().getByRole('button', { name: '空表', exact: true }).click()
    const html = await printed(page)
    assert.match(html, /<th[^>]*>商品名称<\/th>/, '空表仍要列出商品')
    assert.doesNotMatch(html, /<th[^>]*>数量<\/th>/, '空表不该有数量列')
    assert.doesNotMatch(html, /<th[^>]*>单价<\/th>/, '空表不该有单价列')
    assert.doesNotMatch(html, /<th[^>]*>小计<\/th>/, '空表不该有小计列')
    assert.doesNotMatch(html, /(660|200\.00|100\.00)/, '空表里不应出现任何金额')
  } finally { await context.close() }
})

console.log('\n订单页「从模板导入」（需求 6）')

await t('订单页有「从模板导入」按钮，弹窗列出模板与金额', async () => {
  const { page, context, errors } = await open('/orders', seed({ templates: [tplSeed()] }))
  try {
    await page.getByRole('button', { name: '从模板导入' }).click()
    const picker = visibleDialog(page)
    await picker.waitFor()
    const row = picker.locator('.el-table__row').filter({ hasText: '常用管件组合' }).first()
    await row.waitFor()
    assert.match(await row.innerText(), /¥\s*660\.00/, '导入弹窗里的金额与模板页同一口径')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('点「导入」：明细/类型/日期/备注预填进行情表单，金额按订单口径＝660', async () => {
  const { page, context, errors } = await open('/orders', seed({ templates: [tplSeed()] }))
  try {
    await page.getByRole('button', { name: '从模板导入' }).click()
    await visibleDialog(page).locator('.el-table__row').filter({ hasText: '常用管件组合' }).first()
      .getByRole('button', { name: '导入' }).click()
    const dlg = await visibleForm(page)
    assert.equal(await dlg.locator('.lines-scroll .el-table__row').count(), 2, '模板的 2 行都应进表单')
    const text = await dlg.innerText()
    assert.match(text, /管件/)
    assert.match(text, /弯头/)
    assert.match(text, /660\.00/, '合计应按订单口径算出 660')
    // 折扣率原样带过来：弯头 0.9 → 小计 360（不是 400）
    const line2 = dlg.locator('.lines-scroll .el-table__row').nth(1)
    assert.match(await line2.innerText(), /360/, '行折扣 0.9 要跟着模板带进表单')
    assert.equal(await dlg.locator('.el-form-item').filter({ hasText: '备注' }).locator('textarea').inputValue(),
      `来自模板「常用管件组合」`, '备注要标明来源，方便事后核对')
    assert.equal(await dlg.locator('.el-form-item').filter({ hasText: '日期' }).locator('input').inputValue(),
      todayCN(), '日期默认今天')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

// 表单弹窗：从模板导入后打开的是「新建订单」，标题随状态变化，取最后一个可见弹窗即可
async function visibleForm(page) {
  const dlg = page.locator('.el-dialog:visible').last()
  await dlg.waitFor()
  await dlg.locator('.lines-scroll .el-table__row').first().waitFor()
  return dlg
}

await t('导入后补客户再保存：走 POST /orders 的 save（新建、不带 id），金额 660', async () => {
  const state = seed({ templates: [tplSeed()] })
  const { page, context } = await open('/orders', state)
  try {
    await page.getByRole('button', { name: '从模板导入' }).click()
    await visibleDialog(page).locator('.el-table__row').filter({ hasText: '常用管件组合' }).first()
      .getByRole('button', { name: '导入' }).click()
    const dlg = await visibleForm(page)
    // 客户是模板不存的信息，必须仍由用户现场填
    await dlg.locator('.el-form-item').filter({ hasText: '客户' }).locator('.el-select input').first().click()
    await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: '客户甲' }).first().click()
    await page.waitForTimeout(150)
    await dlg.getByRole('button', { name: '保存订单' }).click()
    await page.waitForTimeout(400)
    const post = state.posts.find(p => p.key === 'orders')
    assert.ok(post, '导入的订单保存仍走既有 orderOperation（POST /orders），不是另写一套')
    assert.equal(post.body.action, 'save')
    assert.ok(!post.body.order.id, '从模板导入是新建订单，不能带 id 覆盖已有单据')
    assert.equal(post.body.order.customer, '客户甲')
    assert.equal(post.body.order.kind, 'sale')
    assert.equal(post.body.order.items.length, 2)
    assert.equal(orderAmount(post.body.order), 660, '订单金额必须与模板页、导入弹窗一致')
  } finally { await context.close() }
})

await browser.close()
console.log(`\n全部 ${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
process.exit(fail ? 1 : 0)
