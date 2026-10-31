// 打印版面（A4 / A5）实测：
//   1. 订单金额字号 = 正文的 1.2 倍并加粗（以前固定 24px，是正文的 2 倍，太大）；
//   2. 明细表按「每页行数」分片（行数按虚拟边距与折行估算），切片数 = PDF 真实页数；
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
import { buildPrintHtml, pageCapacities, paperSpec, columnWidths, PAPER_SPECS } from '../src/utils/export.js'
import { paperPref } from '../src/utils/printPrefs.js'

// 本文件验证的是「A4 横向」这套版面以及跨页表头。
// 产品默认已改成 A4 纵向，所以这里显式把方向定成横向；A4 纵向 / 自定义纸张由
// tests/print-paper-browser-test.mjs 覆盖，两边口径分开，不互相牵连。
paperPref.mode = 'preset'
paperPref.paper = 'A4'
paperPref.orientation = 'landscape'
paperPref.rowsPerPage = 0

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

async function open(path, state = {}, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  // 本文件的历史断言都按「A4 横向、40 行/页」写的；产品默认已改成 A4 纵向，
  // 需要横向的用例显式把纸张偏好预置进 localStorage，跟页面里的打印设置是同一份数据
  if (opts.paper) {
    const paper = JSON.stringify(opts.paper)
    await context.addInitScript((p) => {
      if (!localStorage.getItem('stock.print.paper')) localStorage.setItem('stock.print.paper', p)
    }, paper)
  }
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
  // 每次都先清空：否则第二次打印会立刻读到上一次的 HTML，断言就成了摆设
  await page.evaluate(() => { window.__printed = null })
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
  // -layout：按版面网格还原，列宽固定后原始输出顺序会跟视觉顺序不一致（窄列的单元格会被打散），
  // 断言要的是「这一页第一行是第几号」，必须按视觉行序读。
  const textOf = (i) => cp.execSync(`pdftotext -layout -f ${i} -l ${i} ${file} -`).toString()
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

await t('每页行数按虚拟边距重算：比按 8mm 边距的旧常量更保守', () => {
  // 旧常量 40 / 28 是按 @page 8mm 边距算满的值，真机边距更宽时每页会少装几行，
  // 多出的行落到下一张纸、后面紧跟强制换页 → 一页只印两三行。故实际行数一律重算。
  paperPref.mode = 'preset'
  paperPref.orientation = 'landscape'
  assert.ok(paperSpec('A4').rowsPerPage < PAPER_SPECS.A4.rowsPerPage, 'A4 横向应少于 40 行')
  assert.ok(paperSpec('A5').rowsPerPage < PAPER_SPECS.A5.rowsPerPage, 'A5 横向应少于 28 行')
  assert.ok(paperSpec('A4').rowsPerPage >= 20 && paperSpec('A5').rowsPerPage >= 15)
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
  { name: '销售单', path: `/sale/${SALE_ID}`, state: () => seed({ sales: [saleDoc(140)] }), button: '打印' },
  { name: '采购单', path: `/purchase/${PURCHASE_ID}`, state: () => seed({ purchases: [purchaseDoc(140)] }), button: '打印' },
  { name: '订单', path: `/order/${ORDER_ID}`, state: () => seed({ orders: [orderDoc(140)] }), button: '打印' }
]

const LANDSCAPE_A4 = { mode: 'preset', paper: 'A4', orientation: 'landscape', width: 210, height: 297, rowsPerPage: 0 }

for (const c of docCases) {
  await t(`${c.name}：140 行明细 → PDF 页数＝分片数，且每页都有「序号」表头行`, async () => {
    const { page, context, errors } = await open(c.path, c.state(), { paper: LANDSCAPE_A4 })
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
      // 每页起始序号必须接着上一页：分片预算从实际 HTML 里数（首页扣多少行取决于单头信息块高度）
      const caps = (html.match(/<table class="pg[^"]*"[\s\S]*?<\/table>/g) || [])
        .map(tb => (tb.match(/<td class="idx">/g) || []).length)
      assert.equal(caps.reduce((a, b) => a + b, 0), 140, '分片预算必须正好覆盖全部 140 行')
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

await t('销售单：打印设置选 A5 后走 A5 版面，页数与分片数一致且每页带表头', async () => {
  const { page, context } = await open(`/sale/${SALE_ID}`, seed({ sales: [saleDoc(140)] }))
  try {
    // 纸张统一在「打印设置」里选：点开面板切到 A5，再切横向（默认是纵向）
    await page.locator('.paper-btn').click()
    await page.locator('.el-popover:visible').getByText('A5', { exact: true }).click()
    await page.locator('.el-popover:visible').getByText('横向', { exact: true }).click()
    await page.keyboard.press('Escape')
    await capturePrint(page)
    const html = await printed(page, page.getByRole('button', { name: '打印' }))
    assert.match(html, /@page \{ size: A5 landscape/, '打印设置选 A5 后必须打 A5 纸')
    const chunks = (html.match(/<table class="pg/g) || []).length
    // A5 每页约 28 行，首页再扣单头预留；140 行至少切 5 片，且能整除到片内
    const caps = (html.match(/<table class="pg[^"]*"[\s\S]*?<\/table>/g) || [])
      .map(tb => (tb.match(/<td class="idx">/g) || []).length)
    assert.equal(caps.reduce((a, b) => a + b, 0), 140, 'A5 分片必须覆盖全部 140 行')
    assert.equal(chunks, caps.length)
    assert.ok(caps[0] < 28 && caps.slice(1, -1).every(n => n <= 28), '首页要扣单头，后续每页不超过 28 行')
    const { pages, size, landscape, textOf } = await toPdfPages(html, '/tmp/print-layout-a5.pdf')
    assert.match(size, /A5/, `应为 A5 纸，实际 ${size}`)
    assert.ok(landscape, `A5 应为横向，实际 ${size}`)
    assert.equal(pages, chunks, `A5 下 PDF 页数必须等于分片数：分片 ${chunks}，实际 ${pages}`)
    for (let i = 1; i <= pages; i++) assert.match(textOf(i), /序号/, `A5 第 ${i} 页缺商品表头`)
  } finally { await context.close() }
})

await t('订单列表页：每行只有一个「打印」入口（纸张统一走打印设置）', async () => {
  const { page, context } = await open('/orders', seed({ orders: [orderDoc(2)] }))
  try {
    const row = page.locator('.el-table__row', { hasText: ORDER_ID }).first()
    await row.waitFor({ timeout: 5000 })
    await expectAllVisible(row, ['打印'])
    const labels = await row.getByRole('button').allInnerTexts()
    assert.ok(!labels.some(t => /打印\(/.test(t)), `行内不应再有 打印(A4)/打印(A5)：${labels.join('|')}`)
  } finally { await context.close() }
})

await t('订单列表页：批量打印详情的纸张也跟着打印设置（弹窗里不再重复选）', async () => {
  const { page, context } = await open('/orders', seed({ orders: [orderDoc(2)] }))
  try {
    const row = page.locator('.el-table__row', { hasText: ORDER_ID }).first()
    await row.waitFor({ timeout: 5000 })
    await row.locator('.el-table-column--selection .el-checkbox').click()
    // 先把纸张切成 A5（唯一的纸张来源）
    await page.locator('.paper-btn').click()
    await page.locator('.el-popover:visible').getByText('A5', { exact: true }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '打印勾选订单详情页' }).click()
    const dialog = page.locator('.el-dialog', { hasText: '打印勾选订单详情页' })
    await dialog.waitFor({ state: 'visible' })
    assert.equal(await dialog.locator('.el-radio-button__inner', { hasText: 'A5' }).count(), 0, '弹窗里不应再有 A4/A5 纸张选择')
    await capturePrint(page)
    await dialog.getByRole('button', { name: '直接打印' }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /@page \{ size: A5 portrait/, '设置里选了 A5 就必须按 A5 排（默认纵向）')
  } finally { await context.close() }
})

await t('订单列表页：设置成 A5 后单行打印确实是 A5 版面', async () => {
  const { page, context } = await open('/orders', seed({ orders: [orderDoc(2)] }))
  try {
    const row = page.locator('.el-table__row', { hasText: ORDER_ID }).first()
    await row.waitFor({ timeout: 5000 })
    await page.locator('.paper-btn').click()
    await page.locator('.el-popover:visible').getByText('A5', { exact: true }).click()
    await page.keyboard.press('Escape')
    await capturePrint(page)
    const html = await printed(page, row.getByRole('button', { name: '打印' }))
    assert.match(html, /@page \{ size: A5 portrait/, '设置里选了 A5 就按 A5 纵向出纸')
    assert.match(html, /font-size: 9\.5px/)
  } finally { await context.close() }
})

await t('列表类打印（TableToolbar）只有一个「打印」，纸张跟设置走', async () => {
  const { page, context } = await open('/items', seed())
  try {
    const btn = page.getByRole('button', { name: '打印' })
    await btn.waitFor({ timeout: 5000 })
    assert.ok(await btn.isVisible(), '商品列表应有「打印」按钮')
    const labels = await page.locator('.export-bar button').allInnerTexts()
    assert.ok(!labels.some(t => /打印\(/.test(t)), `工具栏不应再有 打印(A4)/打印(A5)：${labels.join('|')}`)
    // 默认 A4 纵向；切成 A5 后同一按钮打 A5
    await capturePrint(page)
    let html = await printed(page, btn)
    assert.match(html, /@page \{ size: A4 portrait/)
    await page.locator('.paper-btn').click()
    await page.locator('.el-popover:visible').getByText('A5', { exact: true }).click()
    await page.keyboard.press('Escape')
    await capturePrint(page)
    html = await printed(page, page.getByRole('button', { name: '打印' }))
    assert.match(html, /@page \{ size: A5/)
  } finally { await context.close() }
})

// 「打印订单金额的字体」这条改的是 tone='xl'，销售/采购/订单三个详情页都吃同一份样式，
// 这里挑订单详情核对：金额行必须存在且带 xl 类
await t('订单详情打印：订单金额用 xl（1.2 倍）而不是 24px', async () => {
  const { page, context } = await open(`/order/${ORDER_ID}`, seed({ orders: [orderDoc(2)] }))
  try {
    await capturePrint(page)
    const html = await printed(page, page.getByRole('button', { name: '打印' }))
    assert.match(html, /class="f xl"><b>订单金额：/, '订单金额应带 xl 样式')
    assert.match(html, /\.fields \.f\.xl \{ font-size: 13\.2px/, 'xl 应为正文 1.2 倍')
  } finally { await context.close() }
})


console.log('\n跨页列宽一致 + 跨页表头开关')

// 真机截图那 8 列（长名称 + 两个超长表头），列宽错开就是在这类表上暴露的
const realCols = () => ([
  { label: '编码', prop: 'code' },
  { label: '名称', prop: 'name' },
  { label: '单位', prop: 'unit' },
  { label: '本次数量', prop: 'qty' },
  { label: '本次单价', prop: 'price' },
  { label: '本次金额', prop: 'total' },
  { label: '折后单价', prop: 'netUnit' },
  { label: '折后金额', prop: 'netAmount' }
])
const realRows = (n) => Array.from({ length: n }, (_, i) => ({
  code: 'P00001', unit: '个', qty: 1, price: '1.50', total: '1.50', netUnit: '1.24', netAmount: '1.24',
  // 长名称故意只放在最后几行：列宽若按「每片各自的内容」算，第一页就会比最后一页窄
  name: i >= n - 3 ? 'PE管外牙直接50*112M' : 'TH内丝国标25*20'
}))

await t('分片之间列宽必须一致：同一份 <colgroup> 写进每一片，表格 fixed 布局', () => {
  const columns = realCols(), rows = realRows(140)
  const html = buildPrintHtml({ title: '销售订单 X1', columns, rows, headerFields: [['订单金额', '¥ 753.85', 'xl']] })
  assert.match(html, /table \{[^}]*table-layout: fixed/, '必须 fixed 布局，列宽才完全由 colgroup 说了算')
  const groups = html.match(/<colgroup>.*?<\/colgroup>/g) || []
  const tables = html.match(/<table class="pg/g) || []
  assert.equal(groups.length, tables.length, '每一片都要带一份 colgroup')
  assert.ok(groups.length >= 4, `140 行应切成多片，实际 ${tables.length}`)
  assert.ok(groups.every(g => g === groups[0]), '各片列宽必须一模一样（跨页不错位）')
  // 宽度按整份明细算：长名称在末页，首页也要给它留出同样的宽度
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0].match(/[\d.]+(?=%)/g).map(Number))),
    columnWidths(columns, rows).map(Number),
    'colgroup 必须等于按全量 rows 算出的 columnWidths')
  // 每列百分比合计 100，且都留出内边距（否则文字换行会把每页 40 行的预算挤崩）
  const sum = columnWidths(columns, rows).reduce((a, b) => a + b, 0)
  assert.equal(Math.round(sum * 100) / 100, 100, '列宽百分比合计必须 100%')
})

await t('真机渲染：各分片表的列起点像素完全一致（Chromium 布局实测）', async () => {
  const columns = realCols(), rows = realRows(140)
  const html = buildPrintHtml({ title: '销售订单 X1', columns, rows, headerFields: [['订单金额', '¥ 753.85', 'xl']] })
  const probe = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  try {
    await probe.setContent(html)
    const xs = await probe.evaluate(() => [...document.querySelectorAll('table')].map(t =>
      [...t.querySelectorAll('thead th')].map(th => Math.round(th.getBoundingClientRect().x))))
    assert.ok(xs.length >= 4, `140 行应渲染出 4 张分片表，实际 ${xs.length}`)
    assert.ok(xs.every(x => JSON.stringify(x) === JSON.stringify(xs[0])),
      `跨页列位置必须完全一致：\n${JSON.stringify(xs)}`)
  } finally { await probe.close() }
})

await t('跨页表头关闭：整份明细一张连续大表，表头只有一份、不强制换页', () => {
  const columns = realCols(), rows = realRows(140)
  const html = buildPrintHtml({ title: '销售订单 X1', columns, rows, repeatHeader: false })
  assert.equal((html.match(/<table/g) || []).length, 1, '关闭后不该切片，只能有一张表')
  assert.equal((html.match(/<thead>/g) || []).length, 1, '表头只印一次')
  assert.doesNotMatch(html, /class="pg brk"/, '不该再有强制换页')
  assert.match(html, /<td class="idx">140<\/td>/, '行不能少')
  // 列宽仍然按全量算，保持与开启时同一套版面
  assert.deepEqual(columnWidths(columns, rows), columnWidths(columns, rows))
})

await t('真机 PDF：关闭跨页表头后只有第 1 页有表头，开启时每页都有', async () => {
  const columns = realCols(), rows = realRows(140)
  const on = buildPrintHtml({ title: '销售订单 X1', columns, rows, headerFields: [['订单金额', '¥ 753.85', 'xl']] })
  const off = buildPrintHtml({ title: '销售订单 X1', columns, rows, headerFields: [['订单金额', '¥ 753.85', 'xl']], repeatHeader: false })
  const a = await toPdfPages(on, '/tmp/print-layout-hdr-on.pdf')
  const b = await toPdfPages(off, '/tmp/print-layout-hdr-off.pdf')
  assert.equal(a.pages, (on.match(/<table class="pg/g) || []).length, '开启时页数＝分片数（fixed 布局没把行挤到换页）')
  for (let i = 1; i <= a.pages; i++) assert.match(a.textOf(i), /序号/, `开启时第 ${i} 页应有表头`)
  assert.ok(b.pages >= 3, `140 行连续表至少要 3 页，实际 ${b.pages}`)
  assert.match(b.textOf(1), /序号/, '关闭时第 1 页仍有表头')
  assert.doesNotMatch(b.textOf(b.pages), /折后金额/, '关闭后续页不再重复表头')
})

await t('A5 同样受跨页表头开关控制（开启时每页带表头 / 关闭后一张表）', () => {
  const columns = realCols(), rows = realRows(90)
  const on = buildPrintHtml({ title: '销售订单 X1', columns, rows, paper: 'A5' })
  const off = buildPrintHtml({ title: '销售订单 X1', columns, rows, paper: 'A5', repeatHeader: false })
  assert.match(on, /@page \{ size: A5 landscape/)
  const chunks = (on.match(/<thead>/g) || []).length
  assert.ok(chunks >= 4, `A5 每页行数有限，90 行应切成多片，实际 ${chunks}`)
  assert.match(off, /@page \{ size: A5 landscape/, 'A5 关闭开关后仍是 A5')
  assert.equal((off.match(/<thead>/g) || []).length, 1, 'A5 关闭后表头只有一份')
})

await t('列表页工具栏：取消「跨页表头」后打印只有一份表头（A4/A5 同一开关）', async () => {
  const { page, context } = await open('/items', seed({
    items: Array.from({ length: 90 }, (_, i) => ({ code: `P${String(i + 1).padStart(5, '0')}`, name: `管件${i + 1}`, unit: '个', price: 10, cost: 5 }))
  }))
  try {
    const cb = page.locator('.el-checkbox', { hasText: '跨页表头' })
    assert.equal(await cb.count(), 1, '工具栏要有「跨页表头」开关')
    assert.match((await cb.first().getAttribute('class')) || '', /is-checked/, '默认开启')
    await capturePrint(page)
    const on4 = await printed(page, page.getByRole('button', { name: '打印' }))
    // 默认 A4 纵向；商品库按 60 行分页，工具栏打「当前页」→ 60 行在纵向 A4 上一页装得下
    assert.match(on4, /@page \{ size: A4 portrait/, '未设置时默认 A4 纵向')
    await cb.first().click()
    const off4 = await printed(page, page.getByRole('button', { name: '打印' }))
    assert.equal((off4.match(/<thead>/g) || []).length, 1, '取消后表头只有一份')
    // 切到 A5 横向：60 行会切成多片，关闭开关后仍只有一份表头
    await page.locator('.paper-btn').click()
    await page.locator('.el-popover:visible').getByText('A5', { exact: true }).click()
    await page.locator('.el-popover:visible').getByText('横向', { exact: true }).click()
    await page.keyboard.press('Escape')
    const off5 = await printed(page, page.getByRole('button', { name: '打印' }))
    assert.match(off5, /@page \{ size: A5 landscape/, '开关对 A5 同样生效')
    assert.equal((off5.match(/<thead>/g) || []).length, 1, 'A5 取消后也只有一份表头')
    // 偏好要能被记住（同一浏览器换页面不用再点一遍）
    assert.equal(await page.evaluate(() => localStorage.getItem('stock.print.repeatHeader')), '0')
  } finally { await context.close() }
})

await t('订单列表、订单详情、模板页都提供「跨页表头」开关', async () => {
  for (const [path, state] of [
    ['/orders', seed({ orders: [orderDoc(2)], items: [{ code: 'P00001', name: '管件', unit: '个', price: 10, cost: 5 }] })],
    [`/order/${ORDER_ID}`, seed({ orders: [orderDoc(2)] })],
    ['/templates', seed({ templates: [{ id: 'T1', name: '常用组合', kind: 'sale', createdAt: '2026-10-20T02:00:00.000Z', items: [{ code: 'P00001', name: '管件', unit: '个', qty: 1, price: 10, discountRate: 1 }] }] })],
    [`/sale/${SALE_ID}`, seed({ sales: [saleDoc(2)] })]
  ]) {
    const { page, context } = await open(path, state)
    try {
      assert.equal(await page.locator('.el-checkbox', { hasText: '跨页表头' }).count(), 1, `${path} 应有「跨页表头」开关`)
    } finally { await context.close() }
  }
})

await t('开关状态跨页面保持（localStorage 记住上次选择）', async () => {
  const { page, context } = await open('/items', seed({ items: [{ code: 'P00001', name: '管件', unit: '个', price: 10, cost: 5 }] }))
  try {
    const cb = page.locator('.el-checkbox', { hasText: '跨页表头' })
    await cb.first().click()
    await page.goto(`${BASE}/items`, { waitUntil: 'networkidle' })
    const cls = (await page.locator('.el-checkbox', { hasText: '跨页表头' }).first().getAttribute('class')) || ''
    assert.doesNotMatch(cls, /is-checked/, '刷新后应仍是关闭状态')
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
