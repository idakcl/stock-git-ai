// 折后单价（含整单折扣）：销售单 / 采购单 / 订单详情页的列 + 单张打印 + CSV 全部同步；
// 以及打印跨页时商品表头必须重复（thead display: table-header-group）。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/unit-net-discount-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'

const line = (code, name, qty, price, discountRate = 1) => ({
  code, name, qty, price, discountRate,
  discount: Math.round(qty * price * (1 - discountRate) * 100) / 100,
  total: Math.round(qty * price * discountRate * 100) / 100
})

const SALE_ID = 'X202610301000000001'
const PURCHASE_ID = 'C202610301000000001'
const ORDER_ID = 'D202610301000000001'

const baseLines = () => [line('P00001', '管件', 2, 10, 0.9), line('P00002', '弯头', 1, 5)]
const saleDoc = () => ({
  id: SALE_ID, customer: '客户甲', date: '2026-10-30',
  total: 23, discount: 0, discountRates: [0.95], payments: [], items: baseLines()
})
const purchaseDoc = () => ({
  id: PURCHASE_ID, supplier: '供应商甲', date: '2026-10-30',
  total: 23, discount: 0, discountRates: [0.95], payments: [], items: baseLines()
})
// 订单行没有 discount 字段，只有 qty/price/discountRate；金额按订单口径现场算
const orderDoc = () => ({
  id: ORDER_ID, no: 'HT-001', kind: 'sale', status: '未过账', customer: '客户甲', date: '2026-10-30',
  total: 23, discount: 0, discountRates: [0.95], deposits: [], items: baseLines()
})

const seed = (over = {}) => ({
  sales: [], purchases: [], orders: [],
  items: [
    { code: 'P00001', name: '管件', unit: '个', price: 12, cost: 8 },
    { code: 'P00002', name: '弯头', unit: '个', price: 6, cost: 4 }
  ],
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  profile: {}, shares: [], ...over
})

const BASE = 'http://127.0.0.1:5173'
const systemChrome = ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => existsSync(p))
const browser = await chromium.launch(systemChrome ? { headless: true, executablePath: systemChrome } : { headless: true })
let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}

async function open(path, state = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  await context.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    // 必须放行 vite 的 /src/api/*.js 模块，否则会被 fulfill 成 JSON 导致白屏
    if (!pathname.startsWith('/api/')) return route.continue()
    const send = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    if (request.method() === 'GET') {
      if (pathname === '/api/session') return send({ ok: true })
      if (pathname === '/api/profile') return send(state.profile ?? {})
      if (pathname === '/api/shares') return send({ shares: state.shares ?? [] })
      if (pathname === '/api/templates') return send({ templates: state.templates ?? [] })
      return send(state[pathname.slice(5)] ?? [])
    }
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
const printed = async (page, trigger = null) => {
  await (trigger || page.getByRole('button', { name: '打印(A4)' })).click()
  await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
  return page.evaluate(() => window.__printed)
}
const captureBlob = (page) => page.evaluate(() => {
  window.__csv = null
  const orig = URL.createObjectURL
  URL.createObjectURL = (blob) => { blob.text().then(txt => { window.__csv = txt }); return orig.call(URL, blob) }
})
const csv = async (page) => {
  await captureBlob(page)
  await page.getByRole('button', { name: '导出CSV' }).click()
  await page.waitForFunction(() => !!window.__csv, null, { timeout: 5000 })
  return (await page.evaluate(() => window.__csv)).replace(/^\uFEFF/, '')
}
const headers = async (page) => (await page.locator('.el-table').first().locator('.el-table__header th').allInnerTexts()).join('|')
const firstRow = async (page) => (await page.locator('.el-table').first().locator('.el-table__row').first().innerText()).replace(/\s+/g, ' ')

// 管件 2×10×0.9=18、弯头 5；整单 ×0.95 → 累计取整行金额 17.10 / 4.75，单价 8.55 / 4.75
const NET_A = '17.10', NET_B = '4.75', UNIT_A = '8.55'

console.log('\n折后单价（含整单折扣）：销售单 / 采购单 / 订单')

await t('销售单详情：页面出现折后单价列，单价×数量乘得回行金额', async () => {
  const { page, context, errors } = await open(`/sale/${SALE_ID}`, seed({ sales: [saleDoc()] }))
  try {
    const head = await headers(page)
    assert.match(head, /折后单价（含整单折扣）/)
    assert.match(head, /折后金额（含整单折扣）/)
    // 列顺序：折后单价在折后金额左边
    assert.ok(head.indexOf('折后单价') < head.indexOf('折后金额'), '单价列在金额列之前')
    const row = await firstRow(page)
    assert.match(row, new RegExp(UNIT_A))
    assert.match(row, new RegExp(NET_A))
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('销售单：打印与 CSV 都带折后单价，行金额合计仍＝单头折后金额', async () => {
  const { page, context } = await open(`/sale/${SALE_ID}`, seed({ sales: [saleDoc()] }))
  try {
    await capturePrint(page)
    const html = await printed(page)
    assert.match(html, /<th>折后单价（含整单折扣）<\/th>/)
    assert.match(html, /<th>折后金额（含整单折扣）<\/th>/)
    // 表头顺序：折后单价在折后金额之前
    assert.ok(html.indexOf('折后单价（含整单折扣）') < html.indexOf('折后金额（含整单折扣）'))
    assert.match(html, new RegExp(UNIT_A))
    // 两行折后金额合计 = 21.85 = 23×0.95（口径不能被单价列带偏）
    assert.match(html, /21\.85/)

    const c = await csv(page)
    assert.match(c, /本次金额,折后单价（含整单折扣）,折后金额（含整单折扣）/)
    assert.match(c, new RegExp(`18\\.00,${UNIT_A.replace('.', '\\.')},${NET_A.replace('.', '\\.')}`))
    assert.deepEqual((c.match(/4\.75/g) || []).length >= 2, true, '弯头行金额与单价同为 4.75')
  } finally { await context.close() }
})

await t('销售单：隐藏单价与金额时折后单价一并消失（对外不泄露）', async () => {
  const { page, context } = await open(`/sale/${SALE_ID}`, seed({ sales: [saleDoc()] }))
  try {
    await page.getByText('隐藏单价与金额', { exact: true }).click()
    await page.waitForTimeout(200)
    assert.doesNotMatch(await headers(page), /折后单价/)
    await capturePrint(page)
    const html = await printed(page)
    assert.doesNotMatch(html, /折后单价/)
    assert.doesNotMatch(html, /折后金额/)
    assert.doesNotMatch(html, new RegExp(UNIT_A))
  } finally { await context.close() }
})

await t('采购单详情：折后单价列与打印同步', async () => {
  const { page, context, errors } = await open(`/purchase/${PURCHASE_ID}`, seed({ purchases: [purchaseDoc()] }))
  try {
    const head = await headers(page)
    assert.match(head, /折后单价（含整单折扣）/)
    assert.match(await firstRow(page), new RegExp(UNIT_A))
    await capturePrint(page)
    const html = await printed(page)
    assert.match(html, /<th>折后单价（含整单折扣）<\/th>/)
    assert.match(html, new RegExp(UNIT_A))
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('订单详情：折后单价列与打印 / CSV 同步（订单口径现算）', async () => {
  const { page, context, errors } = await open(`/order/${ORDER_ID}`, seed({ orders: [orderDoc()] }))
  try {
    const head = await headers(page)
    assert.match(head, /折后单价（含整单折扣）/)
    assert.match(await firstRow(page), new RegExp(UNIT_A))
    await capturePrint(page)
    const html = await printed(page)
    assert.match(html, /<th>折后单价（含整单折扣）<\/th>/)
    assert.match(html, new RegExp(UNIT_A))
    const c = await csv(page)
    assert.match(c, /折后单价（含整单折扣）/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('订单列表：单张打印与批量详情页都带折后单价', async () => {
  const { page, context, errors } = await open('/orders', seed({ orders: [orderDoc()] }))
  try {
    const row = page.locator('.el-table__row', { hasText: ORDER_ID }).first()
    await row.waitFor({ timeout: 5000 })
    await capturePrint(page)
    const html = await printed(page, row.getByRole('button', { name: '打印', exact: true }))
    assert.match(html, /<th>折后单价（含整单折扣）<\/th>/)
    assert.match(html, new RegExp(UNIT_A))
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n打印跨页：商品表头每页重复')

await t('打印样式声明 thead=table-header-group（跨页重复商品表头）', async () => {
  const { page, context } = await open(`/sale/${SALE_ID}`, seed({ sales: [saleDoc()] }))
  try {
    await capturePrint(page)
    const html = await printed(page)
    assert.match(html, /thead \{ display: table-header-group/, '必须有 thead 重复规则')
    assert.match(html, /<thead><tr>/, '表头必须在 thead 里，浏览器才会跨页重复')
    assert.match(html, /tfoot \{ display: table-footer-group/)
  } finally { await context.close() }
})

await t('80 行明细打印：表头在 thead、合计不混进表头（跨页时每页都带列名）', async () => {
  const many = {
    ...saleDoc(),
    total: 800, discountRates: [0.9],
    items: Array.from({ length: 80 }, (_, i) => line('P00001', `商品${i + 1}`, 1, 10))
  }
  const { page, context } = await open(`/sale/${SALE_ID}`, seed({ sales: [many] }))
  try {
    await capturePrint(page)
    const html = await printed(page)
    // 只有一处 thead，且包含全部列名：Chrome 打印时会自动在每页顶部重复
    const thead = /<thead>([\s\S]*?)<\/thead>/.exec(html)[1]
    assert.match(thead, /本次单价/)
    assert.match(thead, /本次金额/)
    assert.equal((html.match(/<thead>/g) || []).length, 1)
    assert.match(html, /<tbody>[\s\S]*80[\s\S]*<\/tbody>/)
  } finally { await context.close() }
})

await t('真·PDF：140 行明细跨多页，每页都带商品表头（Chromium 打印引擎实测）', async () => {
  const many = {
    ...saleDoc(), total: 1400, discountRates: [], payments: [],
    items: Array.from({ length: 140 }, (_, i) => ({ code: 'P00001', name: `商品${i + 1}`, qty: 1, price: 10, discountRate: 1, discount: 0, total: 10 }))
  }
  const { page, context } = await open(`/sale/${SALE_ID}`, seed({ sales: [many] }))
  try {
    await capturePrint(page)
    const html = await printed(page)
    assert.equal((html.match(/<thead>/g) || []).length, 1, '打印 HTML 只有一处表头')
    // 用真实 Chromium 打印引擎渲染该 HTML 成 PDF，再逐页取文本核对表头每页都在
    const probe = await browser.newPage()
    await probe.setContent(html)
    const pdf = await probe.pdf({ printBackground: true })
    await probe.close()
    const fs = await import('node:fs')
    const cp = await import('node:child_process')
    fs.writeFileSync('/tmp/unitnet.pdf', pdf)
    const info = cp.execSync('pdfinfo /tmp/unitnet.pdf').toString()
    const pages = Number(/Pages:\s+(\d+)/.exec(info)[1])
    assert.ok(pages >= 2, `140 行应跨多页，实际 ${pages} 页`)
    for (let i = 1; i <= pages; i++) {
      const one = cp.execSync(`pdftotext -f ${i} -l ${i} /tmp/unitnet.pdf -`).toString()
      assert.match(one, /本次单价/, `第 ${i} 页应重复商品表头`)
    }
  } finally { await context.close() }
})

await browser.close()
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
