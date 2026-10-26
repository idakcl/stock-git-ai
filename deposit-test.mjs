// deposit.js 逻辑测试：用内存 mock 模拟 Worker API，验证删除单据时预付款/预收款的退回行为。
// 运行：node deposit-test.mjs
import { applyDepositFlows, removeDepositFlows } from './src/utils/deposit.js'

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg) }
  else { fail++; console.error('  ✗', msg) }
}
function sum(list) { return (list || []).reduce((s, f) => s + Number(f.amount || 0), 0) }

// 内存 mock：suppliers/customers 各一份，支持增改
function makeApi() {
  const suppliers = []
  const customers = []
  return {
    suppliers, customers,
    getSuppliers: async () => structuredClone(suppliers),
    saveSuppliers: async (s) => { suppliers.length = 0; suppliers.push(...structuredClone(s)) },
    getCustomers: async () => structuredClone(customers),
    saveCustomers: async (c) => { customers.length = 0; customers.push(...structuredClone(c)) },
  }
}

console.log('场景1：当前版本（带订单标记的抵扣）→ 删除后预付款应退回')
{
  const api = makeApi()
  api.suppliers.push({ name: '曼乃水塔', advances: [{ date: '2026-01-01', amount: 1000, remark: '充值', time: 't' }] })
  // 采购单 O1 用预付款抵扣 300（当前版本会写带标记的抵扣流水）
  await applyDepositFlows(api, 'payable', '曼乃水塔', 'O1', 0, 300)
  const sup = (await api.getSuppliers())[0]
  assert(Math.abs(sum(sup.advances) - 700) < 1e-9, `抵扣后余额=700（实际 ${sum(sup.advances)}）`)
  // 删除 O1
  const order1 = { id: 'O1', supplier: '曼乃水塔', payments: [{ amount: 300, fromDeposit: true }] }
  await removeDepositFlows(api, 'payable', '曼乃水塔', 'O1', order1)
  const sup2 = (await api.getSuppliers())[0]
  assert(Math.abs(sum(sup2.advances) - 1000) < 1e-9, `删除后余额恢复=1000（实际 ${sum(sup2.advances)}）`)
  assert(sup2.advances.filter(f => f.order === 'O1').length === 0, '带标记的抵扣流水已被清除')
}

console.log('场景2：历史旧数据（抵扣流水无订单标记）→ 删除后预付款仍应退回（补回）')
{
  const api = makeApi()
  api.suppliers.push({ name: '曼乃水塔', advances: [
    { date: '2026-01-01', amount: 1000, remark: '充值', time: 't' },
    { date: '2026-02-01', amount: -300, remark: '抵扣货款', time: 't2' } // 早期无 order 标记
  ] })
  const before = sum((await api.getSuppliers())[0].advances)
  assert(Math.abs(before - 700) < 1e-9, `历史抵扣后余额=700（实际 ${before}）`)
  // 删除 O2（其付款记录显示用了 300 预付款，但档案里那条抵扣流水无标记）
  const order2 = { id: 'O2', supplier: '曼乃水塔', payments: [{ amount: 300, fromDeposit: true }] }
  await removeDepositFlows(api, 'payable', '曼乃水塔', 'O2', order2)
  const sup = (await api.getSuppliers())[0]
  assert(Math.abs(sum(sup.advances) - 1000) < 1e-9, `删除后余额恢复=1000（实际 ${sum(sup.advances)}）`)
  const back = sup.advances.find(f => f.order === 'O2' && f.remark === '删除单据退回预付款')
  assert(back && Math.abs(back.amount - 300) < 1e-9, '生成带标记的正向补回流水 ¥300')
}

console.log('场景3：销售单（预存款）同理')
{
  const api = makeApi()
  api.customers.push({ name: '客户A', deposits: [
    { date: '2026-01-01', amount: 500, remark: '充值', time: 't' },
    { date: '2026-02-01', amount: -200, remark: '抵扣货款', time: 't2' } // 无标记
  ] })
  const order = { id: 'S1', customer: '客户A', payments: [{ amount: 200, fromDeposit: true }] }
  await removeDepositFlows(api, 'receivable', '客户A', 'S1', order)
  const cu = (await api.getCustomers())[0]
  assert(Math.abs(sum(cu.deposits) - 500) < 1e-9, `删除后预存款恢复=500（实际 ${sum(cu.deposits)}）`)
}

console.log('场景4：未使用预付款的单据删除 → 不应改动余额、不写回')
{
  const api = makeApi()
  api.suppliers.push({ name: 'X', advances: [{ date: '2026-01-01', amount: 100, remark: '充值', time: 't' }] })
  const order = { id: 'O9', supplier: 'X', payments: [{ amount: 100, remark: '现金' }] } // 无 fromDeposit
  const res = await removeDepositFlows(api, 'payable', 'X', 'O9', order)
  assert(res === null, '未用预付款时不写回（返回 null）')
  assert(Math.abs(sum((await api.getSuppliers())[0].advances) - 100) < 1e-9, '余额不变')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
