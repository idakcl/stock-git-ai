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
import { todayCN } from './time.js'

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

// 当天同前缀已有单据数 + 1：预分配 n 个连续不重号编码。
// 为什么要「先分配、后保存」：资金单据编号要写回单据流水（payments[].voucher），
// 若等单据集合落库再生成编号，就得把整表再覆盖一次（两次 GitHub 往返 + 中途失败的悬挂风险）。
export async function allocVoucherCodes(api, kind, date, n) {
  const isRecv = kind === 'receivable'
  const existing = ((await (isRecv ? api.getReceipts : api.getPaymentVouchers)()) || [])
  const working = existing.slice()
  const codes = []
  for (let i = 0; i < Math.max(0, Number(n) || 0); i++) {
    const code = genVoucherCode(isRecv ? 'SK' : 'FK', date, working)
    codes.push(code)
    working.push({ code })
  }
  return codes
}

// 生成并保存多张资金单据（一次性读取+写入，避免 N 次往返与重号）。
//   kind: 'receivable'（收款单 SK-）| 'payable'（付款单 FK-）
//   bases: [{ code?, party, date, remark, category, items:[{ orderId, orderType, amount, discount, settle, note }] }]
//          每项不含 code，由本函数按库内现有单据算下一个连续编码；items 为空 orderId 表示纯资金变动。
//          base.code 已由 attachPaymentVouchers 预分配时原样沿用，保证单据编号与流水上的编号一致。
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
      code: base.code || genVoucherCode(prefix, base.date, working),
      kind,
      category: base.category || 'normal',
      party: base.party || '',
      date: base.date || todayCN(),
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
        date: r.date || (order && order.date) || todayCN(),
        remark: r.remark || '用预存款抵扣货款',
        items: [{ orderId: order && order.id, orderType, amount, note: '用预存款抵扣货款' }]
      })
    } else {
      bases.push({
        category: 'normal',
        party,
        date: r.date || (order && order.date) || todayCN(),
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
      date: (add && add.date) || (order && order.date) || todayCN(),
      remark: (add && add.remark) || note,
      items: [{ orderId: '', orderType: '', amount: over, note }]
    })
  }
  return bases
}

// ---------- 联动的统一入口：流水 → 资金单据 ----------
// 一次收付款会话（单单据收款 / 列表页收款 / 新增单据时的本次实收实付 / 结清收款）落库前调用，
// 产出「已带编号的资金单据 bases」+「把编号回写到自己流水上的单据副本」，调用方只需：
//   1) 用返回的 order 覆盖本地列表并整表保存（此时 payments[].voucher 已带上编号）
//   2) 用 appendVouchers(api, kind, bases) 保存资金单据（base.code 已预分配，不再另起编号）
// 约定：一笔流水 ↔ 一张资金单据；一张资金单据可覆盖多张单据（合并收付款走 CurrentAccounts 自己的分组逻辑）。
//
// rows 定位策略：本次新增流水带一次性定位标记 mid（由弹窗写入，回写编号后即删除、绝不落库）；
// 存量调用未带 mid 时回退「日期+金额+备注+来源」匹配，匹配不到则只生成单据不给流水补号（悬挂可见、可事后核对）。
export async function attachPaymentVouchers(api, kind, order, rows, add) {
  const list = (rows || []).filter(r => r && round2(Number(r.amount || 0)) > 0)
  const over = round2(Number((add && add.amount) || 0))
  const total = list.length + (over > 0 ? 1 : 0)
  if (!total || !order) return { order, bases: [] }
  const isRecv = kind === 'receivable'
  const orderType = isRecv ? 'sale' : 'purchase'
  const party = isRecv ? order.customer : order.supplier
  const fallbackDate = order.date || todayCN()
  const codes = await allocVoucherCodes(api, kind, fallbackDate, total)
  const settled = isSettledOf(netOf(order, kind), order.settle)
  // 工作副本：payments 克隆后回写编号，mid 用完即删
  const payments = (order.payments || []).map(p => ({ ...p }))
  const stampedOrder = { ...order, payments }
  const bases = []
  list.forEach((r, i) => {
    const amount = round2(Number(r.amount || 0))
    const code = codes[i]
    const date = r.date || fallbackDate
    const hit = payments.find(p =>
      (r.mid && p.mid === r.mid) ||
      (!r.mid && p.date === r.date && round2(Number(p.amount || 0)) === amount &&
        (p.remark || '') === (r.remark || '') && !!p.fromDeposit === !!r.fromDeposit))
    if (hit) hit.voucher = code
    const fromDeposit = !!r.fromDeposit
    bases.push({
      code,
      category: fromDeposit ? 'deposit-deduct' : 'normal',
      party,
      date,
      remark: r.remark || (fromDeposit ? '用预存款抵扣货款' : (isRecv ? '收款' : '付款')),
      items: [{
        orderId: order.id,
        orderType,
        amount,
        discount: 0,
        settle: settled,
        note: fromDeposit ? '用预存款抵扣货款' : ''
      }]
    })
  })
  if (over > 0) {
    const note = isRecv ? '超收转预存款' : '超付转预付款'
    bases.push({
      code: codes[codes.length - 1],
      category: 'deposit-over',
      party,
      date: add.date || fallbackDate,
      remark: add.remark || note,
      items: [{ orderId: '', orderType: '', amount: over, note }]
    })
  }
  // mid 只服务于本次会话定位，落库前一律清除（后端 normalize 再兜一道，双保险）
  const cleaned = payments.map(({ mid, ...p }) => p)
  return { order: { ...stampedOrder, payments: cleaned }, bases }
}

// ---------- 落库编排（单据集合 + 资金单据集合的成对写入） ----------
// 为什么需要一个函数管两步：资金单据编号要先回写进单据流水（payments[].voucher），
// 单据集合才能整表落库；顺序拆散在各页面里极易写成「先存单据再补编号」，
// 那样要么多一次整表覆盖，要么留下「有凭证号却无凭证」的悬挂流水。
// 约定返回 stage，由调用方（各视图）决定怎么提示——工具层不碰 UI：
//   ok           单据与资金单据都已保存，codes 为本次新生成的单据编号
//   alloc        编号预读失败：流水照旧落库但不带凭证编号（可稍后用「记一笔」补开）
//   orders       单据集合保存失败：未写资金单据，本地列表未被修改
//   vouchers     单据已保存、资金单据写入失败：流水已带编号，需当场提示补开
// merged 为「合并本次单据后的新数组」，保存成功才由调用方赋给列表（不就地改源数组）
export async function savePaymentWithVouchers(api, kind, orders, order, newRows, add) {
  const isRecv = kind === 'receivable'
  const saveOrders = isRecv ? api.saveSales : api.savePurchases
  const hasMoney = (newRows || []).some(r => r && round2(Number(r.amount || 0)) > 0) ||
    round2(Number((add && add.amount) || 0)) > 0
  let stamped = order
  let bases = []
  let allocFailed = false
  if (hasMoney) {
    try {
      const r = await attachPaymentVouchers(api, kind, order, newRows, add)
      stamped = r.order
      bases = r.bases
    } catch {
      allocFailed = true
    }
  }
  const idx = (orders || []).findIndex(o => o.id === stamped.id)
  // 不改调用方的数组：保存失败时本地列表天然还是原样，无需回滚代码（此前每处都要手写回滚，易漏）
  const merged = idx >= 0
    ? orders.map((o, i) => (i === idx ? stamped : o))
    : [...(orders || []), stamped]
  try {
    await saveOrders(merged)
  } catch (e) {
    return { stage: 'orders', error: e, stamped }
  }
  if (!bases.length) return { stage: allocFailed ? 'alloc' : 'ok', stamped, merged, codes: [] }
  try {
    const { created } = await appendVouchers(api, kind, bases)
    return { stage: 'ok', stamped, merged, codes: created.map(v => v.code).filter(Boolean) }
  } catch (e) {
    return { stage: 'vouchers', error: e, stamped, merged, codes: bases.map(b => b.code).filter(Boolean) }
  }
}


// 把落库结果翻译成给用户的提示（纯函数，不引 UI 库）。
// 视图侧统一：voucherNotices(kind, r).forEach(n => ElMessage[n.type]({ message: n.text, duration: n.duration }))
// 原则：资金单据生成成功要报编号（用户要的是「有据可查」），失败要报原因和补救入口，绝不静默。
export function voucherNotices(kind, r) {
  const word = kind === 'payable' ? '付款单' : '收款单'
  const notices = []
  if (r.stage === 'alloc') {
    notices.push({ type: 'warning', duration: 6000, text: `${word}编号预读失败，本笔流水已入账但暂无凭证编号，请到「来往账 · 记一笔」补开${word}` })
  }
  if (r.stage === 'vouchers') {
    notices.push({
      type: 'error',
      duration: 8000,
      text: `${word}写入失败（${(r.error && r.error.message) || '网络异常'}）：流水已保存，请到「来往账 · 记一笔」补开${word}，否则收付款单列表会缺这一笔`
    })
  }
  if ((r.codes || []).length) {
    notices.push({ type: 'success', duration: 5000, text: `已生成${word}：${r.codes.join('、')}` })
  }
  return notices
}
