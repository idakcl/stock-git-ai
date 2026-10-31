// AI-API：给已开单据记一笔收 / 付款（操作型写接口）。
//
// 与页面「记一笔 / 结清」同一口径：往单据 payments 追加一条流水、同步 received/paid 与结算状态，
// 并生成一张关联单号的收款单 SK- / 付款单 FK-（编号回写到流水）。
//
// 红线：
//   · 只记「不超过未收 / 未付」的钱；多收多付请改用 POST /deposits 记成预存款 / 预付款，
//     避免 AI 一笔账同时改单据和余额，出错时对不上。
//   · 作废单、退货/退款单不收付款（退款链路有自己的核销凭证）。
//   · 同一 requestId 重试只记一次（流水上带 aiRequestId）。
import { openTransaction, commitTransaction } from './tx.js'
import { genVoucherCode } from '../src/utils/voucher.js'
import { round2, payableOf, receivableOf, appendPayment, syncPayments, isVoided } from '../src/utils/account.js'
import { isReturn } from '../src/utils/refunds.js'
import { todayCN } from '../src/utils/time.js'

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e }
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))

export async function paymentWrite(input, env, ctx, requestId) {
  const kind = String(input.kind || '')
  if (!['sale', 'purchase'].includes(kind)) fail('kind 只能是 sale 或 purchase')
  const id = String(input.id || '').trim()
  if (!id) fail('请提供单据号 id')
  const action = String(input.action || 'pay')
  if (!['pay', 'settle'].includes(action)) fail('action 只能是 pay（记一笔）或 settle（按差额结清）')
  if (input.date && !isDate(input.date)) fail('date 格式应为 YYYY-MM-DD')
  const date = isDate(input.date) ? input.date : todayCN()
  const remark = String(input.remark == null ? '' : input.remark).trim().slice(0, 200)

  const listKey = kind === 'sale' ? 'sales' : 'purchases'
  const voucherFile = kind === 'sale' ? 'receipts' : 'payment-vouchers'
  const tx = await openTransaction(env, [listKey, voucherFile, 'logs'], { optional: [voucherFile] })
  const list = (Array.isArray(tx.state[listKey]) ? tx.state[listKey] : []).map(o => ({ ...o }))
  const idx = list.findIndex(o => o && o.id === id)
  if (idx < 0) fail(`单据「${id}」不存在`, 404)
  const doc = list[idx]
  if (isVoided(doc)) fail('单据已作废，不能收付款', 409)
  if (isReturn(doc)) fail('退货 / 退款单请走 POST /refunds 核销，不能直接收付款', 409)

  // account.js 的口径是 'receivable' / 'payable'，别把单据类型（sale/purchase）直接传进去
  const ack = kind === 'sale' ? 'receivable' : 'payable'
  const due = kind === 'sale' ? receivableOf(doc) : payableOf(doc)
  const vouchers = (Array.isArray(tx.state[voucherFile]) ? tx.state[voucherFile] : []).slice()
  const party = kind === 'sale' ? (doc.customer || '') : (doc.supplier || '')
  const money = kind === 'sale' ? '未收' : '未付'

  // 幂等：这条流水已经记过，直接回放，不再追加
  const replay = (doc.payments || []).find(p => p && p.aiRequestId === requestId)
  if (replay) {
    return {
      ok: true, duplicate: true, kind, id,
      amount: round2(Number(replay.amount || 0)),
      outstanding: round2(due),
      settle: doc.settle || '',
      voucher: replay.voucher || null
    }
  }

  const amount = action === 'settle' ? round2(due) : round2(Number(input.amount))
  if (!Number.isFinite(amount) || amount <= 0) fail('amount 必须是大于 0 的数字')
  if (action === 'settle' && due <= 0) fail('这张单已结清，无需再收付款', 409)
  if (amount > due + 1e-6) {
    fail(`本次金额 ¥${amount.toFixed(2)} 超过${money} ¥${round2(due).toFixed(2)}；多余部分请用 POST /deposits 记为预存款 / 预付款`, 409)
  }

  const updated = syncPayments(appendPayment(doc, ack, { date, amount, remark: remark || (kind === 'sale' ? '收款' : '付款') }), ack)
  const payments = (updated.payments || []).slice()
  const code = genVoucherCode(kind === 'sale' ? 'SK' : 'FK', date, vouchers)
  payments[payments.length - 1] = {
    ...payments[payments.length - 1],
    voucher: code,
    aiRequestId: requestId
  }
  const finalDoc = { ...updated, payments }
  list[idx] = finalDoc

  const now = new Date().toISOString()
  vouchers.push({
    code,
    kind: kind === 'sale' ? 'receivable' : 'payable',
    category: 'normal',
    party,
    date,
    remark: remark || (kind === 'sale' ? '收款' : '付款'),
    total: amount,
    items: [{
      orderId: doc.id,
      orderType: kind,
      amount,
      discount: 0,
      settle: finalDoc.settle,
      note: ''
    }],
    createdAt: now
  })

  const next = { [listKey]: list, [voucherFile]: vouchers, logs: tx.state.logs }
  const r = await commitTransaction(tx, {
    next,
    message: `ai: ${kind === 'sale' ? 'receive' : 'pay'} ${doc.id} ¥${amount} ${code} by ${ctx.key.name}`,
    logEntry: {
      source: 'ai', action: kind === 'sale' ? 'receive' : 'pay', code: doc.id,
      amount, voucher: code, party, key: ctx.key.name, keyId: ctx.key.id, at: now
    }
  })

  return {
    ok: true, kind, id,
    amount,
    outstanding: round2(due - amount),
    settle: finalDoc.settle || '',
    voucher: code,
    commit: r.unchanged ? undefined : r.sha
  }
}
