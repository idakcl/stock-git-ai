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
// 流水号取「当天已有单号的最大后缀 + 1」，**不是**「当天单据数量 + 1」：
//   数量法在「删掉一张再开一张」时会算出同一个后缀（3 张 → 删 1 → 又是 3），
//   号码被重复使用，打印件和聊天记录里就出现两个「同一个单号」。
//   取最大值则只在「当天号码被整段清空」时才会回落（例如清空数据后重新开单），
//   这是无外部计数器方案的固有边界，已在 README 写明。
export function genOrderId(prefix, list, dateStr) {
  const ymd = (dateStr || '').replace(/-/g, '') ||
    todayCN().replace(/-/g, '')
  // 编号里的时分秒取北京时间，避免设备时区不同导致单号与实际开单时刻不一致
  const hhmmss = cnHMS()
  let max = 0
  for (const o of (list || [])) {
    const id = String((o && o.id) || '')
    if (!id.startsWith(prefix + ymd)) continue
    const m = /(\d{4})$/.exec(id.slice(prefix.length + ymd.length + 6))
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0)
  }
  return `${prefix}${ymd}${hhmmss}${String(max + 1).padStart(4, '0')}`
}
