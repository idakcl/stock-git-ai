// 对账体检：纯函数规则 + /api/audit 路由接线。
// 跑法：node tests/audit-test.mjs
import assert from 'node:assert/strict'
import { auditState } from '../api/audit.js'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi } from '../api/routes.js'
import { issueToken } from '../api/auth.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')) }
}

const sale = (id, extra = {}) => ({
  id, date: '2026-10-20', customer: '客户甲', total: 100, received: 0, payments: [],
  items: [{ code: 'P00001', qty: 10, price: 10, total: 100 }], ...extra
})
const purchase = (id, extra = {}) => ({
  id, date: '2026-10-20', supplier: '供应商甲', total: 100, paid: 0, payments: [],
  items: [{ code: 'P00001', qty: 10, price: 10, total: 100 }], ...extra
})
const codes = (r) => r.items.map(i => i.code)

console.log('\n规则')
await t('干净数据：0 错误 0 警告', () => {
  const r = auditState({ sales: [sale('S1', { received: 100, settle: '结清', payments: [{ date: '2026-10-20', amount: 100 }] })], purchases: [purchase('C1')] })
  assert.equal(r.counts.error, 0)
  assert.equal(r.counts.warn, 0)
  assert.equal(r.items.length, 0)
})

await t('单头合计与明细不符 → error', () => {
  const r = auditState({ sales: [sale('S1', { total: 120 })] })
  assert.ok(codes(r).includes('total-mismatch'))
  assert.equal(r.items[0].level, 'error')
  assert.match(r.items[0].detail, /相差 ¥20\.00/)
})

await t('1 元以内的历史舍入尾差 → info，不报错误', () => {
  const r = auditState({ sales: [sale('S1', { total: 100.5 })] })
  assert.deepEqual(codes(r), ['total-rounding'])
  assert.equal(r.counts.error, 0)
  assert.equal(r.items[0].level, 'info')
})

await t('单头与「折后行金额之和」一致即可（行折扣不被误报）', () => {
  const o = sale('S1', { total: 80, items: [{ code: 'P00001', qty: 10, price: 10, total: 80, discountRate: 0.8 }] })
  const r = auditState({ sales: [o] })
  assert.equal(r.items.length, 0)
})

await t('实收字段与流水合计不符 → error', () => {
  const r = auditState({ sales: [sale('S1', { received: 50, payments: [{ date: '2026-10-20', amount: 100 }] })] })
  assert.ok(codes(r).includes('payments-mismatch'))
})

await t('标了结清但仍有未收 → error（2026-10-25 事故类型）', () => {
  const r = auditState({ sales: [sale('S1', { settle: '结清', payments: [] })] })
  const hit = r.items.find(i => i.code === 'settle-contradiction')
  assert.ok(hit)
  assert.match(hit.detail, /未收 ¥100\.00/)
})

await t('金额已平但仍挂账 → info（不是错误）', () => {
  const r = auditState({ sales: [sale('S1', { settle: '挂账', received: 100, payments: [{ date: '2026-10-20', amount: 100 }] })] })
  const hit = r.items.find(i => i.code === 'settle-flat')
  assert.ok(hit)
  assert.equal(hit.level, 'info')
})

await t('作废单据一律跳过', () => {
  const r = auditState({ sales: [sale('S1', { status: '作废', total: 999 })] })
  assert.equal(r.items.length, 0)
})

await t('凭证指向不存在的单据 → error', () => {
  const r = auditState({
    sales: [sale('S1')],
    receipts: [{ code: 'SK-1', total: 100, items: [{ orderId: 'S404', orderType: 'sale', amount: 100 }] }]
  })
  const hit = r.items.find(i => i.code === 'voucher-orphan')
  assert.ok(hit)
  assert.match(hit.detail, /S404/)
})

await t('凭证金额与分录合计不符 → warn', () => {
  const r = auditState({
    sales: [sale('S1')],
    receipts: [{ code: 'SK-1', total: 120, items: [{ orderId: 'S1', orderType: 'sale', amount: 100 }] }]
  })
  assert.ok(codes(r).includes('voucher-total-mismatch'))
  assert.equal(r.items.find(i => i.code === 'voucher-total-mismatch').level, 'warn')
})

await t('退货单：原单缺失 → error；超过原单金额 → error', () => {
  const orphan = auditState({ purchases: [purchase('C1'), { ...purchase('CT-1'), total: -50, sourceOrderId: 'C404' }] })
  assert.ok(codes(orphan).includes('return-orphan'))
  const over = auditState({ purchases: [purchase('C1'), { ...purchase('CT-2'), total: -150, sourceOrderId: 'C1' }] })
  assert.ok(codes(over).includes('return-over'))
})

await t('退货单没写原单 → warn', () => {
  const r = auditState({ sales: [sale('S1'), { ...sale('XT-1'), total: -30 }] })
  assert.equal(r.items.find(i => i.code === 'return-no-source').level, 'warn')
})

await t('普通单据出现负数流水 → warn', () => {
  const r = auditState({ sales: [sale('S1', { received: -50, payments: [{ date: '2026-10-20', amount: -50 }] })] })
  assert.ok(codes(r).includes('negative-payment'))
})

await t('单号重复 → error', () => {
  const r = auditState({ sales: [sale('S1'), sale('S1')] })
  assert.ok(codes(r).includes('duplicate-id'))
})

await t('实收超过应收 → warn（多收的钱应转预存）', () => {
  const r = auditState({ sales: [sale('S1', { received: 120, payments: [{ date: '2026-10-20', amount: 120 }] })] })
  const hit = r.items.find(i => i.code === 'overpaid')
  assert.ok(hit)
  assert.equal(hit.level, 'warn')
  assert.match(hit.detail, /多收\/多付 ¥20\.00/)
})

await t('实收恰好等于应收不算超收', () => {
  const r = auditState({ sales: [sale('S1', { received: 100, settle: '结清', payments: [{ date: '2026-10-20', amount: 100 }] })] })
  assert.ok(!codes(r).includes('overpaid'))
})

await t('负库存 → warn，按商品编码定位', () => {
  const r = auditState({ sales: [], purchases: [], stock: { P00001: { qty: -3, cost: 5 }, P00002: { qty: 2, cost: 5 } } })
  const hit = r.items.find(i => i.code === 'negative-stock')
  assert.ok(hit)
  assert.equal(hit.level, 'warn')
  assert.equal(hit.id, 'P00001')
  assert.equal(r.items.length, 1)
})

await t('跨两张凭证累计核销超过单据金额 → warn', () => {
  const r = auditState({
    sales: [sale('S1', { total: 100 })],
    receipts: [
      { code: 'SK-1', total: 60, items: [{ orderId: 'S1', orderType: 'sale', amount: 60 }] },
      { code: 'SK-2', total: 60, items: [{ orderId: 'S1', orderType: 'sale', amount: 60 }] }
    ]
  })
  const hit = r.items.find(i => i.code === 'cross-voucher-over')
  assert.ok(hit)
  assert.equal(hit.level, 'warn')
  assert.match(hit.detail, /多出 ¥20\.00/)
})

await t('分次付款但累计等于单据金额不算超核销', () => {
  const r = auditState({
    sales: [sale('S1', { total: 100 })],
    receipts: [
      { code: 'SK-1', total: 60, items: [{ orderId: 'S1', orderType: 'sale', amount: 60 }] },
      { code: 'SK-2', total: 40, items: [{ orderId: 'S1', orderType: 'sale', amount: 40 }] }
    ]
  })
  assert.ok(!codes(r).includes('cross-voucher-over'))
})

await t('已作废的凭证不参与跨凭证累计', () => {
  const r = auditState({
    sales: [sale('S1', { total: 100 })],
    receipts: [
      { code: 'SK-1', total: 60, items: [{ orderId: 'S1', orderType: 'sale', amount: 60 }] },
      { code: 'SK-2', status: '作废', total: 60, items: [{ orderId: 'S1', orderType: 'sale', amount: 60 }] }
    ]
  })
  assert.ok(!codes(r).includes('cross-voucher-over'))
})

await t('同一张凭证里同一单出现两次 → warn', () => {
  const r = auditState({
    sales: [sale('S1', { total: 100 })],
    receipts: [{ code: 'SK-1', total: 60, items: [{ orderId: 'S1', amount: 30 }, { orderId: 'S1', amount: 30 }] }]
  })
  const hit = r.items.find(i => i.code === 'voucher-duplicate-line')
  assert.ok(hit)
  assert.equal(hit.level, 'warn')
})

await t('输出按 错误 → 警告 → 提示 排序，计数一致', () => {
  const r = auditState({
    sales: [sale('S1', { settle: '挂账', received: 100, payments: [{ date: '2026-10-20', amount: 100 }] }), sale('S2', { total: 120 })],
    receipts: [{ code: 'SK-1', total: 120, items: [{ orderId: 'S2', amount: 100 }] }]
  })
  const order = { error: 0, warn: 1, info: 2 }
  const levels = r.items.map(i => i.level)
  assert.deepEqual(levels, [...levels].sort((a, b) => order[a] - order[b]))
  assert.equal(r.counts.error + r.counts.warn + r.counts.info, r.items.length)
})

console.log('\n路由接线')
const env = { GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main', SESSION_SECRET: 's', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw' }
await t('GET /api/audit 需要登录票据，返回结构与统计', async () => {
  const body = [sale('S1', { total: 120 })]
  const repo = makeFakeRepo({
    'items.json': '[]', 'suppliers.json': '[]', 'customers.json': '[]',
    'sales.json': JSON.stringify(body), 'purchases.json': '[]',
    'stock.json': '{}', 'logs.json': '[]'
  })
  const token = await issueToken(env)
  const req = new Request('https://w.test/api/audit', { headers: { Authorization: `Bearer ${token}` } })
  const res = await handleApi(req, new URL(req.url), env)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok(Array.isArray(data.items) && data.items.length >= 1)
  assert.equal(data.counts.error, 1)
  assert.ok(data.checkedAt)
  void repo
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
