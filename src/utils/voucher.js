// 收付款单编码生成：SK-YYYYMMDD-NNN（收款单）/ FK-YYYYMMDD-NNN（付款单）
// 序号 = 当天（同前缀 + 同日）已存在单据数量 + 1，补零三位。
// 这样同一天多张单据自然递增，且不依赖全局自增计数器（避免并发/漏号问题）。

// 把任意可读日期规整成 YYYYMMDD 八位，无法解析时回退今天
export function ymd8(date) {
  if (date) {
    const digits = String(date).replace(/[^0-9]/g, '')
    if (digits.length >= 8) return digits.slice(0, 8)
  }
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}${m}${day}`
}

// 生成下一个单据编码
//   prefix: 'SK' | 'FK' | 'XT' | 'CT'
//   date:   本次单据日期（YYYY-MM-DD 或任意可解析日期）
//   list:   已有的同类型单据数组（取其中 code 字段比对）
//   digits: 流水位数，资金单据 3 位；退货单 4 位（XT-/CT-YYYYMMDD-NNNN）
export function genVoucherCode(prefix, date, list, digits = 3) {
  const head = `${prefix}-${ymd8(date)}-`
  let max = 0
  for (const v of (list || [])) {
    const code = v && v.code
    if (typeof code === 'string' && code.startsWith(head)) {
      const m = /-(\d+)$/.exec(code)
      if (m) max = Math.max(max, parseInt(m[1], 10) || 0)
    }
  }
  return `${head}${String(max + 1).padStart(digits, '0')}`
}
