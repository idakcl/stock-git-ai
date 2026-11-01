import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
const browser = await chromium.launch({ headless: true, executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined })
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
const fixture = () => ({
  customers: [{ code: 'C1', name: '客户甲' }], suppliers: [{ code: 'P1', name: '供应商甲' }],
  items: [], stock: {}, receipts: [], 'payment-vouchers': [], refunds: [],
  sales: [100, 50].map((total, i) => ({ id: `S${i}`, customer: '客户甲', date: '2026-10-01', total, payments: [], items: [] })),
  purchases: [100, 50].map((total, i) => ({ id: `B${i}`, supplier: '供应商甲', date: '2026-10-01', total, payments: [], items: [] }))
})
let state = fixture(), writes = []
await context.route('**/api/**', async route => {
  const req = route.request(), path = new URL(req.url()).pathname
  if (!path.startsWith('/api/')) return route.continue()
  const key = path.slice(5)
  const send = obj => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) })
  if (req.method() === 'GET') return send(key === 'session' ? { ok: true } : state[key] || [])
  assert.ok(['sales', 'purchases', 'customers', 'suppliers', 'receipts', 'payment-vouchers'].includes(key))
  const body = req.postDataJSON()
  assert.ok(Array.isArray(body[key]))
  state[key] = structuredClone(body[key]); writes.push(key)
  return send({ ok: true })
})
const page = await context.newPage(), errors = []
page.on('pageerror', e => errors.push(e.message))
const dialog = page.locator('.el-dialog:visible')
async function record(kind, amount, discount = 0) {
  await page.goto('http://127.0.0.1:5173/current')
  await page.getByRole('button', { name: '记一笔（收/付款）', exact: true }).click()
  if (kind === 'payable') await dialog.getByText('供应商付款', { exact: true }).click()
  await dialog.locator('.rec-form .el-select').click()
  await page.getByRole('option', { name: kind === 'payable' ? '供应商甲' : '客户甲', exact: true }).click()
  await dialog.getByRole('button', { name: '全选', exact: true }).click()
  if (discount) {
    await dialog.locator('.bulk input').first().fill(String(discount))
    await dialog.getByRole('button', { name: '应用到所选', exact: true }).click()
  }
  await dialog.locator('.rec-amount-input input').fill(String(amount))
  await dialog.locator('.rec-amount-input input').blur()
  const confirm = dialog.getByRole('button', { name: '确认记一笔', exact: true })
  assert.equal(await confirm.isDisabled(), false, '有效金额应启用确认按钮')
  assert.doesNotMatch(await dialog.innerText(), /NaN/)
  await confirm.click()
  await page.getByText(/已保存收付款流水/).waitFor()
}
try {
  for (const [kind, amount, discount] of [['receivable', 150, 0], ['payable', 150, 0], ['receivable', 80, 0], ['receivable', 170, 0], ['receivable', 130, 10]]) {
    state = fixture(); writes = []
    await record(kind, amount, discount)
    if (amount > 150) await page.getByText(/超额转存资金单据/).waitFor()
    const key = kind === 'payable' ? 'payment-vouchers' : 'receipts', orderKey = kind === 'payable' ? 'purchases' : 'sales'
    const vouchers = state[key], payments = state[orderKey].flatMap(o => o.payments)
    assert.equal(vouchers.reduce((s, v) => s + v.total, 0), amount)
    assert.equal(payments.reduce((s, p) => s + p.amount, 0), Math.min(amount, 150 - discount * 2))
    assert.ok(payments.every(p => vouchers.some(v => v.code === p.voucher)))
    assert.equal(vouchers[0].items.length, 2)
    assert.ok(writes.includes(orderKey) && writes.includes(key))
    if (discount) assert.deepEqual(state.sales.map(o => o.discount), [10, 10])
    if (amount > 150) assert.equal(state.customers[0].deposits[0].amount, 20)
    await page.goto('http://127.0.0.1:5173/vouchers')
    if (kind === 'payable') await page.getByRole('tab', { name: '付款单', exact: true }).click()
    await page.getByRole('link', { name: vouchers[0].code, exact: true }).waitFor()
    console.log(`PASS 记一笔 ${kind} 金额${amount} 优惠${discount}：流水和资金凭证对应、列表可见`)
  }
  state = fixture(); writes = []
  await record('receivable', 0, 100)
  assert.equal(state.receipts.length, 0)
  assert.equal(state.sales.flatMap(o => o.payments).length, 0)
  assert.deepEqual(state.sales.map(o => o.discount), [100, 50])
  console.log('PASS 纯优惠结清不伪造现金流水或收款单')
  state = fixture(); writes = []
  await page.goto('http://127.0.0.1:5173/current')
  await page.getByRole('tab', { name: '单据明细', exact: true }).click()
  await page.locator('#pane-orders .el-table__header-wrapper .el-checkbox').click()
  await page.getByRole('button', { name: '合并收付款', exact: true }).click()
  await dialog.getByRole('button', { name: '确认合并收付款', exact: true }).click()
  await page.getByText(/已保存收付款流水/).waitFor()
  assert.equal(state.receipts.length, 1); assert.equal(state['payment-vouchers'].length, 1)
  for (const key of ['receipts', 'payment-vouchers']) { assert.equal(state[key][0].total, 150); assert.equal(state[key][0].items.length, 2) }
  console.log('PASS 合并收付款：四张订单按收付方向生成两张资金凭证，每张关联两单')
  assert.deepEqual(errors, [])
  console.log('PASS 所有测试写入均在隔离内存中，无生产写入')
} catch (e) {
  console.error(errors)
  console.error((await page.locator('body').innerText()).slice(-3500))
  throw e
} finally { await browser.close() }
