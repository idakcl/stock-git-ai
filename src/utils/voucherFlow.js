// 资金单据（收款单 SK- / 付款单 FK-）生成与保存的统一步入口。
//
// 背景：此前资金单据只在「合并收付款 / 记一笔」一处生成，单单据收款/付款、
// 存预存预付、超额转存、用预存款抵扣等路径都没有联动开单，导致结清销售单后
// 「收付款单」列表查不到对应单据（详情页资金单据编号列常显「—」）。
//
// 这里把「读取库内现有单据 → 生成连续不重号编码 → 合并保存」收敛到 appendVouchers，
// 并提供一个把一次收付款保存会话翻译成资金单据 bases 的纯函数，供各入口复用。
import { genVoucherCode } from './voucher.js'
import { round2, netOf, isSettledOf } from './account.js'

// 资金单据类别（仅用于列表/抽屉展示区分，不参与金额计算）
//   normal         普通收付款（关联销售/采购单）
//   deposit-recharge 预存/预付充值（无关联单号）
//   deposit-over   超额收/付款转存预存款/预付款（无关联单号）
//   deposit-deduct 用预存款/预付款抵扣货款的划转（关联单号，资金从预付款余额划出）
export const VOUCHER_CATEGORY = {
  normal: '收付款',
  'deposit-recharge': '预存预付充值',
  'deposit-over': '超额转存',
  'deposit-deduct': '预存款抵扣'
}

// 生成并保存多张资金单据（一次性读取+写入，避免 N 次往返与重号）。
//   kind: 'receivable'（收款单 SK-）| 'payable'（付款单 FK-）
//   bases: [{ party, date, remark, category, items:[{ orderId, orderType, amount, discount, settle, note }] }]
//          每项不含 code，由本函数按库内现有单据算下一个连续编码；items 为空 orderId 表示纯资金变动。
// 返回 { all, created }：all 为保存后的全量列表，created 为本次新生成的单据（含 code）。
export async function appendVouchers(api, kind, bases) {
  const isRecv = kind === 'receivable'
  const get = isRecv ? api.getReceipts : api.getPaymentVouchers
  const save = isRecv ? api.saveReceipts : api.savePaymentVouchers
  const prefix = isRecv ? 'SK' : 'FK'
  const existing = (await get()) || []
  let working = existing.slice()
  const created = []
  for (const base of (bases || [])) {
    const items = (base.items || []).map(it => ({ ...it }))
    const voucher = {
      code: genVoucherCode(prefix, base.date, working),
      kind,
      category: base.category || 'normal',
      party: base.party || '',
      date: base.date || new Date().toISOString().slice(0, 10),
      remark: base.remark || '',
      total: round2(items.reduce((s, it) => s + Number(it.amount || 0), 0)),
      items
    }
    working.push(voucher)
    created.push(voucher)
  }
  if (!created.length) return { all: existing, created: [] }
  await save(working)
  return { all: working, created }
}

// 把一次「单单据收付款」保存会话翻译成资金单据 bases 数组。
//   kind: 'receivable' | 'payable'
//   order: 保存后的单据（含 customer/supplier、id、最新 payments）
//   newRows: 本次会话新增的流水 [{ date, amount, remark, fromDeposit }]（由 PaymentDialog 标记回传）
//   add: 超额收/付款转存预存款/预付款的流水 { amount }（由 PaymentDialog 通过 payload.add 回传）
// 规则（与用户确认口径一致）：
//   每一笔新增流水 → 一张资金单据。其中 fromDeposit（用预存款抵扣）流水对应一张「预存款抵扣划转单」
//   （关联单号，不另由 payload.deduct 重复开单，避免同一笔钱在收款单累计里被算两次）；
//   普通流水 → 普通收付款单（关联单号，settle 取整单是否已结清）；
//   超额转存 → 一张无单号的「超额转存」资金单据。
export function buildPaymentVoucherBases({ kind, order, newRows, add }) {
  const isRecv = kind === 'receivable'
  const orderType = isRecv ? 'sale' : 'purchase'
  const party = isRecv ? (order && order.customer) : (order && order.supplier)
  const bases = []
  const settled = isSettledOf(netOf(order || {}, kind), (order || {}).settle)
  for (const r of (newRows || [])) {
    const amount = round2(Number(r.amount || 0))
    if (amount <= 0) continue
    if (r.fromDeposit) {
      bases.push({
        category: 'deposit-deduct',
        party,
        date: r.date || (order && order.date) || new Date().toISOString().slice(0, 10),
        remark: r.remark || '用预存款抵扣货款',
        items: [{ orderId: order && order.id, orderType, amount, note: '用预存款抵扣货款' }]
      })
    } else {
      bases.push({
        category: 'normal',
        party,
        date: r.date || (order && order.date) || new Date().toISOString().slice(0, 10),
        remark: r.remark || (isRecv ? '收款' : '付款'),
        items: [{ orderId: order && order.id, orderType, amount, discount: 0, settle: settled }]
      })
    }
  }
  const over = round2(Number((add && add.amount) || 0))
  if (over > 0) {
    const note = isRecv ? '超收转预存款' : '超付转预付款'
    bases.push({
      category: 'deposit-over',
      party,
      date: (add && add.date) || (order && order.date) || new Date().toISOString().slice(0, 10),
      remark: (add && add.remark) || note,
      items: [{ orderId: '', orderType: '', amount: over, note }]
    })
  }
  return bases
}
