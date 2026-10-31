import { paperPref } from './printPrefs.js'

const escCsv = (v) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
const escHtml = (v) => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const pick = (col, row) => (typeof col.value === 'function' ? col.value(row) : row?.[col.prop])

/**
 * 列表打印用：商品名/编码超过 max 个时只保留前 max 个，其余用省略号代替，
 * 避免一长串商品把打印纸占满（CSV 导出不受影响，仍导出全量）。
 */
export function joinLimited(list, max = 3) {
  const arr = (list || []).filter(Boolean)
  return arr.length > max ? arr.slice(0, max).join('、') + '…' : arr.join('、')
}

/** 过滤掉空值字段，统一为 [label, value(, tone)] 数组；tone='hl' 加框强调，'xl' 放大 1.2 倍 */
const normFields = (headerFields) => (headerFields || [])
  .filter(([label, value]) => value != null && String(value) !== '')
const fieldHtml = ([label, value, tone]) =>
  `<div class="f${tone ? ' ' + escHtml(tone) : ''}"><b>${escHtml(label)}：</b>${escHtml(value)}</div>`

// 打印落款（用户信息等）：跟在明细表下方，不参与表格布局
const footerHtml = (footerFields) => {
  const list = normFields(footerFields)
  if (!list.length) return ''
  return '<div class="foot">' + list.map(([label, value]) =>
    `<span class="fi"><b>${escHtml(label)}：</b>${escHtml(value)}</span>`).join('') + '</div>'
}

/** 生成 CSV 文本（带 BOM，Excel 打开不乱码）；headerFields 为单头信息 [[标签,值],...]，渲染在表头上方 */
export function buildCSV(columns, rows, headerFields = []) {
  const head = columns.map(c => escCsv(c.label)).join(',')
  const body = (rows || []).map(r => columns.map(c => escCsv(pick(c, r))).join(',')).join('\r\n')
  const fields = normFields(headerFields)
    .map(([label, value]) => escCsv(label) + ',' + escCsv(value))
    .join('\r\n')
  const headBlock = fields ? fields + '\r\n\r\n' : ''
  return '\uFEFF' + headBlock + head + '\r\n' + body
}

/** 下载 CSV 文件 */
export function downloadCSV(filename, columns, rows, headerFields = []) {
  const blob = new Blob([buildCSV(columns, rows, headerFields)], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * 版面规划：纸张尺寸 → 字号、单元格留白、每页明细行数，一处定义、所有打印页面共用。
 *
 * rowsPerPage 为什么是「行数预算」而不是「塞满为止」：
 *   明细表由代码按这个上限切片（见 pageCapacities），每片都自带表头，
 *   所以这个数必须留出余量 —— 真机打印时浏览器分页与 PDF 分页略有差异，
 *   卡着像素算会导致某一片溢出半行、多出一张只有两三行的纸。
 * headReserve / footReserve：首页要放标题+单头信息块，末页要放落款块，
 *   各自按「相当于几行明细」的高度扣掉，保证每片都落在同一张纸里。
 */
export const PAPER_SPECS = {
  A4: {
    key: 'A4', page: 'A4 landscape', margin: '8mm',
    // w/h 为横向时的纸宽/纸高（mm）；纵向＝两者对调，每页行数按纵向纸高重算
    w: 297, h: 210, marginMm: 8,
    base: 11, pad: '1px 4px',
    // rowsPerPage 只是历史参考值（按 @page 8mm 边距算满）；实际行数统一由
    // rowsPerPageOf() 按「虚拟边距」重算，见 budgetMarginMm 的说明
    rowsPerPage: 40, headReserve: 6, footReserve: 2
  },
  A5: {
    key: 'A5', page: 'A5 landscape', margin: '5mm',
    w: 210, h: 148, marginMm: 5,
    base: 9.5, pad: '1px 3px',
    rowsPerPage: 28, headReserve: 6, footReserve: 2
  }
}

// ---- 纸张换算：mm → CSS px（96dpi），行高与每页行数都从这里推导 ----
const MM_PX = 96 / 25.4
// 明细行高：正文行高 1.25 + 上下留白 2px + 边框 1px（与 printStyle 里的 CSS 一一对应）
const rowPxOf = (base) => base * 1.25 + 3
/**
 * 行数预算用的「虚拟边距」。
 *
 * @page 里写的是 8mm（A5 5mm），浏览器和打印驱动却不一定照着留白：
 * iOS / AirPrint 一类链路常见默认边距约 12.7mm（0.5 英寸），还会因打印机再缩一点。
 * 按 8mm 算出来的行数在那种环境下每页少装两三行，溢出的行落到下一张纸；
 * 而每片明细末尾都强制换页，那张纸上就只剩两三行、下面全白 —— 正是「第二页只有几行」的成因。
 *
 * 所以行数预算宁可保守：边距至少按 24mm 计（约合 1 英寸，真机 12.7mm 边距下仍有富余；
 * 窄纸/矮纸按纸高的 16% 封顶，避免小票纸被算成只能印几行）。
 * 代价是每页底部会空出几行——比多出一张只有两三行的白纸好得多。
 */
const BUDGET_MARGIN_MM = 24
const budgetMarginMm = (heightMm, marginMm) => {
  const floor = Math.min(BUDGET_MARGIN_MM, Math.max(6, heightMm * 0.16))
  return Math.max(Number(marginMm) || 0, floor)
}
// 每页能装几行：扣掉表头行与 1 行安全余量，保证「一片＝一张纸」，不会因为差几像素
// 把最后一行挤到下一页（那一页就只剩光秃秃的一行，看起来像「跨页表头失败」）
export function rowsPerPageOf(heightMm, marginMm, base) {
  const m = budgetMarginMm(heightMm, marginMm)
  const contentPx = Math.max(60, heightMm - m * 2) * MM_PX
  const rows = Math.floor((contentPx - rowPxOf(base)) / rowPxOf(base)) - 1
  return Math.max(5, rows)
}

// 自定义纸张：宽高单位 mm，字号按纸宽等比缩放（A4 横向 281mm 内容宽对应正文 11px），
// 每页行数按纸高推算，保证小票纸、B5、二等分纸都能打出完整版面
export function customSpec(width, height, rowsPerPage = 0) {
  const w = Math.min(1000, Math.max(40, Number(width) || 210))
  const h = Math.min(1000, Math.max(40, Number(height) || 297))
  const marginMm = Math.max(3, Math.min(10, Math.round(Math.min(w, h) * 0.04)))
  // 字号只分两档：常规纸（A5 及以上）与 A4 同档 11px，小票/窄纸用 9.5px。
  // 不按纸宽连续缩放——纸窄了字号也跟着缩会小到看不清，窄纸的关键是列少、字别小。
  const base = Math.min(w, h) >= 148 ? 11 : 9.5
  const rows = Number(rowsPerPage) > 0 ? Math.round(Number(rowsPerPage)) : rowsPerPageOf(h, marginMm, base)
  return {
    key: 'custom', page: `${w}mm ${h}mm`, margin: `${marginMm}mm`,
    w, h, marginMm, base, pad: base < 10 ? '1px 3px' : '1px 4px',
    rowsPerPage: rows, headReserve: 6, footReserve: 2
  }
}

/**
 * 解析纸张：页面上只有一个「打印」按钮，纸张统一来自「打印设置」（A4 / A5 / 自定义 + 横纵向）。
 * paper 参数只是给脚本类调用留的覆盖口（打印入口都不再传它）。
 * 自定义纸优先（此时 A4/A5 与方向都不参与）；每页行数手动填了就用它，否则按纸高自动推算。
 */
export const paperSpec = (paper) => {
  const cfg = paperPref || {}
  const preset = PAPER_SPECS[String(paper || cfg.paper || 'A4').toUpperCase()] || PAPER_SPECS.A4
  let spec = preset
  if (cfg.mode === 'custom') {
    // 自定义：宽高即最终出纸方向（宽 < 高＝纵向），不再额外换算
    spec = customSpec(cfg.width, cfg.height, cfg.rowsPerPage)
  } else if (cfg.orientation === 'portrait') {
    const w = preset.h, h = preset.w
    spec = {
      ...preset, page: `${preset.key} portrait`, w, h,
      rowsPerPage: rowsPerPageOf(h, preset.marginMm, preset.base)
    }
  } else {
    // 横向同样按「虚拟边距」重算，不能沿用 40 / 28 的旧常量：
    // 那是按 @page 8mm 边距算满的值，真机上下边距一宽，每页就少装三五行，
    // 尾巴被挤到下一张纸，看起来又是一页只印了几行。
    spec = { ...preset, rowsPerPage: rowsPerPageOf(preset.h, preset.marginMm, preset.base) }
  }
  // 手动行数覆盖（0＝自动）：纸高推算偏保守时也能用，遇到真机溢出就调小
  const manual = Number(cfg.rowsPerPage) > 0 ? Math.round(Number(cfg.rowsPerPage)) : 0
  return manual ? { ...spec, rowsPerPage: manual } : spec
}

// 字号一律由 base 推导：换纸张时整套版式等比缩放，「金额 = 其他字体的 1.2 倍」这条比例不会走样
// repeatHeader=false 时必须把 thead 的 table-header-group 一起关掉：
// 只关掉我们的分片还不够，Chromium 自己会按这条声明在续页顶上重排表头，
// 结果「不重复表头」的选项名不副实。
const printStyle = (p, repeatHeader = true) => {
  // 只保留两位小数、去掉无意义的尾 0：产出 11px / 13.2px / 15.4px 这种可读值，
  // 免得 11*1.4 的浮点尾巴（15.399999…）写进样式里
  const fs = (n) => `${Math.round(p.base * n * 100) / 100}px`
  return `
    @page { size: ${p.page}; margin: ${p.margin}; }
    * { box-sizing: border-box; }
    body { font-family: 'Microsoft YaHei', Arial, sans-serif; font-size: ${p.base}px; color: #000; }
    h2 { text-align: center; margin: 0 0 2px; font-size: ${fs(1.4)}; }
    .sub { text-align: center; color: #555; margin-bottom: 4px; font-size: ${fs(1)}; }
    .fields { display: flex; flex-wrap: wrap; gap: 1px 18px; border: 1px solid #999; padding: 3px 8px; margin-bottom: 5px; font-size: ${fs(1)}; }
    .fields .f { min-width: 180px; line-height: 1.5; }
    .fields .f.hl { border: 1px solid #000; background: #f2f2f2; font-weight: 700; padding: 0 6px; }
    /* 订单金额：以前固定 24px（其他字体的 2 倍）在 A4 上过于突兀，改成正文的 1.2 倍 + 加粗，
       随纸张 base 字号走（A4 13.2px / A5 11.4px），两种纸上观感一致。 */
    .fields .f.xl { font-size: ${fs(1.2)}; font-weight: 800; line-height: 1.3; }
    .foot { margin-top: 4px; padding-top: 3px; border-top: 1px solid #666; display: flex; flex-wrap: wrap; gap: 1px 18px; font-size: ${fs(1)}; }
    .foot .fi { min-width: 170px; line-height: 1.5; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    /* 跨页表头：主要靠下面 pageCapacities 把明细切成「每片自带表头」的多张表，
       这条声明只是兜底 —— 万一某片在真机上多溢出几像素，浏览器仍会给续页补表头。
       （以前只有这条声明，明细表是一整张表，部分浏览器/打印驱动并不重复表头，等于没实现。） */
    thead { display: ${repeatHeader ? 'table-header-group' : 'table-row-group'}; }
    tfoot { display: table-footer-group; }
    /* 行高写死 1.25：每页 40 行这条预算必须靠「行高可预测」才成立。
       用默认 line-height 时行高跟随字体（雅黑 / 宋体 / 系统 CJK 回退各不相同，实测能差 4px/行），
       40 行就会在某些机器上溢到第二页，把「一片一页」的分片变成「一片两页」。 */
    th, td { border: 1px solid #666; padding: ${p.pad}; text-align: left; vertical-align: top; line-height: 1.25; overflow-wrap: anywhere; }
    th { background: #eee; }
    .idx { text-align: center; }
    tr { page-break-inside: avoid; break-inside: avoid; }
    tfoot td { font-weight: 700; }
    /* 每一片明细表（除全文最后一片）后强制换页：切片数 = 实际页数 */
    table.pg.brk, .doc.brk { page-break-after: always; break-after: page; }
  `
}

/**
 * 列宽：按「整份明细」算一次，写进每张分片表的 <colgroup>。
 *
 * 为什么必须显式给宽：分片之后每页是一张独立的 <table>，默认自动布局会各自按
 * 「本页内容」定宽 —— 第 1 页有「PE管外牙直接50*112M」这种长名称，第 2 页只有短行，
 * 两页的列宽就错开了（真机打印看到的正是这个）。table-layout:fixed + 同一份 colgroup
 * 才能让所有分页的列对齐。
 *
 * 权重按显示宽度取（中日韩与全角符号算 2，其余算 1），并夹在 4~44 之间：
 * 下限防止「单位」这种两字列被压到换行，上限防止一个超长名称列吞掉其它列。
 */
const dispWidth = (v) => {
  let n = 0
  for (const ch of String(v ?? '')) n += /[^\x00-\xff]/.test(ch) ? 2 : 1
  return n
}
// 每列都要额外留出单元格内边距 + 边框（约 2 个半角字符宽），
// 否则「编码」这种刚好等于文字宽度的列会在打印时换行，一行变两行、每页 40 行的预算就崩了。
const PAD = 2
export function columnWidths(columns = [], rows = []) {
  const IDX = 4 // 序号列：表头「序号」4 个半角宽，加上留白刚好容得下三位数
  const weights = [IDX + PAD, ...columns.map(c => {
    let w = dispWidth(c.label)
    for (const r of rows || []) w = Math.max(w, dispWidth(pick(c, r)))
    return Math.min(Math.max(w, 4), 44) + PAD
  })]
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  const pct = weights.map(w => Math.round((w / sum) * 10000) / 100)
  // 四舍五入后凑整到 100%，否则 fixed 布局下最后一列会差出零点几个百分点
  pct[pct.length - 1] = Math.round((100 - pct.slice(0, -1).reduce((a, b) => a + b, 0)) * 100) / 100
  return pct
}
const colgroupHtml = (widths) => '<colgroup>' + widths.map(w => `<col style="width:${w}%">`).join('') + '</colgroup>'

// 所有打印单据的明细表统一在最前面加「序号」列，从 1 顺排；列表类打印同样适用。
// offset 是分片起始下标：第 2 页的序号必须接着第 1 页排，不能从 1 重来。
// widths 是分页之间共用的列宽（见 columnWidths），不传就退回自动布局。
const tableHtml = (columns = [], rows = [], offset = 0, cls = '', widths = null) => {
  const head = '<th class="idx">序号</th>' + columns.map(c => `<th>${escHtml(c.label)}</th>`).join('')
  const body = (rows || [])
    .map((r, i) => '<tr><td class="idx">' + (offset + i + 1) + '</td>' +
      columns.map(c => `<td>${escHtml(pick(c, r))}</td>`).join('') + '</tr>')
    .join('')
  return '<table' + (cls ? ' class="' + cls + '"' : '') + '>' +
    (widths ? colgroupHtml(widths) : '') +
    '<thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>'
}

/**
 * 按「每页行数」算出各页应装几行：首页扣掉单头预留、末页扣掉落款预留。
 * 返回值是每页行数，总和 === total（total 为 0 时返回 [0]，表示「只有表头的一页」，
 * 空明细也必须能打出一张带表头的纸）。
 */
export function pageCapacities(total, rowsPerPage, headReserve, footReserve) {
  const t = Math.max(0, Number(total) || 0)
  if (!t) return [0]
  const first = Math.max(1, rowsPerPage - headReserve)
  const caps = []
  let rem = t
  caps.push(Math.min(first, rem))
  rem -= caps[0]
  while (rem > 0) {
    const take = Math.min(rowsPerPage, rem)
    caps.push(take)
    rem -= take
  }
  // 末页装满时给它让出落款的位置：多出的行另起一页（否则落款会被挤到下一张纸）
  const last = caps.length - 1
  const lastCap = Math.max(1, rowsPerPage - footReserve)
  if (caps[last] > lastCap) {
    const spill = caps[last] - lastCap
    caps[last] = lastCap
    caps.push(spill)
  }
  return caps
}

// 明细分片渲染：每片一张完整表格（各自带 <thead>），除最后一片外强制换页。
// repeatHeader=false 时不切片：整份明细就是一张表，表头只出现在第 1 页，
// 后面由浏览器自然续页（有人就要这种「一张连续的大表」）。
const pagedTables = (columns, rows, p, opts, repeatHeader = true) => {
  const list = rows || []
  const widths = columnWidths(columns, list)
  if (!repeatHeader) return tableHtml(columns, list, 0, 'pg', widths)
  // 按「折行后的实际行数」分页，而不是按「条目数」：名称一旦折成两行，
  // 一行就吃掉两行的高度，按条目数切的片必然溢出——溢出的那几行会跑到下一张纸，
  // 紧接着又是强制换页，于是出现「第二页只有两三行、下面全空」。
  const costs = rowLineCosts(columns, list, widths, p)
  const caps = packPageSlices(costs, p.rowsPerPage, opts.headRows || 0, opts.foot ? p.footReserve : 0)
  let offset = 0
  return caps.map((n, i) => {
    const slice = list.slice(offset, offset + n)
    offset += n
    return tableHtml(columns, slice, offset - n, 'pg' + (i < caps.length - 1 ? ' brk' : ''), widths)
  }).join('')
}

/**
 * 一行明细实际会占几行纸面。
 *
 * 以前的页行数预算只数「条目」：40 条就是 40 行。可名称列宽度有限，
 * 长商品名会折成两行，一条就顶两条的高度；条目一多，预定的 40 条就装不下，
 * 溢出部分落到下一张纸 —— 而每片末尾又强制换页，于是那张纸上只剩两三行、大片空白。
 *
 * 这里按列宽与字宽估算每条明细的折行数：整行取所有列里最多的折行数
 * （单元格是并排的，最高的那格决定行高）。全角按 1em、半角按 0.55em 计，
 * 再留 2% 宽度余量，宁可少排一行，也不让一片溢到下一张纸。
 */
export function rowLineCosts(columns, rows, widths, p) {
  // 宽度也按虚拟边距收缩：真机边距一宽，可用纸宽同步变窄，长名称/编码更容易折行。
  // 只按 @page 8mm 算会低估折行数，导致「页数算少了、最后一片溢出」。
  const contentPx = Math.max(120, (p.w - budgetMarginMm(p.w, p.marginMm) * 2) * MM_PX)
  // 单元格左右 padding（p.pad 里的横向值）+ 边框，和 printStyle 一一对应
  const padPx = p.base < 10 ? 8 : 10
  const avail = widths.slice(1).map(pct => Math.max(10, contentPx * (pct / 100) - padPx) * 0.98)
  const pxOf = (v) => {
    let px = 0
    for (const ch of String(v ?? '')) px += /[^\x00-\xff]/.test(ch) ? p.base : p.base * 0.55
    return px
  }
  return (rows || []).map(r => {
    let lines = 1
    columns.forEach((c, i) => {
      lines = Math.max(lines, Math.ceil(pxOf(pick(c, r)) / avail[i]))
    })
    return lines
  })
}

/**
 * 按「行数成本」把明细切到各页：首页扣单头预留、末页扣落款预留。
 * costs 全是 1 时，结果与 pageCapacities（按条目数切）完全一致。
 * 每页至少放一行（单行成本超过一页也只放它自己），保证 sum(caps) === costs.length。
 */
export function packPageSlices(costs, rowsPerPage, headReserve = 0, footReserve = 0) {
  const list = costs || []
  if (!list.length) return [0]
  const cap = Math.max(1, Math.round(rowsPerPage) || 1)
  const firstCap = Math.max(1, cap - Math.max(0, headReserve))
  const lastCap = Math.max(1, cap - Math.max(0, footReserve))
  const caps = []
  const used = []
  let i = 0
  const take = (limit) => {
    let lines = 0, n = 0
    while (i < list.length && (n === 0 || lines + list[i] <= limit)) {
      lines += list[i]
      n++
      i++
    }
    caps.push(n)
    used.push(lines)
  }
  take(firstCap)
  while (i < list.length) take(cap)
  // 末页要给落款腾位置：装太满就把尾部挪到新的一页
  while (used[used.length - 1] > lastCap && caps[caps.length - 1] > 1) {
    const last = caps.length - 1
    i -= 1
    caps[last] -= 1
    used[last] -= list[i]
  }
  while (i < list.length) take(cap)
  return caps
}

/**
 * 首页要为单头信息（标题 / 副标题 / 信息块）预留几行。
 *
 * 以前所有纸张都写死 6 行（A4 够用），但自定义纸张（尤其窄纸）里信息块会折成好几行，
 * 6 行不够 → 首页多溢出几像素 → 浏览器把最后一行挤到下一张纸，那张纸看着就像「表头丢了」。
 * 这里按纸宽算信息块会折几行、再按行高折成「行数」，并多留 1 行安全余量。
 */
const headReserveOf = (sec, p) => {
  const fields = normFields(sec.headerFields)
  if (!sec.title && !sec.subtitle && !fields.length) return 0
  const rowPx = rowPxOf(p.base)
  const contentW = Math.max(120, (p.w - p.marginMm * 2) * MM_PX)
  let px = 0
  if (sec.title) px += p.base * 2.2
  if (sec.subtitle) px += p.base * 1.8
  if (fields.length) {
    // .fields 里的 .f 有 min-width:180px，一行能放几个按内容宽算
    const perRow = Math.max(1, Math.floor(contentW / 190))
    px += Math.ceil(fields.length / perRow) * (p.base * 1.9) + 12
  }
  return Math.max(1, Math.ceil(px / rowPx) + 1)
}

// 一节（一张单据）的打印内容：单头信息只在首页出现，落款只在末页出现
const sectionHtml = (sec, p, withFooter, repeatHeader = true) => {
  const fieldsHtml = normFields(sec.headerFields).map(fieldHtml).join('')
  const hasHead = !!(sec.title || sec.subtitle || fieldsHtml)
  return (sec.title ? '<h2>' + escHtml(sec.title) + '</h2>' : '') +
    (sec.subtitle ? '<div class="sub">' + escHtml(sec.subtitle) + '</div>' : '') +
    (fieldsHtml ? '<div class="fields">' + fieldsHtml + '</div>' : '') +
    pagedTables(sec.columns, sec.rows, p, {
      // 首页扣除单头占用的行数；无单头时不需要预留
      headRows: hasHead ? headReserveOf(sec, p) : 0,
      foot: withFooter
    }, repeatHeader) +
    (withFooter ? footerHtml(sec.footerFields) : '')
}

/** 生成完整打印文档 HTML（纯函数：不发窗口、不打扰用户，方便测试直接断言版面结构） */
export function buildPrintHtml({ title, subtitle, headerFields, columns, rows, footerFields, sections, docTitle, paper, repeatHeader = true } = {}) {
  const p = paperSpec(paper)
  const style = printStyle(p, repeatHeader)
  const list = sections && sections.length
    ? sections.filter(Boolean)
    : [{ title, subtitle, headerFields, columns, rows, footerFields }]
  const body = list.map((sec, i) => {
    const html = sectionHtml(sec, p, !!(sec.footerFields || []).length, repeatHeader)
    // 多张单据批量打印：每张单独占一页（最后一张不加换页）
    return list.length > 1 ? '<div class="doc' + (i < list.length - 1 ? ' brk' : '') + '">' + html + '</div>' : html
  }).join('')
  const head = docTitle || title || (list[0] && list[0].title) || '打印'
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + escHtml(head) +
    '</title><style>' + style + '</style></head><body>' + body + '</body></html>'
}

function openPrintWindow(html, title) {
  const w = window.open('', '_blank')
  if (!w) return null
  w.document.write(html)
  w.document.close()
  w.focus()
  setTimeout(() => { w.print() }, 300)
  return w
}

/**
 * 多节打印：sections = [{ title, subtitle, headerFields, columns, rows }]，
 * 每一节单独占一页（批量打印多张订单详情用）；paper='A4' | 'A5'；
 * repeatHeader=false 时明细不切片、表头只在每张单据第一页出现一次。
 */
export function printA4Sections(sections, docTitle = '', paper = '', repeatHeader = true) {
  const list = (sections || []).filter(Boolean)
  if (!list.length) return
  openPrintWindow(buildPrintHtml({ sections: list, docTitle, paper, repeatHeader }), docTitle || list[0].title || '打印')
}

/**
 * 打开排版好的新窗口并调用打印；headerFields 为单头信息 [[标签,值],...]，footerFields 打印在明细表下方。
 * paper：不传就用「打印设置」里的纸张（A4 / A5 / 自定义 + 横纵向）；函数名保留 printA4 是历史叫法。
 * repeatHeader：默认 true（每页都重复商品表头）；false＝整份明细一张连续大表，表头只印一次。
 */
export function printA4(title, columns, rows, subtitle = '', headerFields = [], footerFields = [], paper = '', repeatHeader = true) {
  openPrintWindow(
    buildPrintHtml({ title, subtitle, headerFields, columns, rows, footerFields, paper, repeatHeader }),
    title
  )
}
