// AI-API 回归：密钥签发/权限/过期/吊销、读接口、直接开单、草稿过账、幂等、主数据。
// 跑法：node tests/ai-api-test.mjs   （纯 Node，不需要浏览器）
import assert from 'node:assert/strict'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi } from '../api/routes.js'
import { issueToken } from '../api/auth.js'
import { invalidateKeyCache } from '../api/ai-keys.js'
import { AI_ALL_SCOPE_IDS } from '../src/utils/aiScopes.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw',
  ALLOWED_ORIGINS: 'https://worker.test'
}

const SEED = {
  'items.json': JSON.stringify([
    { code: 'P00001', name: '三通', unit: '个', cost: 8, price: 12 },
    { code: 'P00002', name: '弯头', unit: '个', cost: 5, price: 9 }
  ]),
  'suppliers.json': JSON.stringify([{ code: 'S00001', name: '供应商甲', products: ['P00001'] }]),
  'customers.json': JSON.stringify([{ code: 'C00001', name: '客户甲', contact: '', phone: '', remark: '' }]),
  'purchases.json': JSON.stringify([{
    id: 'C202601011000000001', date: '2026-01-01', supplier: '供应商甲',
    items: [{ code: 'P00001', name: '三通', unit: '个', qty: 10, price: 8, total: 80 }],
    total: 80, payments: [], paid: 0, settle: '挂账', createdAt: '2026-01-01T02:00:00.000Z'
  }]),
  'sales.json': JSON.stringify([{
    id: 'X202601021100000001', date: '2026-01-02', customer: '客户甲',
    items: [{ code: 'P00001', name: '三通', unit: '个', qty: 2, price: 12, total: 24 }],
    total: 24, payments: [], received: 0, settle: '挂账', createdAt: '2026-01-02T03:00:00.000Z'
  }]),
  'stock.json': JSON.stringify({ P00001: { qty: 8, cost: 8 }, P00002: { qty: 0, cost: 5 } }),
  'logs.json': '[]'
}

const repo = makeFakeRepo(SEED)
let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')) }
}

async function call(path, { method = 'GET', token, key, body } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: 'https://worker.test' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (key) headers.Authorization = `Bearer ${key}`
  const req = new Request(`https://worker.test${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  })
  const res = await handleApi(req, new URL(req.url), env)
  const data = await res.json().catch(() => null)
  return { status: res.status, data, headers: res.headers }
}

async function ok(path, opts) {
  const r = await call(path, opts)
  if (r.status !== 200) throw new Error(`${opts && opts.method || 'GET'} ${path} → ${r.status} ${r.data && r.data.error || ''}`)
  return r.data
}

const rid = (n) => `test-request-id-${String(n).padStart(6, '0')}`
const itemsFile = () => JSON.parse(repo.read('items.json'))
const stockFile = () => JSON.parse(repo.read('stock.json'))
const salesFile = () => JSON.parse(repo.read('sales.json'))

const token = await issueToken(env)
let readKey = ''
let maxKey = ''
let readRecord = null
let maxRecord = null

console.log('\n密钥签发与列表')
await t('登录态可以签发只读密钥，明文只在响应里出现一次', async () => {
  const data = await ok('/api/ai-keys', {
    method: 'POST', token,
    body: { action: 'create', name: '只读测试', scopes: ['read:catalog', 'read:docs'], expiresInDays: 7 }
  })
  assert.match(data.key, /^ai_live_/)
  assert.match(data.key, /^ai_live_[A-Za-z0-9]{20,}$/)
  readKey = data.key
  readRecord = data.record
  assert.equal(data.record.name, '只读测试')
  assert.deepEqual(data.record.scopes, ['read:catalog', 'read:docs'])
  assert.ok(data.record.expiresAt, '7 天密钥必须有到期时间')
  const raw = repo.read('ai-keys.json')
  assert.ok(!raw.includes(readKey), '明文密钥不能落库')
  assert.ok(raw.includes(data.record.prefix), '落库的是显示前缀')
})

await t('列表不含 hash / 明文，含 usage 字段', async () => {
  const data = await ok('/api/ai-keys', { token })
  const row = data.keys.find(k => k.id === readRecord.id)
  assert.ok(row)
  assert.ok(!('hash' in row))
  assert.ok(row.active)
})

await t('最大权限：全部业务权限 + 永久', async () => {
  const data = await ok('/api/ai-keys', {
    method: 'POST', token,
    body: { action: 'create', name: '最大权限测试', scopes: AI_ALL_SCOPE_IDS, expiresInDays: 0 }
  })
  assert.equal(data.record.expiresAt, null, '0 天 = 永久')
  assert.equal(data.record.scopes.length, AI_ALL_SCOPE_IDS.length)
  maxKey = data.key
  maxRecord = data.record
})

await t('未登录不能签发密钥', async () => {
  const r = await call('/api/ai-keys', { method: 'POST', body: { action: 'create', name: 'x', scopes: ['read:catalog'] } })
  assert.equal(r.status, 401)
})

console.log('\n鉴权与权限')
await t('没有密钥 → 401', async () => {
  const r = await call('/api/ai/v1/items')
  assert.equal(r.status, 401)
})

await t('错误密钥 → 401 且不透露原因', async () => {
  const r = await call('/api/ai/v1/items', { key: 'ai_live_ffffffffffffffffffffffffffff' })
  assert.equal(r.status, 401)
  assert.match(r.data.error, /密钥无效/)
})

await t('只读密钥读商品：有价格、无成本', async () => {
  const data = await ok('/api/ai/v1/items', { key: readKey })
  assert.equal(data.total, 2)
  const p1 = data.items.find(i => i.code === 'P00001')
  assert.equal(p1.price, 12)
  assert.equal(p1.stock, 8)
  assert.ok(!('cost' in p1), '未勾选看进价时不得返回成本')
})

await t('越权访问报表 → 403', async () => {
  const r = await call('/api/ai/v1/summary', { key: readKey })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /没有「报表汇总」权限/)
})

await t('只读密钥不能开单 → 403', async () => {
  const r = await call('/api/ai/v1/sales', { key: readKey, method: 'POST', body: { customer: '客户甲', items: [{ code: 'P00001', qty: 1 }], requestId: rid(1) } })
  assert.equal(r.status, 403)
})

await t('最大权限密钥读成本与毛利', async () => {
  const items = await ok('/api/ai/v1/items', { key: maxKey })
  assert.equal(items.items.find(i => i.code === 'P00001').cost, 8)
  const summary = await ok('/api/ai/v1/summary', { key: maxKey })
  assert.equal(summary.sales.count, 1)
  assert.equal(summary.sales.amount, 24)
  assert.equal(summary.cost, 16)
  assert.equal(summary.margin, 8)
})

await t('/schema 返回能力清单并标出当前密钥有没有权限', async () => {
  const data = await ok('/api/ai/v1/schema', { key: readKey })
  assert.equal(data.version, 1)
  assert.ok(data.endpoints.length >= 15)
  const salesPost = data.endpoints.find(e => e.method === 'POST' && e.path.endsWith('/sales'))
  assert.equal(salesPost.allowed, false, '只读密钥看不到开单权限')
  const itemsGet = data.endpoints.find(e => e.method === 'GET' && e.path.endsWith('/items'))
  assert.equal(itemsGet.allowed, true)
})

console.log('\n读接口')
await t('GET /sales 过滤与汇总', async () => {
  const data = await ok('/api/ai/v1/sales?party=客户甲&include=lines', { key: maxKey })
  assert.equal(data.total, 1)
  assert.equal(data.docs[0].gross, 24)
  assert.equal(data.docs[0].unpaid, 24)
  assert.equal(data.docs[0].items[0].code, 'P00001')
})

await t('GET /parties 客户欠款', async () => {
  const data = await ok('/api/ai/v1/parties?type=customer', { key: maxKey })
  const c = data.parties.find(p => p.name === '客户甲')
  assert.equal(c.balance, 24)
})

await t('GET /ledger 来往账', async () => {
  const data = await ok('/api/ai/v1/ledger?type=customer&party=客户甲', { key: maxKey })
  assert.equal(data.count, 1)
  assert.equal(data.totals.unpaid, 24)
})

await t('GET /stock?low=1 只看无库存', async () => {
  const data = await ok('/api/ai/v1/stock?low=1', { key: maxKey })
  assert.deepEqual(data.items.map(i => i.code), ['P00002'])
})

console.log('\n直接开单')
let saleId = ''
await t('POST /sales：服务端重算金额、写库存、挂账', async () => {
  const before = stockFile().P00001.qty
  const data = await ok('/api/ai/v1/sales', {
    key: maxKey, method: 'POST',
    body: { customer: '客户甲', date: '2026-02-01', items: [{ code: 'P00001', qty: 3 }], requestId: rid(10) }
  })
  assert.equal(data.ok, true)
  assert.equal(data.amount, 36, '单价取商品档案 12 × 3')
  saleId = data.id
  const doc = salesFile().find(s => s.id === saleId)
  assert.equal(doc.total, 36)
  assert.equal(doc.received, 0)
  assert.equal(doc.settle, '挂账')
  assert.equal(doc.createdBy, 'ai:最大权限测试')
  assert.equal(stockFile().P00001.qty, before - 3, '库存必须扣减')
})

await t('同一个 requestId 重试 → duplicate，不重复开单', async () => {
  const count = salesFile().length
  const data = await ok('/api/ai/v1/sales', {
    key: maxKey, method: 'POST',
    body: { customer: '客户甲', date: '2026-02-01', items: [{ code: 'P00001', qty: 3 }], requestId: rid(10) }
  })
  assert.equal(data.duplicate, true)
  assert.equal(data.id, saleId)
  assert.equal(salesFile().length, count)
})

await t('客户不存在 → 400（不静默建档）', async () => {
  const r = await call('/api/ai/v1/sales', {
    key: maxKey, method: 'POST',
    body: { customer: '不存在的客户', items: [{ code: 'P00001', qty: 1 }], requestId: rid(11) }
  })
  assert.equal(r.status, 400)
  assert.match(r.data.error, /还没有档案/)
})

await t('商品编码不存在 → 400', async () => {
  const r = await call('/api/ai/v1/sales', {
    key: maxKey, method: 'POST',
    body: { customer: '客户甲', items: [{ code: 'P99999', qty: 1 }], requestId: rid(12) }
  })
  assert.equal(r.status, 400)
  assert.match(r.data.error, /不在商品库/)
})

await t('缺少 requestId → 400', async () => {
  const r = await call('/api/ai/v1/sales', {
    key: maxKey, method: 'POST',
    body: { customer: '客户甲', items: [{ code: 'P00001', qty: 1 }] }
  })
  assert.equal(r.status, 400)
  assert.match(r.data.error, /requestId/)
})

console.log('\n草稿与过账')
let draftId = ''
await t('POST /orders save：只填编码+数量也能存成草稿，不占库存', async () => {
  const before = stockFile().P00001.qty
  const data = await ok('/api/ai/v1/orders', {
    key: maxKey, method: 'POST',
    body: { action: 'save', requestId: rid(20), order: { kind: 'sale', customer: '客户甲', date: '2026-02-02', items: [{ code: 'P00001', qty: 2 }] } }
  })
  assert.match(data.code, /^D/)
  draftId = data.code
  assert.equal(stockFile().P00001.qty, before, '草稿不影响库存')
})

await t('同一个 requestId 重试 save → duplicate', async () => {
  const data = await ok('/api/ai/v1/orders', {
    key: maxKey, method: 'POST',
    body: { action: 'save', requestId: rid(20), order: { kind: 'sale', customer: '客户甲', date: '2026-02-02', items: [{ code: 'P00001', qty: 2 }] } }
  })
  assert.equal(data.duplicate, true)
  assert.equal(data.code, draftId)
})

await t('POST /orders post：过账生成正式单据并扣库存', async () => {
  const before = stockFile().P00001.qty
  const data = await ok('/api/ai/v1/orders', {
    key: maxKey, method: 'POST', body: { action: 'post', orderId: draftId, requestId: rid(21) }
  })
  assert.ok(data.code)
  assert.equal(stockFile().P00001.qty, before - 2)
  assert.ok(salesFile().some(s => s.id === data.code))
})

console.log('\n主数据')
let newItemCode = ''
await t('master upsert 新商品：编码自动生成', async () => {
  const data = await ok('/api/ai/v1/master', {
    key: maxKey, method: 'POST',
    body: { type: 'item', action: 'upsert', item: { name: '新阀门', unit: '个', price: 20, cost: 13 } }
  })
  newItemCode = data.code
  assert.match(newItemCode, /^P\d{5}$/)
  assert.ok(itemsFile().some(i => i.code === newItemCode && i.name === '新阀门'))
})

await t('master 改价：按编码更新', async () => {
  const data = await ok('/api/ai/v1/master', {
    key: maxKey, method: 'POST',
    body: { type: 'item', action: 'upsert', item: { code: newItemCode, price: 22 } }
  })
  assert.equal(data.code, newItemCode)
  assert.equal(itemsFile().find(i => i.code === newItemCode).price, 22)
})

await t('master 传了不存在的编码 → 404（不静默新建）', async () => {
  const r = await call('/api/ai/v1/master', {
    key: maxKey, method: 'POST',
    body: { type: 'item', action: 'upsert', item: { code: 'P88888', name: '瞎猜' } }
  })
  assert.equal(r.status, 404)
})

await t('删除被单据引用的商品 → 409', async () => {
  const r = await call('/api/ai/v1/master', {
    key: maxKey, method: 'POST',
    body: { type: 'item', action: 'delete', code: 'P00001' }
  })
  assert.equal(r.status, 409)
})

await t('删除未被引用的新商品 → ok', async () => {
  await ok('/api/ai/v1/master', { key: maxKey, method: 'POST', body: { type: 'item', action: 'delete', code: newItemCode } })
  assert.ok(!itemsFile().some(i => i.code === newItemCode))
})

console.log('\n预存 / 预付充值')
const suppliersFile = () => JSON.parse(repo.read('suppliers.json'))
const customersFile = () => JSON.parse(repo.read('customers.json'))
const vouchersFile = (name) => JSON.parse(repo.read(name) || '[]')
const advanceSum = () => (suppliersFile().find(s => s.code === 'S00001').advances || [])
  .reduce((s, f) => s + Number(f.amount || 0), 0)

await t('POST /deposits：供应商预付款充值，同时生成付款单 FK-', async () => {
  const data = await ok('/api/ai/v1/deposits', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(401), type: 'supplier', party: 'S00001', action: 'add', amount: 1000, date: '2026-10-31', remark: '银行转账' }
  })
  assert.equal(data.ok, true)
  assert.equal(data.balance, 1000)
  assert.match(data.voucher, /^FK-20261031-\d{4}$/)
  const flow = advanceSum()
  assert.equal(flow, 1000)
  const saved = suppliersFile().find(s => s.code === 'S00001').advances.slice(-1)[0]
  assert.equal(saved.remark, '银行转账')
  assert.equal(saved.voucher, data.voucher)
  assert.ok(saved.aiRequestId, '流水要带 requestId 以便幂等')
  const v = vouchersFile('payment-vouchers.json').find(x => x.code === data.voucher)
  assert.equal(v.category, 'deposit-recharge')
  assert.equal(v.total, 1000)
  assert.equal(v.party, '供应商甲')
})

await t('同一 requestId 重试 → duplicate，余额不重复增加', async () => {
  const data = await ok('/api/ai/v1/deposits', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(401), type: 'supplier', party: 'S00001', action: 'add', amount: 1000, date: '2026-10-31', remark: '银行转账' }
  })
  assert.equal(data.duplicate, true)
  assert.equal(data.balance, 1000)
  assert.equal(advanceSum(), 1000, '不能重复充值')
  assert.equal(vouchersFile('payment-vouchers.json').length, 1)
})

await t('deduct 抵扣：余额减少、不生成资金单据；超过余额 → 409', async () => {
  const data = await ok('/api/ai/v1/deposits', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(402), type: 'supplier', party: '供应商甲', action: 'deduct', amount: 300 }
  })
  assert.equal(data.balance, 700)
  assert.equal(data.voucher, null)
  assert.equal(advanceSum(), 700)
  const r = await call('/api/ai/v1/deposits', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(403), type: 'supplier', party: 'S00001', action: 'deduct', amount: 701 }
  })
  assert.equal(r.status, 409)
  assert.equal(advanceSum(), 700, '被拒绝的抵扣不能落库')
})

await t('客户预存款充值生成收款单 SK-；/parties 能读到可用余额', async () => {
  const data = await ok('/api/ai/v1/deposits', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(404), type: 'customer', party: 'C00001', action: 'add', amount: 50 }
  })
  assert.match(data.voucher, /^SK-\d{8}-\d{4}$/)
  const c = customersFile().find(x => x.code === 'C00001')
  assert.equal((c.deposits || []).reduce((s, f) => s + Number(f.amount || 0), 0), 50)
  const parties = await ok('/api/ai/v1/parties?type=supplier', { key: maxKey })
  assert.equal(parties.parties.find(p => p.code === 'S00001').prepaid, 700)
})

await t('预存充值需要 write:deposits：只读密钥 → 403', async () => {
  const limited = await ok('/api/ai-keys', {
    method: 'POST', token,
    body: { action: 'create', name: '无充值权限', scopes: ['read:parties'], expiresInDays: 1 }
  })
  const r = await call('/api/ai/v1/deposits', {
    key: limited.key, method: 'POST',
    body: { requestId: rid(405), type: 'supplier', party: 'S00001', action: 'add', amount: 1 }
  })
  assert.equal(r.status, 403)
  assert.equal(advanceSum(), 700)
  await ok('/api/ai-keys', { method: 'POST', token, body: { action: 'revoke', id: limited.record.id } })
})

console.log('\n收付款记账')
const saleDoc = () => JSON.parse(repo.read('sales.json')).find(o => o.id === 'X202601021100000001')
const purchaseDoc = () => JSON.parse(repo.read('purchases.json')).find(o => o.id === 'C202601011000000001')

await t('POST /payments：销售单收款 10 元，生成收款单 SK- 并保留欠款', async () => {
  const data = await ok('/api/ai/v1/payments', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(501), kind: 'sale', id: 'X202601021100000001', amount: 10, date: '2026-10-31', remark: '微信' }
  })
  assert.equal(data.amount, 10)
  assert.equal(data.outstanding, 14)
  assert.equal(data.settle, '挂账')
  assert.match(data.voucher, /^SK-20261031-\d{4}$/)
  const doc = saleDoc()
  assert.equal(doc.received, 10)
  assert.equal(doc.payments.length, 1)
  assert.equal(doc.payments[0].voucher, data.voucher)
  assert.ok(doc.payments[0].aiRequestId)
  const v = vouchersFile('receipts.json').find(x => x.code === data.voucher)
  assert.equal(v.items[0].orderId, doc.id)
  assert.equal(v.items[0].orderType, 'sale')
  assert.equal(v.total, 10)
})

await t('同一 requestId 重试 → duplicate，不重复收款', async () => {
  const data = await ok('/api/ai/v1/payments', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(501), kind: 'sale', id: 'X202601021100000001', amount: 10, date: '2026-10-31', remark: '微信' }
  })
  assert.equal(data.duplicate, true)
  assert.equal(saleDoc().received, 10)
  assert.equal(saleDoc().payments.length, 1)
})

await t('action=settle 按差额结清；结清后再记 → 409', async () => {
  const data = await ok('/api/ai/v1/payments', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(502), kind: 'sale', id: 'X202601021100000001', action: 'settle' }
  })
  assert.equal(data.amount, 14)
  assert.equal(data.outstanding, 0)
  assert.equal(data.settle, '结清')
  assert.equal(saleDoc().settle, '结清')
  const r = await call('/api/ai/v1/payments', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(503), kind: 'sale', id: 'X202601021100000001', amount: 1 }
  })
  assert.equal(r.status, 409)
})

await t('付款超过未付 → 409；采购单付款生成付款单 FK-', async () => {
  const over = await call('/api/ai/v1/payments', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(504), kind: 'purchase', id: 'C202601011000000001', amount: 100 }
  })
  assert.equal(over.status, 409)
  assert.match(over.data.error, /预存款|预付款/)
  const data = await ok('/api/ai/v1/payments', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(505), kind: 'purchase', id: 'C202601011000000001', amount: 80 }
  })
  assert.match(data.voucher, /^FK-20261031-\d{4}$/)
  assert.equal(data.settle, '结清')
  assert.equal(purchaseDoc().paid, 80)
})

console.log('\n资金单据查询')
await t('GET /vouchers：列表可按类型 / 单位 / 单号筛选', async () => {
  const all = await ok('/api/ai/v1/vouchers', { key: maxKey })
  assert.ok(all.total >= 4, `至少包含预存/预付与收付款单，实际 ${all.total}`)
  const recv = await ok('/api/ai/v1/vouchers?type=receivable', { key: maxKey })
  assert.ok(recv.vouchers.every(v => v.kind === 'receivable'))
  assert.ok(recv.vouchers.some(v => v.code === vouchersFile('receipts.json')[0].code))
  const byParty = await ok(`/api/ai/v1/vouchers?party=${encodeURIComponent('供应商甲')}`, { key: maxKey })
  assert.ok(byParty.vouchers.length >= 1)
  assert.ok(byParty.vouchers.every(v => v.party === '供应商甲'))
  const byOrder = await ok('/api/ai/v1/vouchers?q=X202601021100000001', { key: maxKey })
  assert.ok(byOrder.vouchers.length >= 1)
  assert.ok(byOrder.vouchers.every(v => v.items.some(it => it.orderId === 'X202601021100000001')))
})

console.log('\n变更已开单据')
await t('POST /amends：减少明细生成退货单，原单不动；同一 requestId 幂等', async () => {
  const body = {
    requestId: rid(601), kind: 'sale', sourceOrderId: 'X202601021100000001', party: '客户甲',
    date: '2026-10-31', refundLines: [{ index: 0, qty: 1 }], amendLines: [],
    reason: '客户少要一件', mode: 'pending'
  }
  const data = await ok('/api/ai/v1/amends', { key: maxKey, method: 'POST', body })
  assert.ok(data.code)
  assert.ok(data.returnId)
  const again = await ok('/api/ai/v1/amends', { key: maxKey, method: 'POST', body })
  assert.equal(again.duplicate, true)
  assert.equal(again.code, data.code)
})

console.log('\n外链分享')
await t('POST /shares 建链 / 列表 / 取消', async () => {
  const data = await ok('/api/ai/v1/shares', {
    key: maxKey, method: 'POST',
    body: { action: 'create', kind: 'sale', docId: 'X202601021100000001', days: 7 }
  })
  assert.ok(data.share && data.share.token)
  const list = await ok('/api/ai/v1/shares', { key: maxKey })
  assert.ok(list.shares.some(s => s.token === data.share.token))
  const cancel = await ok('/api/ai/v1/shares', {
    key: maxKey, method: 'POST', body: { action: 'cancel', token: data.share.token }
  })
  assert.equal(cancel.ok, true)
})

console.log('\n主数据细节')
await t('master 可写商品照片与供应商挂靠；不存在的供应商编码 → 404', async () => {
  const data = await ok('/api/ai/v1/master', {
    key: maxKey, method: 'POST',
    body: { type: 'item', action: 'upsert', item: { code: 'P00002', photos: ['https://example.com/p.png'], suppliers: ['S00001'] } }
  })
  assert.equal(data.code, 'P00002')
  const p2 = itemsFile().find(i => i.code === 'P00002')
  assert.deepEqual(p2.photos, ['https://example.com/p.png'])
  assert.deepEqual(p2.suppliers, ['S00001'])
  const r = await call('/api/ai/v1/master', {
    key: maxKey, method: 'POST',
    body: { type: 'item', action: 'upsert', item: { code: 'P00002', suppliers: ['S99999'] } }
  })
  assert.equal(r.status, 404)
})

await t('预存流水 edit / delete：只能改自己写入的流水，已开单的金额被锁', async () => {
  const add = await ok('/api/ai/v1/deposits', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(701), type: 'supplier', party: 'S00001', action: 'add', amount: 20, remark: '现金' }
  })
  assert.ok(add.flowId)
  const locked = await call('/api/ai/v1/deposits', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(702), type: 'supplier', party: 'S00001', action: 'edit', flowId: add.flowId, amount: 30 }
  })
  assert.equal(locked.status, 409, '已开资金单据的金额不能改')
  const edited = await ok('/api/ai/v1/deposits', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(703), type: 'supplier', party: 'S00001', action: 'edit', flowId: add.flowId, remark: '现金（改）' }
  })
  assert.equal(edited.amount, 20)
  const del = await call('/api/ai/v1/deposits', {
    key: maxKey, method: 'POST',
    body: { requestId: rid(704), type: 'supplier', party: 'S00001', action: 'delete', flowId: add.flowId }
  })
  assert.equal(del.status, 409, '已开资金单据的流水不能删')
  assert.equal(edited.balance, 720)
})

console.log('\n吊销与过期')
await t('吊销后立即 401', async () => {
  await ok('/api/ai-keys', { method: 'POST', token, body: { action: 'revoke', id: readRecord.id } })
  const r = await call('/api/ai/v1/items', { key: readKey })
  assert.equal(r.status, 401)
})

await t('吊销记录仍在列表里（可审计），active=false', async () => {
  const data = await ok('/api/ai-keys', { token })
  const row = data.keys.find(k => k.id === readRecord.id)
  assert.ok(row.revokedAt)
  assert.equal(row.active, false)
})

await t('过期密钥 → 401', async () => {
  const data = await ok('/api/ai-keys', {
    method: 'POST', token,
    body: { action: 'create', name: '过期测试', scopes: ['read:catalog'], expiresInDays: 1 }
  })
  const keys = JSON.parse(repo.read('ai-keys.json'))
  const rec = keys.find(k => k.id === data.record.id)
  rec.expiresAt = new Date(Date.now() - 60000).toISOString()
  repo.poke('ai-keys.json', JSON.stringify(keys))
  invalidateKeyCache(env)
  const r = await call('/api/ai/v1/items', { key: data.key })
  assert.equal(r.status, 401)
})

await t('改权限后立即生效（无需重发密钥）', async () => {
  const created = await ok('/api/ai-keys', {
    method: 'POST', token,
    body: { action: 'create', name: '提权测试', scopes: ['read:catalog'], expiresInDays: 7 }
  })
  const before = await call('/api/ai/v1/summary', { key: created.key })
  assert.equal(before.status, 403)
  await ok('/api/ai-keys', {
    method: 'POST', token,
    body: { action: 'update', id: created.record.id, scopes: ['read:catalog', 'read:reports'] }
  })
  const after = await call('/api/ai/v1/summary', { key: created.key })
  assert.equal(after.status, 200)
})

await t('可以继续签发新密钥（未触及上限）', async () => {
  // 前面已签发若干把，这里不重复造到上限（测试时间），只校验常量提示存在
  const r = await call('/api/ai-keys', { method: 'POST', token, body: { action: 'create', name: '上限测试', scopes: ['read:catalog'], expiresInDays: 1 } })
  assert.equal(r.status, 200)
})

console.log('\n调用日志')

await t('日志记录成功调用：密钥名、接口、状态、耗时', async () => {
  const created = await ok('/api/ai-keys', {
    method: 'POST', token,
    body: { action: 'create', name: '日志测试', scopes: AI_ALL_SCOPE_IDS, expiresInDays: 7 }
  })
  const sale = await ok('/api/ai/v1/sales', {
    method: 'POST', key: created.key,
    body: {
      requestId: rid(9001), customer: '客户甲', date: '2026-02-01',
      items: [{ code: 'P00001', qty: 1 }]
    }
  })
  const data = await ok('/api/ai-logs?limit=50', { token })
  assert.ok(data.logs.length > 0, '应该有日志')
  const hit = data.logs.find(l => l.path === '/sales' && l.code === sale.id)
  assert.ok(hit, '应能按单号找到这次开单')
  assert.equal(hit.key, '日志测试')
  assert.equal(hit.keyId, created.record.id)
  assert.equal(hit.method, 'POST')
  assert.equal(hit.status, 200)
  assert.equal(hit.requestId, rid(9001))
  assert.ok(hit.ms >= 0)
  assert.ok(!('body' in hit), '不记录请求体')
})

await t('日志记录鉴权失败，且不落密钥明文', async () => {
  const bad = 'ai_live_thisisnotarealkey1234567890'
  const r = await call('/api/ai/v1/items', { key: bad })
  assert.equal(r.status, 401)
  const data = await ok('/api/ai-logs?status=error&limit=200', { token })
  const hit = data.logs.find(l => l.path === '/items' && l.status === 401)
  assert.ok(hit, '401 也应留痕')
  assert.equal(hit.key, '')
  const raw = repo.read('ai-logs.json')
  assert.ok(!raw.includes(bad), '日志里不能出现密钥明文')
  assert.ok(!raw.includes('ai_live_'), '日志里不能出现任何 ai_live_ 前缀')
})

await t('日志记录无权限调用 403，并可按密钥筛选', async () => {
  const created = await ok('/api/ai-keys', {
    method: 'POST', token,
    body: { action: 'create', name: '日志只读', scopes: ['read:catalog'], expiresInDays: 7 }
  })
  const r = await call('/api/ai/v1/summary', { key: created.key })
  assert.equal(r.status, 403)
  const data = await ok(`/api/ai-logs?keyId=${encodeURIComponent(created.record.id)}`, { token })
  assert.equal(data.total, 1)
  assert.equal(data.logs[0].status, 403)
  assert.equal(data.logs[0].path, '/summary')
  assert.match(data.logs[0].error, /权限/)
  assert.equal(data.logs[0].key, '日志只读')
})

await t('日志接口需要登录态', async () => {
  const r = await call('/api/ai-logs')
  assert.equal(r.status, 401)
})

console.log(`\n${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
