// 本请求新增功能：打印字号 2 倍、用户信息落款、外链分享（生成/取消/时效/二维码）、公开只读页。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/profile-share-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'

const BASE = 'http://127.0.0.1:5173'
const systemChrome = ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => existsSync(p))
const browser = await chromium.launch(systemChrome ? { headless: true, executablePath: systemChrome } : { headless: true })
let pass = 0, fail = 0

const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}

const line = (code, name, qty, price, discountRate = 1) => ({
  code, name, qty, price, discountRate,
  discount: Math.round(qty * price * (1 - discountRate) * 100) / 100,
  total: Math.round(qty * price * discountRate * 100) / 100
})

const SALE_ID = 'X202610291000000001'
const PURCHASE_ID = 'C202610291000000001'
const ORDER_ID = 'D202610291000000001'

const sale = () => ({
  id: SALE_ID, customer: '客户甲', date: '2026-10-29',
  total: 25, discount: 0, discountRates: [0.9], payments: [],
  items: [line('P00001', '管件', 2, 10), line('P00002', '弯头', 1, 5)]
})
const purchase = () => ({
  id: PURCHASE_ID, supplier: '供应商甲', date: '2026-10-29',
  total: 100, discount: 0, payments: [{ type: 'paid', amount: 40, date: '2026-10-29' }],
  items: [line('P00001', '管件', 10, 10)]
})
const order = () => ({
  id: ORDER_ID, no: 'SO-001', kind: 'sale', status: '草稿', customer: '客户甲', date: '2026-10-29',
  total: 20, discount: 2, discountRates: [], deposits: [{ amount: 5, date: '2026-10-29' }],
  items: [line('P00001', '管件', 2, 10)]
})

const PROFILE = { name: '某某建材经营部', phone: '13800000000', address: '城南路 1 号', remark: '微信同号' }

const shareRow = (over = {}) => ({
  token: 'a'.repeat(36), kind: 'sale', docId: SALE_ID,
  createdAt: '2026-10-29T10:00:00.000Z',
  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  expired: false, docLabel: '销售单', party: '客户甲', date: '2026-10-29',
  amount: 22.5, status: '正常', missing: false, voided: false, ...over
})

const sharePayload = (over = {}) => ({
  readOnly: true, kind: 'sale',
  share: { token: 'a'.repeat(36), createdAt: '2026-10-29T10:00:00.000Z', expiresAt: over.expiresAt ?? null },
  doc: {
    id: SALE_ID, no: '', date: '2026-10-29', party: '客户甲', partyLabel: '客户',
    docLabel: '销售单', status: '正常', remark: '送货前请联系', isReturn: false, ...over.doc
  },
  lines: [
    { code: 'P00001', name: '管件', unit: '个', qty: 2, price: 10, discountRate: 1, discount: 0, total: 20, net: 18, hasDiscount: false },
    { code: 'P00002', name: '弯头', unit: '个', qty: 1, price: 5, discountRate: 1, discount: 0, total: 5, net: 4.5, hasDiscount: false }
  ],
  totals: {
    gross: 25, lineDiscount: 0, total: 25, rateText: '×0.90', discountAmount: 2.5,
    discountedTotal: 22.5, discount: 0, due: 22.5, paid: 0, unpaid: 22.5,
    hasLineDiscount: false, hasOrderDiscount: true, ...over.totals
  },
  ...over.rest
})

// state: { 'sales': [...], 'profile': {...}, 'shares': [...], sharePayload: {...}, posts: [...] }
async function open(path, state = {}, { authed = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  if (authed) await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  const posts = []
  let shares = [...(state.shares || [])]
  await context.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    const send = (data, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(data)
    })
    if (pathname === '/api/session') return send({ ok: true })
    if (request.method() === 'GET') {
      if (pathname.startsWith('/api/share/')) {
        const p = state.sharePayload
        return p ? send(p) : send({ error: '分享链接无效或已取消' }, 404)
      }
      if (pathname === '/api/profile') return send(state.profile ?? {})
      if (pathname === '/api/shares') return send({ shares })
      const key = pathname.slice(5)
      return send(state[key] ?? [])
    }
    if (request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}')
      posts.push({ path: pathname, body })
      if (pathname === '/api/profile') return send({ ok: true, profile: { ...PROFILE, ...body } })
      if (pathname === '/api/shares') {
        if (body.action === 'create') {
          const created = shareRow({ docId: body.docId, kind: body.kind, expiresAt: body.days ? new Date(Date.now() + body.days * 86400000).toISOString() : null })
          shares = [created, ...shares]
          return send({ ok: true, share: created, token: created.token, reused: false })
        }
        if (body.action === 'cancel') { shares = shares.filter(s => s.token !== body.token); return send({ ok: true }) }
        if (body.action === 'update') {
          shares = shares.map(s => s.token === body.token
            ? { ...s, expiresAt: body.days ? new Date(Date.now() + body.days * 86400000).toISOString() : null, expired: false }
            : s)
          return send({ ok: true, share: shares.find(s => s.token === body.token) })
        }
      }
      return send({ ok: true })
    }
    return send({ ok: true })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  return { page, context, errors, posts, currentShares: () => shares }
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
const messages = (page) => page.locator('.el-message').allInnerTexts()
// el-radio-button 的真实 input 是透明的，点 label 才生效
const pickRadio = async (scope, text) => scope.locator(`.el-radio-button__inner:text-is("${text}")`).first().click()
const until = async (fn, timeout = 5000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const v = await fn()
    if (v) return v
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('等待超时')
}

console.log('\n系统 → 用户信息')

await t('菜单「系统」里有「用户信息」「外链分享」，进入后可填写并保存四个字段', async () => {
  const { page, context, errors, posts } = await open('/profile', { profile: PROFILE })
  try {
    const menu = await page.locator('.aside .menu').innerText()
    assert.match(menu, /用户信息/)
    assert.match(menu, /外链分享/)
    const inputs = page.locator('.profile-form input')
    assert.equal((await inputs.first().inputValue()), '某某建材经营部')
    await page.locator('.profile-form input').nth(1).fill('13900000000')
    await page.getByRole('button', { name: '保存' }).click()
    const post = await until(() => posts.find(p => p.path === '/api/profile'))
    assert.equal(post.body.phone, '13900000000')
    assert.equal(post.body.name, '某某建材经营部')
    const msg = (await messages(page)).join(' ')
    assert.match(msg, /已保存|保存成功/)
    // 落款预览跟随表单
    assert.match(await page.locator('.preview-body').innerText(), /电话：13900000000/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n详情页「显示用户信息」→ 页面落款 + 打印落款')

for (const [label, path, seed, key] of [
  ['销售单', `/sale/${SALE_ID}`, sale, 'sales'],
  ['采购单', `/purchase/${PURCHASE_ID}`, purchase, 'purchases'],
  ['订单', `/order/${ORDER_ID}`, order, 'orders']
]) {
  await t(`${label}：勾选后页面出现落款，打印把用户信息跟在商品列表底部`, async () => {
    const { page, context, errors } = await open(path, { [key]: [seed()], profile: PROFILE })
    try {
      const foot = page.locator('.print-foot')
      assert.equal(await foot.count(), 0, '默认不显示落款')
      await page.getByText('显示用户信息', { exact: true }).click()
      await page.waitForTimeout(200)
      const text = (await foot.innerText()).replace(/\s+/g, ' ')
      assert.match(text, /联系名称：某某建材经营部/)
      assert.match(text, /电话：13800000000/)
      assert.match(text, /地址：城南路 1 号/)
      assert.match(text, /备注：微信同号/)

      await capturePrint(page)
      const html = await printed(page)
      assert.match(html, /<div class="foot">/, '打印 HTML 需含落款容器')
      assert.match(html, /<span class="fi"><b>联系名称：<\/b>某某建材经营部<\/span>/)
      assert.match(html, /<span class="fi"><b>地址：<\/b>城南路 1 号<\/span>/)
      // 落款必须在表格之后
      assert.ok(html.indexOf('<table') < html.indexOf('<div class="foot">'), '落款要跟在商品列表底部')
      assert.deepEqual(errors, [], '页面不得报错')
    } finally { await context.close() }
  })
}

await t('未填写用户信息时勾选：页面提示去「系统 → 用户信息」，打印不带空落款', async () => {
  const { page, context, errors } = await open(`/sale/${SALE_ID}`, { sales: [sale()], profile: {} })
  try {
    await page.getByText('显示用户信息', { exact: true }).click()
    await page.waitForTimeout(300)
    assert.match(await page.locator('.print-foot').innerText(), /尚未填写用户信息/)
    const msg = (await messages(page)).join(' ')
    assert.match(msg, /尚未填写用户信息|用户信息/)
    await capturePrint(page)
    const html = await printed(page)
    assert.doesNotMatch(html, /<div class="foot">/, '全空字段不应产生落款块')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('取消勾选后落款从页面和打印一起消失', async () => {
  const { page, context } = await open(`/sale/${SALE_ID}`, { sales: [sale()], profile: PROFILE })
  try {
    await page.getByText('显示用户信息', { exact: true }).click()
    await page.waitForTimeout(150)
    await page.getByText('显示用户信息', { exact: true }).click()
    await page.waitForTimeout(150)
    assert.equal(await page.locator('.print-foot').count(), 0)
    await capturePrint(page)
    assert.doesNotMatch(await printed(page), /<div class="foot">/)
  } finally { await context.close() }
})

console.log('\n打印字号：订单金额放大两倍')

await t('订单详情打印单头「订单金额」用 xl 样式（24px）', async () => {
  const { page, context, errors } = await open(`/order/${ORDER_ID}`, { orders: [order()], profile: {} })
  try {
    await capturePrint(page)
    const html = await printed(page)
    assert.match(html, /<div class="f xl"><b>订单金额：<\/b>/)
    assert.match(html, /\.fields \.f\.xl \{ font-size: 24px/, '打印样式需内置 2 倍字号规则')
    // 其余字段不受影响
    assert.doesNotMatch(html, /<div class="f xl"><b>客户：/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('订单列表打印单头「订单金额」同样是 xl 样式', async () => {
  const { page, context, errors } = await open('/orders', {
    orders: [order()], sales: [], purchases: [],
    items: [{ code: 'P00001', name: '管件', unit: '个', price: 12, cost: 8 }],
    customers: [{ code: 'C00001', name: '客户甲' }], suppliers: [{ code: 'S00001', name: '供应商甲' }]
  })
  try {
    const row = page.locator('.el-table__row', { hasText: ORDER_ID }).first()
    await row.waitFor({ timeout: 5000 })
    await capturePrint(page)
    const html = await printed(page, row.getByRole('button', { name: '打印', exact: true }))
    assert.match(html, /<div class="f xl"><b>订单金额：<\/b>/)
    assert.match(html, /¥18\.00/, '订单金额 = 合计 20 - 整单优惠 2')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n详情页分享弹窗：生成 / 复制 / 二维码 / 取消')

await t('销售单详情点「分享」→ 生成只读链接并显示状态', async () => {
  const { page, context, errors, posts, currentShares } = await open(`/sale/${SALE_ID}`, { sales: [sale()], profile: {}, shares: [] })
  try {
    await page.getByRole('button', { name: '分享' }).click()
    const dialog = page.locator('.el-dialog', { hasText: '分享销售单' })
    await dialog.waitFor({ timeout: 5000 })
    await pickRadio(dialog, '30 天')
    await dialog.getByRole('button', { name: '生成分享链接' }).click()
    const post = await until(() => posts.find(p => p.path === '/api/shares' && p.body.action === 'create'))
    assert.equal(post.body.kind, 'sale')
    assert.equal(post.body.docId, SALE_ID)
    assert.equal(post.body.days, 30)
    await until(async () => {
      const input = dialog.locator('.el-input input').first()
      return /\/share\/[a-f0-9]{36}$/.test(await input.inputValue())
    })
    const link = await dialog.locator('.el-input input').first().inputValue()
    assert.equal(link, `${BASE}/share/${currentShares()[0].token}`)
    assert.match(await dialog.innerText(), /有效/)
    // 作废单不显示分享入口
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('已有分享：直接展示链接，可出二维码、可取消（带确认框）', async () => {
  const { page, context, posts } = await open(`/sale/${SALE_ID}`, {
    sales: [sale()], profile: {}, shares: [shareRow()]
  })
  try {
    await page.getByRole('button', { name: '分享' }).click()
    const dialog = page.locator('.el-dialog', { hasText: '分享销售单' })
    await dialog.waitFor({ timeout: 5000 })
    await until(async () => /\/share\/a{36}/.test(await dialog.locator('.el-input input').first().inputValue()))

    await dialog.getByRole('button', { name: '二维码' }).click()
    // el-dialog 是嵌套结构，用外层 .el-overlay-dialog 作为作用域，避免严格模式撞车
    const qr = page.locator('.el-overlay-dialog', { hasText: '分享二维码' })
    await qr.waitFor({ timeout: 5000 })
    await qr.locator('img.qr-img').waitFor({ timeout: 5000 })
    const src = await qr.locator('img.qr-img').getAttribute('src')
    assert.match(src, /^data:image\/(png|jpeg);base64,/, '二维码应渲染为图片')
    assert.match(await qr.locator('.qr-url input').inputValue(), /\/share\/a{36}/)
    await qr.getByRole('button', { name: '关闭', exact: true }).click()

    await dialog.getByRole('button', { name: '取消分享' }).click()
    const box = page.locator('.el-message-box')
    await box.waitFor({ timeout: 5000 })
    await box.getByRole('button', { name: '取消分享' }).click()
    const post = await until(() => posts.find(p => p.path === '/api/shares' && p.body.action === 'cancel'))
    assert.equal(post.body.token, 'a'.repeat(36))
    await until(async () => !!(await dialog.getByRole('button', { name: '生成分享链接' }).count()))
    assert.equal((await posts.filter(p => p.body?.action === 'cancel')).length, 1)
  } finally { await context.close() }
})

await t('已作废单据不显示分享入口', async () => {
  const voided = sale()
  voided.voided = true
  const { page, context } = await open(`/sale/${SALE_ID}`, { sales: [voided], profile: {}, shares: [] })
  try {
    assert.equal(await page.getByRole('button', { name: '分享' }).count(), 0)
  } finally { await context.close() }
})

console.log('\n外链分享管理页 /shares')

await t('列表统一展示三类分享，可按状态区分', async () => {
  // 后端按 createdAt 倒序返回，mock 这里给同样的顺序（missing 的那条最早）
  const rows = [
    shareRow({ token: 'c'.repeat(36), kind: 'order', docId: ORDER_ID, docLabel: '销售订单', party: '客户甲', amount: 15, createdAt: '2026-10-29T12:00:00.000Z', expiresAt: null }),
    shareRow({ token: 'b'.repeat(36), kind: 'purchase', docId: PURCHASE_ID, docLabel: '采购单', party: '供应商甲', amount: 60, createdAt: '2026-10-29T11:00:00.000Z' }),
    shareRow({ createdAt: '2026-10-29T10:00:00.000Z' }),
    shareRow({ token: 'd'.repeat(36), docId: 'Xgone', createdAt: '2026-10-29T09:00:00.000Z', missing: true, status: '已删除', expiresAt: new Date(Date.now() - 86400000).toISOString(), expired: true })
  ]
  const { page, context, errors } = await open('/shares', { shares: rows })
  try {
    await page.locator('.el-table__row').first().waitFor({ timeout: 5000 })
    assert.equal(await page.locator('.el-table__row').count(), 4)
    const text = await page.locator('.el-table').innerText()
    assert.match(text, /销售单/)
    assert.match(text, /采购单/)
    assert.match(text, /销售订单/)
    assert.match(text, /长期有效/)
    assert.match(text, /单据已删除/)
    assert.match(text, /至 /)
    // 单据号在分享管理页可跳回内部详情页
    const links = await page.locator('.el-table__row a.link').allInnerTexts()
    assert.deepEqual(links, [ORDER_ID, PURCHASE_ID, SALE_ID], 'missing 的行不给链接，按创建时间倒序')
    const tags = await page.locator('.el-table__row .el-tag').allInnerTexts()
    assert.deepEqual(tags, ['有效', '有效', '有效', '单据已删除'])
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('时效：改成 1 天后按现在重新计算有效期', async () => {
  const before = Date.now()
  const { page, context, posts, currentShares } = await open('/shares', { shares: [shareRow({ expiresAt: new Date(before + 90 * 86400000).toISOString() })] })
  try {
    await page.locator('.el-table__row').first().waitFor({ timeout: 5000 })
    assert.match(await page.locator('.el-table__row').first().innerText(), /至 /)
    await page.getByRole('button', { name: '时效' }).click()
    const dialog = page.locator('.el-dialog', { hasText: '修改分享时效' })
    await dialog.waitFor({ timeout: 5000 })
    await pickRadio(dialog, '1 天')
    await dialog.getByRole('button', { name: '保存' }).click()
    const post = await until(() => posts.find(p => p.body?.action === 'update'))
    assert.equal(post.body.token, 'a'.repeat(36))
    assert.equal(post.body.days, 1)
    const expiresAt = await until(async () => {
      const s = currentShares().find(x => x.token === 'a'.repeat(36))
      return s && s.expiresAt && Date.parse(s.expiresAt) < before + 30 * 86400000 ? s.expiresAt : null
    })
    const left = Date.parse(expiresAt) - Date.now()
    assert.ok(left > 23 * 3600000 && left <= 24 * 3600000 + 60000, `有效期应约为 1 天，实际 ${left / 3600000} 小时`)
    await until(async () => (await messages(page)).join(' ').includes('已更新有效期'))
  } finally { await context.close() }
})

await t('管理页复制链接给出 /share/<token>，取消分享走确认框', async () => {
  const { page, context, posts } = await open('/shares', { shares: [shareRow()] })
  try {
    await page.locator('.el-table__row').first().waitFor({ timeout: 5000 })
    await page.getByRole('button', { name: '复制链接' }).click()
    await until(async () => (await messages(page)).join(' ').includes('链接已复制'))
    await page.locator('.el-table__row').first().getByRole('button', { name: '取消', exact: true }).click()
    const box = page.locator('.el-message-box')
    await box.waitFor({ timeout: 5000 })
    assert.match(await box.innerText(), /取消 X{36}|销售单/)
    await box.getByRole('button', { name: '取消分享' }).click()
    const post = await until(() => posts.find(p => p.body?.action === 'cancel'))
    assert.equal(post.body.token, 'a'.repeat(36))
    await until(async () => !!(await page.locator('.el-table__row').count() === 0))
  } finally { await context.close() }
})

console.log('\n公开只读页 /share/:token（未登录）')

await t('未登录可直接打开：显示明细与合计、只读标识、有效期', async () => {
  const { page, context, errors } = await open(`/share/${'a'.repeat(36)}`, { sharePayload: sharePayload({ expiresAt: new Date(Date.now() + 86400000).toISOString() }) }, { authed: false })
  try {
    await page.locator('.share-card').waitFor({ timeout: 5000 })
    const text = await page.locator('.share-card').innerText()
    assert.match(text, /销售单/)
    assert.match(text, /客户甲/)
    assert.match(text, /只读分享/)
    assert.match(text, /管件/)
    // 整单折扣：隐藏行折扣列、保留折后金额列
    const head = await page.locator('.share-table thead').innerText()
    assert.doesNotMatch(head, /折扣率/)
    assert.match(head, /折后金额/)
    assert.match(text, /22\.50/)
    assert.match(text, /有效期至/)
    assert.match(text, /此链接仅供查看，无编辑权限/)
    // 无任何编辑入口
    assert.equal(await page.locator('button, .el-button').count(), 0, '公开页不应有按钮')
    assert.equal(await page.locator('.el-menu').count(), 0, '公开页不应出现后台菜单')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('有行折扣时显示折扣率/本次折扣列；无整单折扣时不显示折后金额', async () => {
  const payload = sharePayload({
    totals: { hasLineDiscount: true, hasOrderDiscount: false, lineDiscount: 2, gross: 27, total: 25, due: 25, paid: 5, unpaid: 20, rateText: '', discountedTotal: 25, discountAmount: 0, discount: 0 }
  })
  payload.lines = [
    { code: 'P00001', name: '管件', unit: '个', qty: 2, price: 10, discountRate: 0.9, discount: 2, total: 18, net: 18, hasDiscount: true },
    { code: 'P00002', name: '弯头', unit: '个', qty: 1, price: 7, discountRate: 1, discount: 0, total: 7, net: 7, hasDiscount: false }
  ]
  const { page, context, errors } = await open(`/share/${'a'.repeat(36)}`, { sharePayload: payload }, { authed: false })
  try {
    await page.locator('.share-card').waitFor({ timeout: 5000 })
    const head = await page.locator('.share-table thead').innerText()
    assert.match(head, /折扣率/)
    assert.match(head, /本次折扣/)
    assert.doesNotMatch(head, /折后金额/)
    assert.match(await page.locator('.share-card').innerText(), /-2\.00/)
    assert.doesNotMatch(await page.locator('.totals').innerText(), /整单折扣/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await t('长期有效链接页脚显示「长期有效」', async () => {
  const { page, context } = await open(`/share/${'a'.repeat(36)}`, { sharePayload: sharePayload({ expiresAt: null }) }, { authed: false })
  try {
    await page.locator('.share-foot').waitFor({ timeout: 5000 })
    assert.match(await page.locator('.share-foot').innerText(), /长期有效/)
  } finally { await context.close() }
})

await t('链接失效（404/410）：显示提示卡片而不是登录页', async () => {
  for (const [status, msg] of [[404, '分享链接无效或已取消'], [410, '分享链接已过期']]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname
      // 只拦真实接口，避免把 vite 的 /src/api/index.js 模块也 fulfill 成 JSON
      if (!pathname.startsWith('/api/')) return route.continue()
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: msg }) })
    })
    const page = await context.newPage()
    try {
      await page.goto(`${BASE}/share/${'a'.repeat(36)}`, { waitUntil: 'networkidle' })
      await page.locator('.share-tip-card').waitFor({ timeout: 5000 })
      assert.match(await page.locator('.share-tip-card').innerText(), new RegExp(msg))
      assert.equal(await page.locator('.login-card, form').count(), 0, '不应把外链访问者踢到登录页')
    } finally { await context.close() }
  }
})

await t('公开页深链直接访问不依赖登录票据（Worker 走 SPA 回退）', async () => {
  const payload = sharePayload({ expiresAt: null })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) })
  })
  const page = await context.newPage()
  try {
    await page.goto(`${BASE}/share/${'a'.repeat(36)}`, { waitUntil: 'networkidle' })
    assert.equal(await page.evaluate(() => sessionStorage.getItem('stock.auth.token')), null)
    await page.locator('.share-card').waitFor({ timeout: 5000 })
    assert.match(await page.locator('.share-card').innerText(), /销售单/)
  } finally { await context.close() }
})

await browser.close()
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
