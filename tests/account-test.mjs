// 账务口径回归：应收/应付「总额」与未收/未付「余额」必须是两个不同的东西。
// 跑法：node tests/account-test.mjs   （纯 Node，不需要浏览器）
//
// 起因：OrderEditDialog 的保存红线①曾把 payableOf/receivableOf（未付/未收余额）
// 当成「应付/应收总额」用，结清单据的余额恒为 0 → 实付 15 > 上限 0，
// 所有已付满的单据一进编辑弹窗就存不下来，新增时选「结清」并填实付同样被拦。
import assert from 'node:assert/strict'
import {
  grossOf, payableOf, receivableOf, netOf, paidSumOf, receivedSumOf,
  overpaidOf, settleActionOf, isSettledOf, settleBalance,
  discountRatesOf, effectiveRateOf, discountRatesTextOf, discountAmountOf, discountedTotalOf
} from '../src/utils/account.js'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}
const P = (total, payments, extra = {}) => ({ id: 'C1', date: '2026-01-01', total, payments, ...extra })
const S = (total, payments, extra = {}) => ({ id: 'X1', date: '2026-01-01', total, payments, ...extra })

console.log('\n总额 vs 余额：两个量不能混用')
await t('实付＝应付的结清单：余额 0，但总额仍是 15', () => {
  const o = P(15, [{ amount: 15 }])
  assert.equal(payableOf(o), 0)
  assert.equal(grossOf(o), 15)
})
await t('结清单据不被红线①拦（超额 0）', () => {
  assert.equal(overpaidOf(P(15, [{ amount: 15 }]), 'payable'), 0)
  assert.equal(overpaidOf(S(50, [{ amount: 50 }]), 'receivable'), 0)
})
await t('未付满的挂账单不拦', () => {
  assert.equal(overpaidOf(P(100, [{ amount: 30 }]), 'payable'), 0)
})
await t('真超额才拦，且超额额准确', () => {
  assert.equal(overpaidOf(P(15, [{ amount: 20 }]), 'payable'), 5)
  assert.equal(overpaidOf(S(15, [{ amount: 16.5 }]), 'receivable'), 1.5)
})

console.log('\n折扣与优惠进入上限')
await t('整单优惠抵减后按净额算上限（应付 10、已付 10 不拦）', () => {
  const o = P(15, [{ amount: 10 }], { discount: 5 })
  assert.equal(grossOf(o), 10)
  assert.equal(overpaidOf(o, 'payable'), 0)
})
await t('多级折扣链连乘后按折后净额算上限', () => {
  const o = P(100, [{ amount: 81 }], { discountRates: [0.9, 0.9] })
  assert.equal(grossOf(o), 81)
  assert.equal(overpaidOf(o, 'payable'), 0)
  assert.equal(overpaidOf({ ...o, payments: [{ amount: 82 }] }, 'payable'), 1)
})
await t('多笔流水累加后判定（10+5 对 15 不超额）', () => {
  assert.equal(paidSumOf(P(15, [{ amount: 10 }, { amount: 5 }])), 15)
  assert.equal(overpaidOf(P(15, [{ amount: 10 }, { amount: 5 }]), 'payable'), 0)
})

console.log('\n旧数据与红字单据')
await t('无 payments 数组时回退旧 paid 字段，结清旧单同样不被误拦', () => {
  const legacy = { id: 'C2', date: '2024-05-05', total: 100, paid: 100 }
  assert.equal(paidSumOf(legacy), 100)
  assert.equal(overpaidOf(legacy, 'payable'), 0)
})
await t('退货单（负数总额、负数流水）不拦', () => {
  const ret = P(-8618, [{ amount: -8618 }], { type: 'purchase-return' })
  assert.equal(grossOf(ret), -8618)
  assert.equal(overpaidOf(ret, 'payable'), 0)
})
await t('退货核销(settlements)抵平的欠款：仍不算超额', () => {
  const o = S(100, [{ amount: 60 }], { settlements: [{ amount: 40 }] })
  assert.equal(receivableOf(o), 0)
  assert.equal(overpaidOf(o, 'receivable'), 0)
})

console.log('\n红线②（结清必须无欠款）仍按余额判定')
await t('标了结清但仍有未付：余额 > 0，红线②应拦', () => {
  const o = P(100, [{ amount: 90 }], { settle: '结清' })
  assert.equal(netOf(o, 'payable'), 10)
  assert.equal(isSettledOf(netOf(o, 'payable'), o.settle), false)
})
await t('金额已平且无优惠：无改账动作可点', () => {
  assert.equal(settleActionOf(P(100, [{ amount: 100 }], { settle: '结清' }), 'payable'), 'none')
})
await t('金额已平但含抹零优惠：给出「改挂账」', () => {
  assert.equal(settleActionOf(P(100, [{ amount: 95 }], { discount: 5, settle: '结清' }), 'payable'), 'unrest')
})
await t('仍有未付：给出「改结清」', () => {
  assert.equal(settleActionOf(P(100, [{ amount: 40 }]), 'payable'), 'settle')
})

console.log('\nsettleBalance：结清联动（此前仓库内无覆盖）')
await t("anchor='paid'：优惠补差，实付原样返回", () => {
  assert.deepEqual(settleBalance({ gross: 100, paidNow: 85, anchor: 'paid' }), { discount: 15, paidNow: 85 })
})
await t("anchor='paid'：抵扣计入凑够的钱，但返回的 paidNow 只含现金", () => {
  // 毛额 100 = 现金 50 + 抵扣 30 + 抹零 20
  assert.deepEqual(settleBalance({ gross: 100, paidNow: 50, depositPay: 30, anchor: 'paid' }), { discount: 20, paidNow: 50 })
})
await t("anchor='discount'：实付补差 = 毛额 − 优惠 − 抵扣", () => {
  assert.deepEqual(settleBalance({ gross: 100, discount: 10, depositPay: 20, anchor: 'discount' }), { discount: 10, paidNow: 70 })
})
await t('超额一律夹 0，不反向制造欠款', () => {
  assert.deepEqual(settleBalance({ gross: 100, paidNow: 120, anchor: 'paid' }), { discount: 0, paidNow: 120 })
  assert.deepEqual(settleBalance({ gross: 100, discount: 150, anchor: 'discount' }), { discount: 150, paidNow: 0 })
})
await t('非法/缺失/负数输入按 0 处理', () => {
  assert.deepEqual(settleBalance({}), { discount: 0, paidNow: 0 })
  assert.deepEqual(settleBalance({ gross: 'abc', paidNow: null, depositPay: undefined, discount: NaN }), { discount: 0, paidNow: 0 })
  assert.deepEqual(settleBalance({ gross: -50, paidNow: 10, anchor: 'paid' }), { discount: 0, paidNow: 10 })
})
await t('与 grossOf 联动：折后毛额补差后未付恰为 0', () => {
  const base = { id: 'C3', date: '2026-02-02', total: 100, discountRates: [0.9], payments: [{ amount: 85 }] }
  const { discount } = settleBalance({ gross: discountedTotalOf(base), paidNow: 85, anchor: 'paid' })
  assert.equal(discount, 5)
  const settled = { ...base, discount }
  assert.equal(grossOf(settled), 85)
  assert.equal(payableOf(settled), 0)
  assert.equal(overpaidOf(settled, 'payable'), 0)
})

console.log('\n折扣链：旧标量回退、非法剔除、连乘与展示')
await t('旧单只有标量 discountRate 时按单级链生效，不丢折扣', () => {
  assert.deepEqual(discountRatesOf({ discountRate: 0.85 }), [0.85])
  assert.equal(effectiveRateOf({ discountRate: 0.85 }), 0.85)
  assert.equal(discountedTotalOf({ total: 200, discountRate: 0.85 }), 170)
})
await t('折扣链剔除非法项（≤0 / >1 / NaN），空数组与 0 视为无折扣', () => {
  assert.deepEqual(discountRatesOf({ discountRates: [0.9, 0, 1.5, 'abc', 0.8] }), [0.9, 0.8])
  assert.deepEqual(discountRatesOf({}), [])
  assert.deepEqual(discountRatesOf({ discountRates: [] }), [])
  assert.deepEqual(discountRatesOf({ discountRate: 0 }), [])
  assert.equal(effectiveRateOf({ discountRates: [0.9, 0, 1.5] }), 0.9)
})
await t('等效折扣率连乘；无折扣为 1', () => {
  assert.equal(effectiveRateOf({}), 1)
  assert.equal(effectiveRateOf({ discountRates: [0.9, 0.9] }), 0.81)
})
await t('折扣率文本：无折扣空串 / 单级 / 多级带等效', () => {
  assert.equal(discountRatesTextOf({}), '')
  assert.equal(discountRatesTextOf({ discountRate: 0.9 }), '×0.90')
  assert.equal(discountRatesTextOf({ discountRates: [0.9, 0.9, 0.8] }), '×0.90 ×0.90 ×0.80 = ×0.65')
})
await t('折扣金额与折后金额互补：合计 = 折后 + 折扣额', () => {
  const o = { total: 100, discountRates: [0.9, 0.9] }
  assert.equal(discountedTotalOf(o), 81)
  assert.equal(discountAmountOf(o), 19)
  assert.equal(discountedTotalOf(o) + discountAmountOf(o), 100)
})
await t('长折扣链末位收敛：1000 × 0.1³ 恰为 1（不留浮点尘）', () => {
  assert.equal(discountedTotalOf({ total: 1000, discountRates: [0.1, 0.1, 0.1] }), 1)
  assert.equal(discountAmountOf({ total: 1000, discountRates: [0.1, 0.1, 0.1] }), 999)
})
await t('红字单据：折后仍为负、折扣额夹 0，且不参与整单优惠抵减', () => {
  const ret = { total: -100, discountRates: [0.9], discount: 5, type: 'purchase-return' }
  assert.equal(discountedTotalOf(ret), -90)
  assert.equal(discountAmountOf(ret), 0)
  assert.equal(grossOf(ret), -90)
  assert.equal(overpaidOf({ ...ret, payments: [{ amount: -90 }] }, 'payable'), 0)
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
