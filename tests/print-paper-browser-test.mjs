// 打印纸张：自定义纸张 / A4 纵向 / 手动每页行数，以及「跨页表头」在真机分页下确实每页都有。
// 用真实 Chromium 打印引擎（preferCSSPageSize 吃 @page 尺寸）出 PDF 校验，不靠猜。
// 跑法：先起 dev server（npx vite --port 5173 --strictPort --host 127.0.0.1），再 node tests/print-paper-browser-test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import cp from 'node:child_process'
import { buildPrintHtml, paperSpec, paperRowsInfo, headRowsOf, customSpec, rowsPerPageOf, columnWidths, rowLineCosts, packPageSlices, pageCapacities, PAPER_SPECS } from '../src/utils/export.js'
import { paperPref, resetPaperPref } from '../src/utils/printPrefs.js'

const { chromium } = createRequire(import.meta.url)('playwright')
const browser = await chromium.launch()

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      ')) }
}

const columns = [
  { label: '商品名称', prop: 'name' },
  { label: '数量', prop: 'qty' },
  { label: '金额', prop: 'total' }
]
const rowsOf = (n, nameOf = (i) => `商品${i + 1}`) =>
  Array.from({ length: n }, (_, i) => ({ name: nameOf(i), qty: 1, price: 10, total: 10 }))
const docOf = (rows) => ({
  title: '销售单 X1', subtitle: '客户：客户甲',
  headerFields: [['客户', '客户甲'], ['日期', '2026-10-30'], ['合计', '¥ 100.00', 'hl']],
  columns, rows, paper: 'A4'
})
const chunkCount = (html) => (html.match(/<table class="pg/g) || []).length

async function pdfPages(html, file) {
  const probe = await browser.newPage()
  await probe.setContent(html)
  const pdf = await probe.pdf({ printBackground: true, preferCSSPageSize: true })
  await probe.close()
  await fs.writeFile(file, pdf)
  const info = cp.execSync(`pdfinfo ${file}`).toString()
  const pages = Number(/Pages:\s+(\d+)/.exec(info)[1])
  const size = (/Page size:\s+(.+)/.exec(info) || [])[1] || ''
  const [w, h] = (size.match(/([\d.]+)\s*x\s*([\d.]+)/) || []).slice(1).map(Number)
  const textOf = (i) => cp.execSync(`pdftotext -layout -f ${i} -l ${i} ${file} -`).toString()
  return { pages, size, wmm: w / 72 * 25.4, hmm: h / 72 * 25.4, textOf }
}

console.log('\n纸张换算（纯函数）')

await t('自定义纸张：宽高按 mm 出纸，每页行数按纸高推算', () => {
  const s = customSpec(100, 150)
  assert.equal(s.page, '100mm 150mm')
  assert.equal(s.margin, '4mm')
  assert.ok(s.rowsPerPage > 10 && s.rowsPerPage < 60, `每页行数应随纸高收缩，实际 ${s.rowsPerPage}`)
  // 高纸多装行、矮纸少装行
  assert.ok(customSpec(100, 300).rowsPerPage > customSpec(100, 100).rowsPerPage)
  // 非法输入夹到安全范围，不产生 NaN / 0 行
  const bad = customSpec('', '')
  assert.ok(Number.isFinite(bad.rowsPerPage) && bad.rowsPerPage >= 5)
  assert.equal(bad.page, '210mm 297mm')
})

await t('A4 纵向：行数按纵向纸高重算，比横向多', () => {
  const rowsOfPage = (h, m, b) => rowsPerPageOf(h, m, b)
  const portrait = rowsOfPage(PAPER_SPECS.A4.w, PAPER_SPECS.A4.marginMm, PAPER_SPECS.A4.base)
  assert.ok(portrait > PAPER_SPECS.A4.rowsPerPage, `纵向 ${portrait} 应多于横向 ${PAPER_SPECS.A4.rowsPerPage}`)
  resetPaperPref()
  paperPref.orientation = 'portrait'
  const s = paperSpec('A4')
  assert.equal(s.page, 'A4 portrait')
  assert.equal(s.rowsPerPage, portrait)
  resetPaperPref()
})

await t('分页按「折行后的行数」计算：长名称折行会占两行高度', () => {
  const p = { ...PAPER_SPECS.A4, w: 210, h: 297, marginMm: 8, base: 11 }
  const cols = [{ label: '名称', prop: 'name' }, { label: '数量', prop: 'qty' }]
  const rows = rowsOf(6, i => (i === 0 ? '很长的商品名称'.repeat(12) : '三通'))
  const widths = columnWidths(cols, rows)
  const costs = rowLineCosts(cols, rows, widths, p)
  assert.ok(costs[0] >= 2, `长名称应折成多行，实际 ${costs[0]}`)
  assert.equal(costs[1], 1)
  // 按累计行数切页：两行成本的条目不能被当成一行塞进页尾
  const caps = packPageSlices(costs, 8, 0, 0)
  assert.equal(caps.reduce((a, b) => a + b, 0), 6, '切片后条目总数不能变')
  let off = 0
  for (const n of caps) {
    const used = costs.slice(off, off + n).reduce((a, b) => a + b, 0)
    assert.ok(used <= 8, `每页行数不得超过预算，实际 ${used}`)
    off += n
  }
})

await t('packPageSlices 与旧的条目分片完全兼容（每行成本为 1 时）', () => {
  for (const [total, cap, head, foot] of [[140, 40, 6, 0], [140, 40, 6, 2], [74, 40, 6, 2], [34, 40, 6, 0], [3, 40, 6, 0]]) {
    const caps = packPageSlices(Array(total).fill(1), cap, head, foot)
    assert.deepEqual(caps, pageCapacities(total, cap, head, foot), `${total}/${cap}/${head}/${foot}`)
  }
  assert.deepEqual(packPageSlices([], 40, 6, 2), [0], '空明细也要有一片（只有表头的一页）')
  // 任意折行组合：切片总数守恒、每片不超过预算
  const costs = [1, 2, 1, 3, 1, 1, 2, 4, 1, 1, 1, 2]
  const caps = packPageSlices(costs, 6, 2, 1)
  assert.equal(caps.reduce((a, b) => a + b, 0), costs.length)
  let off = 0
  caps.forEach((n, i) => {
    const used = costs.slice(off, off + n).reduce((a, b) => a + b, 0)
    const limit = i === 0 ? 4 : 6
    assert.ok(used <= limit || n === 1, `第 ${i + 1} 页超预算：${used} > ${limit}`)
    off += n
  })
})

await t('行数预算按更大的虚拟边距算：1 英寸打印边距下也装得下', () => {
  const rows = rowsPerPageOf(297, 8, 11)
  assert.ok(rows <= 56, `A4 纵向行数应保守（实际 ${rows}），不能按 8mm 边距算满`)
  const rowPx = 11 * 1.25 + 3
  const content = (297 - 25.4 * 2) * 96 / 25.4   // 1 英寸边距下的可打印高度
  assert.ok((rows + 1) * rowPx <= content, `整页明细(含表头)必须装进 1 英寸边距：${(rows + 1) * rowPx} vs ${content}`)
})

await t('自定义纸张优先于 A4/A5 纸张选择；每页行数可手动覆盖', () => {
  resetPaperPref()
  paperPref.orientation = 'landscape'
  assert.equal(paperSpec('A4').page, 'A4 landscape')
  assert.equal(paperSpec('A5').page, 'A5 landscape')
  paperPref.mode = 'custom'
  paperPref.width = 148
  paperPref.height = 100
  assert.equal(paperSpec('A4').page, '148mm 100mm')
  assert.equal(paperSpec('A5').page, '148mm 100mm', '自定义纸下两个按钮出同一种纸')
  const auto = paperSpec('A4').rowsPerPage
  paperPref.rowsPerPage = 12
  assert.equal(paperSpec('A4').rowsPerPage, 12)
  assert.notEqual(auto, 12)
  paperPref.rowsPerPage = 0
  resetPaperPref()
})

await t('文档 HTML 直接带上自定义纸张的 @page 尺寸', () => {
  paperPref.mode = 'custom'
  paperPref.width = 120
  paperPref.height = 180
  const html = buildPrintHtml(docOf(rowsOf(10)))
  assert.match(html, /@page \{ size: 120mm 180mm; margin: 5mm; \}/)
  resetPaperPref()
})

console.log('\n真机打印：纸张尺寸、页数与每页表头')

await t('A4 横向 160 行：PDF 页数＝分片数，每页都有「序号」表头', async () => {
  resetPaperPref()
  paperPref.orientation = 'landscape'
  const html = buildPrintHtml(docOf(rowsOf(160)))
  const chunks = chunkCount(html)
  const { pages, size, textOf } = await pdfPages(html, '/tmp/paper-a4.pdf')
  assert.match(size, /A4/)
  assert.equal(pages, chunks, `页数必须等于分片数：${pages} vs ${chunks}`)
  for (let i = 1; i <= pages; i++) assert.match(textOf(i), /序号/, `第 ${i} 页缺表头`)
})

await t('A4 横向 140 行长商品名（自动换行）：页数＝分片数，每页仍有表头', async () => {
  resetPaperPref()
  paperPref.orientation = 'landscape'
  const long = (i) => `第${i + 1}号 PE管外牙直接50*112M 加长商品名称用于测试换行`
  const html = buildPrintHtml(docOf(rowsOf(140, long)))
  const chunks = chunkCount(html)
  const { pages, textOf } = await pdfPages(html, '/tmp/paper-a4-long.pdf')
  assert.equal(pages, chunks, `换行明细也不能多出页：${pages} vs ${chunks}`)
  for (let i = 1; i <= pages; i++) assert.match(textOf(i), /序号/, `第 ${i} 页缺表头`)
})

await t('A4 纵向：纸张确实是竖的，行数按纵向推算，每页带表头', async () => {
  resetPaperPref()
  paperPref.orientation = 'portrait'
  const html = buildPrintHtml(docOf(rowsOf(160)))
  assert.match(html, /@page \{ size: A4 portrait/)
  const chunks = chunkCount(html)
  const { pages, wmm, hmm, textOf } = await pdfPages(html, '/tmp/paper-a4-portrait.pdf')
  assert.ok(hmm > wmm, `应为纵向：${wmm.toFixed(1)}×${hmm.toFixed(1)}mm`)
  assert.ok(Math.abs(wmm - 210) < 3 && Math.abs(hmm - 297) < 3, `尺寸应为 A4 纵向，实际 ${wmm.toFixed(1)}×${hmm.toFixed(1)}mm`)
  assert.equal(pages, chunks)
  for (let i = 1; i <= pages; i++) assert.match(textOf(i), /序号/, `第 ${i} 页缺表头`)
  resetPaperPref()
})

await t('自定义 100×150mm：PDF 实测就是 100×150，每页带表头', async () => {
  resetPaperPref()
  paperPref.mode = 'custom'
  paperPref.width = 100
  paperPref.height = 150
  const html = buildPrintHtml(docOf(rowsOf(80)))
  const chunks = chunkCount(html)
  const { pages, wmm, hmm, textOf } = await pdfPages(html, '/tmp/paper-custom.pdf')
  assert.ok(Math.abs(wmm - 100) < 2 && Math.abs(hmm - 150) < 2, `实测 ${wmm.toFixed(1)}×${hmm.toFixed(1)}mm`)
  assert.equal(pages, chunks, `页数＝分片数：${pages} vs ${chunks}`)
  for (let i = 1; i <= pages; i++) assert.match(textOf(i), /序号/, `第 ${i} 页缺表头`)
  resetPaperPref()
})

await t('手动每页行数生效：改成 20 行后分片变多，页数仍与分片一致', async () => {
  resetPaperPref()
  paperPref.rowsPerPage = 20
  const html = buildPrintHtml(docOf(rowsOf(60)))
  const chunks = chunkCount(html)
  // 首页扣掉单头预留（本页信息块 3 个字段，A4 横向一行放得下 → 6 行）：14 + 20 + 20 + 6
  assert.equal(chunks, 4, `60 行按 20 行一页应切成 4 片，实际 ${chunks}`)
  const { pages, textOf } = await pdfPages(html, '/tmp/paper-manual.pdf')
  assert.equal(pages, chunks)
  for (let i = 1; i <= pages; i++) assert.match(textOf(i), /序号/, `第 ${i} 页缺表头`)
  resetPaperPref()
})

console.log('\n界面：打印设置里改纸张，按钮立刻按新纸张出纸')

async function openApp(path) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  // 新 context 的 localStorage 本来就是空的，不要在 initScript 里清——
  // initScript 每次导航都跑，刷新后会把刚设置的纸张偏好清掉，反而测不出「记住设置」
  await context.addInitScript(() => sessionStorage.setItem('stock.auth.token', 'isolated-test'))
  const state = {
    sales: [{ id: 'X202610301100000001', customer: '客户甲', date: '2026-10-30', total: 100, discount: 0, discountRates: [], payments: [], items: rowsOf(5) }],
    purchases: [], orders: [], items: [], customers: [{ code: 'C00001', name: '客户甲' }], suppliers: [], profile: {}, shares: [], templates: []
  }
  await context.route('**/api/**', route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) })
    if (request.method() === 'GET') {
      if (pathname === '/api/session') return send({ ok: true })
      if (pathname === '/api/profile') return send({})
      if (pathname === '/api/shares') return send({ shares: [] })
      if (pathname === '/api/templates') return send({ templates: [] })
      return send(state[pathname.slice(5)] ?? [])
    }
    return send({ ok: true })
  })
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:5173${path}`, { waitUntil: 'networkidle' })
  return { page, context }
}

await t('打印设置弹层：切换自定义纸张后，打印按钮按新纸张出纸且设置被记住', async () => {
  const { page, context } = await openApp('/sale/X202610301100000001')
  try {
    const btn = page.locator('.paper-btn')
    await btn.waitFor()
    assert.equal((await btn.innerText()).trim(), 'A4 纵向', '默认 A4 纵向')
    await btn.click()
    const pop = page.locator('.pp')
    await pop.waitFor()
    await pop.getByText('自定义', { exact: true }).click()
    // 等自定义分支渲染出来（方向按钮消失、宽高输入框出现）再填，避免填在旧节点上
    const nums = pop.locator('.pp-num input')
    await nums.first().waitFor()
    await nums.nth(0).fill('100')
    await nums.nth(0).blur()
    await nums.nth(1).fill('150')
    await nums.nth(1).blur()
    await page.waitForFunction(() => document.querySelector('.paper-btn')?.textContent.trim() === '100×150mm', null, { timeout: 5000 })
    assert.equal((await btn.innerText()).trim(), '100×150mm')
    // 点「打印」：纸张必须是自定义的 100×150mm，而不是 A4
    await page.evaluate(() => {
      window.__printed = null
      window.open = () => { const doc = { write: h => { window.__printed = h }, close() {} }; return { document: doc, focus() {}, print() {} } }
    })
    await page.getByRole('button', { name: '打印' }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /@page \{ size: 100mm 150mm; margin: 4mm; \}/)
    // 重新进页面，设置仍在（localStorage）
    await page.reload({ waitUntil: 'networkidle' })
    assert.equal((await page.locator('.paper-btn').innerText()).trim(), '100×150mm')
    // 换回默认设置后仍是自定义纸优先，不会偷偷变回 A4
    await page.evaluate(() => {
      window.__printed = null
      window.open = () => { const doc = { write: h => { window.__printed = h }, close() {} }; return { document: doc, focus() {}, print() {} } }
    })
    await page.getByRole('button', { name: '打印' }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    assert.match(await page.evaluate(() => window.__printed), /@page \{ size: 100mm 150mm/)
  } finally { await context.close() }
})

await t('打印设置弹层：默认就是 A4 纵向，打印出纵向纸', async () => {
  const { page, context } = await openApp('/sale/X202610301100000001')
  try {
    await page.locator('.paper-btn').click()
    const pop = page.locator('.pp')
    await pop.waitFor()
    await pop.getByText('纵向', { exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.paper-btn')?.textContent.trim() === 'A4 纵向', null, { timeout: 5000 })
    assert.equal((await page.locator('.paper-btn').innerText()).trim(), 'A4 纵向')
    await page.evaluate(() => {
      window.__printed = null
      window.open = () => { const doc = { write: h => { window.__printed = h }, close() {} }; return { document: doc, focus() {}, print() {} } }
    })
    await page.getByRole('button', { name: '打印' }).click()
    await page.waitForFunction(() => !!window.__printed, null, { timeout: 5000 })
    const html = await page.evaluate(() => window.__printed)
    assert.match(html, /@page \{ size: A4 portrait/)
  } finally { await context.close() }
})

await t('打印设置面板：显示的行数与真正切片同口径（A4/A5/横纵向/自定义/手动）', () => {
  resetPaperPref()
  for (const paper of ['A4', 'A5']) {
    for (const orientation of ['landscape', 'portrait']) {
      paperPref.orientation = orientation
      const info = paperRowsInfo(paper)
      assert.equal(info.manual, false, `${paper} ${orientation} 默认应为自动`)
      assert.equal(info.rowsPerPage, paperSpec(paper).rowsPerPage, `${paper} ${orientation} 自动行数应与纸张解析一致`)
      assert.equal(info.auto, info.rowsPerPage)
    }
  }
  // 自定义纸张：改宽高自动重算，手动填行数时单独标注且覆盖自动值
  resetPaperPref()
  paperPref.mode = 'custom'
  paperPref.width = 100
  paperPref.height = 180
  let info = paperRowsInfo()
  assert.equal(info.manual, false)
  assert.equal(info.rowsPerPage, paperSpec().rowsPerPage)
  assert.equal(info.auto, customSpec(100, 180, 0).rowsPerPage)
  const before = info.auto
  paperPref.height = 260
  assert.ok(paperRowsInfo().auto > before, '加高纸张后自动行数应变多')
  paperPref.rowsPerPage = 25
  info = paperRowsInfo()
  assert.equal(info.manual, true)
  assert.equal(info.rowsPerPage, 25, '手动行数优先')
  assert.equal(info.auto, customSpec(100, 260, 0).rowsPerPage)
  resetPaperPref()
})

await t('标头行数：首页商品行数 = 每页行数 - 标头行数（与 buildPrintHtml 的切片一致）', () => {
  resetPaperPref()
  const p = paperSpec('A4')
  const doc = docOf(rowsOf(80))
  const head = headRowsOf(p, doc)
  assert.ok(head >= 2, `带标题/副标题/信息块的单据标头不应少于 2 行，实际 ${head}`)
  const html = buildPrintHtml({ ...doc, repeatHeader: true })
  const firstTable = html.split('<table class="pg')[1].split('</table>')[0]
  const firstCount = (firstTable.match(/<tr>/g) || []).length - 1
  assert.equal(firstCount, Math.max(1, p.rowsPerPage - head))
  // 没有标题/副标题/信息块（列表、模板打印）→ 标头 0 行，首页整页都是商品
  assert.equal(headRowsOf(p, {}), 0)
  assert.equal(headRowsOf(p, { headerFields: [['客户', ''], ['日期', null]] }), 0)
  // 窄自定义纸：信息块折行更多，标头行数应比 A4 多
  paperPref.mode = 'custom'
  paperPref.width = 80
  paperPref.height = 200
  assert.ok(headRowsOf(paperSpec(), doc) > head, '窄纸信息块折行更多，标头应占更多行')
  resetPaperPref()
})

await t('打印设置弹层：自动行数 / 标头 / 商品行数随纸张即时显示', async () => {
  const { page, context } = await openApp('/sale/X202610301100000001')
  try {
    await page.locator('.paper-btn').click()
    const cap = page.locator('.pp-cap')
    await cap.waitFor()
    const text = () => cap.innerText()
    // 默认 A4 纵向：自动行数、标头、商品三行都在
    let t1 = await text()
    assert.match(t1, /每页 \d+ 行/)
    assert.match(t1, /自动/)
    assert.match(t1, /首页：标头 [1-9]\d* 行 \+ 商品 [1-9]\d* 行/)
    assert.match(t1, /后续页：商品 \d+ 行/)
    const rowsOfText = (s) => Number((s.match(/每页 (\d+) 行/) || [])[1])
    const headOfText = (s) => Number((s.match(/标头 (\d+) 行/) || [])[1])
    const firstOfText = (s) => Number((s.match(/商品 (\d+) 行/) || [])[1])
    const rowsA4 = rowsOfText(t1), head = headOfText(t1)
    assert.equal(firstOfText(t1), rowsA4 - head)
    // 切到 A5：行数变少，标头/商品同步重算
    await page.locator('.pp').getByText('A5', { exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.paper-btn')?.textContent.includes('A5'))
    const t2 = await text()
    assert.ok(rowsOfText(t2) < rowsA4, `A5 每页 ${rowsOfText(t2)} 应少于 A4 ${rowsA4}`)
    assert.equal(firstOfText(t2), rowsOfText(t2) - headOfText(t2))
    // 自定义纸张：填窄纸后自动行数再变
    await page.locator('.pp').getByText('自定义', { exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.paper-btn')?.textContent.includes('×'))
    const t3 = await text()
    assert.match(t3, /每页 \d+ 行/)
    assert.equal(firstOfText(t3), rowsOfText(t3) - headOfText(t3))
    // 手动填 12 行：标注「手动」并让商品行数跟着走
    const num = page.locator('.pp .pp-row').filter({ hasText: '每页行数' }).locator('input')
    await num.fill('12')
    await num.blur()
    await page.waitForFunction(() => document.querySelector('.pp-cap')?.textContent.includes('手动'))
    const t4 = await text()
    assert.match(t4, /每页 12 行/)
    assert.match(t4, /手动/)
    assert.equal(firstOfText(t4), Math.max(1, 12 - headOfText(t4)))
  } finally { await context.close() }
})

await browser.close()
console.log(`\n${fail ? '✗' : '✓'} ${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
