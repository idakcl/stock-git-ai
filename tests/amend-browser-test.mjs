// 订单 + 单据变更（真浏览器）：锁定两处最容易错的界面行为——
//   ① 已动过钱的单据打开编辑弹窗时，明细/折扣/优惠/结算必须整体锁死，且给出「变更明细」入口；
//   ② 变更弹窗只提交行索引与数量，金额由服务端重算；同编码追加时单价锁回原单价。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/amend-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'

const seed = () => ({
  sales: [{
    id: 'X1', date: '2026-10-20', customer: '客户甲', total: 140, discount: 14, received: 50,
    settle: '挂账', payments: [{ date: '2026-10-20', amount: 50, remark: '部分收款', time: '' }], photos: [],
    items: [
      { code: 'P00001', name: '管件', unit: '个', qty: 10, price: 10, total: 100 },
      { code: 'P00002', name: '阀门', unit: '个', qty: 2, price: 20, total: 40 }
    ]
  }],
  purchases: [],
  items: [
    { code: 'P00001', name: '管件', unit: '个', price: 10, cost: 8 },
    { code: 'P00002', name: '阀门', unit: '个', price: 20, cost: 15 },
    { code: 'P00003', name: '弯头', unit: '个', price: 6, cost: 5 }
  ],
  stock: { P00001: 100, P00002: 100, P00003: 100 },
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [], receipts: [], refunds: [], 'payment-vouchers': [], orders: [], logs: []
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  await context.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    const key = pathname.slice(5)
    const send = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    if (request.method() === 'GET') return send(key === 'session' ? { ok: true } : (state[key] ?? []))
    state.posts = [...(state.posts || []), { key, body: request.postDataJSON() }]
    if (key === 'amends') return send({ ok: true, code: 'XA-20261029-0001', returnId: 'XT-20261029-0001', amendId: 'XA-20261029-0001' })
    if (key === 'orders') return send({ ok: true, code: 'D20261029000000001', orderId: 'D20261029000000001' })
    return send({ ok: true })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  return { page, context, state, errors }
}

// 编辑弹窗（销售列表页第一行的「编辑」）
async function openEdit(state) {
  const ui = await open('/sales', state)
  await ui.page.getByRole('button', { name: '编辑' }).first().click()
  const dialog = ui.page.locator('.el-dialog:visible').first()
  await dialog.waitFor()
  return { ...ui, dialog }
}

console.log('\n已动过钱的单据：编辑弹窗锁明细 + 变更入口')

await t('明细与折扣整体锁定，并给出「变更明细」入口', async () => {
  const s = seed(); const { page, dialog, context, errors } = await openEdit(s)
  try {
    assert.equal(await dialog.locator('.lock-bar').count(), 1, '应显示资金锁定提示')
    assert.match((await dialog.locator('.lock-bar').innerText()).replace(/\s+/g, ''), /已记收付款流水/, '提示要说清锁定原因')
    // 明细表里不该再有任何输入框（锁定态改为纯文本展示）
    assert.equal(await dialog.locator('.lines-scroll input').count(), 0, '锁定后明细表不应再有输入框')
    assert.equal(await dialog.locator('.lines-scroll button').count(), 0, '锁定后不应再有删除行按钮')
    // 整单优惠、结算状态必须禁用
    assert.equal(await dialog.locator('.el-form-item', { hasText: '整单优惠金额' }).locator('input').first().isDisabled(), true)
    assert.equal(await dialog.getByRole('radio', { name: '结清' }).isDisabled().catch(() => true), true)
    // 但备注、实收金额还能改（补收是合法操作）
    assert.equal(await dialog.locator('.el-form-item', { hasText: '实收金额' }).locator('input').first().isDisabled(), false)
    assert.equal(await dialog.getByRole('button', { name: /变更明细/ }).count(), 1, '要有变更明细入口')
    assert.deepEqual(errors, [], '页面不得报错')
    await page.keyboard.press('Escape')
  } finally { await context.close() }
})

await t('没动过钱的单不锁定（明细仍可原地改）', async () => {
  const s = seed()
  s.sales[0] = { ...s.sales[0], payments: [], received: 0 }
  const { dialog, context, errors } = await openEdit(s)
  try {
    assert.equal(await dialog.locator('.lock-bar').count(), 0, '未动钱的单不该出现锁定条')
    assert.ok(await dialog.locator('.lines-scroll input').count() > 0, '明细仍可编辑')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n变更明细弹窗：退货 + 补差一次提交')

async function openAmend(state) {
  const ui = await openEdit(state)
  await ui.dialog.getByRole('button', { name: /变更明细/ }).click()
  const amend = ui.page.locator('.el-dialog:visible').last()
  await amend.waitFor()
  return { ...ui, amend }
}

await t('只退货不补差：提交退款行、金额由服务端算（界面只做预览）', async () => {
  const s = seed(); const { page, amend, context, errors, state } = await openAmend(s)
  try {
    const qty = amend.locator('.el-table').first().locator('.el-input-number input').first()
    await qty.fill('2')
    await page.waitForTimeout(150)
    const pv = (await amend.locator('.preview').innerText()).replace(/\s+/g, ' ')
    // 原单：140 × 0.9 = 126，管件行净额 100×0.9=90，退 2/10 → 18
    assert.match(pv, /本次退货（2 件） − ¥ 18\.00/, `退货预览应为 18.00：${pv}`)
    assert.match(pv, /变更后净成交金额 ¥ 108\.00/, `净成交应为 126−18=108：${pv}`)
    assert.equal(await amend.locator('.pv-error').count(), 0, '不该有校验错误')
    // 变更原因必填：没填时提交按钮直接禁用，不发出请求
    const submitBtn = amend.getByRole('button', { name: '确认变更' })
    assert.equal(await submitBtn.isDisabled(), true, '没填原因时提交按钮应禁用')
    assert.equal(state.posts?.filter(p => p.key === 'amends').length || 0, 0, '没填原因不能提交')
    await amend.locator('.el-form-item', { hasText: '变更原因' }).locator('input').fill('客户少要两件')
    await page.waitForTimeout(150)
    assert.equal(await submitBtn.isDisabled(), false, '填了原因后应可提交')
    await submitBtn.click()
    await page.locator('.el-message-box').getByRole('button', { name: '确定' }).click()
    await page.waitForTimeout(400)
    const post = (state.posts || []).find(p => p.key === 'amends')
    assert.ok(post, '应提交到 /api/amends')
    assert.equal(post.body.kind, 'sale')
    assert.equal(post.body.sourceOrderId, 'X1')
    assert.equal(post.body.party, '客户甲')
    assert.equal(post.body.reason, '客户少要两件')
    assert.deepEqual(post.body.refundLines, [{ index: 0, qty: 2 }])
    assert.deepEqual(post.body.amendLines, [])
    assert.match(post.body.requestId, /^[0-9a-f-]{36}$/, 'requestId 必须是 uuid，服务端据此幂等')
    assert.equal(await page.locator('.el-dialog:visible').count(), 0, '成功后两层弹窗都应关闭')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('追加已有商品时单价锁回原价；新商品按档案价带出', async () => {
  const s = seed(); const { page, amend, context, errors } = await openAmend(s)
  try {
    await amend.getByRole('button', { name: '添加行' }).click()
    const rows = amend.locator('.el-table').nth(1)
    const picker = rows.locator('.el-select input').first()
    await picker.click()
    await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: '管件' }).first().click()
    await page.waitForTimeout(150)
    // P00001 在原单里是 10 元（商品档案也是 10），必须锁死不可改
    const price = rows.locator('.el-input-number input').nth(1)
    assert.equal(await price.inputValue(), '10.00', '已有商品应沿用原单价')
    assert.equal(await price.isDisabled(), true, '已有商品单价应锁定')
    assert.match((await amend.innerText()).replace(/\s+/g, ''), /沿用原单价/, '要说明为什么锁定')
    // 换一个全新商品：档案价 6 可改
    await rows.locator('.el-select input').first().click()
    await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: '弯头' }).first().click()
    await page.waitForTimeout(150)
    const inputs = rows.locator('.el-input-number input')
    assert.equal(await inputs.nth(1).inputValue(), '6.00', '新商品带出档案售价')
    assert.equal(await inputs.nth(1).isDisabled(), false, '新商品单价可改')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('退货 + 补差同时提交，两张单一次请求生成', async () => {
  const s = seed(); const { page, amend, context, errors, state } = await openAmend(s)
  try {
    await amend.locator('.el-table').first().locator('.el-input-number input').nth(1).fill('1')
    await amend.getByRole('button', { name: '添加行' }).click()
    const rows = amend.locator('.el-table').nth(1)
    await rows.locator('.el-select input').first().click()
    await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: '弯头' }).first().click()
    await rows.locator('.el-input-number input').first().fill('3')
    await amend.locator('.el-form-item', { hasText: '变更原因' }).locator('input').fill('少退一个阀门、加三个弯头')
    await page.waitForTimeout(150)
    const pv = (await amend.locator('.preview').innerText()).replace(/\s+/g, ' ')
    // 阀门行净额 40×0.9=36，退 1/2 → 18；补差 3×6=18
    assert.match(pv, /本次退货（1 件） − ¥ 18\.00/, `退货预览：${pv}`)
    assert.match(pv, /本次补差（按原价，不含折扣） \+ ¥ 18\.00/, `补差预览：${pv}`)
    assert.match(pv, /变更后净成交金额 ¥ 126\.00/, `净成交不变：${pv}`)
    await amend.getByRole('button', { name: '确认变更' }).click()
    await page.locator('.el-message-box').getByRole('button', { name: '确定' }).click()
    await page.waitForTimeout(400)
    const post = (state.posts || []).find(p => p.key === 'amends')
    assert.deepEqual(post.body.refundLines, [{ index: 1, qty: 1 }])
    assert.deepEqual(post.body.amendLines, [{ code: 'P00003', name: '弯头', unit: '个', qty: 3, price: 6 }])
    assert.equal(post.body.mode, 'cash', '退货默认退现金')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('没有改动时不许提交；处理方式在只补差时禁用', async () => {
  const s = seed(); const { page, amend, context, errors, state } = await openAmend(s)
  try {
    assert.equal(await amend.getByRole('button', { name: '确认变更' }).isDisabled(), true, '未改动时按钮应禁用')
    await amend.getByRole('button', { name: '添加行' }).click()
    const rows = amend.locator('.el-table').nth(1)
    await rows.locator('.el-select input').first().click()
    await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: '弯头' }).first().click()
    await page.waitForTimeout(150)
    assert.equal(await amend.locator('.el-form-item', { hasText: '处理方式' }).locator('input').first().isDisabled(), true, '只补差不涉及退款，处理方式应禁用')
    assert.equal(await amend.getByRole('button', { name: '确认变更' }).isDisabled(), true, '没填原因时按钮应禁用')
    assert.equal(state.posts?.filter(p => p.key === 'amends').length || 0, 0, '没填原因不许提交')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n订单页：草稿落 orders.json、过账才生成单据')

await t('新建订单只提交 save，不碰销售单', async () => {
  const s = seed(); const { page, context, errors, state } = await open('/orders', s)
  try {
    await page.getByRole('button', { name: '新建订单' }).click()
    const dialog = page.locator('.el-dialog:visible').first()
    await dialog.waitFor()
    const party = dialog.locator('.el-form-item', { hasText: '客户' }).locator('.el-select input').first()
    await party.click()
    await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: '客户甲' }).first().click()
    await dialog.locator('.quick-add-select input').click()
    await page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: '管件' }).first().click()
    await dialog.locator('.lines-scroll .el-input-number input').first().fill('4')
    await page.waitForTimeout(150)
    assert.match((await dialog.locator('.calc-line').first().innerText()).replace(/\s+/g, ''), /订单金额：40\.00/, '金额＝数量×单价')
    await dialog.getByRole('button', { name: '保存订单' }).click()
    await page.waitForTimeout(400)
    const posts = (state.posts || []).filter(p => p.key === 'orders')
    assert.equal(posts.length, 1, '应且只应提交一次订单接口')
    assert.equal(posts[0].body.action, 'save')
    assert.equal(posts[0].body.order.kind, 'sale')
    assert.equal(posts[0].body.order.customer, '客户甲')
    assert.deepEqual(posts[0].body.order.items, [{ code: 'P00001', name: '管件', qty: 4, price: 10, total: 40 }])
    assert.equal(state.posts.some(p => p.key === 'sales'), false, '新建订单绝不能整表写销售单')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('草稿列表可过账：确认后提交 post', async () => {
  const s = seed()
  s.orders = [{ id: 'D20261029000000001', kind: 'sale', status: '草稿', customer: '客户甲', date: '2026-10-29',
    discount: 0, discountRates: [], items: [{ code: 'P00001', name: '管件', unit: '个', qty: 4, price: 10, total: 40 }], deposits: [] }]
  const { page, context, errors, state } = await open('/orders', s)
  try {
    await page.getByRole('button', { name: '过账' }).first().click()
    await page.locator('.el-message-box').getByRole('button', { name: '确定' }).click()
    await page.waitForTimeout(400)
    const post = (state.posts || []).find(p => p.key === 'orders')
    assert.equal(post.body.action, 'post')
    assert.equal(post.body.orderId, 'D20261029000000001')
    assert.match((await page.locator('.el-table').innerText()).replace(/\s+/g, ' '), /D20261029000000001/, '列表应显示该订单')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('已过账订单禁止编辑/删除，只提供撤销过账', async () => {
  const s = seed()
  s.orders = [{ id: 'D20261029000000002', kind: 'sale', status: '已过账', postedOrderId: 'X2', customer: '客户甲',
    date: '2026-10-29', discount: 0, discountRates: [], items: [{ code: 'P00001', name: '管件', qty: 4, price: 10, total: 40 }], deposits: [] }]
  const { page, context, errors } = await open('/orders', s)
  try {
    const ops = page.locator('.ops-col button')
    assert.equal(await ops.nth(0).isDisabled(), true, '已过账不能编辑')
    assert.equal(await ops.nth(1).isDisabled(), true, '已过账不能收订金')
    assert.equal(await ops.nth(2).isDisabled(), true, '已过账不能重复过账')
    assert.equal(await ops.nth(3).isDisabled(), false, '应可撤销过账')
    assert.equal(await ops.nth(4).isDisabled(), true, '已过账不能直接删除')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('看板显示待过账订单数并带订金', async () => {
  const s = seed()
  s.orders = [{ id: 'D20261029000000003', kind: 'sale', status: '草稿', customer: '客户甲', date: '2026-10-29',
    discount: 0, discountRates: [], items: [{ code: 'P00001', name: '管件', qty: 4, price: 10, total: 40 }],
    deposits: [{ date: '2026-10-29', amount: 10, voucher: 'SK-20261029-0001' }] }]
  const { page, context, errors } = await open('/', s)
  try {
    const card = page.locator('.orders-card')
    assert.equal(await card.count(), 1, '看板应出现待过账订单提示')
    assert.match((await card.innerText()).replace(/\s+/g, ' '), /待过账订单 1 张/, '数量正确')
    assert.match((await card.innerText()).replace(/\s+/g, ' '), /订金合计 ¥10\.00/, '已收订金要一起提醒')
    await card.getByRole('button', { name: '去处理' }).click()
    await page.waitForURL('**/orders')
    assert.equal(page.url().includes('/orders'), true, '点去处理应跳到订单页')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
