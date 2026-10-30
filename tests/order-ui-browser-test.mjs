// 单据界面三项改动：
//   1. 新增销售 / 采购 / 订单弹窗左上角有「最大化」角标，点击铺满屏幕，再点还原；
//   2. 明细表最前面有「序号」列（新增弹窗与历史单据详情都显示，按行号实时生成）；
//   3. 折后列文案统一为「折后单价 / 折后金额」，不再带「（含整单折扣）」。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/order-ui-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const BASE = 'http://127.0.0.1:5173'
const browser = await chromium.launch()

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}

const SALE_ID = 'X202610301100000001'
const PURCHASE_ID = 'C202610301100000001'
const ORDER_ID = 'D202610301100000001'
const lines = [
  { code: 'P00001', name: '管件A', qty: 2, price: 100, discountRate: 1, total: 200, discount: 0 },
  { code: 'P00002', name: '管件B', qty: 1, price: 50, discountRate: 1, total: 50, discount: 0 }
]
const seed = (over = {}) => ({
  sales: [], purchases: [], orders: [], items: [
    { code: 'P00001', name: '管件A', unit: '个', price: 100, cost: 80 },
    { code: 'P00002', name: '管件B', unit: '个', price: 50, cost: 40 }
  ],
  customers: [{ code: 'C00001', name: '客户甲', category: '零售' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  profile: {}, shares: [], templates: [], ...over
})

async function open(path, state = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  await context.route('**/api/**', route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) })
    if (request.method() === 'GET') {
      if (pathname === '/api/session') return send({ ok: true })
      if (pathname === '/api/profile') return send(state.profile ?? {})
      if (pathname === '/api/shares') return send({ shares: [] })
      if (pathname === '/api/templates') return send({ templates: [] })
      if (pathname === '/api/sale-history') return send({})
      if (pathname === '/api/purchase-history') return send({})
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

const fullscreen = (page) => page.evaluate(() => {
  const dlg = [...document.querySelectorAll('.el-dialog')].find(d => d.offsetParent !== null)
  if (!dlg) return null
  return { full: dlg.classList.contains('is-fullscreen'), w: dlg.getBoundingClientRect().width, vw: window.innerWidth }
})

async function checkMaximize(page, openBtn) {
  await page.getByRole('button', { name: openBtn, exact: true }).first().click()
  const dlg = page.locator('.el-dialog:visible')
  await dlg.waitFor()
  const btn = dlg.locator('.dlg-max')
  await btn.waitFor()
  assert.equal(await btn.getAttribute('aria-label'), '最大化窗口')
  // 角标在标题左侧（左上角）
  const [bb, tb] = await Promise.all([btn.boundingBox(), dlg.locator('.el-dialog__title').first().boundingBox()])
  assert.ok(bb.x < tb.x && bb.y < tb.y + 6, '最大化角标应位于标题左上角')
  assert.equal((await fullscreen(page)).full, false, '默认是普通弹窗')
  await btn.click()
  await page.waitForTimeout(350)
  const max = await fullscreen(page)
  assert.equal(max.full, true, '点击后应铺满屏幕')
  assert.ok(max.w >= max.vw - 2, `全屏宽度应等于视口：${max.w} / ${max.vw}`)
  assert.equal(await dlg.locator('.dlg-max').getAttribute('aria-label'), '还原窗口')
  await dlg.locator('.dlg-max').click()
  await page.waitForTimeout(350)
  assert.equal((await fullscreen(page)).full, false, '再点一次应还原')
  return dlg
}

console.log('\n新增弹窗：最大化角标 + 明细序号')

await t('销售单新增弹窗：左上角最大化角标可切换，明细首列是序号', async () => {
  const { page, context, errors } = await open('/sales', seed())
  try {
    const dlg = await checkMaximize(page, '新增销售')
    const headers = await dlg.locator('.el-table__header th .cell').allInnerTexts()
    assert.equal(headers[1].trim(), '序号', `勾选框后第一列应为序号，实际 ${headers.slice(0, 3).join('|')}`)
    // 加一行商品，行号应显示 1
    const firstNum = (await dlg.locator('.el-table__body tr').first().locator('td').nth(1).innerText()).trim()
    assert.equal(firstNum, '1')
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

await t('采购单新增弹窗：同样有最大化角标与序号列', async () => {
  const { page, context, errors } = await open('/purchases', seed())
  try {
    const dlg = await checkMaximize(page, '新增采购')
    const headers = await dlg.locator('.el-table__header th .cell').allInnerTexts()
    assert.equal(headers[1].trim(), '序号')
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

await t('订单新增弹窗：同样有最大化角标与序号列', async () => {
  const { page, context, errors } = await open('/orders', seed())
  try {
    const dlg = await checkMaximize(page, '新建订单')
    const headers = await dlg.locator('.el-table__header th .cell').allInnerTexts()
    assert.equal(headers[1].trim(), '序号')
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

console.log('\n历史单据：序号自动补齐，折后列文案统一')

await t('销售单详情：历史单据明细从 1 开始编号', async () => {
  const sale = { id: SALE_ID, customer: '客户甲', date: '2026-10-30', total: 250, discount: 0, discountRates: [], payments: [], items: lines }
  const { page, context, errors } = await open(`/sale/${SALE_ID}`, seed({ sales: [sale] }))
  try {
    const table = page.locator('.el-table').first()
    const headers = await table.locator('.el-table__header th .cell').allInnerTexts()
    assert.equal(headers[0].trim(), '序号', `明细首列应为序号，实际 ${headers.slice(0, 3).join('|')}`)
    const nums = await table.locator('.el-table__body tr td:first-child').allInnerTexts()
    assert.deepEqual(nums.map(s => s.trim()), ['1', '2'])
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

await t('销售单详情：折后列显示「折后单价 / 折后金额」，不再带括号说明', async () => {
  const sale = {
    id: SALE_ID, customer: '客户甲', date: '2026-10-30', total: 250, discount: 0,
    discountRates: [0.9], payments: [], items: lines
  }
  const { page, context } = await open(`/sale/${SALE_ID}`, seed({ sales: [sale] }))
  try {
    const headers = (await page.locator('.el-table__header th .cell').allInnerTexts()).map(s => s.trim())
    assert.ok(headers.includes('折后单价'), `应出现「折后单价」，实际 ${headers.join('|')}`)
    assert.ok(headers.includes('折后金额'), '应出现「折后金额」')
    assert.ok(!headers.some(h => h.includes('含整单折扣')), '不应再出现「含整单折扣」')
    const body = await page.locator('body').innerText()
    assert.ok(!body.includes('（含整单折扣）'), '页面上不应残留旧文案')
  } finally { await context.close() }
})

await t('采购单详情、订单详情：同样有「序号」列', async () => {
  const state = seed({
    purchases: [{ id: PURCHASE_ID, supplier: '供应商甲', date: '2026-10-30', total: 250, discount: 0, discountRates: [], payments: [], items: lines }],
    orders: [{ id: ORDER_ID, no: 'HT-1', kind: 'sale', status: '未过账', customer: '客户甲', date: '2026-10-30', total: 250, discount: 0, discountRates: [], deposits: [], items: lines }]
  })
  for (const [path, label] of [[`/purchase/${PURCHASE_ID}`, '采购单'], [`/order/${ORDER_ID}`, '订单']]) {
    const { page, context } = await open(path, state)
    try {
      const headers = (await page.locator('.el-table__header th .cell').allInnerTexts()).map(s => s.trim())
      assert.equal(headers[0], '序号', `${label}详情明细首列应为序号`)
    } finally { await context.close() }
  }
})

await browser.close()
console.log(`\n${fail ? '✗' : '✓'} ${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
