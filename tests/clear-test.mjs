// 清空业务数据（/api/clear）的回归测试：不用真实数据，全部用假仓库种子。
// 覆盖：密码/二次确认闸门、一次提交、库存按剩余单据重算、孤儿单据改名、审计日志必留。
import assert from 'node:assert/strict'
import { makeFakeRepo } from './fake-github.mjs'
import { handleApi } from '../api/routes.js'
import { issueToken } from '../api/auth.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', APP_PASSWORD: 'correct-password'
}

const item = (code, name, cost) => ({ code, name, unit: '个', cost })
const sale = (id, customer, code, qty, price, date = '2026-10-20') => ({
  id, date, customer, total: qty * price, received: qty * price, paid: 0,
  items: [{ code, qty, price, total: qty * price }], payments: []
})
const purchase = (id, supplier, code, qty, price, date = '2026-10-01') => ({
  id, date, supplier, total: qty * price, paid: qty * price, received: 0,
  items: [{ code, qty, price, total: qty * price }], payments: []
})

function seed() {
  return makeFakeRepo({
    'items.json': JSON.stringify([item('P1', '三通', 10), item('P2', '弯头', 20)]),
    'suppliers.json': JSON.stringify([{ code: 'S1', name: '甲供货', products: [] }]),
    'customers.json': JSON.stringify([{ code: 'C1', name: '乙客户', deposits: [] }]),
    'purchases.json': JSON.stringify([purchase('CG1', '甲供货', 'P1', 10, 12)]),
    'sales.json': JSON.stringify([sale('XS1', '乙客户', 'P1', 3, 30)]),
    'receipts.json': JSON.stringify([{ id: 'SK1', date: '2026-10-20', party: '乙客户', amount: 90 }]),
    'payment-vouchers.json': JSON.stringify([{ id: 'FK1', date: '2026-10-01', party: '甲供货', amount: 120 }]),
    'stock.json': JSON.stringify({ P1: { qty: 7, cost: 12 } }),
    'logs.json': JSON.stringify([{ time: '2026-10-01T00:00:00.000Z', source: 'orders', action: 'post' }])
  })
}

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')) }
}

let repo, token
const call = async (path, method, body, tok = token) => {
  const req = new Request(`https://w.test/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Origin: 'https://w.test', 'CF-Connecting-IP': '1.2.3.4' },
    body: body ? JSON.stringify(body) : undefined
  })
  const res = await handleApi(req, new URL(req.url), env)
  return { status: res.status, data: await res.json().catch(() => null) }
}
const read = async (file) => JSON.parse(await repo.read(file))
const commits = () => repo.log().length

console.log('\n清空入口：闸门')
repo = seed(); token = await issueToken(env)

await t('未带票据直接调 /clear 被拒', async () => {
  const r = await call('/clear', 'POST', { target: 'sales', password: 'correct-password', confirm: 'CLEAR' }, '')
  assert.equal(r.status, 401)
  assert.equal((await read('sales.json')).length, 1, '数据不能动')
})

await t('密码错误 → 403（不用 401，避免前端把它当成会话失效而登出），且不动数据', async () => {
  const r = await call('/clear', 'POST', { target: 'sales', password: 'wrong', confirm: 'CLEAR' })
  assert.equal(r.status, 403)
  assert.match(r.data.error, /密码/)
  assert.equal((await read('sales.json')).length, 1)
})

await t('没有 confirm=CLEAR → 400，且不动数据（防误调）', async () => {
  const r = await call('/clear', 'POST', { target: 'sales', password: 'correct-password' })
  assert.equal(r.status, 400)
  assert.equal((await read('sales.json')).length, 1)
})

await t('未知 target → 400，不产生任何提交', async () => {
  const before = await commits()
  const r = await call('/clear', 'POST', { target: 'everything', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 400)
  assert.equal(await commits(), before)
})

console.log('\n清空入口：单表')
await t('清空销售单：一次提交、单据清空、库存按剩余采购重算', async () => {
  const before = await commits()
  const r = await call('/clear', 'POST', { target: 'sales', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  assert.equal(r.data.counts.sales, 1)
  assert.equal(await commits(), before + 1, '必须是一次提交，不能逐表写')
  assert.equal((await read('sales.json')).length, 0)
  assert.equal((await read('purchases.json')).length, 1, '采购单不能被牵连')
  const stock = await read('stock.json')
  assert.equal(stock.P1.qty, 10, '卖掉的 3 个要回到库存')
  assert.equal(stock.P1.cost, 12)
})

await t('清空销售单不是静默删除：日志里能查到 target/条数/来源', async () => {
  const logs = await read('logs.json')
  const last = logs[logs.length - 1]
  assert.equal(last.source, 'clear')
  assert.equal(last.action, 'clear')
  assert.equal(last.target, 'sales')
  assert.match(last.detail, /sales=1/)
  assert.equal(last.ip, '1.2.3.4')
  assert.ok(logs.length >= 2, '原有日志不能被清掉')
})

console.log('\n清空入口：档案类')
await t('清空客户：档案清空，名下销售单保留并打「(已删除客户)」前缀', async () => {
  repo = seed(); token = await issueToken(env)
  const r = await call('/clear', 'POST', { target: 'customers', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  assert.equal((await read('customers.json')).length, 0)
  const sales = await read('sales.json')
  assert.equal(sales.length, 1, '单据必须保留')
  assert.equal(sales[0].customer, '(已删除客户) 乙客户')
})

await t('清空商品：不因为还留着单据就把商品重新造回来', async () => {
  repo = seed(); token = await issueToken(env)
  const r = await call('/clear', 'POST', { target: 'items', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  assert.equal((await read('items.json')).length, 0, '服务端不得调 derive 反填商品')
  assert.equal((await read('sales.json')).length, 1, '单据保留')
})

console.log('\n清空入口：全清')
await t('清空全部：七类归零、一次提交、库存归零、日志保留并追加', async () => {
  repo = seed(); token = await issueToken(env)
  const before = await commits()
  const r = await call('/clear', 'POST', { target: 'all', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  for (const f of ['items.json', 'customers.json', 'suppliers.json', 'purchases.json', 'sales.json', 'receipts.json', 'payment-vouchers.json']) {
    assert.equal((await read(f)).length, 0, `${f} 应清空`)
  }
  assert.deepEqual(await read('stock.json'), {})
  const names = repo.names()
  assert.ok(!names.some(n => /^(purchases|sales)-\d{4}\.json$/.test(n)), '分片模式下不能留下旧年片')
  assert.equal(await commits(), before + 1, '全清也必须是一次提交')
  const logs = await read('logs.json')
  assert.ok(logs.some(l => l.source === 'clear' && l.target === 'all'))
})

await t('重复清空已空库：不产生空提交（幂等）', async () => {
  const before = await commits()
  const r = await call('/clear', 'POST', { target: 'all', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  assert.equal(r.data.unchanged, true)
  assert.equal(await commits(), before, '没有变化就不该再提交一次')
})

console.log('\n清空入口：退款单与订单')
const REFUND = (code, direction, party, orderId, amount) => ({
  code, requestId: 'req-' + code, kind: 'refund', category: direction === 'to_customer' ? 'refund' : 'refund',
  direction, party, date: '2026-10-25', total: amount, settlementTotal: amount,
  items: [{ orderId, orderType: direction === 'to_customer' ? 'sale' : 'purchase', amount, role: 'return', settle: true }]
})
const retSale = (id, voucher, amount) => ({
  id, date: '2026-10-25', customer: '乙客户', type: 'sale-return', total: -amount, received: -amount, paid: 0,
  items: [{ code: 'P1', qty: -1, price: amount, total: -amount }],
  payments: [{ date: '2026-10-25', amount: -amount, voucher, remark: '现金退款' }], settle: '挂账'
})
const retPurchase = (id, voucher, amount) => ({
  id, date: '2026-10-25', supplier: '甲供货', type: 'purchase-return', total: -amount, paid: -amount, received: 0,
  items: [{ code: 'P1', qty: -1, price: amount, total: -amount }],
  payments: [{ date: '2026-10-25', amount: -amount, voucher, remark: '现金退款' }], settle: '挂账'
})
const order = (id, kind, status, docId) => ({
  id, kind, status, postedOrderId: docId, date: '2026-10-25',
  customer: kind === 'sale' ? '乙客户' : undefined, supplier: kind === 'purchase' ? '甲供货' : undefined,
  items: [{ code: 'P1', qty: 1, price: 30, total: 30 }], deposits: []
})
function seedWithRefunds() {
  const base = {
    'items.json': JSON.stringify([item('P1', '三通', 10)]),
    'suppliers.json': JSON.stringify([{ code: 'S1', name: '甲供货', products: [], advances: [{ date: '2026-10-25', amount: 5, voucher: 'HX-2026-0009' }] }]),
    'customers.json': JSON.stringify([{ code: 'C1', name: '乙客户', deposits: [
      { date: '2026-10-25', amount: 30, voucher: 'TK-2026-0001' },
      { date: '2026-10-25', amount: 5, voucher: 'HX-2026-0002' }
    ] }]),
    'purchases.json': JSON.stringify([purchase('CG1', '甲供货', 'P1', 10, 12), retPurchase('CT-1', 'TK-2026-0003', 12)]),
    'sales.json': JSON.stringify([sale('XS1', '乙客户', 'P1', 3, 30), retSale('XT-1', 'TK-2026-0001', 30)]),
    'receipts.json': JSON.stringify([]),
    'payment-vouchers.json': JSON.stringify([]),
    'refunds.json': JSON.stringify([
      REFUND('TK-2026-0001', 'to_customer', '乙客户', 'XT-1', 30),
      REFUND('TK-2026-0003', 'from_supplier', '甲供货', 'CT-1', 12),
      REFUND('HX-2026-0002', 'to_customer', '乙客户', 'XS1', 5)
    ]),
    'orders.json': JSON.stringify([
      order('DD-S1', 'sale', '已过账', 'XS1'),
      order('DD-P1', 'purchase', '已过账', 'CG1'),
      order('DD-S2', 'sale', '未过账', '')
    ]),
    'stock.json': JSON.stringify({ P1: { qty: 6, cost: 12 } }),
    'logs.json': JSON.stringify([{ time: '2026-10-01T00:00:00.000Z', source: 'orders', action: 'post' }])
  }
  return makeFakeRepo(base)
}

await t('清空退款单：凭证清空，退货单上的负向流水与预存流水一并回滚，结清状态重算', async () => {
  repo = seedWithRefunds(); token = await issueToken(env)
  const r = await call('/clear', 'POST', { target: 'refunds', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  assert.equal(r.data.counts.refunds, 3)
  assert.equal((await read('refunds.json')).length, 0)
  const sales = await read('sales.json')
  assert.equal(sales.length, 2, '销售单本身不能被牵连')
  const ret = sales.find(o => o.id === 'XT-1')
  assert.deepEqual(ret.payments, [], '退款留下的负向流水必须一并回滚')
  assert.equal(ret.received, 0)
  assert.equal(ret.settle, '挂账', '退款没了，结清状态要重算')
  assert.deepEqual((await read('customers.json'))[0].deposits, [], '退款转预存的流水要回滚')
  assert.equal((await read('suppliers.json'))[0].advances.length, 1, '不是退款凭证的普通预付不能被牵连')
  // 库存按剩余单据重算：采购 10+1、销售 3+1，所以是 7；清退款凭证不改变数量
  assert.deepEqual(await read('stock.json'), { P1: { qty: 7, cost: 12 } }, '清凭证不影响库存')
})

await t('清空销售单：只回滚退给客户的退款，供应商方向的退款保留；已过账销售订单退回未过账', async () => {
  repo = seedWithRefunds(); token = await issueToken(env)
  const r = await call('/clear', 'POST', { target: 'sales', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  assert.equal((await read('sales.json')).length, 0)
  const refunds = await read('refunds.json')
  assert.deepEqual(refunds.map(v => v.code), ['TK-2026-0003'], '采购方向的退款不能跟着消失')
  assert.equal(r.data.counts.refundsKept, 1)
  const orders = await read('orders.json')
  const s1 = orders.find(o => o.id === 'DD-S1')
  assert.equal(s1.status, '未过账')
  assert.equal(s1.postedOrderId, '')
  assert.equal(orders.find(o => o.id === 'DD-P1').status, '已过账', '采购订单不受影响')
  assert.equal(orders.find(o => o.id === 'DD-S2').status, '未过账')
  assert.deepEqual((await read('customers.json'))[0].deposits, [], '客户预存里来自销售退款的流水要回滚')
  assert.equal((await read('suppliers.json'))[0].advances.length, 1, '供应商预付不受销售清空影响')
})

await t('清空客户：退款单上的往来单位也打「(已删除客户)」前缀，不再是无档案裸名', async () => {
  repo = seedWithRefunds(); token = await issueToken(env)
  const r = await call('/clear', 'POST', { target: 'customers', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  const refunds = await read('refunds.json')
  const toCustomer = refunds.filter(v => v.direction === 'to_customer')
  assert.equal(toCustomer.length, 2)
  assert.ok(toCustomer.every(v => v.party === '(已删除客户) 乙客户'))
  assert.equal(refunds.find(v => v.direction === 'from_supplier').party, '甲供货', '供应商退款不受影响')
})

await t('清空全部：退款单归零、目录也归零，订单保留但两张已过账订单都退回未过账', async () => {
  repo = seedWithRefunds(); token = await issueToken(env)
  const before = await commits()
  const r = await call('/clear', 'POST', { target: 'all', password: 'correct-password', confirm: 'CLEAR' })
  assert.equal(r.status, 200)
  assert.equal((await read('refunds.json')).length, 0)
  assert.deepEqual(await read('stock.json'), {})
  assert.equal(await commits(), before + 1, '仍然只提交一次')
  const orders = await read('orders.json')
  assert.equal(orders.length, 3, '订单一张都不删')
  assert.equal(orders.filter(o => o.status === '已过账').length, 0)
  assert.equal(orders.find(o => o.id === 'DD-S2').status, '未过账')
  const logs = await read('logs.json')
  const last = logs[logs.length - 1]
  assert.match(last.detail, /refunds=3/)
  assert.match(last.detail, /ordersReset=2/)
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
