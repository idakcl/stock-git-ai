// 行级多级折扣纯逻辑测试：覆盖 catalog.js 新增的纯函数。
// 跑法：node tests/line-batch-test.mjs
import assert from 'node:assert/strict'
import {
  lineDiscountRatesOf, lineEffectiveRate, applyLineRates,
  normalizeRate, resolveLine
} from '../src/utils/catalog.js'
import { round2 } from '../src/utils/account.js'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}

console.log('\nlineDiscountRatesOf：规范化行折扣链')

await t('有 discountRates 数组时优先使用', () => {
  assert.deepEqual(lineDiscountRatesOf({ discountRates: [0.9, 0.8] }), [0.9, 0.8])
})

await t('discountRates 含非法项时剔除', () => {
  assert.deepEqual(lineDiscountRatesOf({ discountRates: [0.9, 0, 1.5, 'abc', 0.8] }), [0.9, 0.8])
})

await t('空数组回退到 discountRate 标量', () => {
  assert.deepEqual(lineDiscountRatesOf({ discountRates: [], discountRate: 0.85 }), [0.85])
})

await t('无 discountRates 时使用 discountRate 标量', () => {
  assert.deepEqual(lineDiscountRatesOf({ discountRate: 0.9 }), [0.9])
})

await t('什么都没有时返回空数组', () => {
  assert.deepEqual(lineDiscountRatesOf({}), [])
  // discountRate=0 是既有口径里的「整行全免」（normalizeRate 认 0），不是非法值：
  // 剔掉它会让行折扣框填 0 时静默变回原价，金额凭空多出一笔
  assert.deepEqual(lineDiscountRatesOf({ discountRate: 0 }), [0])
  assert.deepEqual(lineEffectiveRate({ discountRate: 0 }), 0)
  assert.deepEqual(lineDiscountRatesOf({ discountRate: -1 }), [])
})

console.log('\nlineEffectiveRate：行等效折扣率')

await t('多级链连乘', () => {
  assert.equal(lineEffectiveRate({ discountRates: [0.9, 0.9] }), 0.81)
  assert.equal(lineEffectiveRate({ discountRates: [0.9, 0.8] }), 0.72)
})

await t('单级标量回退', () => {
  assert.equal(lineEffectiveRate({ discountRate: 0.85 }), 0.85)
})

await t('无折扣返回 1', () => {
  assert.equal(lineEffectiveRate({}), 1)
  assert.equal(lineEffectiveRate({ discountRate: 1 }), 1)
})

console.log('\napplyLineRates：应用折扣链到行')

await t('两级链 0.9 → 0.9：原价 100，折后 81', () => {
  const result = applyLineRates({}, [0.9, 0.9], 100)
  assert.equal(result.discountRate, 0.81)
  assert.deepEqual(result.discountRates, [0.9, 0.9])
  assert.equal(result.discount, 19)
  assert.equal(result.total, 81)
})

await t('三级链 0.9 → 0.9 → 0.8：原价 1000，折后 648', () => {
  const result = applyLineRates({}, [0.9, 0.9, 0.8], 1000)
  assert.equal(result.discountRate, 0.648)
  assert.deepEqual(result.discountRates, [0.9, 0.9, 0.8])
  assert.equal(result.discount, 352)
  assert.equal(result.total, 648)
})

await t('空链不打折', () => {
  const result = applyLineRates({}, [], 100)
  assert.equal(result.discountRate, 1)
  assert.deepEqual(result.discountRates, [])
  assert.equal(result.discount, 0)
  assert.equal(result.total, 100)
})

await t('非法链剔除后生效', () => {
  const result = applyLineRates({}, [0.9, 0, 1.5, 0.8], 100)
  assert.equal(result.discountRate, 0.72)
  assert.deepEqual(result.discountRates, [0.9, 0.8])
  assert.equal(result.total, 72)
})

console.log('\n向后兼容：normalizeRate 与 resolveLine 不受影响')

await t('normalizeRate 仍只读 discountRate 标量', () => {
  assert.equal(normalizeRate({ discountRate: 0.9 }, 100), 0.9)
  assert.equal(normalizeRate({ discountRate: 0.9, discountRates: [0.8, 0.8] }, 100), 0.9)
})

await t('resolveLine 返回的行不含 discountRates 字段（旧行为不变）', () => {
  const { line } = resolveLine([{ code: 'P1', name: '测试', price: 10 }], { code: 'P1', name: '测试', qty: 2, price: 10, discountRate: 0.9 })
  assert.equal(line.discountRate, 0.9)
  assert.equal(line.discountRates, undefined)
  assert.equal(line.total, 18)
})

console.log('\n过账后不变数：等效值落到 discountRate')

await t('多级链的等效乘积写入 discountRate，过账后金额一致', () => {
  const result = applyLineRates({}, [0.9, 0.9, 0.8], 1000)
  // discountRate 是等效乘积 0.648，过账后 normalizeRate 读到它就能还原同样的金额
  assert.equal(normalizeRate({ discountRate: result.discountRate }, 1000), 0.648)
  const line = { qty: 10, price: 100, discountRate: result.discountRate }
  const gross = round2(line.qty * line.price)
  assert.equal(round2(gross * normalizeRate(line, gross)), 648)
})

await t('旧单只有 discountRate 标量时，lineEffectiveRate 回退到它', () => {
  assert.equal(lineEffectiveRate({ discountRate: 0.85 }), 0.85)
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log(`\n全部 ${pass} 项通过`)
