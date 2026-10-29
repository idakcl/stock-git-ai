// 结清联动回归（真浏览器）：锁定「el-input-number 的 input 事件早于 v-model 落地」这类时序 bug。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort），再 node tests/settle-link-browser-test.mjs
//
// 复现的用户反馈：编辑单里实收先填 7 → 点「结清」（优惠补成 68）→ 把实收改成 75，
// 优惠仍停在 68，页面变成「应收 7 / 实收 75 / 未收 0」，保存还会撞红线①。
// 原因：@input 里直接算补差，读到的是上一个值（Element Plus handleInput 先 emit('input')
// 再 emit('update:modelValue')），必须等一个 tick 让 v-model 落地。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const seed = () => ({
  sales: [{
    id: 'X1', date: '2026-10-29', customer: '客户甲', total: 75, discount: 0, received: 0,
    settle: '挂账', payments: [], photos: [],
    items: [{ code: 'P00001', name: '管件', unit: '个', qty: 50, price: 1.5, total: 75 }]
  }],
  purchases: [], items: [{ code: 'P00001', name: '管件', unit: '个', price: 1.5, cost: 1, stock: 100 }],
  stock: { P00001: 100 }, customers: [{ code: 'C00001', name: '客户甲', category: '零售' }],
  suppliers: [], receipts: [], refunds: [], 'payment-vouchers': [], logs: []
})

const BASE = 'http://127.0.0.1:5173'
// 沙箱里没装 Playwright 自带的浏览器，退回系统 Chromium；本地开发装了就用自带的。
import { existsSync } from 'node:fs'
const systemChrome = ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => existsSync(p))
const launch = systemChrome ? { headless: true, executablePath: systemChrome } : { headless: true }
const browser = await chromium.launch(launch)
let pass = 0, fail = 0

async function openDialog(state) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const key = path.slice(5)
    const send = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    if (request.method() === 'GET') return send(key === 'session' ? { ok: true } : (state[key] ?? []))
    state.posts = [...(state.posts || []), { key, body: request.postDataJSON() }]
    return send({ ok: true })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${BASE}/sales`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '编辑' }).first().click()
  const dialog = page.locator('.el-dialog:visible')
  await dialog.waitFor()
  const item = label => dialog.locator('.el-form-item').filter({ has: page.locator('.el-form-item__label', { hasText: label }) })
  const num = label => item(label).locator('.el-input-number input').first()
  return { page, context, dialog, item, num, errors, settle: async (v) => { await dialog.locator('.el-radio-button', { hasText: v }).click() } }
}

const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}

console.log('\n结清联动：改实收后优惠必须按新值补差（不能停在上一笔）')

await t('实收 7 → 结清（优惠 68）→ 实收改 75：优惠归 0、应收 75', async () => {
  const s = seed(); const ui = await openDialog(s)
  try {
    await ui.num('实收金额').fill('7')
    await ui.settle('结清')
    await ui.page.waitForTimeout(120)
    assert.equal(await ui.num('整单优惠金额').inputValue(), '68.00', '点结清后优惠应补成 68')
    await ui.num('实收金额').fill('75')
    await ui.page.waitForTimeout(120)   // 让 nextTick 联动跑完
    assert.equal(await ui.num('整单优惠金额').inputValue(), '0.00', '实收改 75 后优惠必须归 0，不能停在 68')
    assert.equal(Number(await ui.num('实收金额').inputValue()), 75)
    const calc = await ui.dialog.locator('.calc-line').first().innerText()
    assert.match(calc, /应收[：:]\s*75\.00/, `结算明细应显示应收 75：${calc}`)
    assert.deepEqual(ui.errors, [], '页面不得报错')
  } finally { await ui.context.close() }
})

await t('挂账单直接填实收 75：自动结清且优惠为 0', async () => {
  const s = seed(); const ui = await openDialog(s)
  try {
    await ui.num('实收金额').fill('75')
    await ui.page.waitForTimeout(150)
    assert.equal(await ui.num('整单优惠金额').inputValue(), '0.00')
    assert.equal(await ui.dialog.locator('.el-radio-button.is-active', { hasText: '结清' }).count(), 1, '收满后应自动标记结清')
    assert.deepEqual(ui.errors, [], '页面不得报错')
  } finally { await ui.context.close() }
})

await t('反向：优惠为基准，填优惠 68 → 实收补成 7', async () => {
  const s = seed(); const ui = await openDialog(s)
  try {
    await ui.settle('结清')
    await ui.num('整单优惠金额').fill('68')
    await ui.page.waitForTimeout(120)
    assert.equal(Number(await ui.num('实收金额').inputValue()), 7, '以优惠为基准时实收应补成 7')
    assert.deepEqual(ui.errors, [], '页面不得报错')
  } finally { await ui.context.close() }
})

await t('结清模式下实收框封顶在折后金额（填 200 夹回 75）', async () => {
  const s = seed(); const ui = await openDialog(s)
  try {
    await ui.settle('结清')
    await ui.num('实收金额').fill('200')
    await ui.page.waitForTimeout(120)
    const calc = await ui.dialog.locator('.calc-line').first().innerText()
    assert.match(calc, /应收[：:]\s*75\.00/, `模型应收应封顶在 75：${calc}`)
    await ui.num('实收金额').blur()
    await ui.page.waitForTimeout(120)
    assert.equal(Number(await ui.num('实收金额').inputValue()), 75, '结清时多收的部分存不进，输入框应封顶在 75')
    assert.equal(await ui.num('整单优惠金额').inputValue(), '0.00')
    assert.deepEqual(ui.errors, [], '页面不得报错')
  } finally { await ui.context.close() }
})

await t('编辑已有流水的单：实收框不能低于已记流水（下限＝cashFloor）', async () => {
  const s = seed()
  s.sales[0] = { ...s.sales[0], total: 100, received: 50, settle: '挂账', discount: 0,
    payments: [{ date: '2026-10-20', amount: 50, remark: '部分收款', time: '' }],
    items: [{ code: 'P00001', name: '管件', unit: '个', qty: 100, price: 1, total: 100 }] }
  const ui = await openDialog(s)
  try {
    assert.match((await ui.dialog.innerText()).replace(/\s+/g, ''), /已记收款流水¥50\.00是这一栏的下限/, '要写明这一栏只能持平或调高')
    await ui.num('实收金额').fill('10')
    await ui.page.waitForTimeout(120)
    await ui.num('实收金额').blur()
    await ui.page.waitForTimeout(120)
    assert.equal(Number(await ui.num('实收金额').inputValue()), 50, '调低到已记流水以下应被夹回 50，而不是静默失效')
    const calc = await ui.dialog.locator('.calc-line').first().innerText()
    assert.match(calc, /未收[：:]\s*50\.00/, `未收仍是 50：${calc}`)
    assert.deepEqual(ui.errors, [], '页面不得报错')
  } finally { await ui.context.close() }
})

await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
