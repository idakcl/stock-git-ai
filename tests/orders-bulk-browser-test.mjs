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
  id: 'D202610281000000001', status: '未过账', kind: 'sale', customer: '客户甲',
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
    if (body.action === 'postMany' || body.action === 'post') {
      const ids = body.action === 'postMany' ? (body.orderIds || []) : [body.orderId]
      let posted = 0
      state.orders = (state.orders || []).map(o => {
        if (!ids.includes(o.id) || o.status === '已过账') return o
        posted++
        return { ...o, status: '已过账', postedOrderId: `X20261028${String(posted).padStart(8, '0')}` }
      })
      return send({ ok: true, posted, skipped: ids.length - posted, code: `X20261028${String(posted).padStart(8, '0')}` })
    }
    if (body.action === 'save') {
      const id = body.order?.id || 'D202610281000000099'
      return send({ ok: true, code: id })
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

// 只看打印出来的正文：样式块里的注释不算内容泄露
const printBody = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, '')

const fixtures = () => [
  order({ id: 'D202610281000000001', no: 'HT-001', items: [line('P00001', '管件', 2, 10)] }),
  order({ id: 'D202610281000000002', items: [line('P00002', '弯头', 3, 5)] }),
  order({ id: 'D202610281000000003', status: '未过账', deposits: [{ date: '2026-10-28', amount: 5 }] }),
  order({ id: 'D202610281000000004' }),
  order({ id: 'D202610281000000005', status: '已过账', postedOrderId: 'X202610281000000001' })
]

console.log('\n订单列表：默认只看未过账，状态下拉三个选项')

await t('默认不显示已过账订单，下拉选项与文案一致', async () => {
  const { page, context, errors } = await open(seed(fixtures()))
  try {
    assert.equal(await rows(page).count(), 4, '默认只显示 4 张未过账订单')
    assert.equal(await rowOf(page, 'D202610281000000005').count(), 0, '已过账订单默认不出现')
    const tableText = (await page.locator('.el-table').innerText()).replace(/\s+/g, ' ')
    assert.match(tableText, /未过账/, '状态列显示「未过账」')
    assert.doesNotMatch(tableText, /草稿/, '状态列不再出现「草稿」')
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

console.log('\n历史数据：status「草稿」自动迁移为「未过账」')

await t('打开订单页静默提交一次 migrateStatus，状态显示未过账', async () => {
  const state = seed([order({ id: 'D202610281000000009', status: '草稿' })])
  const { page, context, errors } = await open(state)
  try {
    await page.waitForTimeout(600)
    const post = state.posts.find(p => p.action === 'migrateStatus')
    assert.ok(post, '发现历史「草稿」应自动提交一次 migrateStatus')
    assert.equal(await rowOf(page, 'D202610281000000009').count(), 1, '历史订单照常显示')
    const tableText = (await page.locator('.el-table').innerText()).replace(/\s+/g, ' ')
    assert.match(tableText, /未过账/)
    assert.doesNotMatch(tableText, /草稿/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n列表备注')

await t('列表「备注」按钮：弹窗保存只提交 remark，不动其它字段', async () => {
  const state = seed(fixtures())
  const { page, context, errors } = await open(state)
  try {
    await rowOf(page, 'D202610281000000002').getByRole('button', { name: '备注', exact: true }).click()
    const dialog = page.locator('.el-dialog:visible').last()
    await dialog.waitFor()
    await dialog.locator('textarea').fill('月底前交货')
    await dialog.getByRole('button', { name: '保存备注' }).click()
    await page.waitForTimeout(500)
    const post = state.posts.find(p => p.action === 'remark')
    assert.ok(post, '应提交 remark 操作')
    assert.equal(post.orderId, 'D202610281000000002')
    assert.equal(post.remark, '月底前交货')
    assert.deepEqual(Object.keys(post).sort(), ['action', 'orderId', 'remark'], '只提交 remark 三个字段')
    await page.waitForSelector('.el-message--success')
    assert.match(await page.locator('.el-message--success').first().innerText(), /已保存备注/)
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
    await page.getByRole('button', { name: '打印勾选订单列表', exact: true }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /订单列表/)
    assert.match(html, /勾选 2 单/)
    assert.match(html, /D202610281000000001/)
    assert.match(html, /D202610281000000002/)
    assert.doesNotMatch(html, /D202610281000000003/)
    assert.doesNotMatch(html, /X202610281000000001/, '已过账单据不在这批勾选里')
    assert.match(html, /业务单号/)
    // 「订单金额」要在正文里出现，不能只被样式注释满足
    assert.match(printBody(html), /订单金额/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n打印列表：商品多于 3 个时用省略号')

await t('打印订单列表时只保留前 3 个商品名，其余用省略号', async () => {
  const names = ['管件', '弯头', '三通', '阀门']
  const items = names.map((name, i) => line(`P0000${i + 1}`, name, 1, 10))
  const state = seed([order({ id: 'D202610281000000010', items })])
  state.items.push(
    { code: 'P00003', name: '三通', unit: '个', price: 10, cost: 8 },
    { code: 'P00004', name: '阀门', unit: '个', price: 10, cost: 8 }
  )
  const { page, context, errors } = await open(state)
  try {
    await capturePrint(page)
    await checkRow(page, 'D202610281000000010')
    await page.getByRole('button', { name: '打印勾选订单列表', exact: true }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /管件、弯头、三通…/, '前 3 个保留并追加省略号')
    assert.doesNotMatch(html, /阀门/, '第 4 个商品名不再打印')
    assert.match(html, /<th class="idx">序号<\/th>/)
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
    // 副标题只报商品项数，状态不能拼进 <div class="sub">
    assert.equal((html.match(/<div class="sub">共 1 项商品<\/div>/g) || []).length, 2, '两张单副标题都只有项数')
    assert.doesNotMatch(html, /<div class="sub">[^<]*未过账/)
    assert.match(html, /单价/)
    // 这些单没有行折扣，也没有整单折扣：折扣率/折扣金额列与折后金额列都不打印
    assert.doesNotMatch(html, /折扣率/)
    assert.doesNotMatch(html, /折扣金额/)
    assert.doesNotMatch(html, /折后金额/)
    assert.match(html, /本次金额/)
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
    // 第二行只留商品项数：不显示状态，也不显示「金额已隐藏」
    assert.match(html, /<div class="sub">共 1 项商品<\/div>/)
    assert.doesNotMatch(html, /金额已隐藏/)
    // 每张单的明细表都有序号列，从 1 开始
    assert.match(html, /<th class="idx">序号<\/th>/)
    assert.equal((html.match(/<td class="idx">1<\/td>/g) || []).length, 2, '两张单各一行，都从 1 开始编号')
    // 所有金额与内部状态都不能出现：¥ 符号、金额/状态列与字段一个都不留
    // printBody：剥掉 <style> 再看内容。export.js 的样式里有「订单金额」这类说明注释，
    // 泄露检查针对的是印出来的字，不是 CSS 注释。
    const body = printBody(html)
    assert.doesNotMatch(body, /¥/, '不得出现任何金额符号')
    for (const word of ['单价', '折扣率', '折扣金额', '折后金额', '订单金额', '已收订金', '原价合计', '整单折扣', '整单优惠', '未收', '未付', '状态']) {
      assert.doesNotMatch(body, new RegExp(word), `不得出现「${word}」`)
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

console.log('\n过账：单张 / 勾选批量 / 录入页，都要先选结清或挂账')

await t('勾选两张后过账：弹窗二选一，选「结清」发 postMany + settleMode=settle', async () => {
  const { page, context, state, errors } = await open(seed(fixtures()))
  try {
    await checkRow(page, 'D202610281000000001')
    await checkRow(page, 'D202610281000000002')
    const btn = page.getByRole('button', { name: '过账勾选（2）' })
    assert.equal(await btn.isEnabled(), true, '勾了两张未过账单，批量过账可用')
    await btn.click()
    const dlg = page.locator('.el-dialog:visible', { hasText: '选择过账方式' })
    await dlg.waitFor()
    const text = (await dlg.innerText()).replace(/\s+/g, ' ')
    assert.match(text, /待过账 2 张/, '弹窗报待过账张数')
    assert.match(text, /订单金额合计 ¥ 35\.00/, '金额按订单口径汇总（20 + 15）')
    assert.match(text, /过账为结清/, '提供「过账为结清」')
    assert.match(text, /过账为挂账/, '提供「过账为挂账」')
    await dlg.getByRole('button', { name: /过账为结清/ }).click()
    await page.waitForTimeout(700)
    const post = state.posts.find(p => p.action === 'postMany')
    assert.ok(post, '应发 postMany')
    assert.equal(post.settleMode, 'settle')
    assert.deepEqual([...post.orderIds].sort(), ['D202610281000000001', 'D202610281000000002'])
    await page.waitForSelector('.el-message--success')
    assert.match(await page.locator('.el-message--success').first().innerText(), /已过账 2 张订单（结清）/)
    assert.equal(await rows(page).count(), 2, '过账后这两张从「未过账」列表消失')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('行内「过账」也走方式选择：选挂账发 settleMode=credit，不再直接过账', async () => {
  const { page, context, state, errors } = await open(seed(fixtures()))
  try {
    await rowOf(page, 'D202610281000000001').getByRole('button', { name: '过账', exact: true }).click()
    const dlg = page.locator('.el-dialog:visible', { hasText: '选择过账方式' })
    await dlg.waitFor()
    assert.match((await dlg.innerText()).replace(/\s+/g, ' '), /待过账 1 张销售单/)
    assert.equal(state.posts.filter(p => p.action === 'post').length, 0, '弹窗没确认前不发请求')
    await dlg.getByRole('button', { name: /过账为挂账/ }).click()
    await page.waitForTimeout(700)
    const post = state.posts.find(p => p.action === 'post')
    assert.equal(post.orderId, 'D202610281000000001')
    assert.equal(post.settleMode, 'credit')
    assert.match(await page.locator('.el-message--success').first().innerText(), /（挂账）/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('录入页「保存并过账」：先 save 再 post，同一订单号、带过账方式', async () => {
  const { page, context, state, errors } = await open(seed(fixtures()))
  try {
    await page.getByRole('button', { name: '新建订单' }).click()
    const form = page.locator('.el-dialog:visible', { hasText: '新建订单' })
    await form.waitFor()
    await form.locator('.el-form-item', { hasText: '客户' }).locator('.el-select').first().click()
    await page.getByRole('option', { name: /客户甲/ }).first().click()
    // 「快速添加」选商品后回车入表：比逐行点表格里的下拉稳（下拉可能被弹窗遮挡）
    await form.locator('.quick-add-select input').first().click()
    await page.locator('.el-select-dropdown__item', { hasText: '管件' }).first().click()
    await page.waitForTimeout(300)
    assert.equal(await form.locator('.el-table__row').count(), 1, '商品已入明细')
    await form.getByRole('button', { name: '保存并过账' }).click()
    const dlg = page.locator('.el-dialog:visible', { hasText: '选择过账方式' })
    await dlg.waitFor()
    await dlg.getByRole('button', { name: /过账为结清/ }).click()
    await page.waitForTimeout(900)
    const save = state.posts.find(p => p.action === 'save')
    const post = state.posts.find(p => p.action === 'post')
    assert.ok(save, '先保存草稿')
    assert.ok(post, '再按同一个订单号过账')
    assert.equal(post.orderId, 'D202610281000000099', '过账用的是保存返回的订单号')
    assert.equal(post.settleMode, 'settle')
    assert.equal(await page.locator('.el-dialog:visible', { hasText: '新建订单' }).count(), 0, '成功后表单关闭')
    const okMsg = page.locator('.el-message--success', { hasText: '订单已保存并过账' }).first()
    await okMsg.waitFor()
    assert.match(await okMsg.innerText(), /（结清）/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await browser.close()
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
