// 销售单 / 采购单详情：整单折扣醒目、明细「折后金额（含整单折扣）」列、无行折扣时隐藏折扣列。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/detail-discount-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'

const line = (code, name, qty, price, discountRate = 1) => ({
  code, name, qty, price, discountRate,
  discount: Math.round(qty * price * (1 - discountRate) * 100) / 100,
  total: Math.round(qty * price * discountRate * 100) / 100
})

const saleOrder = (over = {}) => ({
  id: 'X202610281000000001', customer: '客户甲', date: '2026-10-28',
  total: 23, discount: 0, discountRates: [0.95], payments: [],
  items: [line('P00001', '管件', 2, 10, 0.9), line('P00002', '弯头', 1, 5)],
  ...over
})

const purchaseOrder = (over = {}) => ({
  id: 'C202610281000000001', supplier: '供应商甲', date: '2026-10-28',
  total: 23, discount: 0, discountRates: [0.95], payments: [],
  items: [line('P00001', '管件', 2, 10, 0.9), line('P00002', '弯头', 1, 5)],
  ...over
})

const seed = ({ sales = [], purchases = [] }) => ({
  sales,
  purchases,
  items: [
    { code: 'P00001', name: '管件', unit: '个', price: 12, cost: 8, suppliers: ['S00001'] },
    { code: 'P00002', name: '弯头', unit: '个', price: 6, cost: 4, suppliers: ['S00001'] }
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

async function open(path, state) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  await context.route('**/api/**', async route => {
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

const headers = async (page) => (await page.locator('.el-table').first().locator('.el-table__header th').allInnerTexts()).join('|')
const capturePrint = (page) => page.evaluate(() => {
  window.__printed = null
  window.open = () => {
    const doc = { write: html => { window.__printed = html }, close() {} }
    return { document: doc, focus() {}, print() {} }
  }
})
const printed = async (page) => {
  await page.getByRole('button', { name: '打印(A4)' }).click()
  await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
  return page.evaluate(() => window.__printed)
}
const captureBlob = (page) => page.evaluate(() => {
  window.__csv = null
  const orig = URL.createObjectURL
  URL.createObjectURL = (blob) => { blob.text().then(txt => { window.__csv = txt }); return orig.call(URL, blob) }
})

console.log('\n销售单详情：整单折扣醒目 + 明细折后金额')

await t('有行折扣与整单折扣：页面多一列「折后金额（含整单折扣）」，打印/CSV 同步', async () => {
  const { page, context, errors } = await open('/sale/X202610281000000001', seed({ sales: [saleOrder()] }))
  try {
    const head = await headers(page)
    assert.match(head, /本次折扣/)
    assert.match(head, /折后金额（含整单折扣）/)
    const row = (await page.locator('.el-table').first().locator('.el-table__row').first().innerText()).replace(/\s+/g, ' ')
    assert.match(row, /17\.10/)
    // 单头折扣用醒目样式包裹
    assert.match((await page.locator('.order-discount').innerText()).replace(/\s+/g, ' '), /整单折扣：×0\.95（减 ¥1\.15）/)

    await capturePrint(page)
    const html = await printed(page)
    assert.match(html, /<div class="f hl"><b>整单折扣：<\/b>/)
    assert.match(html, /整单折扣：<\/b>×0\.95（减 ¥1\.15）/)
    assert.match(html, /<th>本次折扣<\/th>/)
    assert.match(html, /<th>折后金额（含整单折扣）<\/th>/)
    assert.match(html, /17\.10/)
    assert.match(html, /4\.75/)

    await captureBlob(page)
    await page.getByRole('button', { name: '导出CSV' }).click()
    await page.waitForFunction(() => !!window.__csv, null, { timeout: 5000 })
    const csv = (await page.evaluate(() => window.__csv)).replace(/^\uFEFF/, '')
    assert.match(csv, /本次单价,本次折扣,本次金额,折后单价（含整单折扣）,折后金额（含整单折扣）/)
    assert.match(csv, /18\.00,8\.55,17\.10/)
    assert.match(csv, /5\.00,4\.75/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('没有行折扣：页面与打印都隐藏「本次折扣」，但保留折后金额列', async () => {
  const noLine = saleOrder({
    items: [line('P00001', '管件', 2, 10), line('P00002', '弯头', 1, 5)],
    total: 25, discountRates: [0.9]
  })
  const { page, context, errors } = await open('/sale/X202610281000000001', seed({ sales: [noLine] }))
  try {
    const head = await headers(page)
    assert.doesNotMatch(head, /本次折扣/)
    assert.match(head, /折后金额（含整单折扣）/)
    const row = (await page.locator('.el-table').first().locator('.el-table__row').first().innerText()).replace(/\s+/g, ' ')
    assert.match(row, /18\.00/)

    await capturePrint(page)
    const html = await printed(page)
    assert.doesNotMatch(html, /本次折扣/)
    assert.doesNotMatch(html, /<th>折扣率<\/th>/)
    assert.match(html, /<th>折后金额（含整单折扣）<\/th>/)
    assert.match(html, /18\.00/)
    assert.match(html, /4\.50/)

    // 隐藏单价与金额：新列与折扣列一起消失，不泄露金额
    await page.getByText('隐藏单价与金额', { exact: true }).click()
    await page.waitForTimeout(200)
    await capturePrint(page)
    const masked = await printed(page)
    assert.doesNotMatch(masked, /折后金额/)
    assert.doesNotMatch(masked, /本次折扣/)
    assert.doesNotMatch(masked, /本次金额/)
    assert.match(masked, /本次数量/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n采购单详情同步')

await t('采购单：整单折扣高亮、折后金额列与打印一致', async () => {
  const { page, context, errors } = await open('/purchase/C202610281000000001', seed({ purchases: [purchaseOrder()] }))
  try {
    const head = await headers(page)
    assert.match(head, /本次折扣/)
    assert.match(head, /折后金额（含整单折扣）/)
    const row = (await page.locator('.el-table').first().locator('.el-table__row').first().innerText()).replace(/\s+/g, ' ')
    assert.match(row, /17\.10/)
    assert.match((await page.locator('.order-discount').innerText()).replace(/\s+/g, ' '), /整单折扣：×0\.95（减 ¥1\.15）/)

    await capturePrint(page)
    const html = await printed(page)
    assert.match(html, /采购单 C202610281000000001/)
    assert.match(html, /<div class="f hl"><b>整单折扣：<\/b>/)
    assert.match(html, /<th>折后金额（含整单折扣）<\/th>/)
    assert.match(html, /17\.10/)
    assert.match(html, /4\.75/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await browser.close()
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
