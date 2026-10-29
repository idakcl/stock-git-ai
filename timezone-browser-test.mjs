import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

// 关键点：浏览器时区故意设成 UTC，验证系统仍按东八区取日期、显示时间
const browser = await chromium.launch({ headless: true, executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' })
await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
const state = {
  customers: [{ code: 'C00001', name: '客户甲' }], suppliers: [{ code: 'S00001', name: '供应商甲' }],
  items: [], stock: {}, receipts: [], 'payment-vouchers': [], refunds: [], sales: [], purchases: []
}
await context.route('**/api/**', route => {
  const req = route.request(), path = new URL(req.url()).pathname
  if (!path.startsWith('/api/')) return route.continue()
  const key = path.slice(5)
  const send = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
  if (req.method() === 'GET') return send(key === 'session' ? { ok: true } : state[key] || [])
  return send({ ok: true })
})
const page = await context.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))

await page.goto('http://127.0.0.1:5173/current')
const clock = page.locator('.aside .cn-clock')
await clock.waitFor()
const text = (await clock.innerText()).replace(/\s+/g, ' ')
const beijing = new Date(Date.now() + 8 * 3600e3).toISOString()
console.log('侧边栏时钟：', text, '｜ UTC 时刻：', new Date().toISOString())
assert.match(text, /北京时间\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
assert.equal(text.split(' ')[1], beijing.slice(0, 10), '时钟日期应为北京日期')
const secs = s => s.split(':').reduce((a, b) => a * 60 + Number(b), 0)
const skew = Math.abs(secs(text.split(' ')[2]) - secs(beijing.slice(11, 19)))
assert.ok(skew <= 3, `时钟时分秒应为北京时间（偏差 ${skew}s）`)
const tt = await clock.boundingBox()
const aside = await page.locator('.aside').boundingBox()
assert.ok(tt.y > aside.y + aside.height / 2, '时钟应位于菜单左下角')
console.log('PASS 菜单左下角显示北京时间（浏览器时区 UTC 下仍为东八区）')

// 记一笔弹窗默认日期 = 北京日期
await page.getByRole('button', { name: '记一笔（收/付款）', exact: true }).click()
const dialog = page.locator('.el-dialog:visible')
await dialog.waitFor()
const dateInput = await dialog.locator('input[placeholder="选择日期"], .el-date-editor input').first().inputValue()
console.log('记一笔默认日期：', dateInput, '｜ 北京日期：', beijing.slice(0, 10))
assert.equal(dateInput, beijing.slice(0, 10), '默认日期应为北京时间日期')
console.log('PASS 默认业务日期取北京时间，不受设备时区影响')

// 单号列一行显示：注入一张带连字符的退货单与普通单
state.sales = [
  { id: 'XT-20261028-001', customer: '客户甲', date: '2026-10-28', total: -100, type: 'sale-return', items: [], payments: [] },
  { id: 'X202610281405320001', customer: '客户甲', date: '2026-10-28', total: 100, items: [], payments: [] }
]
await page.goto('http://127.0.0.1:5173/sales')
await page.locator('.el-table__body-wrapper').first().waitFor()
for (const id of ['XT-20261028-001', 'X202610281405320001']) {
  const cell = page.locator('.el-table .id-col .cell', { hasText: id }).first()
  const box = await cell.boundingBox()
  const lineHeight = await cell.evaluate(el => parseFloat(getComputedStyle(el).lineHeight))
  console.log(`${id} 单元格高度=${box.height.toFixed(1)} 行高=${lineHeight.toFixed(1)}`)
  assert.ok(box.height < lineHeight * 1.8, `${id} 应在一行内显示`)
}
console.log('PASS 销售单列表单号（含退货单号）保持单行显示')

await page.goto('http://127.0.0.1:5173/purchases')
await page.locator('.el-table__body-wrapper').first().waitFor()
state.purchases = [{ id: 'CT-20261028-002', supplier: '供应商甲', date: '2026-10-28', total: -50, type: 'purchase-return', items: [], payments: [] }]
await page.reload()
await page.locator('.el-table .id-col .cell', { hasText: 'CT-20261028-002' }).first().waitFor()
const pbox = await page.locator('.el-table .id-col .cell', { hasText: 'CT-20261028-002' }).first().boundingBox()
const plh = await page.locator('.el-table .id-col .cell', { hasText: 'CT-20261028-002' }).first().evaluate(el => parseFloat(getComputedStyle(el).lineHeight))
assert.ok(pbox.height < plh * 1.8, '采购退货单号应单行')
console.log('PASS 采购单列表单号单行显示')

assert.deepEqual(errors, [])
console.log('PASS 无浏览器运行时异常')
await browser.close()
