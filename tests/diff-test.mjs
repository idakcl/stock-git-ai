// 字段级留痕：纯函数 diff + 保存链路把 diff 写进 logs.json。
// 跑法：node tests/diff-test.mjs
import assert from 'node:assert/strict'
import { diffDocuments, diffText } from '../api/diff.js'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi, derive, rebuildStock } from '../api/routes.js'
import { issueToken } from '../api/auth.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')) }
}

const base = (id, extra = {}) => ({
  id, date: '2026-10-20', customer: '客户甲', total: 100, discount: 0, received: 0,
  payments: [], items: [{ code: 'P00001', qty: 10, price: 10, total: 100 }], ...extra
})

console.log('\n纯函数')
await t('没有变化 → null（不写日志）', () => {
  assert.equal(diffDocuments([base('S1')], [base('S1')], 'sale'), null)
})

await t('金额变化 → 记录 from/to，文本可读', () => {
  const d = diffDocuments([base('S1')], [base('S1', { total: 90 })], 'sale')
  assert.equal(d.changed, 1)
  assert.deepEqual(d.docs[0].fields.total, { label: '金额', from: 100, to: 90 })
  assert.equal(diffText(d.docs[0]), '金额 100 → 90')
})

await t('客户与日期变化各记一条', () => {
  const d = diffDocuments([base('S1')], [base('S1', { customer: '客户乙', date: '2026-10-21' })], 'sale')
  assert.deepEqual(Object.keys(d.docs[0].fields).sort(), ['customer', 'date'])
})

await t('金额尾差 < 0.005 视为没变（浮点尘不刷屏）', () => {
  assert.equal(diffDocuments([base('S1', { total: 100.001 })], [base('S1', { total: 100.002 })], 'sale'), null)
})

await t('明细行数变化 → 记「明细行数」', () => {
  const two = base('S1', { items: [{ code: 'P00001', qty: 5, price: 10, total: 50 }, { code: 'P00002', qty: 5, price: 10, total: 50 }] })
  const d = diffDocuments([base('S1')], [two], 'sale')
  assert.deepEqual(d.docs[0].fields.items, { label: '明细行数', from: 1, to: 2 })
})

await t('新增单记「新建」，移除单记「移除」', () => {
  const d = diffDocuments([base('S1')], [base('S2')], 'sale')
  const byId = Object.fromEntries(d.docs.map(x => [x.id, x]))
  assert.ok(byId.S2.fields._new)
  assert.ok(byId.S1.fields._deleted)
  assert.equal(d.changed, 2)
})

await t('超过 20 张只保留前 20 条，changed 仍是真实总数', () => {
  const before = Array.from({ length: 30 }, (_, i) => base(`S${i}`))
  const after = before.map(o => ({ ...o, total: o.total + 1 }))
  const d = diffDocuments(before, after, 'sale')
  assert.equal(d.changed, 30)
  assert.equal(d.docs.length, 20)
})

console.log('\n保存链路')
const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw'
}
const line = (code, name, qty, price) => ({ code, name, unit: '个', qty, price, total: Math.round(qty * price * 100) / 100 })
const rawSeed = {
  items: [{ code: 'P00001', name: '管件', unit: '个', cost: 8, price: 10 }],
  suppliers: [],
  customers: [{ code: 'C00001', name: '客户甲', contact: '', phone: '', remark: '' }],
  purchases: [],
  sales: [{ id: 'X202610020900000001', date: '2026-10-02', customer: '客户甲', total: 50, discount: 0, received: 0, settle: '挂账', payments: [], items: [line('P00001', '管件', 5, 10)] }],
  logs: []
}
const derived = derive(rawSeed.items, rawSeed.suppliers, rawSeed.purchases, rawSeed.sales, rawSeed.customers)
const repo = makeFakeRepo({
  'items.json': derived.items,
  'suppliers.json': derived.suppliers,
  'customers.json': derived.customers,
  'receipts.json': [], 'payment-vouchers.json': [], 'refunds.json': [], 'logs.json': [],
  'stock.json': rebuildStock(derived.purchases, derived.sales, derived.items),
  'sales-2026.json': derived.sales,
  'purchases.json': [],
  '.split-yearly.json': { purchases: true, sales: true }
})
const token = await issueToken(env)
const post = async (path, body) => {
  const req = new Request(`https://worker.test/api${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://worker.test' },
    body: JSON.stringify(body)
  })
  const res = await handleApi(req, new URL(req.url), env)
  return res.json()
}
const logs = () => JSON.parse(repo.read('logs.json'))

await t('改金额后保存：logs.json 出现 source=save 的字段 diff', async () => {
  const before = logs().length
  const sale = { ...derived.sales[0], total: 40, items: [line('P00001', '管件', 4, 10)] }
  const r = await post('/sales', { sales: [sale] })
  assert.equal(r.ok, true)
  const all = logs()
  assert.ok(all.length > before)
  const hit = all.find(x => x.source === 'save')
  assert.ok(hit, '必须有字段级留痕')
  assert.equal(hit.kind, 'sale')
  assert.equal(hit.changed, 1)
  assert.deepEqual(hit.docs[0].fields.total, { label: '金额', from: 50, to: 40 })
  void hit
})

await t('原样重存：不新增字段 diff 日志', async () => {
  const before = logs().length
  const sale = JSON.parse(JSON.stringify(derived.sales[0]))
  sale.total = 40
  sale.items = [line('P00001', '管件', 4, 10)]
  const r = await post('/sales', { sales: [sale] })
  assert.equal(r.ok, true)
  assert.equal(logs().length, before, '没有变化就不该写日志')
})

await t('日志只保留最近 200 条（diff 不会把文件撑爆）', () => {
  assert.ok(logs().length <= 200)
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
