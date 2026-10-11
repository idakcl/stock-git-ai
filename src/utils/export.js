const escCsv = (v) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
const escHtml = (v) => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const pick = (col, row) => (typeof col.value === 'function' ? col.value(row) : row?.[col.prop])

/** 生成 CSV 文本（带 BOM，Excel 打开不乱码） */
export function buildCSV(columns, rows) {
  const head = columns.map(c => escCsv(c.label)).join(',')
  const body = (rows || []).map(r => columns.map(c => escCsv(pick(c, r))).join(',')).join('\r\n')
  return '\uFEFF' + head + '\r\n' + body
}

/** 下载 CSV 文件 */
export function downloadCSV(filename, columns, rows) {
  const blob = new Blob([buildCSV(columns, rows)], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 打开 A4 排版的新窗口并调用打印 */
export function printA4(title, columns, rows, subtitle = '') {
  const w = window.open('', '_blank')
  if (!w) return
  const head = columns.map(c => `<th>${escHtml(c.label)}</th>`).join('')
  const body = (rows || [])
    .map(r => '<tr>' + columns.map(c => `<td>${escHtml(pick(c, r))}</td>`).join('') + '</tr>')
    .join('')
  const style = `
    @page { size: A4 landscape; margin: 10mm; }
    * { box-sizing: border-box; }
    body { font-family: 'Microsoft YaHei', Arial, sans-serif; font-size: 12px; color: #000; }
    h2 { text-align: center; margin: 0 0 4px; font-size: 18px; }
    .sub { text-align: center; color: #555; margin-bottom: 10px; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #666; padding: 4px 6px; text-align: left; vertical-align: top; }
    th { background: #eee; }
    tr { page-break-inside: avoid; }
    tfoot td { font-weight: 700; }
  `
  w.document.write(
    '<!doctype html><html><head><meta charset="utf-8"><title>' + escHtml(title) + '</title><style>' +
    style + '</style></head><body><h2>' + escHtml(title) + '</h2>' +
    (subtitle ? '<div class="sub">' + escHtml(subtitle) + '</div>' : '') +
    '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></body></html>'
  )
  w.document.close()
  w.focus()
  setTimeout(() => { w.print() }, 300)
}
