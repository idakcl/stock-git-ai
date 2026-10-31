// AI-API：客户预存款 / 供应商预付款流水（操作型写接口）。
//
// 为什么不直接开放「整表改 suppliers / customers」：
//   deposits / advances 是资金流水，写错一笔就是账上多钱少钱。这里只暴露四个动作：
//   充值 add / 抵扣 deduct / 编辑 edit / 删除 delete，由服务端按流水追加或就地修改，
//   充值还会生成对应的收/付款单（与界面「预存款充值 / 预付款充值」同一口径）。
//
// 幂等：同一 requestId 重试只会成功一次（流水上记 aiRequestId），网络抖动不会重复充值。
// 删除：只允许删「没有开过资金单据」的流水——已开单的流水删了会对不上账，
//   写错了请用相反方向再记一笔冲回（add ↔ deduct），流水始终可审计。
import { openTransaction, commitTransaction } from './tx.js'
import { genVoucherCode } from '../src/utils/voucher.js'
import { round2 } from '../src/utils/account.js'
import { todayCN } from '../src/utils/time.js'

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e }
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
const MAX_AMOUNT = 100000000
const ACTIONS = ['add', 'deduct', 'edit', 'delete']

// 客户走「预存款 + 收款单 SK-」，供应商走「预付款 + 付款单 FK-」
const SPEC = {
  customer: { file: 'customers', field: 'deposits', kind: 'receivable', prefix: 'SK', voucherFile: 'receipts', label: '客户', money: '预存款' },
  supplier: { file: 'suppliers', field: 'advances', kind: 'payable', prefix: 'FK', voucherFile: 'payment-vouchers', label: '供应商', money: '预付款' }
}

const balanceOf = (list) => round2((list || []).reduce((s, f) => s + Number(f && f.amount || 0), 0))

export async function depositWrite(input, env, ctx, requestId) {
  const type = String(input.type || '')
  if (!['customer', 'supplier'].includes(type)) fail('type 只能是 customer 或 supplier')
  const spec = SPEC[type]
  const action = String(input.action || 'add')
  if (!ACTIONS.includes(action)) fail(`action 只能是 ${ACTIONS.join(' / ')}`)
  if (input.date && !isDate(input.date)) fail('date 格式应为 YYYY-MM-DD')
  const date = isDate(input.date) ? input.date : todayCN()
  const remark = String(input.remark == null ? '' : input.remark).trim().slice(0, 200)

  const ref = String(input.party || input.code || input.name || '').trim()
  if (!ref) fail(`请提供 party（${spec.label}编码或名称）`)

  const tx = await openTransaction(env, [spec.file, spec.voucherFile, 'logs'], { optional: [spec.voucherFile] })
  const list = (Array.isArray(tx.state[spec.file]) ? tx.state[spec.file] : []).map(x => ({ ...x }))
  // 优先按编码定位（同名单位理论上可能重名），没有编码再按名称精确匹配
  const byCode = list.findIndex(x => x.code === ref)
  const idx = byCode >= 0 ? byCode : list.findIndex(x => x.name === ref)
  if (idx < 0) fail(`${spec.label}「${ref}」不存在`, 404)
  const party = list[idx]
  const flows = Array.isArray(party[spec.field]) ? party[spec.field].slice() : []
  const vouchers = (Array.isArray(tx.state[spec.voucherFile]) ? tx.state[spec.voucherFile] : []).slice()

  const commitAndReturn = async (entry, extra) => {
    party[spec.field] = flows
    list[idx] = party
    // 两个集合都要带上：commitTransaction 按 keys 逐项比对，缺一项会被当成「改成 undefined」写坏文件
    const next = {
      [spec.file]: list,
      [spec.voucherFile]: vouchers,
      logs: tx.state.logs
    }
    const r = await commitTransaction(tx, {
      next,
      message: `ai: ${entry.action} ${type} ${party.code || party.name}${entry.amount != null ? ` ¥${entry.amount}` : ''}${entry.voucher ? ` ${entry.voucher}` : ''} by ${ctx.key.name}`.replace(/\s+/g, ' ').trim(),
      logEntry: {
        source: 'ai', action: `deposit-${entry.action}`, type, code: party.code || party.name,
        amount: entry.amount, voucher: entry.voucher || '', party: party.name,
        key: ctx.key.name, keyId: ctx.key.id, at: new Date().toISOString()
      }
    })
    return {
      ok: true, type, action,
      party: { code: party.code || '', name: party.name },
      amount: entry.amount,
      balance: balanceOf(flows),
      voucher: entry.voucher || null,
      flowId: entry.flowId || null,
      date: entry.date || date,
      commit: r.unchanged ? undefined : r.sha,
      ...extra
    }
  }

  // ---- 编辑 / 删除历史流水：按 flowId 定位（只有本接口写入的流水带 id）----
  if (action === 'edit' || action === 'delete') {
    const flowId = String(input.flowId || '').trim()
    if (!flowId) fail('编辑 / 删除需要 flowId（流水编号，充值接口返回的 flowId）')
    const fi = flows.findIndex(f => f && f.id === flowId)
    if (fi < 0) fail(`流水「${flowId}」不存在；只有通过本接口写入的流水带 flowId`, 404)
    const flow = { ...flows[fi] }
    if (action === 'delete') {
      if (flow.voucher) fail('该笔已生成资金单据，不能删除；请用相反方向再记一笔冲回', 409)
      flows.splice(fi, 1)
      return commitAndReturn({ action, flowId, date: flow.date }, { deleted: true })
    }
    if (input.date) flow.date = input.date
    if (input.remark != null) flow.remark = remark
    if (input.amount != null) {
      if (flow.voucher) fail('该笔已生成资金单据，金额不能改；请用相反方向冲回后重记', 409)
      const a = round2(Number(input.amount))
      if (!Number.isFinite(a) || a <= 0) fail('amount 必须是大于 0 的数字')
      if (a > MAX_AMOUNT) fail(`单笔金额不能超过 ${MAX_AMOUNT}`)
      const dir = input.direction === 'deduct' ? -1 : input.direction === 'add' ? 1 : (Number(flow.amount) < 0 ? -1 : 1)
      flow.amount = round2(a * dir)
    }
    flows[fi] = flow
    return commitAndReturn({ action, amount: flow.amount, flowId, voucher: flow.voucher, date: flow.date })
  }

  // ---- 充值 / 抵扣 ----
  const amount = round2(Number(input.amount))
  if (!Number.isFinite(amount) || amount <= 0) fail('amount 必须是大于 0 的数字')
  if (amount > MAX_AMOUNT) fail(`单笔金额不能超过 ${MAX_AMOUNT}`)

  // 幂等：同一个 requestId 之前已经记过账，直接回放结果，绝不重复加钱
  const replay = flows.find(f => f && f.aiRequestId && f.aiRequestId === requestId)
  if (replay) {
    return {
      ok: true, duplicate: true, type, action, party: { code: party.code, name: party.name },
      amount: Number(replay.amount || 0), balance: balanceOf(flows), voucher: replay.voucher || null,
      flowId: replay.id || null, date: replay.date || ''
    }
  }

  const now = new Date().toISOString()
  const signed = action === 'add' ? amount : -amount
  if (action === 'deduct') {
    const balance = balanceOf(flows)
    if (balance + 1e-6 < amount) {
      fail(`${spec.money}余额不足：「${party.name}」当前 ¥${balance.toFixed(2)}，本次抵扣 ¥${amount.toFixed(2)}`, 409)
    }
  }

  const flow = {
    id: `df-${requestId}`,
    date,
    amount: signed,
    remark: remark || (action === 'add' ? `存入${spec.label}${spec.money}` : '抵扣货款'),
    time: now,
    aiRequestId: requestId
  }

  let voucher = null
  if (action === 'add') {
    // 与界面「充值一笔」一致：充值即资金变动，生成一张无关联单号的收/付款单，编号回写到流水
    const code = genVoucherCode(spec.prefix, date, vouchers)
    voucher = {
      code,
      kind: spec.kind,
      category: 'deposit-recharge',
      party: party.name,
      date,
      remark: flow.remark,
      total: amount,
      items: [{ orderId: '', orderType: '', amount, note: `存入${spec.label}${spec.money}` }],
      createdAt: now
    }
    vouchers.push(voucher)
    flow.voucher = code
  }

  flows.push(flow)
  return commitAndReturn({ action, amount: signed, voucher: voucher ? voucher.code : '', flowId: flow.id })
}
