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
import { todayCN } from './time.js'

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
  const date = todayCN()
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

// 删除单据时调用：清掉该订单此前标记的全部流水（删除单据后不应残留幽灵流水）。
//
// 健壮性：早期历史订单的「抵扣货款」流水没有 order 标记（如早期 S00067 预付款），
// 单纯按 order 标记过滤会匹配不到，导致删除单据后预付款/预收款没有退回余额。
// 因此额外以「单据自身付款记录」(order.payments 中 fromDeposit 部分) 反推本单用掉的
// 预付款金额——这是最可靠的来源——若没找到带标记的抵扣流水，就补一笔正向流水把用掉的
// 预付款退回余额。带标记流水存在时（当前版本）不补，避免重复加回。
// 无匹配流水且不补回则不写回（返回 null），避免为删单产生一次内容不变的提交。
//
// order：被删除的单据对象（含 payments），用于反推本单用掉的预付款；不传则只走标记过滤。
export async function removeDepositFlows(api, kind, name, orderId, order) {
  const get = kind === 'receivable' ? api.getCustomers : api.getSuppliers
  const save = kind === 'receivable' ? api.saveCustomers : api.saveSuppliers
  const field = kind === 'receivable' ? 'deposits' : 'advances'
  const list = await get()
  const entity = list.find(x => x.name === name)
  if (!entity) return null
  const flows = entity[field] || []
  const before = flows.length
  // 1) 清掉带订单标记的全部流水（当前版本写入的抵扣/超额流水）
  const cleaned = flows.filter(f => f.order !== orderId)
  // 2) 本单实际用掉的预付款/预收款：以单据自身付款记录为准（最可靠）
  const used = order
    ? (order.payments || []).filter(p => p.fromDeposit).reduce((s, p) => s + Number(p.amount || 0), 0)
    : 0
  // 是否已存在「带订单标记的抵扣流水」被清掉（当前版本已正确处理，无需补回，避免重复加回）
  const hadTaggedDeduct = flows.some(f => f.order === orderId && Number(f.amount) < 0)
  let corrected = false
  if (round2(used) > 0.005 && !hadTaggedDeduct) {
    const now = new Date().toISOString()
    cleaned.push({
      date: todayCN(),
      amount: round2(used),
      remark: '删除单据退回预付款',
      order: orderId,
      time: now
    })
    corrected = true
  }
  entity[field] = cleaned
  if (cleaned.length !== before || corrected) {
    await save(list)
    return list
  }
  return null
}
