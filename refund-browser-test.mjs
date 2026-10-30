import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { applyRefundOperation } from './src/utils/refunds.js'
const { chromium } = createRequire(import.meta.url)('playwright')
const browser = await chromium.launch({ headless: true, executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined })
const fixture = () => ({ logs: [], items: [{ code: 'P00001', name: '管件', cost: 10 }], stock: {}, refunds: [], customers: [{ code: 'C00001', name: '客户甲' }], suppliers: [{ code: 'S00001', name: '供应商甲' }],
  sales: [{ id: 'S1', date: '2026-10-01', customer: '客户甲', total: 100, discount: 10, payments: [], items: [{ code: 'P00001', name: '管件', qty: 10, price: 10, total: 100 }] }],
  purchases: [{ id: 'B1', date: '2026-10-01', supplier: '供应商甲', total: 100, paid: 100, items: [{ code: 'P00001', name: '管件', qty: 10, price: 10, total: 100 }] }] })
let state, failure, posts
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
await context.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname
  if (!path.startsWith('/api/')) return route.continue()
  const key = path.slice(5)
  const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
  if (request.method() === 'GET') return send(key === 'session' ? { ok: true } : state[key] || [])
  assert.equal(key, 'refunds', '不得写入其他接口')
  const input = request.postDataJSON(); posts.push(input)
  if (failure === 400 || failure === 409) { const status = failure; failure = null; return send({ error: '测试拒绝' }, status) }
  try {
    const result = applyRefundOperation(state, input); state = result.state
    if (failure === 'lost') { failure = null; return route.abort('failed') }
    return send({ ok: true, code: result.code, duplicate: result.duplicate })
  } catch (e) { return send({ error: e.message }, e.status || 500) }
})
const page = await context.newPage(), errors = []
page.on('pageerror', e => errors.push(e.message))
const dialog = page.locator('.el-dialog:visible')
const formItem = label => dialog.locator('.el-form-item').filter({ has: page.locator('.el-form-item__label', { hasText: label }) })
async function begin(kind = 'sale') {
  await page.goto(`http://127.0.0.1:5173/returns?kind=${kind}&source=${kind === 'sale' ? 'S1' : 'B1'}`)
  await dialog.waitFor()
  await dialog.getByRole('spinbutton').waitFor()
  assert.equal(await dialog.getByRole('spinbutton').inputValue(), '0')
  assert.match(await formItem('处理方式').innerText(), /退现金/)
  await dialog.getByRole('spinbutton').fill('2')
  await formItem('退货原因').locator('input').fill('验收退货')
}
async function setMode(label) {
  await formItem('处理方式').locator('.el-select').click()
  await page.getByRole('option', { name: label, exact: true }).click()
}
async function save() {
  await dialog.getByRole('button', { name: '确认保存', exact: true }).click()
  await page.locator('.el-message-box').getByRole('button', { name: '确定', exact: true }).click()
}
try {
  for (const [mode, label] of [['cash', null], ['pending', '先退货，暂不退款'], ['offset', '冲抵同单位欠款（先旧单）'], ['deposit', '转预存款 / 预付款']]) {
    state = fixture(); posts = []; failure = null
    await begin()
    if (label) await setMode(label)
    await save(); await dialog.waitFor({ state: 'hidden' })
    assert.equal(posts[0].mode, mode); assert.equal(state.sales[1].total, -18)
    if (mode === 'cash') assert.equal(state.refunds[0].total, 18)
    if (mode === 'pending') assert.equal(state.refunds.length, 0)
    if (mode === 'offset') assert.equal(state.refunds[0].settlementTotal, 18)
    if (mode === 'deposit') assert.equal(state.customers[0].deposits[0].amount, 18)
    console.log(`PASS 浏览器创建 ${mode}`)
  }
  // 退货原因非必填：留空不拦，服务端落库记「无」
  state = fixture(); posts = []; failure = null
  await begin()
  await formItem('退货原因').locator('input').fill('')
  await save(); await dialog.waitFor({ state: 'hidden' })
  assert.equal(posts[0].reason, ''); assert.equal(state.sales[1].returnReason, '无')
  console.log('PASS 退货原因留空：保存成功且落库记「无」')
  state = fixture(); posts = []; failure = null
  for (let i = 0; i < 2; i++) {
    await begin(); await setMode('先退货，暂不退款'); await save(); await dialog.waitFor({ state: 'hidden' })
  }
  await page.locator('.el-table__header-wrapper .el-checkbox').first().click()
  await page.getByRole('button', { name: '所选退货单退款', exact: true }).click()
  await dialog.getByRole('spinbutton').fill('20')
  await save(); await dialog.waitFor({ state: 'hidden' })
  assert.equal(state.refunds.length, 1); assert.equal(state.refunds[0].items.length, 2)
  assert.equal(state.refunds[0].total, 20); assert.equal(state.sales[2].received, -2)
  console.log('PASS 同单位两张退货合并、部分退款')
  state = fixture(); posts = []; failure = 'lost'
  await begin(); await save()
  await page.getByText(/结果不明，表单已锁定/).waitFor()
  assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
  await page.reload(); await dialog.waitFor()
  assert.equal(await dialog.getByRole('spinbutton').isDisabled(), true)
  await save(); await dialog.waitFor({ state: 'hidden' })
  assert.equal(posts.length, 2); assert.deepEqual(posts[0], posts[1]); assert.equal(state.refunds.length, 1)
  assert.equal(await page.evaluate(() => sessionStorage.getItem('stock.refund.pending')), null)
  console.log('PASS 提交成功响应丢失、刷新恢复、同请求幂等重试')
  for (const status of [400, 409]) {
    state = fixture(); posts = []; failure = status
    await begin(); await save()
    await page.getByText(status === 409 ? '数据已被其他操作更新，请取消并刷新后重试' : '测试拒绝', { exact: true }).waitFor()
    assert.equal(state.refunds.length, 0); assert.equal(await dialog.getByRole('spinbutton').isDisabled(), false)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    console.log(`PASS HTTP ${status} 拒绝且可取消修正`)
  }
  state = fixture(); posts = []; failure = null
  await page.setViewportSize({ width: 390, height: 844 })
  await begin('purchase')
  const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 391)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await save(); await dialog.waitFor({ state: 'hidden' })
  assert.equal(state.refunds[0].direction, 'from_supplier')
  console.log('PASS 手机采购退款及弹窗宽度')
  await page.goto('http://127.0.0.1:5173/vouchers')
  await page.getByRole('tab', { name: '退款单 TK', exact: true }).click()
  await page.getByText(state.refunds[0].code, { exact: true }).waitFor()
  await page.getByText('收供应商退款', { exact: true }).first().waitFor()
  console.log('PASS 退款凭证页签、编号和方向')
  await page.goto('http://127.0.0.1:5173/sale/S1')
  await page.getByRole('button', { name: '退货 / 退款', exact: true }).click()
  await dialog.waitFor()
  assert.match(page.url(), /source=S1/)
  assert.match(await formItem('原单').innerText(), /S1/)
  console.log('PASS 详情跳转携带原单')
  state = fixture()
  state.sales[0].settlements = [{ date: '2026-10-28', amount: 18, voucher: 'HX-20261028-001' }]
  await page.goto('http://127.0.0.1:5173/sale/S1')
  await page.getByRole('button', { name: '记录收款', exact: true }).click()
  await dialog.waitFor()
  assert.match(await dialog.innerText(), /应收：\s*¥ 72\.00/)
  console.log('PASS 核销后普通收款扣除已核销金额')
  for (const [key, kind, id, button] of [['sales', 'sale', 'S1', '记录收款'], ['purchases', 'purchase', 'B1', '记录付款']]) {
    state = fixture(); state[key][0].type = `${kind}-return`; state[key][0].total = 0
    await page.goto(`http://127.0.0.1:5173/${kind}/${id}`)
    await page.getByRole('button', { name: '退货 / 退款', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '编辑', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '删除', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: button, exact: true }).count(), 0)
  }
  console.log('PASS 零金额退货单也禁止普通编辑、删除、收付')
  state = fixture()
  state.sales.push({ ...structuredClone(state.sales[0]), id: 'S2' })
  state.receipts = [{ code: 'SK-20261028-001', kind: 'receivable', category: 'normal', party: '客户甲', date: '2026-10-28', total: 20, items: [{ orderId: 'S1', orderType: 'sale', amount: 10 }, { orderId: 'S2', orderType: 'sale', amount: 10 }] }]
  state['payment-vouchers'] = [{ code: 'FK-20261028-001', kind: 'payable', party: '供应商甲', date: '2026-10-28', total: 20, items: [{ orderId: 'B1', amount: 20 }] }]
  state.sales[0].payments = [{ date: '2026-10-28', amount: 10, voucher: state.receipts[0].code }]
  state.purchases[0].payments = [{ date: '2026-10-28', amount: 20, voucher: state['payment-vouchers'][0].code }]
  const funds = page.locator('.el-drawer:visible')
  for (const [path, code, label, orderPath, linkName] of [
    ['/sale/S1', 'SK-20261028-001', '收款单', '/sale/S1', '销售单 · S1'],
    ['/purchase/B1', 'FK-20261028-001', '付款单', '/purchase/B1', '采购单 · B1'],
    ['/sales', 'SK-20261028-001', '收款单', '/sale/S1', '销售单 · S1'],
    ['/purchases', 'FK-20261028-001', '付款单', '/purchase/B1', '采购单 · B1']
  ]) {
    await page.goto(`http://127.0.0.1:5173${path}`)
    const link = page.getByRole('link', { name: code, exact: true }).first()
    assert.equal(await link.getAttribute('href'), `/vouchers?code=${code}`)
    await link.click(); await funds.waitFor()
    assert.match(await funds.innerText(), /资金单据详情/)
    assert.equal(await funds.getByText(label, { exact: true }).count(), 1)
    assert.equal(await funds.getByRole('link', { name: linkName, exact: true }).getAttribute('href'), orderPath)
    if (label === '收款单') assert.equal(await funds.getByRole('link', { name: '销售单 · S2', exact: true }).count(), 1)
    await page.reload(); await funds.waitFor()
    await funds.getByRole('link', { name: linkName, exact: true }).click()
    await page.waitForURL(`**${orderPath}`)
    await page.goBack(); await funds.waitFor()
  }
  console.log('PASS 手机资金编号双向链接、合并单全部关联、类别区分、刷新和后退')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('http://127.0.0.1:5173/vouchers')
  await page.getByRole('link', { name: 'SK-20261028-001', exact: true }).waitFor()
  assert.equal(await page.locator('.el-table .el-tag').filter({ hasText: /^收款单$/ }).count(), 1)
  await page.getByRole('link', { name: 'SK-20261028-001', exact: true }).click(); await funds.waitFor()
  await funds.locator('.el-drawer__close-btn').click(); await funds.waitFor({ state: 'hidden' })
  assert.equal(new URL(page.url()).searchParams.has('code'), false)
  await page.getByRole('tab', { name: '付款单', exact: true }).click()
  assert.equal(await page.locator('.el-table .el-tag').filter({ hasText: /^付款单$/ }).count(), 1)
  await page.getByRole('link', { name: 'FK-20261028-001', exact: true }).click(); await funds.waitFor()
  await page.goto('http://127.0.0.1:5173/vouchers?code=NOT-FOUND')
  await page.getByText('未找到该资金单据，请核对编号或刷新重试', { exact: true }).waitFor()
  assert.equal(await funds.count(), 0)
  console.log('PASS 列表编号链接、普通收付款类别、关闭清理地址及失效编号提示')
  state = fixture()
  const many = (prefix, kind, category, count) => Array.from({ length: count }, (_, i) => ({ code: `${prefix}-20261028-${String(i + 1).padStart(3, '0')}`, kind, category, direction: 'to_customer', party: i === 0 ? '客户乙' : '客户甲', date: '2026-10-28', total: 10, items: [] }))
  state.receipts = many('SK', 'receivable', 'normal', 55)
  state['payment-vouchers'] = many('FK', 'payable', 'normal', 25)
  state.refunds = [...many('TK', 'refund', 'refund', 25), ...many('HX', 'refund', 'return-offset', 25)]
  await page.goto('http://127.0.0.1:5173/vouchers')
  const pager = page.locator('.voucher-pagination'), rows = page.locator('.table-wrap .el-table__body-wrapper .el-table__row')
  await pager.waitFor()
  assert.equal(await rows.count(), 20)
  assert.match(await page.locator('.sum-bar').innerText(), /550\.00/)
  await pager.locator('.btn-next').click()
  assert.equal(await rows.count(), 20)
  assert.match(await rows.first().innerText(), /SK-20261028-035/)
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出CSV', exact: true }).click()
  const stream = await (await downloaded).createReadStream(); let csv = ''
  for await (const part of stream) csv += part.toString()
  assert.equal((csv.match(/SK-20261028-/g) || []).length, 55)
  await pager.locator('.btn-next').click()
  assert.equal(await rows.count(), 15)
  await page.locator('.filter-bar .el-select').click()
  await page.getByRole('option', { name: '客户乙', exact: true }).click()
  assert.equal(await rows.count(), 1)
  assert.equal(await pager.locator('.el-pager .is-active').innerText(), '1')
  await page.goto('http://127.0.0.1:5173/vouchers')
  await pager.waitFor()
  await pager.locator('.el-select').click()
  await page.getByRole('option', { name: '50条/页', exact: true }).click()
  assert.equal(await rows.count(), 50)
  await pager.locator('.btn-next').click()
  assert.equal(await rows.count(), 5)
  await page.getByRole('tab', { name: '付款单', exact: true }).click()
  assert.equal(await pager.locator('.el-pager .is-active').innerText(), '1')
  assert.equal(await rows.count(), 25)
  await pager.locator('.el-select').click()
  await page.getByRole('option', { name: '20条/页', exact: true }).click()
  for (const label of ['付款单', '退款单 TK', '退货核销 HX']) {
    await page.getByRole('tab', { name: label, exact: true }).click()
    assert.equal(await rows.count(), 20)
    await pager.locator('.btn-next').click()
    assert.equal(await rows.count(), 5)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  const pagerBox = await pager.boundingBox()
  assert.ok(pagerBox.x >= 0 && pagerBox.x + pagerBox.width <= 391)
  console.log('PASS 四页签分页、20/50条切换、末页、筛选重置、全量汇总及CSV、手机宽度')
  state = fixture()
  for (const width of [375, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('http://127.0.0.1:5173/current')
    await page.getByRole('button', { name: '记一笔（收/付款）', exact: true }).click()
    await dialog.waitFor()
    const fill = dialog.getByRole('button', { name: '按所选未结合计填入', exact: true })
    const db = await dialog.boundingBox(), bb = await fill.boundingBox()
    assert.ok(bb.x >= db.x && bb.x + bb.width <= db.x + db.width)
    const inputBox = await dialog.locator('.rec-amount-input').boundingBox()
    if (width <= 600) assert.ok(bb.y >= inputBox.y + inputBox.height)
    else assert.ok(Math.abs(bb.y - inputBox.y) < 8)
    await dialog.locator('.rec-form .el-select').click()
    await page.getByRole('option', { name: '客户甲', exact: true }).click()
    await dialog.getByRole('button', { name: '全选', exact: true }).click()
    await fill.click()
    assert.equal(await dialog.locator('.rec-amount-input input').inputValue(), '90.00')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
  }
  console.log('PASS 375/390/430px金额按钮换行不溢出，桌面并排，填入合计仍正常')
  assert.deepEqual(errors, [])
  console.log('PASS 无浏览器未捕获错误；全部请求使用隔离内存数据')
} catch (e) {
  console.error('页面错误', errors)
  console.error((await page.locator('body').innerText()).slice(0, 4000))
  throw e
} finally { await browser.close() }
