// 编码规则工具
// 商品 P + 5位 | 客户 C + 5位 | 供应商 S + 5位
// 采购单 C + 年月日时分秒 + 本日4位流水 | 销售单 X + 年月日时分秒 + 本日4位流水

import { cnHMS, todayCN } from './time.js'

// 下一个实体编码：取现有同类编码中最大序号 +1

export function nextEntityCode(list, prefix, digits = 5) {
  let max = 0
  const re = new RegExp('^' + prefix + '(\\d{' + digits + '})$')
  for (const it of (list || [])) {
    const m = re.exec((it && it.code) || '')
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return prefix + String(max + 1).padStart(digits, '0')
}

// 单据号：单字母 + 年月日时分秒 + 本日开单流水号(4位)
export function genOrderId(prefix, list, dateStr) {
  const ymd = (dateStr || '').replace(/-/g, '') ||
    todayCN().replace(/-/g, '')
  // 编号里的时分秒取北京时间，避免设备时区不同导致单号与实际开单时刻不一致
  const hhmmss = cnHMS()
  let seq = 1
  for (const o of (list || [])) {
    if ((o.date || '').replace(/-/g, '') === ymd) seq++
  }
  return `${prefix}${ymd}${hhmmss}${String(seq).padStart(4, '0')}`
}
