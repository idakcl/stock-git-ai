// 预存款 / 预付款流水写入：全站统一入口，且按「订单 id」标记、幂等重建。
//
// 为什么必须幂等：收款/付款流水弹窗每次点「保存」都会触发一次 deposit 变动写入。
// 若简单地「追加」流水，重复保存（例如改个备注再保存、或用预存款抵扣）会把同一笔
// 抵扣/超额流水重复记 N 次 → 客户预存款被重复扣减、或超额被重复转入（资金泄漏）。
//
// 这里以 orderId 给每一笔流水打标记，保存时先删掉该订单此前标记的所有流水，再按
// 本次 payload 重建。无论保存多少次，结果都收敛到同一份流水，与订单的收付款状态严格一致。
// 历史遗留的、没有 order 标记的流水（如手动充值、早期 S00067 预付款）一律保留，零破坏。
import { round2 } from './account.js'

// kind: 'receivable' 销售单 → 客户 deposits；'payable' 采购单 → 供应商 advances
// 返回写回后的档案数组（调用方据此刷新本地列表）；找不到对应档案时返回 null
export async function applyDepositFlows(api, kind, name, orderId, addAmount, deductAmount) {
  const get = kind === 'receivable' ? api.getCustomers : api.getSuppliers
  const save = kind === 'receivable' ? api.saveCustomers : api.saveSuppliers
  const field = kind === 'receivable' ? 'deposits' : 'advances'
  const list = await get()
  const entity = list.find(x => x.name === name)
  if (!entity) return null
  // 重建：先清掉该订单此前标记的全部流水（无论正负），再按本次结果写入
  entity[field] = (entity[field] || []).filter(f => f.order !== orderId)
  const now = new Date().toISOString()
  const date = now.slice(0, 10)
  const add = round2(Number(addAmount) || 0)
  const deduct = round2(Number(deductAmount) || 0)
  if (add > 0) {
    entity[field].push({ date, amount: add, remark: kind === 'receivable' ? '超收转预存款' : '超付转预付款', order: orderId, time: now })
  }
  if (deduct > 0) {
    entity[field].push({ date, amount: -deduct, remark: '抵扣货款', order: orderId, time: now })
  }
  await save(list)
  return list
}

// 删除单据时调用：清掉该订单此前标记的全部流水（删除单据后不应残留幽灵流水）
// 无匹配流水则不写回（返回 null），避免为删单产生一次内容不变的提交
export async function removeDepositFlows(api, kind, name, orderId) {
  const get = kind === 'receivable' ? api.getCustomers : api.getSuppliers
  const save = kind === 'receivable' ? api.saveCustomers : api.saveSuppliers
  const field = kind === 'receivable' ? 'deposits' : 'advances'
  const list = await get()
  const entity = list.find(x => x.name === name)
  if (!entity) return null
  const before = (entity[field] || []).length
  entity[field] = (entity[field] || []).filter(f => f.order !== orderId)
  if (entity[field].length !== before) {
    await save(list)
    return list
  }
  return null
}
