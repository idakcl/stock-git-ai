// 列表打印的商品列截断（真浏览器）：销售单 / 采购单 / 订单列表打印时，
// 商品名称或编码超过 3 个只留前 3 个并补「…」；CSV 导出仍保留完整清单。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），
//      再 node tests/list-print-truncate-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'

const BASE = 'http://127.0.0.1:5173'
const CODES = ['P00001', 'P00002', 'P00003', 'P00004', 'P00005']
const NAMES = ['管件', '弯头', '三通', '阀门', '法兰']
const line = (i) => ({ code: CODES[i], name: NAMES[i], unit: '个', qty: 1, price: 10, total: 10 })
const items = CODES.map((code, i) => ({ code, name: NAMES[i], unit: '个', price: 10, cost: 8 }))

const seedSales = () => ({
  items,
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  sales: [{ id: 'X202610281000000001', date: '2026-10-28', customer: '客户甲', no: '', total: 50, discount: 0, payments: [], items: CODES.map((_, i) => line(i)) }],
  purchases: []
})
const seedPurchases = () => ({
  items,
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  sales: [],
  purchases: [{ id: 'C202610281000000001', date: '2026-10-28', supplier: '供应商甲', no: '', total: 50, discount: 0, paid: 0, payments: [], items: CODES.map((_, i) => line(i)) }]
})
const seedOrders = () => ({
  items,
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  orders: [{ id: 'D202610281000000001', status: '未过账', kind: 'sale', customer: '客户甲', date: '2026-10-28', no: '', remark: '', items: CODES.map((_, i) => line(i)), deposits: [] }]
})

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

const capturePrint = (page) => page.evaluate(() => {
  window.__printed = null
  window.open = () => {
    const doc = { write: html => { window.__printed = html }, close() {} }
    return { document: doc, focus() {}, print() {} }
  }
})
const captureBlob = (page) => page.evaluate(() => {
  window.__csv = null
  const orig = URL.createObjectURL
  URL.createObjectURL = (blob) => { blob.text().then(txt => { window.__csv = txt }); return orig.call(URL, blob) }
})

async function printAndCsv(page) {
  await capturePrint(page)
  await page.getByRole('button', { name: '打印' }).click()
  await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
  const html = await page.evaluate(() => window.__printed)
  await captureBlob(page)
  await page.getByRole('button', { name: '导出CSV' }).click()
  await page.waitForFunction(() => !!window.__csv, null, { timeout: 5000 })
  const csv = (await page.evaluate(() => window.__csv)).replace(/^\uFEFF/, '')
  return { html, csv }
}

console.log('\n销售单列表打印：商品编码超过 3 个截断')

await t('打印只留前 3 个编码 + 省略号，CSV 仍是完整 5 个', async () => {
  const { page, context, errors } = await open('/sales', seedSales())
  try {
    const { html, csv } = await printAndCsv(page)
    assert.match(html, /销售单/)
    assert.match(html, /P00001、P00002、P00003…/)
    assert.doesNotMatch(html, /P00004/)
    assert.match(csv, /P00001、P00002、P00003、P00004、P00005/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n采购单列表打印：商品编码超过 3 个截断')

await t('打印只留前 3 个编码 + 省略号，CSV 仍是完整 5 个', async () => {
  const { page, context, errors } = await open('/purchases', seedPurchases())
  try {
    const { html, csv } = await printAndCsv(page)
    assert.match(html, /采购单/)
    assert.match(html, /P00001、P00002、P00003…/)
    assert.doesNotMatch(html, /P00004/)
    assert.match(csv, /P00001、P00002、P00003、P00004、P00005/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n订单列表打印：商品名称超过 3 个截断')

await t('勾选后打印只留前 3 个名称 + 省略号', async () => {
  const { page, context, errors } = await open('/orders', seedOrders())
  try {
    await page.locator('.el-table__row', { hasText: 'D202610281000000001' }).first().locator('.el-checkbox__inner').click()
    await capturePrint(page)
    await page.getByRole('button', { name: '打印勾选订单列表', exact: true }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /管件、弯头、三通…/)
    assert.doesNotMatch(html, /阀门/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await browser.close()
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
