// 批量行折扣与批量删除：真浏览器测试（简化版）
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/line-batch-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'

const seed = () => ({
  sales: [],
  purchases: [],
  items: [
    { code: 'P00001', name: '管件', unit: '个', price: 100, cost: 50 },
    { code: 'P00002', name: '弯头', unit: '个', price: 200, cost: 100 }
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
  return { page, context, state, errors }
}

const dialog = (page) => page.locator('.el-dialog:visible').first()

// 在「快速添加」里选中商品
async function quickAdd(page, productName) {
  await page.locator('.quick-add-select').first().click()
  await page.getByRole('option', { name: productName, exact: true }).click()
  await page.waitForTimeout(300)
}

console.log('\n批量折扣与批量删除：勾选框、批量操作')

await t('销售单弹窗显示勾选框列与批量操作按钮', async () => {
  const { page, context, errors } = await open('/sales', seed())
  try {
    await page.getByRole('button', { name: '新增销售' }).click()
    const dlg = dialog(page)
    await dlg.waitFor()
    // 检查是否有勾选框列
    const selectionColumn = dlg.locator('.el-table__header th .el-checkbox')
    assert.equal(await selectionColumn.count(), 1, '应显示全选勾选框')
    // 检查是否有批量操作按钮
    const batchDiscountBtn = dlg.getByRole('button', { name: /批量设置折扣/ })
    const batchDeleteBtn = dlg.getByRole('button', { name: /批量删除/ })
    assert.equal(await batchDiscountBtn.count(), 1, '应显示批量设置折扣按钮')
    assert.equal(await batchDeleteBtn.count(), 1, '应显示批量删除按钮')
    // 初始状态按钮应禁用
    assert.equal(await batchDiscountBtn.isDisabled(), true, '未勾选时批量折扣按钮应禁用')
    assert.equal(await batchDeleteBtn.isDisabled(), true, '未勾选时批量删除按钮应禁用')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('勾选行后批量按钮可用，显示已选数量', async () => {
  const { page, context } = await open('/sales', seed())
  try {
    await page.getByRole('button', { name: '新增销售' }).click()
    const dlg = dialog(page)
    await dlg.waitFor()
    // 快速添加两行商品
    await quickAdd(page, '管件 (P00001)')
    await quickAdd(page, '弯头 (P00002)')
    // 勾选第一行
    const rows = dlg.locator('.el-table__body-wrapper tbody tr')
    await rows.nth(0).locator('.el-checkbox').click()
    await page.waitForTimeout(100)
    // 检查按钮状态
    const batchDiscountBtn = dlg.getByRole('button', { name: /批量设置折扣/ })
    assert.equal(await batchDiscountBtn.isDisabled(), false, '勾选后批量折扣按钮应可用')
    // 检查按钮文本显示已选数量
    const btnText = await batchDiscountBtn.textContent()
    assert.match(btnText, /已选 1 项/, '按钮应显示已选 1 项')
    // 勾选第二行
    await rows.nth(1).locator('.el-checkbox').click()
    await page.waitForTimeout(100)
    const btnText2 = await batchDiscountBtn.textContent()
    assert.match(btnText2, /已选 2 项/, '按钮应显示已选 2 项')
  } finally { await context.close() }
})

await t('全选勾选框：勾选/取消全选所有行', async () => {
  const { page, context } = await open('/sales', seed())
  try {
    await page.getByRole('button', { name: '新增销售' }).click()
    const dlg = dialog(page)
    await dlg.waitFor()
    await quickAdd(page, '管件 (P00001)')
    await quickAdd(page, '弯头 (P00002)')
    // 点击全选勾选框
    const selectAllCheckbox = dlg.locator('.el-table__header th .el-checkbox')
    await selectAllCheckbox.click()
    await page.waitForTimeout(100)
    // 检查按钮显示已选 2 项
    const batchDiscountBtn = dlg.getByRole('button', { name: /批量设置折扣/ })
    const btnText = await batchDiscountBtn.textContent()
    assert.match(btnText, /已选 2 项/, '全选后应显示已选 2 项')
    // 再次点击取消全选
    await selectAllCheckbox.click()
    await page.waitForTimeout(100)
    assert.equal(await batchDiscountBtn.isDisabled(), true, '取消全选后按钮应禁用')
  } finally { await context.close() }
})

await t('批量设置折扣：打开弹窗，显示统一折扣链模式', async () => {
  const { page, context } = await open('/sales', seed())
  try {
    await page.getByRole('button', { name: '新增销售' }).click()
    const dlg = dialog(page)
    await dlg.waitFor()
    await quickAdd(page, '管件 (P00001)')
    await quickAdd(page, '弯头 (P00002)')
    // 全选
    await dlg.locator('.el-table__header th .el-checkbox').click()
    await page.waitForTimeout(100)
    // 点击批量设置折扣
    await dlg.getByRole('button', { name: /批量设置折扣/ }).click()
    await page.waitForTimeout(300)
    // 检查批量折扣弹窗是否打开
    const discountDialog = page.locator('.el-dialog:visible').last()
    assert.equal(await discountDialog.isVisible(), true, '批量折扣弹窗应打开')
    // 检查标题
    const title = await discountDialog.locator('.el-dialog__header').textContent()
    assert.match(title, /批量设置折扣/, '弹窗标题应为批量设置折扣')
    // 默认应该是统一折扣链模式
    const unifiedRadio = discountDialog.getByText('统一折扣链')
    assert.equal(await unifiedRadio.count() > 0, true, '应显示统一折扣链模式选项')
    // 检查是否显示已选行数
    const selectedCount = await discountDialog.textContent()
    assert.match(selectedCount, /已选 2 行/, '应显示已选 2 行')
  } finally { await context.close() }
})

await t('批量删除：二次确认后删除勾选行', async () => {
  const { page, context } = await open('/sales', seed())
  try {
    await page.getByRole('button', { name: '新增销售' }).click()
    const dlg = dialog(page)
    await dlg.waitFor()
    await quickAdd(page, '管件 (P00001)')
    await quickAdd(page, '弯头 (P00002)')
    // 再添加一行管件，需要处理重复商品弹窗
    await quickAdd(page, '管件 (P00001)')
    // 处理重复商品弹窗，点击"再次添加"
    const duplicateDialog = page.locator('.el-message-box')
    await duplicateDialog.waitFor({ state: 'visible', timeout: 2000 })
    await duplicateDialog.getByRole('button', { name: '再次添加' }).click()
    await page.waitForTimeout(300)
    // 勾选前两行
    const rows = dlg.locator('.el-table__body-wrapper tbody tr')
    await rows.nth(0).locator('.el-checkbox').click()
    await rows.nth(1).locator('.el-checkbox').click()
    await page.waitForTimeout(100)
    // 点击批量删除
    await dlg.getByRole('button', { name: /批量删除/ }).click()
    await page.waitForTimeout(300)
    // 检查确认弹窗是否出现
    const confirmDialog = page.locator('.el-message-box')
    assert.equal(await confirmDialog.isVisible(), true, '应显示删除确认弹窗')
    const confirmText = await confirmDialog.textContent()
    assert.match(confirmText, /确定删除已勾选的 2 行/, '确认弹窗应提示删除 2 行')
    // 点击确定删除
    await confirmDialog.getByRole('button', { name: '确定删除' }).click()
    await page.waitForTimeout(300)
    // 检查行数是否减少（应该只剩 1 行）
    const remainingRows = dlg.locator('.el-table__body-wrapper tbody tr')
    assert.equal(await remainingRows.count(), 1, '删除后应只剩 1 行')
  } finally { await context.close() }
})

await t('批量删除：点击取消不删除', async () => {
  const { page, context } = await open('/sales', seed())
  try {
    await page.getByRole('button', { name: '新增销售' }).click()
    const dlg = dialog(page)
    await dlg.waitFor()
    await quickAdd(page, '管件 (P00001)')
    await quickAdd(page, '弯头 (P00002)')
    // 全选
    await dlg.locator('.el-table__header th .el-checkbox').click()
    await page.waitForTimeout(100)
    // 点击批量删除
    await dlg.getByRole('button', { name: /批量删除/ }).click()
    await page.waitForTimeout(300)
    // 点击取消
    const confirmDialog = page.locator('.el-message-box')
    await confirmDialog.getByRole('button', { name: '取消' }).click()
    await page.waitForTimeout(300)
    // 检查行数是否保持不变（应该还是 2 行）
    const remainingRows = dlg.locator('.el-table__body-wrapper tbody tr')
    assert.equal(await remainingRows.count(), 2, '取消后行数应保持不变')
  } finally { await context.close() }
})

await t('采购单弹窗同样显示勾选框与批量按钮', async () => {
  const { page, context, errors } = await open('/purchases', seed())
  try {
    await page.getByRole('button', { name: '新增采购' }).click()
    const dlg = dialog(page)
    await dlg.waitFor()
    const selectionColumn = dlg.locator('.el-table__header th .el-checkbox')
    assert.equal(await selectionColumn.count(), 1, '采购单应显示全选勾选框')
    const batchDiscountBtn = dlg.getByRole('button', { name: /批量设置折扣/ })
    assert.equal(await batchDiscountBtn.count(), 1, '采购单应显示批量设置折扣按钮')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('订单弹窗同样显示勾选框与批量按钮', async () => {
  const { page, context, errors } = await open('/orders', seed())
  try {
    await page.getByRole('button', { name: '新建订单' }).click()
    const dlg = dialog(page)
    await dlg.waitFor()
    const selectionColumn = dlg.locator('.el-table__header th .el-checkbox')
    assert.equal(await selectionColumn.count(), 1, '订单应显示全选勾选框')
    const batchDiscountBtn = dlg.getByRole('button', { name: /批量设置折扣/ })
    assert.equal(await batchDiscountBtn.count(), 1, '订单应显示批量设置折扣按钮')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await browser.close()
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
