// 订单详情页（真浏览器）：勾选项是否真的改变页面 / 打印 / 导出，而不是只改个开关。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/order-detail-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'

const line = (code, name, qty, price, discountRate = 1) => ({
  code, name, qty, price, discountRate,
  discount: Math.round(qty * price * (1 - discountRate) * 100) / 100,
  total: Math.round(qty * price * discountRate * 100) / 100
})

const saleOrder = {
  id: 'D202610281000000001', status: '未过账', kind: 'sale', customer: '客户甲', supplier: '',
  date: '2026-10-28', no: 'HT-2026-001', remark: '月底交货',
  items: [line('P00001', '管件', 2, 10, 0.9), line('P00002', '弯头', 1, 5)],
  discountRates: [0.95], discount: 1,
  deposits: [{ date: '2026-10-28', amount: 5, remark: '微信定金', voucher: 'SK-20261028-0001', time: '2026-10-28T10:00:00.000Z' }],
  photos: []
}

const purchaseOrder = {
  ...saleOrder,
  id: 'D202610281100000002', kind: 'purchase', customer: '', supplier: '供应商甲',
  no: 'PO-2026-009', deposits: []
}

const seed = (orders = [saleOrder]) => ({
  orders,
  items: [
    { code: 'P00001', name: '管件', unit: '个', price: 12, cost: 8, package: '20 个/箱', priceWholesale: 11, priceInstaller: 10, remark: '常用件', photos: ['https://example.invalid/p1.png'] },
    { code: 'P00002', name: '弯头', unit: '个', price: 6, cost: 4 }
  ],
  customers: [{ code: 'C00001', name: '客户甲', contact: '张三', phone: '13800000000', address: '城南路 1 号' }],
  suppliers: [{ code: 'S00001', name: '供应商甲', contact: '李四', phone: '13900000000', address: '城北路 2 号' }],
  'purchase-history': {
    P00001: [{ date: '2026-09-01', id: 'C202609010900000001', supplierName: '供应商甲', qty: 10, price: 8, total: 80 }]
  },
  'sale-history': {
    P00001: [{ date: '2026-09-02', id: 'X202609020900000001', customer: '客户甲', qty: 1, price: 12, total: 12 }]
  }
})

const BASE = 'http://127.0.0.1:5173'
const systemChrome = ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => existsSync(p))
const browser = await chromium.launch(systemChrome ? { headless: true, executablePath: systemChrome } : { headless: true })
let pass = 0, fail = 0

const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}

async function open(orderId, state = seed()) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  await context.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    const key = pathname.slice(5)
    const send = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    if (request.method() === 'GET') return send(key === 'session' ? { ok: true } : (state[key] ?? []))
    state.posts = state.posts || []
    state.posts.push(JSON.parse(request.postData() || '{}'))
    return send({ ok: true })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${BASE}/order/${orderId}`, { waitUntil: 'networkidle' })
  return { page, context, state, errors }
}

const headers = async (page) => (await page.locator('.el-table').first().locator('.el-table__header th').allInnerTexts()).join('|')

const captureBlob = (page) => page.evaluate(() => {
  window.__csv = null
  const orig = URL.createObjectURL
  URL.createObjectURL = (blob) => { blob.text().then(txt => { window.__csv = txt }); return orig.call(URL, blob) }
})

const capturePrint = (page) => page.evaluate(() => {
  window.__printed = null
  window.open = () => {
    const doc = { write: html => { window.__printed = html }, close() {} }
    return { document: doc, focus() {}, print() {} }
  }
})

console.log('\n订单详情：基础信息与价格开关')

await t('默认只看本次数据：不显示档案售价/进价，金额与订金齐全', async () => {
  const { page, context, errors } = await open(saleOrder.id)
  try {
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    assert.match(body, /销售订单：D202610281000000001/)
    assert.match(body, /业务单号：HT-2026-001/)
    assert.match(body, /客户：\s*客户甲/)
    assert.match(body, /订单金额：¥ 20\.85/)
    assert.match(body, /已收订金：¥ 5\.00（1 笔）/)
    assert.match(body, /未收：¥ 15\.85/)
    const head = await headers(page)
    assert.match(head, /本次单价/)
    assert.match(head, /本次金额/)
    assert.doesNotMatch(head, /售价/)
    assert.doesNotMatch(head, /进价/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('勾「显示售价 / 显示进价」后出现档案价列（与本次单价区分）', async () => {
  const { page, context } = await open(saleOrder.id)
  try {
    await page.getByText('显示售价', { exact: true }).click()
    await page.getByText('显示进价', { exact: true }).click()
    await page.waitForTimeout(200)
    const head = await headers(page)
    assert.match(head, /售价/)
    assert.match(head, /进价/)
    const row = (await page.locator('.el-table').first().locator('.el-table__row').first().innerText()).replace(/\s+/g, ' ')
    // 供应商列之后依次是：进价 8、售价 12、本次数量 2、本次单价 10、折扣 -2.00、本次金额 18
    assert.match(row, /— 8 12 2 10 -2\.00 18/)
  } finally { await context.close() }
})

await t('隐藏单价与金额：价格列与金额信息一起消失，数量保留', async () => {
  const { page, context } = await open(saleOrder.id)
  try {
    await page.getByText('隐藏单价与金额', { exact: true }).click()
    await page.waitForTimeout(200)
    const head = await headers(page)
    assert.doesNotMatch(head, /本次单价/)
    assert.doesNotMatch(head, /本次折扣/)
    assert.doesNotMatch(head, /本次金额/)
    assert.match(head, /本次数量/)
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    assert.match(body, /（价格与金额已隐藏）/)
    assert.doesNotMatch(body, /订单金额：¥ 20\.85/)
    // 订金卡片金额也隐藏，但笔数仍可见
    assert.match(body, /订金记录（1 笔 · 金额已隐藏）/)
  } finally { await context.close() }
})

console.log('\n订单详情：对外查看与供应商信息')

await t('对外查看：只读 + 隐藏价格，编辑按钮消失、导出打印仍可用', async () => {
  const { page, context } = await open(saleOrder.id)
  try {
    await page.getByText('对外查看（隐藏价格·只读）', { exact: true }).click()
    await page.waitForTimeout(200)
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    assert.match(body, /对外查看模式：价格与金额已隐藏，页面只读/)
    assert.equal(await page.getByRole('button', { name: '编辑', exact: true }).count(), 0, '只读模式不能有编辑按钮')
    assert.equal(await page.getByText('隐藏单价与金额', { exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: '导出CSV' }).count(), 1)
    assert.equal(await page.getByRole('button', { name: '打印(A4)' }).count(), 1)
    assert.match(await headers(page), /本次数量/)
    assert.doesNotMatch(await headers(page), /本次单价/)
  } finally { await context.close() }
})

await t('采购订单勾「显示供应商信息详情」：页面显示联系人/电话/地址', async () => {
  const { page, context, errors } = await open(purchaseOrder.id, seed([purchaseOrder]))
  try {
    await page.getByText('显示供应商信息详情', { exact: true }).click()
    await page.waitForTimeout(200)
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    assert.match(body, /供应商：\s*供应商甲/)
    assert.match(body, /联系人：李四/)
    assert.match(body, /电话：13900000000/)
    assert.match(body, /地址：城北路 2 号/)
    await capturePrint(page)
    await page.getByRole('button', { name: '打印(A4)' }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /供应商：<\/b>供应商甲/)
    assert.match(html, /联系人：<\/b>李四/)
    assert.match(html, /采购订单 D202610281100000002/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n订单详情：历史价 / 商品档案')

await t('展开历史价与商品档案：出现历史采购价、历史销售价与商品照片', async () => {
  const { page, context, errors } = await open(saleOrder.id)
  try {
    await page.getByText('展开历史价与商品档案', { exact: true }).click()
    await page.waitForTimeout(200)
    await page.locator('.el-table').first().locator('.el-table__expand-icon').first().click()
    await page.waitForFunction(() => document.body.innerText.includes('历史采购价'), null, { timeout: 5000 })
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    assert.match(body, /历史采购价/)
    assert.match(body, /C202609010900000001/)
    assert.match(body, /历史销售价/)
    assert.match(body, /X202609020900000001/)
    assert.match(body, /规格\/包装：20 个\/箱/)
    assert.match(body, /商品照片/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n订单详情：打印 / CSV 跟随开关')

await t('正常模式打印：单头 + 业务单号 + 折扣链 + 明细与合计', async () => {
  const { page, context } = await open(saleOrder.id)
  try {
    await capturePrint(page)
    await page.getByRole('button', { name: '打印(A4)' }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /销售订单 D202610281000000001/)
    assert.match(html, /业务单号：<\/b>HT-2026-001/)
    assert.match(html, /原价合计：<\/b>¥25\.00（单项折扣 -¥2\.00）/)
    assert.match(html, /整单折扣：<\/b>×0\.95（减 ¥1\.15）/)
    assert.match(html, /订单金额：<\/b>¥20\.85/)
    assert.match(html, /已收订金：<\/b>¥5\.00/)
    assert.match(html, /未收：<\/b>¥15\.85/)
    assert.match(html, /本次单价/)
    assert.match(html, /本次金额/)
    // 明细最前面是序号列：1、2 顺排
    assert.match(html, /<th class="idx">序号<\/th>/)
    assert.match(html, /<td class="idx">1<\/td>/)
    assert.match(html, /<td class="idx">2<\/td>/)
  } finally { await context.close() }
})

await t('隐藏价格后打印/CSV：只留商品与数量，不泄露单价金额', async () => {
  const { page, context } = await open(saleOrder.id)
  try {
    await page.getByText('隐藏单价与金额', { exact: true }).click()
    await page.waitForTimeout(200)
    await capturePrint(page)
    await page.getByRole('button', { name: '打印(A4)' }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /本次数量/)
    assert.doesNotMatch(html, /本次单价/)
    assert.doesNotMatch(html, /订单金额/)
    assert.doesNotMatch(html, /已收订金/)
    // 对外打印不显示内部状态，第二行只留商品项数
    assert.match(html, /<div class="sub">共 2 项商品<\/div>/)
    assert.doesNotMatch(html, /状态/)
    assert.doesNotMatch(html, /金额已隐藏/)
    assert.match(html, /<th class="idx">序号<\/th>/)

    await captureBlob(page)
    await page.getByRole('button', { name: '导出CSV' }).click()
    await page.waitForFunction(() => !!window.__csv, null, { timeout: 5000 })
    const csv = (await page.evaluate(() => window.__csv)).replace(/^\uFEFF/, '')
    assert.match(csv, /编码,名称,单位,本次数量/)
    assert.doesNotMatch(csv, /本次单价/)
    assert.doesNotMatch(csv, /订单金额/)
    assert.match(csv, /P00001,管件,个,2/)
  } finally { await context.close() }
})

await t('正常模式 CSV：档案价按开关出现，单头含业务单号与订金', async () => {
  const { page, context } = await open(saleOrder.id)
  try {
    await page.getByText('显示售价', { exact: true }).click()
    await page.getByText('显示进价', { exact: true }).click()
    await page.waitForTimeout(200)
    await captureBlob(page)
    await page.getByRole('button', { name: '导出CSV' }).click()
    await page.waitForFunction(() => !!window.__csv, null, { timeout: 5000 })
    const csv = (await page.evaluate(() => window.__csv)).replace(/^\uFEFF/, '')
    assert.match(csv, /业务单号,HT-2026-001/)
    assert.match(csv, /订单金额,¥20\.85/)
    assert.match(csv, /已收订金,¥5\.00/)
    assert.match(csv, /编码,名称,单位,进价,售价,本次数量,本次单价,折扣率,本次折扣,本次金额/)
    assert.match(csv, /P00001,管件,个,8\.00,12\.00,2,10\.00,0\.90,2\.00,18\.00/)
  } finally { await context.close() }
})

console.log('\n订单详情：备注')

await t('备注框 + 添加备注按钮：保存只提交 remark，单号/金额不动', async () => {
  const state = seed()
  const { page, context, errors } = await open(saleOrder.id, state)
  try {
    assert.match((await page.locator('.remark-cell').innerText()).replace(/\s+/g, ' '), /备注：\s*月底交货/)
    await page.getByRole('button', { name: '编辑备注' }).click()
    const dialog = page.locator('.el-dialog:visible').last()
    await dialog.waitFor()
    await dialog.locator('textarea').fill('发票待补，尾款下周付')
    await dialog.getByRole('button', { name: '保存备注' }).click()
    await page.waitForTimeout(500)
    const post = state.posts.find(p => p.action === 'remark')
    assert.ok(post, '应提交 remark 操作')
    assert.equal(post.orderId, saleOrder.id)
    assert.equal(post.remark, '发票待补，尾款下周付')
    assert.deepEqual(Object.keys(post).sort(), ['action', 'orderId', 'remark'])
    await page.waitForSelector('.el-message--success')
    assert.match(await page.locator('.el-message--success').first().innerText(), /已保存备注/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await browser.close()
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
