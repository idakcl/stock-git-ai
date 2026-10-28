// 系统时区：固定东八区（UTC+8）
//
// 业务日期、单据编号里的时间一律按北京时间计算，与浏览器/设备所在时区无关：
// 原来直接 new Date().toISOString().slice(0, 10) 取的是 UTC 日期，
// 北京时间 00:00–08:00 开单会被记成前一天，跨月、跨年时对账会错位。
const CN_OFFSET_MS = 8 * 60 * 60 * 1000

// 把时间点平移到东八区，之后用 getUTC*/toISOString 读取即为北京时间
export function cnShift(ms = Date.now()) {
  return new Date(Number(ms) + CN_OFFSET_MS)
}

const pad = n => String(n).padStart(2, '0')

// 北京时间日期 YYYY-MM-DD
export function todayCN(ms = Date.now()) {
  return cnShift(ms).toISOString().slice(0, 10)
}

// 北京时间 YYYY-MM-DD HH:mm:ss，用于界面时钟与展示
export function cnDateTime(ms = Date.now()) {
  const d = cnShift(ms)
  return `${d.toISOString().slice(0, 10)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

// 北京时间时分秒 HHmmss，用于单据编号
export function cnHMS(ms = Date.now()) {
  const d = cnShift(ms)
  return pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds())
}
