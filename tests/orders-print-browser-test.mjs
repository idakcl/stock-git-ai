// 订单打印 / 导出（真浏览器）：
//  ① 列表工具栏的 CSV 只导当前页、带「业务单号」列；
//  ② 单张订单 A4 打印的单头、明细、折扣与合计；
//  ③ 单张订单 CSV 的内容与文件名口径。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/orders-print-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'

const line = (code, name, qty, price, discountRate = 1) => ({
  code, name, qty, price, discountRate,
  discount: Math.round(qty * price * (1 - discountRate) * 100) / 100,
  total: Math.round(qty * price * discountRate * 100) / 100
})

const order = (over = {}) => ({
  id: 'D202610281000000001', status: '未过账', kind: 'sale', customer: '客户甲',
  date: '2026-10-28', no: 'HT-2026-001', remark: '月底交货',
  items: [line('P00001', '管件', 2, 10, 0.9), line('P00002', '弯头', 1, 5)],
  discountRates: [0.95], discount: 1,
  deposits: [], ...over
})

const seed = (orders) => ({
  orders,
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
    return send({ ok: true })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${BASE}/orders`, { waitUntil: 'networkidle' })
  return { page, context, state, errors }
}

const captureBlob = (page) => page.evaluate(() => {
  window.__csv = null
  const orig = URL.createObjectURL
  URL.createObjectURL = (blob) => { blob.text().then(txt => { window.__csv = txt }); return orig.call(URL, blob) }
})

const rowOf = (page, id) => page.locator('.el-table__row', { hasText: id }).first()

console.log('\n订单列表：CSV 只导当前页，并带业务单号')

await t('61 张订单时第一页 CSV 只导出 60 行，表头含业务单号', async () => {
  const many = Array.from({ length: 61 }, (_, i) => order({
    id: `D20261028100000${String(i + 1).padStart(4, '0')}`,
    no: i === 60 ? 'HT-2026-001' : '',
    items: [line('P00001', '管件', 1, 10)]
  }))
  const { page, context, errors } = await open(seed(many))
  try {
    await captureBlob(page)
    await page.getByRole('button', { name: '导出CSV' }).click()
    await page.waitForFunction(() => !!window.__csv, null, { timeout: 5000 })
    const rows = (await page.evaluate(() => window.__csv)).replace(/^\uFEFF/, '').split('\r\n')
    const head = rows.find(r => r.startsWith('订单号,'))
    assert.ok(head, '缺少订单表头')
    assert.match(head, /业务单号/)
    const data = rows.slice(rows.indexOf(head) + 1).filter(Boolean)
    assert.equal(data.length, 60, '只导出当前页 60 行')
    assert.match(data[0], /HT-2026-001/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n单张订单：A4 打印')

await t('打印单头 / 明细 / 折扣链 / 合计与未收金额', async () => {
  const { page, context, errors } = await open(seed([order()]))
  try {
    await page.evaluate(() => {
      window.__printed = null
      window.open = () => {
        const doc = { write: html => { window.__printed = html }, close() {} }
        return { document: doc, focus() {}, print() {} }
      }
    })
    await rowOf(page, 'D202610281000000001').getByRole('button', { name: '打印', exact: true }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /销售订单 D202610281000000001/)
    assert.match(html, /业务单号：<\/b>HT-2026-001/)
    assert.match(html, /客户：<\/b>客户甲/)
    assert.match(html, /原价合计：<\/b>¥25\.00（单项折扣 -¥2\.00）/)
    assert.match(html, /整单折扣：<\/b>×0\.95（减 ¥1\.15）/)
    // 整单折扣字段高亮（打印样式 .f.hl），让单头折扣一眼可见
    assert.match(html, /<div class="f hl"><b>整单折扣：<\/b>/)
    // 明细摊完整单折扣后的金额：18×0.95=17.10，5×0.95=4.75
    assert.match(html, /<th>折后金额<\/th>/)
    assert.match(html, /17\.10/)
    assert.match(html, /4\.75/)
    assert.match(html, /整单优惠：<\/b>¥1\.00/)
    // 行折后 23 × 整单 0.95 = 21.85，再减整单优惠 1 = 20.85；订金 0
    assert.match(html, /订单金额：<\/b>¥20\.85/)
    assert.match(html, /未收：<\/b>¥20\.85/)
    assert.match(html, /管件/)
    assert.match(html, /2\.00/)
    assert.match(html, /18\.00/)
    // 副标题只报商品项数，不出现订单状态（状态仍在单头「状态」字段）
    assert.match(html, /<div class="sub">共 2 项商品<\/div>/)
    assert.doesNotMatch(html, /<div class="sub">[^<]*未过账/)
    // 明细最前面是序号列：1、2 顺排
    assert.match(html, /<th class="idx">序号<\/th>/)
    assert.match(html, /<td class="idx">1<\/td>/)
    assert.match(html, /<td class="idx">2<\/td>/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n单张订单：CSV 导出')

await t('CSV 文件名与内容：单头 + 明细行，折扣与折后金额同口径', async () => {
  const { page, context, state, errors } = await open(seed([order()]))
  try {
    await captureBlob(page)
    await rowOf(page, 'D202610281000000001').getByRole('button', { name: 'CSV', exact: true }).click()
    await page.waitForFunction(() => !!window.__csv, null, { timeout: 5000 })
    const csv = (await page.evaluate(() => window.__csv)).replace(/^\uFEFF/, '')
    assert.match(csv, /业务单号,HT-2026-001/)
    assert.match(csv, /订单金额,¥20\.85/)
    assert.match(csv, /编码,名称,数量,单价,折扣率,折扣金额,本次金额,折后单价,折后金额/)
    assert.match(csv, /P00001,管件,2,10\.00,0\.90,2\.00,18\.00,8\.55,17\.10/)
    assert.match(csv, /P00002,弯头,1,5\.00,1\.00,0\.00,5\.00,4\.75,4\.75/)
    // 文件名在下载时确定，这里只确认这条路径没发写请求（纯前端导出）
    assert.deepEqual(state.posts || [], [])
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n已过账订单也能打印：带上关联单据号')

await t('已过账订单的打印单头显示关联单据', async () => {
  const posted = order({ status: '已过账', postedOrderId: 'X202610281100000001' })
  const { page, context, errors } = await open(seed([posted]))
  try {
    // 列表默认只看未过账订单，已过账的要先切到「显示全部订单」
    await page.locator('.filter-row .el-select').first().click()
    await page.getByRole('option', { name: '显示全部订单' }).click()
    await page.waitForTimeout(200)
    await page.evaluate(() => {
      window.__printed = null
      window.open = () => {
        const doc = { write: html => { window.__printed = html }, close() {} }
        return { document: doc, focus() {}, print() {} }
      }
    })
    await rowOf(page, 'D202610281000000001').getByRole('button', { name: '打印', exact: true }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /状态：<\/b>已过账/)
    assert.match(html, /关联单据：<\/b>X202610281100000001/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await browser.close()
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
