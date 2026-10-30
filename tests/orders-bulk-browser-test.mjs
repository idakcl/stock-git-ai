// 订单列表批量操作（真浏览器）：
//  ① 默认只显示未过账订单，状态下拉三个选项；
//  ② 勾选后打印列表（只打勾选的）；
//  ③ 打印勾选订单详情页：直接打印 / 隐藏金额打印（金额信息必须全部消失）；
//  ④ 勾选批量删除：一次请求 deleteMany，删掉多张。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/orders-bulk-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'

const line = (code, name, qty, price) => ({
  code, name, qty, price, discountRate: 1, discount: 0, total: Math.round(qty * price * 100) / 100
})

const order = (over = {}) => ({
  id: 'D202610281000000001', status: '草稿', kind: 'sale', customer: '客户甲',
  date: '2026-10-28', no: '', remark: '',
  items: [line('P00001', '管件', 2, 10)],
  deposits: [], ...over
})

const seed = (orders) => ({
  posts: [],
  orders: orders.map((o, i) => ({ ...o, createdAt: `2026-10-28T10:00:0${i}.000Z` })),
  items: [
    { code: 'P00001', name: '管件', unit: '个', price: 10, cost: 8 },
    { code: 'P00002', name: '弯头', unit: '个', price: 5, cost: 4 }
  ],
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }]
})

const BASE = 'http://127.0.0.1:5173'
const systemChrome = ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => existsSync(p))
const browser = await chromium.launch(systemChrome ? { headless: true, executablePath: systemChrome } : { headless: true })
let pass = 0, fail = 0

const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}

async function open(state) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  await context.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    const key = pathname.slice(5)
    const send = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    if (request.method() === 'GET') return send(key === 'session' ? { ok: true } : (state[key] ?? []))
    const body = JSON.parse(request.postData() || '{}')
    state.posts.push(body)
    if (body.action === 'deleteMany') {
      const drop = new Set(body.orderIds || [])
      const removed = state.orders.filter(o => drop.has(o.id)).length
      state.orders = state.orders.filter(o => !drop.has(o.id))
      return send({ ok: true, removed, skipped: (body.orderIds || []).length - removed })
    }
    return send({ ok: true })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${BASE}/orders`, { waitUntil: 'networkidle' })
  return { page, context, state, errors }
}

const rows = (page) => page.locator('.el-table__body .el-table__row')
const rowOf = (page, id) => page.locator('.el-table__row', { hasText: id }).first()
const checkRow = async (page, id) => { await rowOf(page, id).locator('.el-checkbox__inner').click() }

const capturePrint = (page) => page.evaluate(() => {
  window.__printed = null
  window.open = () => {
    const doc = { write: html => { window.__printed = html }, close() {} }
    return { document: doc, focus() {}, print() {} }
  }
})

const fixtures = () => [
  order({ id: 'D202610281000000001', no: 'HT-001', items: [line('P00001', '管件', 2, 10)] }),
  order({ id: 'D202610281000000002', items: [line('P00002', '弯头', 3, 5)] }),
  order({ id: 'D202610281000000003', status: '草稿', deposits: [{ date: '2026-10-28', amount: 5 }] }),
  order({ id: 'D202610281000000004' }),
  order({ id: 'D202610281000000005', status: '已过账', postedOrderId: 'X202610281000000001' })
]

console.log('\n订单列表：默认只看未过账，状态下拉三个选项')

await t('默认不显示已过账订单，下拉选项与文案一致', async () => {
  const { page, context, errors } = await open(seed(fixtures()))
  try {
    assert.equal(await rows(page).count(), 4, '默认只显示 4 张未过账订单')
    assert.equal(await rowOf(page, 'D202610281000000005').count(), 0, '已过账订单默认不出现')
    await page.locator('.filter-row .el-select').first().click()
    const options = (await page.locator('.el-select-dropdown__item').allTextContents()).map(s => s.trim())
    assert.deepEqual(options, ['显示全部订单', '仅显示未过账订单', '仅显示已过账订单'])
    await page.getByRole('option', { name: '仅显示已过账订单' }).click()
    await page.waitForTimeout(200)
    assert.equal(await rows(page).count(), 1, '只看已过账时只剩 1 张')
    assert.equal(await rowOf(page, 'D202610281000000005').count(), 1)
    await page.locator('.filter-row .el-select').first().click()
    await page.getByRole('option', { name: '显示全部订单' }).click()
    await page.waitForTimeout(200)
    assert.equal(await rows(page).count(), 5, '全部订单 5 张')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n勾选后打印订单列表')

await t('只打印勾选的订单，未勾选的不出现', async () => {
  const { page, context, errors } = await open(seed(fixtures()))
  try {
    await capturePrint(page)
    await checkRow(page, 'D202610281000000001')
    await checkRow(page, 'D202610281000000002')
    assert.match(await page.locator('.sel-hint').innerText(), /已勾选 2 单/)
    await page.getByRole('button', { name: '打印勾选订单列表' }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /订单列表/)
    assert.match(html, /勾选 2 单/)
    assert.match(html, /D202610281000000001/)
    assert.match(html, /D202610281000000002/)
    assert.doesNotMatch(html, /D202610281000000003/)
    assert.doesNotMatch(html, /X202610281000000001/, '已过账单据不在这批勾选里')
    assert.match(html, /业务单号/)
    assert.match(html, /订单金额/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n打印勾选订单详情页：直接打印 / 隐藏金额')

await t('直接打印：每张订单一页，金额与单价都在', async () => {
  const { page, context, errors } = await open(seed(fixtures()))
  try {
    await capturePrint(page)
    await checkRow(page, 'D202610281000000001')
    await checkRow(page, 'D202610281000000002')
    await page.getByRole('button', { name: '打印勾选订单详情页' }).click()
    await page.getByRole('button', { name: '直接打印' }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /销售订单 D202610281000000001/)
    assert.match(html, /销售订单 D202610281000000002/)
    assert.equal((html.match(/class="doc brk"/g) || []).length, 1, '两张单之间分页')
    assert.match(html, /单价/)
    assert.match(html, /折扣率/)
    assert.match(html, /订单金额：<\/b>¥20\.00/)
    assert.match(html, /¥/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('隐藏金额打印：单价、折扣、合计、订金、未收全部消失', async () => {
  const { page, context, errors } = await open(seed(fixtures()))
  try {
    await capturePrint(page)
    await checkRow(page, 'D202610281000000001')
    await checkRow(page, 'D202610281000000002')
    await page.getByRole('button', { name: '打印勾选订单详情页' }).click()
    await page.getByRole('button', { name: '隐藏金额打印' }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    // 仍保留：单号、业务单号、客户、日期、商品、数量
    assert.match(html, /D202610281000000001/)
    assert.match(html, /业务单号：<\/b>HT-001/)
    assert.match(html, /客户：<\/b>客户甲/)
    assert.match(html, /管件/)
    assert.match(html, /数量/)
    assert.match(html, /共 1 项商品 · 草稿 · 金额已隐藏/)
    // 所有金额信息都不能出现：¥ 符号、金额列与金额字段一个都不留
    assert.doesNotMatch(html, /¥/, '不得出现任何金额符号')
    for (const word of ['单价', '折扣率', '折扣金额', '折后金额', '订单金额', '已收订金', '原价合计', '整单折扣', '整单优惠', '未收', '未付']) {
      assert.doesNotMatch(html, new RegExp(word), `不得出现「${word}」`)
    }
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n勾选批量删除')

await t('一次请求 deleteMany 删除多张，列表随即少掉这些单', async () => {
  const { page, context, state, errors } = await open(seed(fixtures()))
  try {
    await checkRow(page, 'D202610281000000001')
    await checkRow(page, 'D202610281000000002')
    await page.getByRole('button', { name: '删除勾选（2）' }).click()
    await page.getByRole('button', { name: '删除 2 张' }).click()
    await page.waitForTimeout(600)
    const post = state.posts.find(p => p.action === 'deleteMany')
    assert.ok(post, '应发出 deleteMany 请求')
    assert.deepEqual([...post.orderIds].sort(), ['D202610281000000001', 'D202610281000000002'])
    await page.waitForTimeout(300)
    assert.equal(await rows(page).count(), 2, '4 张未过账删掉 2 张')
    assert.equal(await rowOf(page, 'D202610281000000001').count(), 0)
    assert.equal(await rowOf(page, 'D202610281000000003').count(), 1)
    await page.waitForSelector('.el-message--success')
    assert.match(await page.locator('.el-message--success').first().innerText(), /已删除 2 张订单/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await browser.close()
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
