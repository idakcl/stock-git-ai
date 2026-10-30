// 作废（真浏览器）：列表上的「作废」按钮 → 确认 → POST /api/voids；作废后的单据打标、详情页锁写、
// 资金单据页标作废且不计入合计。另附订单弹窗「行折扣」与顶部提示间距。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/void-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'

const line = (code, name, qty, price) => ({ code, name, unit: '个', qty, price, total: Math.round(qty * price * 100) / 100 })

const seed = () => ({
  sales: [
    {
      id: 'X1', date: '2026-10-20', customer: '客户甲', total: 100, discount: 0, settle: '结清',
      payments: [{ date: '2026-10-20', amount: 100, remark: '全款', time: '', voucher: 'SK-0001' }],
      photos: [], items: [line('P00001', '管件', 10, 10)]
    },
    {
      id: 'X2', date: '2026-10-21', customer: '客户甲', total: 20, discount: 0, settle: '挂账',
      payments: [], photos: [], items: [line('P00001', '管件', 2, 10)]
    },
    {
      id: 'X3', date: '2026-10-22', customer: '客户甲', total: 30, discount: 0, settle: '挂账', status: '作废',
      voidedAt: '2026-10-23T02:00:00.000Z', voidedReason: '客户取消', voidedVouchers: [], payments: [], photos: [],
      items: [line('P00001', '管件', 3, 10)]
    }
  ],
  purchases: [
    {
      id: 'C1', date: '2026-10-19', supplier: '供应商甲', total: 80, discount: 0, settle: '结清',
      payments: [{ date: '2026-10-19', amount: 80, remark: '', time: '', voucher: 'FK-0001' }],
      photos: [], items: [line('P00001', '管件', 8, 10)]
    }
  ],
  items: [
    { code: 'P00001', name: '管件', unit: '个', price: 10, cost: 8 },
    { code: 'P00002', name: '阀门', unit: '个', price: 20, cost: 15 }
  ],
  stock: { P00001: 100, P00002: 50 },
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  receipts: [
    { code: 'SK-0001', kind: 'receivable', category: 'normal', party: '客户甲', date: '2026-10-20', total: 100, items: [{ orderId: 'X1', orderType: 'sale', amount: 100 }] },
    { code: 'SK-0002', kind: 'receivable', category: 'normal', party: '客户甲', date: '2026-10-21', total: 50, items: [{ orderId: 'X2', orderType: 'sale', amount: 50 }] },
    { code: 'SK-0003', kind: 'receivable', category: 'normal', party: '客户甲', date: '2026-10-22', total: 30, status: '作废', voidedAt: '2026-10-23T02:00:00.000Z', voidOf: 'X3', items: [{ orderId: 'X3', orderType: 'sale', amount: 30 }] }
  ],
  refunds: [],
  'payment-vouchers': [
    { code: 'FK-0001', kind: 'payable', category: 'normal', party: '供应商甲', date: '2026-10-19', total: 80, items: [{ orderId: 'C1', orderType: 'purchase', amount: 80 }] }
  ],
  orders: [], logs: []
})

const BASE = 'http://127.0.0.1:5173'
const systemChrome = ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => existsSync(p))
const browser = await chromium.launch(systemChrome ? { headless: true, executablePath: systemChrome } : { headless: true })
let pass = 0, fail = 0

const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}

async function open(path, state, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport })
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  await context.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    const key = pathname.slice(5)
    const send = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    if (request.method() === 'GET') return send(key === 'session' ? { ok: true } : (state[key] ?? []))
    state.posts = [...(state.posts || []), { key, body: request.postDataJSON() }]
    if (key === 'voids') {
      const body = request.postDataJSON()
      const codes = body.kind === 'purchase' ? ['FK-0001'] : ['SK-0001']
      return send({ ok: true, code: body.id, vouchers: codes })
    }
    if (key === 'orders') return send({ ok: true, code: 'D20261030000000001', orderId: 'D20261030000000001' })
    return send({ ok: true })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  return { page, context, state, errors }
}

const rowOf = (page, id) => page.locator('.el-table__row', { hasText: id }).first()

console.log('\n销售列表：作废按钮 → 确认 → POST /voids')

await t('点「作废」弹出含后果说明的确认框，确认后提交 { kind: sale, id }', async () => {
  const s = seed(); const { page, context, state, errors } = await open('/sales', s)
  try {
    const row = rowOf(page, 'X1')
    await row.getByRole('button', { name: '作废' }).click()
    const box = page.locator('.el-message-box')
    await box.waitFor()
    const text = (await box.innerText()).replace(/\s+/g, ' ')
    assert.match(text, /库存回滚/)
    assert.match(text, /收款单同步作废/)
    assert.match(text, /不可恢复/)
    await box.getByRole('button', { name: '确认作废' }).click()
    await page.waitForTimeout(400)
    const posts = (state.posts || []).filter(p => p.key === 'voids')
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].body, { kind: 'sale', id: 'X1' })
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('确认框点「取消」不提交任何作废请求', async () => {
  const s = seed(); const { page, context, state } = await open('/sales', s)
  try {
    await rowOf(page, 'X1').getByRole('button', { name: '作废' }).click()
    const box = page.locator('.el-message-box')
    await box.waitFor()
    await box.getByRole('button', { name: '取消' }).click()
    await page.waitForTimeout(250)
    assert.equal((state.posts || []).filter(p => p.key === 'voids').length, 0)
  } finally { await context.close() }
})

await t('已作废的单：打「作废」标，编辑/收款/作废按钮全部禁用', async () => {
  const s = seed(); const { page, context, errors } = await open('/sales', s)
  try {
    const row = rowOf(page, 'X3')
    assert.equal(await row.locator('.void-tag').count(), 1, '单号旁应有作废标签')
    assert.equal(await row.getByRole('button', { name: '编辑' }).isDisabled(), true)
    assert.equal(await row.getByRole('button', { name: '收款' }).isDisabled(), true)
    assert.equal(await row.getByRole('button', { name: '作废' }).isDisabled(), true)
    // 未作废的单仍可作废
    assert.equal(await rowOf(page, 'X2').getByRole('button', { name: '作废' }).isDisabled(), false)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n采购列表与详情页')

await t('采购列表「作废」提交 kind: purchase', async () => {
  const s = seed(); const { page, context, state } = await open('/purchases', s)
  try {
    await rowOf(page, 'C1').getByRole('button', { name: '作废' }).click()
    await page.locator('.el-message-box').getByRole('button', { name: '确认作废' }).click()
    await page.waitForTimeout(400)
    const posts = (state.posts || []).filter(p => p.key === 'voids')
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].body, { kind: 'purchase', id: 'C1' })
  } finally { await context.close() }
})

await t('详情页顶部提示已作废，写操作全部禁用', async () => {
  const s = seed(); const { page, context, errors } = await open('/sale/X3', s)
  try {
    const alert = page.locator('.external-banner')
    assert.equal(await alert.count(), 1, '应显示作废提示条')
    const text = (await alert.innerText()).replace(/\s+/g, '')
    assert.match(text, /这张单已作废/)
    assert.match(text, /客户取消/)
    assert.equal(await page.getByRole('button', { name: '编辑' }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '删除' }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: /退货/ }).count(), 0, '作废单不应再有退货入口')
    assert.equal(await page.getByRole('button', { name: '记录收款' }).count(), 0)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n资金单据页：作废标记与合计口径')

await t('作废凭证打标，且不计入收款单累计与筛选合计', async () => {
  const s = seed(); const { page, context, errors } = await open('/vouchers', s)
  try {
    const voidRow = rowOf(page, 'SK-0003')
    assert.equal(await voidRow.locator('.void-tag').count(), 1)
    // 累计 100 + 50，作废的 30 不算
    const stats = (await page.locator('.stat-grid, .v-stats').first().innerText().catch(() => page.locator('body').innerText())).replace(/\s+/g, ' ')
    assert.match(stats, /150\.00/, `收款单累计应为 150.00：${stats}`)
    assert.match((await page.locator('.sum-bar').innerText()).replace(/\s+/g, ' '), /150\.00/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n订单弹窗：行折扣与顶部提示间距')

async function openOrderDialog(s) {
  const ui = await open('/orders', s)
  await ui.page.getByRole('button', { name: '新建订单' }).click()
  const dialog = ui.page.locator('.el-dialog:visible').first()
  await dialog.waitFor()
  const party = dialog.locator('.el-form-item', { hasText: '客户' }).locator('.el-select input').first()
  await party.click()
  await ui.page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: '客户甲' }).first().click()
  await dialog.locator('.quick-add-select input').click()
  await ui.page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: '管件' }).first().click()
  return { ...ui, dialog }
}

await t('行折扣 0.9：小计 36.00、合计 36.00，并提示原价', async () => {
  const s = seed(); const { page, dialog, context, errors } = await openOrderDialog(s)
  try {
    const qty = dialog.locator('.lines-scroll .el-input-number input').nth(0)
    await qty.fill('4')
    const rate = dialog.locator('.lines-scroll .el-input-number input').nth(2)
    await rate.fill('0.9')
    await page.waitForTimeout(200)
    assert.equal((await dialog.locator('.line-net').first().innerText()).trim(), '36.00')
    assert.match((await dialog.locator('.calc-line').innerText()).replace(/\s+/g, ''), /订单金额：36\.00/)
    assert.match((await dialog.locator('.calc-detail').innerText()).replace(/\s+/g, ' '), /原价合计 ¥ 40\.00/)
    assert.match((await dialog.locator('.calc-detail').innerText()).replace(/\s+/g, ' '), /单项折扣 -¥ 4\.00/)
    assert.equal(await dialog.locator('.line-net').first().getAttribute('title'), '原价 ¥40.00')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('保存时行折扣原样落到订单明细（discountRate / discount / total 三件套）', async () => {
  const s = seed(); const { page, dialog, context, state } = await openOrderDialog(s)
  try {
    await dialog.locator('.lines-scroll .el-input-number input').nth(0).fill('4')
    await dialog.locator('.lines-scroll .el-input-number input').nth(2).fill('0.9')
    await page.waitForTimeout(200)
    await dialog.getByRole('button', { name: '保存订单' }).click()
    await page.waitForTimeout(400)
    const posts = (state.posts || []).filter(p => p.key === 'orders')
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].body.order.items, [{ code: 'P00001', name: '管件', qty: 4, price: 10, discountRate: 0.9, discount: 4, total: 36 }])
  } finally { await context.close() }
})

await t('顶部提示条与下方表单之间有可见间距（≥10px）', async () => {
  const s = seed(); const { dialog, context, errors } = await openOrderDialog(s)
  try {
    const alert = await dialog.locator('.draft-alert').boundingBox()
    const firstItem = await dialog.locator('.el-form-item').first().boundingBox()
    assert.ok(alert && firstItem)
    const gap = firstItem.y - (alert.y + alert.height)
    assert.ok(gap >= 10, `提示条与表单间距应≥10px，实际 ${gap.toFixed(1)}px`)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await browser.close()
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
