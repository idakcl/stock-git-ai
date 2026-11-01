// CSV 导出的公式注入防护：名字/备注里写 `=HYPERLINK(..)`、`@SUM(..)`、`+1+1`
// 在 Excel / WPS 里会被当公式执行。这里钉死：危险前缀加单引号、纯数字（含负数）不受影响、
// 引号逗号换行的转义规则不被破坏。
import assert from 'node:assert/strict'
import { buildCSV } from '../src/utils/export.js'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')) }
}

const one = (value) => buildCSV([{ label: '名字', prop: 'v' }], [{ v: value }]).replace(/^\uFEFF/, '').split('\r\n')
const cell = (value) => one(value)[1]

console.log('\nCSV 公式注入')
t('以 = 开头的文本被前缀单引号', () => {
  assert.equal(cell('=HYPERLINK("http://x","点我")'), `"'=HYPERLINK(""http://x"",""点我"")"`)
})
t('以 @ + - 开头的文本同样处理', () => {
  assert.equal(cell('@SUM(A1)'), `"'@SUM(A1)"`)
  assert.equal(cell('+1+1'), `"'+1+1"`)
  assert.equal(cell('-1+1'), `"'-1+1"`)
})
t('以制表符/回车开头的文本同样处理', () => {
  assert.equal(cell('\t=1'), `"'\t=1"`)
})
t('纯数字与负数金额原样输出（不能被加引号，否则二次计算全错）', () => {
  assert.equal(cell('12.50'), '12.50')
  assert.equal(cell('-12.50'), '-12.50')
  assert.equal(cell('-0.05'), '-0.05')
})
t('普通中文与空值不受影响', () => {
  assert.equal(cell('三通'), '三通')
  assert.equal(cell(''), '')
  assert.equal(cell(null), '')
})
t('原有的引号/逗号/换行转义仍然有效', () => {
  assert.equal(cell('a,b'), '"a,b"')
  assert.equal(cell('a"b'), '"a""b"')
})
t('表头字段同样过防护（自定义落款也可能带公式）', () => {
  const csv = buildCSV([{ label: 'A', prop: 'a' }], [{ a: 1 }], [['备注', '=1+1']]).replace(/^\uFEFF/, '')
  assert.ok(csv.includes(`'=1+1`), csv)
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
