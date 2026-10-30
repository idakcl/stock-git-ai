// 打印版面（A4 / A5）实测：
//   1. 订单金额字号 = 正文的 1.2 倍并加粗（以前固定 24px，是正文的 2 倍，太大）；
//   2. 明细表按「每页 40 行」（A5 每页 28 行）分片，切片数 = PDF 真实页数；
//   3. 跨页表头真的重复：销售单 / 采购单 / 订单详情，每一页都有「序号 + 列名」那一行。
//      —— 靠的是「每片表各自带 <thead>」这个物理结构，不再只看 table-header-group 那条声明。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/print-layout-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import cp from 'node:child_process'
const { chromium } = createRequire(import.meta.url)('playwright')
// 纯函数直接 import：版面参数（字号、每页行数、分片算法）不依赖浏览器，能在 node 里算清楚
import { buildPrintHtml, pageCapacities, paperSpec, PAPER_SPECS } from '../src/utils/export.js'

const line = (code, name, qty, price, discountRate = 1) => ({
  code, name, qty, price, discountRate,
  discount: Math.round(qty * price * (1 - discountRate) * 100) / 100,
  total: Math.round(qty * price * discountRate * 100) / 100
})

const SALE_ID = 'X202610301100000001'
const PURCHASE_ID = 'C202610301100000001'
const ORDER_ID = 'D202610301100000001'

// 140 行明细：A4 下应该切成 34 + 40 + 40 + 26 = 4 片 → PDF 必须正好 4 页
const manyLines = (n) => Array.from({ length: n }, (_, i) => line('P00001', `商品${i + 1}`, 1, 10))
const saleDoc = (n) => ({
  id: SALE_ID, customer: '客户甲', date: '2026-10-30',
  total: n * 10, discount: 0, discountRates: [], payments: [], items: manyLines(n)
})
const purchaseDoc = (n) => ({
  id: PURCHASE_ID, supplier: '供应商甲', date: '2026-10-30',
  total: n * 10, discount: 0, discountRates: [], payments: [], items: manyLines(n)
})
const orderDoc = (n) => ({
  id: ORDER_ID, no: 'HT-100', kind: 'sale', status: '未过账', customer: '客户甲', date: '2026-10-30',
  total: n * 10, discount: 0, discountRates: [], deposits: [], items: manyLines(n)
})

const seed = (over = {}) => ({
  sales: [], purchases: [], orders: [],
  items: [{ code: 'P00001', name: '管件', unit: '个', price: 12, cost: 8 }],
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  profile: {}, shares: [], templates: [], ...over
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

// 拦下打印窗口：拿到那份 HTML 字符串，而不是真去弹系统打印框
const capturePrint = (page) => page.evaluate(() => {
  window.__printed = null
  window.open = () => {
    const doc = { write: html => { window.__printed = html }, close() {} }
    return { document: doc, focus() {}, print() {} }
  }
})
const printed = async (page, trigger) => {
  await trigger.click()
  await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
  return page.evaluate(() => window.__printed)
}

// 用真实 Chromium 打印引擎把 HTML 排成 PDF：preferCSSPageSize 才会吃 @page 里的 A4/A5 landscape，
// 与用户点「打印」时打印预览用的是同一套分页
async function toPdfPages(html, file) {
  const probe = await browser.newPage()
  await probe.setContent(html)
  const pdf = await probe.pdf({ printBackground: true, preferCSSPageSize: true })
  await probe.close()
  await fs.writeFile(file, pdf)
  const info = cp.execSync(`pdfinfo ${file}`).toString()
  const pages = Number(/Pages:\s+(\d+)/.exec(info)[1])
  const size = (/Page size:\s+(.+)/.exec(info) || [])[1] || ''
  // 横竖与纸张由 pdfinfo 的「宽 x 高 (标签)」判断，不写死小数：Chromium 的输出会随版本四舍五入
  const [w, h] = (size.match(/([\d.]+)\s*x\s*([\d.]+)/) || []).slice(1).map(Number)
  const textOf = (i) => cp.execSync(`pdftotext -f ${i} -l ${i} ${file} -`).toString()
  return { pages, size, landscape: w > h, textOf }
}

console.log('\n版面参数：字号比例与每页行数')

await t('A4 正文基准字号 11px，订单金额＝1.2 倍（13.2px）且加粗', () => {
  const html = buildPrintHtml({
    title: '销售单 X1', columns: [{ label: '名称', prop: 'name' }], rows: [{ name: '管件' }],
    headerFields: [['订单金额', '¥ 1,234.00', 'xl']]
  })
  assert.match(html, /body \{[^}]*font-size: 11px/, '正文基准应为 11px')
  assert.match(html, /\.fields \.f\.xl \{ font-size: 13\.2px; font-weight: 800/, '金额应为正文 1.2 倍并加粗')
  assert.doesNotMatch(html, /font-size: 24px/, '24px（2 倍）必须已经取消')
  // 比例必须由 base 推导，不能各处硬写：A4 = 11 × 1.2
  const p = paperSpec('A4')
  assert.equal(Number((p.base * 1.2).toFixed(2)), 13.2)
})

await t('A5 版面另有一套参数（148mm 宽的纸，字号与每页行数都更小）', () => {
  const html = buildPrintHtml({
    title: '销售单 X1', columns: [{ label: '名称', prop: 'name' }], rows: [{ name: '管件' }],
    headerFields: [['订单金额', '¥ 1.00', 'xl']], paper: 'A5'
  })
  assert.match(html, /@page \{ size: A5 landscape/, 'A5 应输出 A5 landscape')
  assert.match(html, /body \{[^}]*font-size: 9\.5px/)
  assert.match(html, /\.fields \.f\.xl \{ font-size: 11\.4px/, 'A5 上金额仍是正文 1.2 倍')
})

await t('每页行数：A4 = 40 行、A5 = 28 行', () => {
  assert.equal(PAPER_SPECS.A4.rowsPerPage, 40)
  assert.equal(PAPER_SPECS.A5.rowsPerPage, 28)
})

await t('分片算法：首页扣单头预留、末页扣落款预留，总行数不丢', () => {
  // 140 行 A4（无落款）：34 + 40 + 40 + 26
  assert.deepEqual(pageCapacities(140, 40, 6, 0), [34, 40, 40, 26])
  // 带落款时末页上限降到 38：这批末页只有 26 行，本来就没装满，落款直接跟在后面
  assert.deepEqual(pageCapacities(140, 40, 6, 2), [34, 40, 40, 26])
  // 反过来，末页装满 40 行时必须给落款腾位置，多出的行另起一页
  assert.deepEqual(pageCapacities(74, 40, 6, 2), [34, 38, 2])
  // 恰好一页、不足一页、空明细都不能丢行或报错
  assert.deepEqual(pageCapacities(34, 40, 6, 0), [34])
  assert.deepEqual(pageCapacities(3, 40, 6, 0), [3])
  assert.deepEqual(pageCapacities(0, 40, 6, 0), [0])
  for (const n of [1, 33, 34, 35, 73, 74, 200]) {
    const caps = pageCapacities(n, 40, 6, 2)
    assert.equal(caps.reduce((s, v) => s + v, 0), n, `${n} 行分片后总行数必须相等`)
    assert.ok(caps.every(v => v > 0), '每页至少一行，不能出现空片')
    assert.ok(caps[0] <= 40 - 6, '首页要给单头信息留位')
    assert.ok(caps[caps.length - 1] <= 40 - 2, '末页要给落款留位')
  }
})

await t('分片后每片都自带表头，序号跨片接续', () => {
  const columns = [{ label: '商品名称', prop: 'name' }, { label: '数量', prop: 'qty' }]
  const rows = manyLines(90).map(l => ({ name: l.name, qty: l.qty }))
  const html = buildPrintHtml({ title: '销售单 X1', columns, rows, paper: 'A4' })
  const tables = html.match(/<table class="pg/g) || []
  assert.equal(tables.length, 3, '90 行 A4 应切成 3 片')
  assert.equal((html.match(/<thead>/g) || []).length, 3, '每片都必须有自己的表头')
  // 序号不能每页从 1 重来
  assert.match(html, /<td class="idx">35<\/td>/)
  assert.match(html, /<td class="idx">90<\/td>/)
})

console.log('\n真机打印（Chromium 分页引擎）：每片＝一张纸，每页都有表头')

const docCases = [
  { name: '销售单', path: `/sale/${SALE_ID}`, state: () => seed({ sales: [saleDoc(140)] }), button: '打印(A4)' },
  { name: '采购单', path: `/purchase/${PURCHASE_ID}`, state: () => seed({ purchases: [purchaseDoc(140)] }), button: '打印(A4)' },
  { name: '订单', path: `/order/${ORDER_ID}`, state: () => seed({ orders: [orderDoc(140)] }), button: '打印(A4)' }
]

for (const c of docCases) {
  await t(`${c.name}：140 行明细 → PDF 页数＝分片数，且每页都有「序号」表头行`, async () => {
    const { page, context, errors } = await open(c.path, c.state())
    try {
      await capturePrint(page)
      const html = await printed(page, page.getByRole('button', { name: c.button }))
      const chunks = (html.match(/<table class="pg/g) || []).length
      assert.ok(chunks >= 4, `140 行应至少切成 4 片，实际 ${chunks}`)
      const file = `/tmp/print-layout-${c.name}.pdf`
      const { pages, size, landscape, textOf } = await toPdfPages(html, file)
      assert.match(size, /A4/, `应为 A4 纸，实际 ${size}`)
      assert.ok(landscape, `A4 应为横向，实际 ${size}`)
      assert.equal(pages, chunks, `PDF 页数必须等于分片数（每片恰好一页）：分片 ${chunks}，实际 ${pages}`)
      for (let i = 1; i <= pages; i++) {
        assert.match(textOf(i), /序号/, `第 ${i} 页缺商品表头`)
      }
      // 每页起始序号必须等于分片预算：这一条就是「A4 一页 40 行」的真机凭证
      const caps = pageCapacities(140, 40, 6, 0)
      let start = 1
      for (let i = 1; i <= pages; i++) {
        const after = textOf(i).split('序号')[1] || ''
        const first = Number((/(\d+)/.exec(after) || [])[1])
        assert.equal(first, start, `第 ${i} 页应从序号 ${start} 起（每片 ${caps[i - 1]} 行）`)
        start += caps[i - 1]
      }
      assert.equal(start - 1, 140, '分片预算必须正好覆盖全部 140 行')
      // 首末页内容核对：首页有单头；末页末尾是第 140 行（序号连着上一页，不从 1 重来）
      assert.match(textOf(1), /客户|供应商|订单号|日期/, '首页应带单头信息')
      assert.match(textOf(pages), /140/, '末页应有最后一行（序号 140）')
      assert.deepEqual(errors, [], '页面不得报错')
    } finally { await context.close() }
  })
}

await t('销售单：打印(A5) 按钮走 A5 版面，页数与分片数一致且每页带表头', async () => {
  const { page, context } = await open(`/sale/${SALE_ID}`, seed({ sales: [saleDoc(140)] }))
  try {
    await capturePrint(page)
    const html = await printed(page, page.getByRole('button', { name: '打印(A5)' }))
    assert.match(html, /@page \{ size: A5 landscape/, 'A5 按钮必须打 A5 纸')
    const chunks = (html.match(/<table class="pg/g) || []).length
    // A5 每页 28 行（首页 22）→ 140 行切 6 片：22+28+28+28+28+6
    assert.deepEqual(pageCapacities(140, 28, 6, 0), [22, 28, 28, 28, 28, 6])
    assert.equal(chunks, 6)
    const { pages, size, landscape, textOf } = await toPdfPages(html, '/tmp/print-layout-a5.pdf')
    assert.match(size, /A5/, `应为 A5 纸，实际 ${size}`)
    assert.ok(landscape, `A5 应为横向，实际 ${size}`)
    assert.equal(pages, chunks, `A5 下 PDF 页数必须等于分片数：分片 ${chunks}，实际 ${pages}`)
    for (let i = 1; i <= pages; i++) assert.match(textOf(i), /序号/, `A5 第 ${i} 页缺商品表头`)
  } finally { await context.close() }
})

await t('订单列表页：每行都有「打印(A5)」入口', async () => {
  const { page, context } = await open('/orders', seed({ orders: [orderDoc(2)] }))
  try {
    const row = page.locator('.el-table__row', { hasText: ORDER_ID }).first()
    await row.waitFor({ timeout: 5000 })
    await expectAllVisible(row, ['打印', '打印(A5)'])
  } finally { await context.close() }
})

await t('订单列表页：批量打印详情页可选 A5', async () => {
  const { page, context } = await open('/orders', seed({ orders: [orderDoc(2)] }))
  try {
    const row = page.locator('.el-table__row', { hasText: ORDER_ID }).first()
    await row.waitFor({ timeout: 5000 })
    await row.locator('.el-table-column--selection .el-checkbox').click()
    await page.getByRole('button', { name: '打印勾选订单详情页' }).click()
    const dialog = page.locator('.el-dialog', { hasText: '打印勾选订单详情页' })
    await dialog.waitFor({ state: 'visible' })
    await dialog.locator('.el-radio-button__inner', { hasText: 'A5' }).click()
    await capturePrint(page)
    await dialog.getByRole('button', { name: '直接打印' }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /@page \{ size: A5 landscape/, '选了 A5 就必须按 A5 排')
  } finally { await context.close() }
})

await t('订单列表页：单行打印(A5) 出的确实是 A5 版面', async () => {
  const { page, context } = await open('/orders', seed({ orders: [orderDoc(2)] }))
  try {
    const row = page.locator('.el-table__row', { hasText: ORDER_ID }).first()
    await row.waitFor({ timeout: 5000 })
    await capturePrint(page)
    const html = await printed(page, row.getByRole('button', { name: '打印(A5)' }))
    assert.match(html, /@page \{ size: A5 landscape/)
    assert.match(html, /font-size: 9\.5px/)
  } finally { await context.close() }
})

await t('列表类打印（TableToolbar）也提供 A5 入口', async () => {
  const { page, context } = await open('/items', seed())
  try {
    const btn = page.getByRole('button', { name: '打印(A5)' })
    await btn.waitFor({ timeout: 5000 })
    assert.ok(await btn.isVisible(), '商品列表应有「打印(A5)」按钮')
    await capturePrint(page)
    const html = await printed(page, btn)
    assert.match(html, /@page \{ size: A5 landscape/)
  } finally { await context.close() }
})

// 「打印订单金额的字体」这条改的是 tone='xl'，销售/采购/订单三个详情页都吃同一份样式，
// 这里挑订单详情核对：金额行必须存在且带 xl 类
await t('订单详情打印：订单金额用 xl（1.2 倍）而不是 24px', async () => {
  const { page, context } = await open(`/order/${ORDER_ID}`, seed({ orders: [orderDoc(2)] }))
  try {
    await capturePrint(page)
    const html = await printed(page, page.getByRole('button', { name: '打印(A4)' }))
    assert.match(html, /class="f xl"><b>订单金额：/, '订单金额应带 xl 样式')
    assert.match(html, /\.fields \.f\.xl \{ font-size: 13\.2px/, 'xl 应为正文 1.2 倍')
  } finally { await context.close() }
})

async function expectAllVisible(locator, names) {
  for (const n of names) {
    assert.ok(await locator.getByRole('button', { name: n }).first().isVisible(), `缺少按钮「${n}」`)
  }
}

await browser.close()
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
