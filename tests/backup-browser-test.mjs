// 数据备份（真浏览器）：全量导出是否真的把未过账订单/退款核销单打进 JSON；全量导入是否用 restore
// 把它们写回；旧备份（不含这两类）是否保持兼容；分类导入订单是否按单号去重。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/backup-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { existsSync } from 'node:fs'

const line = (code, name, qty, price) => ({ code, name, unit: '个', qty, price, total: Math.round(qty * price * 100) / 100 })

const seed = () => ({
  items: [{ code: 'P00001', name: '管件', unit: '个', price: 10, cost: 8 }],
  customers: [{ code: 'C00001', name: '客户甲' }],
  suppliers: [{ code: 'S00001', name: '供应商甲' }],
  purchases: [{ id: 'C1', date: '2026-10-01', supplier: '供应商甲', total: 40, discount: 0, payments: [], items: [line('P00001', '管件', 4, 10)] }],
  sales: [{ id: 'X1', date: '2026-10-02', customer: '客户甲', total: 20, discount: 0, payments: [], items: [line('P00001', '管件', 2, 10)] }],
  receipts: [{ code: 'SK-0001', kind: 'receivable', party: '客户甲', date: '2026-10-02', total: 20, items: [{ orderId: 'X1', amount: 20 }] }],
  'payment-vouchers': [{ code: 'FK-0001', kind: 'payable', party: '供应商甲', date: '2026-10-01', total: 40, items: [{ orderId: 'C1', amount: 40 }] }],
  orders: [{ id: 'D202610280900000001', status: '未过账', kind: 'sale', customer: '客户甲', date: '2026-10-28', items: [line('P00001', '管件', 2, 10)] }],
  refunds: [{ code: 'TK-20261020-0001', kind: 'sale', category: 'refund', direction: 'to_customer', party: '客户甲', total: 20, date: '2026-10-20' }],
  logs: []
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  await context.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    const key = pathname.slice(5)
    const send = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    if (request.method() === 'GET') return send(key === 'session' ? { ok: true } : (state[key] ?? []))
    const body = request.postDataJSON?.() || null
    state.posts = [...(state.posts || []), { key, body }]
    if (key === 'orders' && body?.action === 'restore') return send({ ok: true, restored: (body.orders || []).length })
    if (key === 'refunds' && body?.action === 'restore') return send({ ok: true, restored: (body.refunds || []).length })
    if (key === 'import-merge') return send({ ok: true, added: 1, skippedKey: 1, skippedName: 0, invalid: 0, total: 3 })
    return send({ ok: true })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${BASE}/data`, { waitUntil: 'networkidle' })
  return { page, context, state, errors }
}

const typeRow = (page, label) => page.locator('.type-table .el-table__row', { hasText: label }).first()

console.log('\n分类导入导出：订单 / 退款也有一行')

await t('表格列出未过账订单与退款/核销单，并显示库内数量', async () => {
  const s = seed(); const { page, context, errors } = await open(s)
  try {
    const orderRow = typeRow(page, '未过账订单')
    const refundRow = typeRow(page, '退款/核销单')
    await orderRow.waitFor()
    assert.match((await orderRow.innerText()).replace(/\s+/g, ' '), /1 单/)
    assert.match((await refundRow.innerText()).replace(/\s+/g, ' '), /1 单/)
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n全量导出：JSON 里必须带上 orders / refunds')

await t('导出的备份文件包含未过账订单与退款核销单', async () => {
  const s = seed(); const { page, context, errors } = await open(s)
  try {
    // 捕获导出用的 Blob：不依赖浏览器下载目录，直接读 JSON 文本
    await page.evaluate(() => {
      window.__exported = null
      const orig = URL.createObjectURL
      URL.createObjectURL = (blob) => { blob.text().then(txt => { window.__exported = txt }) ; return orig.call(URL, blob) }
    })
    await page.getByRole('button', { name: '导出全部数据' }).click()
    await page.waitForFunction(() => !!window.__exported, null, { timeout: 5000 })
    const payload = JSON.parse(await page.evaluate(() => window.__exported))
    assert.equal(payload.app, 'stock-git-ai')
    assert.equal(payload.data.orders.length, 1)
    assert.equal(payload.data.orders[0].id, 'D202610280900000001')
    assert.equal(payload.data.refunds.length, 1)
    assert.equal(payload.data.refunds[0].code, 'TK-20261020-0001')
    // 原有 7 类不能被挤掉
    for (const k of ['items', 'customers', 'suppliers', 'sales', 'purchases', 'receipts', 'payment-vouchers']) {
      assert.ok(Array.isArray(payload.data[k]), `缺少 ${k}`)
    }
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

console.log('\n全量导入：新备份用 restore 写回订单与退款')

async function importBackup(page, payload) {
  const buf = Buffer.from(JSON.stringify(payload))
  await page.locator('.backup-upload input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: buf })
  await page.locator('.summary').waitFor()
  await page.getByRole('button', { name: '确认导入（覆盖现有数据）' }).click()
  await page.locator('.el-message-box').getByRole('button', { name: '确认覆盖导入' }).click()
  await page.waitForTimeout(500)
}

await t('导入顺序与落库口径：9 类依次写入，订单/退款走 restore', async () => {
  const s = seed(); const { page, context, state } = await open(s)
  try {
    const payload = {
      app: 'stock-git-ai', version: 1, exportedAt: '2026-10-30T00:00:00.000Z',
      data: {
        items: s.items, customers: s.customers, suppliers: s.suppliers,
        sales: s.sales, purchases: s.purchases, receipts: s.receipts,
        'payment-vouchers': s['payment-vouchers'], orders: s.orders, refunds: s.refunds
      }
    }
    const summary = await page.locator('.summary').count()
    assert.equal(summary, 0)
    await importBackup(page, payload)
    const posts = state.posts || []
    assert.deepEqual(posts.map(p => p.key), ['items', 'suppliers', 'customers', 'purchases', 'sales', 'receipts', 'payment-vouchers', 'orders', 'refunds'])
    const orderPost = posts.find(p => p.key === 'orders')
    assert.equal(orderPost.body.action, 'restore')
    assert.equal(orderPost.body.orders.length, 1)
    const refundPost = posts.find(p => p.key === 'refunds')
    assert.equal(refundPost.body.action, 'restore')
    assert.equal(refundPost.body.refunds.length, 1)
  } finally { await context.close() }
})

await t('旧备份（不含订单/退款）保持兼容：不碰现有草稿与退款单', async () => {
  const s = seed(); const { page, context, state } = await open(s)
  try {
    const old = {
      app: 'stock-git-ai', version: 1, exportedAt: '2026-09-01T00:00:00.000Z',
      data: { items: s.items, customers: s.customers, suppliers: s.suppliers, sales: s.sales, purchases: s.purchases }
    }
    await page.locator('.backup-upload input[type=file]').setInputFiles({ name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) })
    await page.locator('.summary').waitFor()
    // 摘要里不显示这两类（文件里没有）
    assert.equal(await page.locator('.summary').getByText('未过账订单').count(), 0)
    await page.getByRole('button', { name: '确认导入（覆盖现有数据）' }).click()
    await page.locator('.el-message-box').getByRole('button', { name: '确认覆盖导入' }).click()
    await page.waitForTimeout(400)
    const keys = (state.posts || []).map(p => p.key)
    assert.equal(keys.includes('orders'), false, '旧备份不该调用订单 restore')
    assert.equal(keys.includes('refunds'), false, '旧备份不该调用退款 restore')
  } finally { await context.close() }
})

console.log('\n分类导入订单：按单号去重')

await t('粘贴 2 条（1 重复 + 1 新增）→ 预览只追加新增那条', async () => {
  const s = seed(); const { page, context, state, errors } = await open(s)
  try {
    const row = typeRow(page, '未过账订单')
    await row.getByRole('button', { name: '粘贴文本' }).click()
    const dialog = page.locator('.el-dialog:visible').last()
    await dialog.waitFor()
    const incoming = [
      { ...s.orders[0] },
      { id: 'D202610290900000002', status: '未过账', kind: 'sale', customer: '客户甲', date: '2026-10-29', items: [line('P00001', '管件', 1, 10)] }
    ]
    await dialog.locator('textarea').fill(JSON.stringify({ orders: incoming }))
    await dialog.getByRole('button', { name: '解析并比对' }).click()
    const preview = page.locator('.el-dialog:visible').last()
    await preview.locator('.preview-stats').waitFor()
    const stats = (await preview.locator('.preview-stats').innerText()).replace(/\s+/g, ' ')
    assert.match(stats, /将新增 1/)
    assert.match(stats, /重复跳过 1/)
    await preview.getByRole('button', { name: /确认导入（追加 1 条）/ }).click()
    await page.waitForTimeout(400)
    const post = (state.posts || []).find(p => p.key === 'import-merge')
    assert.equal(post.body.key, 'orders')
    assert.equal(post.body.records.length, 1)
    assert.equal(post.body.records[0].id, 'D202610290900000002')
    assert.deepEqual(errors, [], '页面不得报错')
  } finally { await context.close() }
})

await browser.close()
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }
console.log(`\n全部 ${pass} 项通过`)
