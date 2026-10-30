// 明细重复商品提示（真浏览器）：订单 / 销售单 / 采购单在「快速添加」里再次录入同一商品时，
// 弹出「本商品已录入」，可选「定位到已录入商品」（该行蓝色外框闪烁两下）或「再次添加」（再添一行）。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），
//      再 node tests/duplicate-item-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'

const BASE = 'http://127.0.0.1:5173'
const line = (code, name, qty, price) => ({ code, name, unit: '个', qty, price, total: Math.round(qty * price * 100) / 100 })
const seed = () => ({
  items: [
    { code: 'P00001', name: '管件', unit: '个', price: 10, cost: 8 },
    { code: 'P00002', name: '弯头', unit: '个', price: 5, cost: 4 }
  ],
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  sales: [{ id: 'X202610281000000001', date: '2026-10-28', customer: '客户甲', total: 10, discount: 0, payments: [], items: [line('P00002', '弯头', 1, 5)] }],
  purchases: [{ id: 'C202610281000000001', date: '2026-10-28', supplier: '供应商甲', total: 10, discount: 0, paid: 0, payments: [], items: [line('P00002', '弯头', 1, 5)] }],
  orders: []
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

// 在「快速添加」里选中管件（P00001）
async function quickAdd(page) {
  await page.locator('.quick-add-select').first().click()
  await page.getByRole('option', { name: '管件 (P00001)', exact: true }).click()
  await page.waitForTimeout(300)
}

const dialogRows = (dialog) => dialog.locator('.el-table__row')
const dialog = (page) => page.locator('.el-dialog:visible').last()

async function expectDuplicatePrompt(page) {
  const box = page.locator('.el-message-box:visible').last()
  await box.waitFor({ timeout: 5000 })
  const text = (await box.innerText()).replace(/\s+/g, ' ')
  assert.match(text, /本商品已录入/, '标题应显示「本商品已录入」')
  assert.match(text, /第 1 行/, '应指出已录入的行号')
  assert.equal(await box.getByRole('button', { name: '定位到已录入商品', exact: true }).count(), 1)
  assert.equal(await box.getByRole('button', { name: '再次添加', exact: true }).count(), 1)
  return box
}

console.log('\n订单弹窗：重复商品 → 定位 / 再次添加')

await t('再次录入同一商品弹出「本商品已录入」；定位后不新增行且该行蓝色闪烁', async () => {
  const state = seed()
  const { page, context, errors } = await open('/orders', state)
  try {
    await page.getByRole('button', { name: '新建订单' }).click()
    const dlg = dialog(page)
    await dlg.waitFor()
    await quickAdd(page)
    assert.equal(await dialogRows(dlg).count(), 1, '首次录入只有一行')
    await quickAdd(page)
    await expectDuplicatePrompt(page)
    await page.locator('.el-message-box:visible').last().getByRole('button', { name: '定位到已录入商品', exact: true }).click()
    await page.waitForSelector('tr.locate-flash', { timeout: 3000 })
    assert.equal(await dialogRows(dlg).count(), 1, '定位不应再添一行')
    // 蓝色外框由 CSS 动画实现，且持续时间覆盖两下闪烁
    const cell = dlg.locator('tr.locate-flash > td').first()
    const anim = await cell.evaluate(el => {
      const s = getComputedStyle(el)
      return { name: s.animationName, duration: s.animationDuration, shadow: s.boxShadow }
    })
    assert.notEqual(anim.name, 'none', '该行应带闪烁动画')
    assert.equal(anim.duration, '1.6s')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('选择「再次添加」：同一商品出现两行，数量各自可改', async () => {
  const state = seed()
  const { page, context, errors } = await open('/orders', state)
  try {
    await page.getByRole('button', { name: '新建订单' }).click()
    const dlg = dialog(page)
    await dlg.waitFor()
    await quickAdd(page)
    await quickAdd(page)
    await expectDuplicatePrompt(page)
    await page.locator('.el-message-box:visible').last().getByRole('button', { name: '再次添加', exact: true }).click()
    await page.waitForTimeout(400)
    assert.equal(await dialogRows(dlg).count(), 2, '再次添加后应为两行')
    assert.match((await dlg.innerText()).replace(/\s+/g, ' '), /管件/, '两行都是同一商品')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n销售单弹窗：重复商品')

await t('销售单再次添加同一商品也会提示，可再次添加成两行', async () => {
  const { page, context, errors } = await open('/sales', seed())
  try {
    await page.getByRole('button', { name: '新增销售' }).click()
    const dlg = dialog(page)
    await dlg.waitFor()
    await quickAdd(page)
    await quickAdd(page)
    await expectDuplicatePrompt(page)
    await page.locator('.el-message-box:visible').last().getByRole('button', { name: '再次添加', exact: true }).click()
    await page.waitForTimeout(400)
    assert.equal(await dialogRows(dlg).count(), 2)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n采购单弹窗：重复商品')

await t('采购单重复商品可定位到已录入行', async () => {
  const { page, context, errors } = await open('/purchases', seed())
  try {
    const create = page.getByRole('button', { name: /新增采购/ })
    await create.click()
    const dlg = dialog(page)
    await dlg.waitFor()
    await quickAdd(page)
    await quickAdd(page)
    await expectDuplicatePrompt(page)
    await page.locator('.el-message-box:visible').last().getByRole('button', { name: '定位到已录入商品', exact: true }).click()
    await page.waitForSelector('tr.locate-flash', { timeout: 3000 })
    assert.equal(await dialogRows(dlg).count(), 1)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await browser.close()
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
