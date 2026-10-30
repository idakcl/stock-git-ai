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

/** 过滤掉空值字段，统一为 [label, value] 数组 */
const normFields = (headerFields) => (headerFields || [])
  .filter(([label, value]) => value != null && String(value) !== '')

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

const printStyle = `
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Microsoft YaHei', Arial, sans-serif; font-size: 12px; color: #000; }
  h2 { text-align: center; margin: 0 0 4px; font-size: 18px; }
  .sub { text-align: center; color: #555; margin-bottom: 10px; font-size: 12px; }
  .fields { display: flex; flex-wrap: wrap; gap: 2px 24px; border: 1px solid #999; padding: 6px 10px; margin-bottom: 10px; font-size: 12px; }
  .fields .f { min-width: 200px; line-height: 1.7; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #666; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #eee; }
  .idx { width: 42px; text-align: center; }
  tr { page-break-inside: avoid; }
  tfoot td { font-weight: 700; }
  .doc.brk { page-break-after: always; }
`

// 所有打印单据的明细表统一在最前面加「序号」列，从 1 顺排；列表类打印同样适用。
const tableHtml = (columns = [], rows = []) => {
  const head = '<th class="idx">序号</th>' + columns.map(c => `<th>${escHtml(c.label)}</th>`).join('')
  const body = (rows || [])
    .map((r, i) => '<tr><td class="idx">' + (i + 1) + '</td>' +
      columns.map(c => `<td>${escHtml(pick(c, r))}</td>`).join('') + '</tr>')
    .join('')
  return '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>'
}

const sectionHtml = (sec) => {
  const fieldsHtml = normFields(sec.headerFields)
    .map(([label, value]) => `<div class="f"><b>${escHtml(label)}：</b>${escHtml(value)}</div>`)
    .join('')
  return (sec.title ? '<h2>' + escHtml(sec.title) + '</h2>' : '') +
    (sec.subtitle ? '<div class="sub">' + escHtml(sec.subtitle) + '</div>' : '') +
    (fieldsHtml ? '<div class="fields">' + fieldsHtml + '</div>' : '') +
    tableHtml(sec.columns, sec.rows)
}

/**
 * 多节 A4 打印：sections = [{ title, subtitle, headerFields, columns, rows }]，
 * 每一节单独占一页（批量打印多张订单详情用）。
 */
export function printA4Sections(sections, docTitle = '') {
  const list = (sections || []).filter(Boolean)
  if (!list.length) return
  const w = window.open('', '_blank')
  if (!w) return
  const body = list
    .map((sec, i) => '<div class="doc' + (i < list.length - 1 ? ' brk' : '') + '">' + sectionHtml(sec) + '</div>')
    .join('')
  w.document.write(
    '<!doctype html><html><head><meta charset="utf-8"><title>' + escHtml(docTitle || list[0].title || '打印') +
    '</title><style>' + printStyle + '</style></head><body>' + body + '</body></html>'
  )
  w.document.close()
  w.focus()
  setTimeout(() => { w.print() }, 300)
}

/** 打开 A4 排版的新窗口并调用打印；headerFields 为单头信息 [[标签,值],...]，渲染在标题与表格之间 */
export function printA4(title, columns, rows, subtitle = '', headerFields = []) {
  const w = window.open('', '_blank')
  if (!w) return
  const fieldsHtml = normFields(headerFields)
    .map(([label, value]) => `<div class="f"><b>${escHtml(label)}：</b>${escHtml(value)}</div>`)
    .join('')
  w.document.write(
    '<!doctype html><html><head><meta charset="utf-8"><title>' + escHtml(title) + '</title><style>' +
    printStyle + '</style></head><body><h2>' + escHtml(title) + '</h2>' +
    (subtitle ? '<div class="sub">' + escHtml(subtitle) + '</div>' : '') +
    (fieldsHtml ? '<div class="fields">' + fieldsHtml + '</div>' : '') +
    tableHtml(columns, rows) + '</body></html>'
  )
  w.document.close()
  w.focus()
  setTimeout(() => { w.print() }, 300)
}
