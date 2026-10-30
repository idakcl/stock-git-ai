<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title"><b>数据备份与恢复</b></div>
        </div>
      </template>

      <el-alert type="info" :closable="false" show-icon class="intro">
        <b>全量导出</b>：把全部数据（商品、客户、供应商、销售单、采购单、收付款单、订单草稿、退款核销单）打包成 JSON 文件保存到本地，可用于定期存档或换设备恢复；库存由单据自动推导，无需备份。<br />
        <b>全量导入</b>：选择以前导出的 JSON 文件写回系统，<b>会整体覆盖现有数据</b>，操作前建议先导出一份当前数据。<br />
        <b>分类导入导出</b>：按数据类型单独导出、导入；导入时与库内现有数据<b>按编码/单号比对去重</b>，已存在的自动跳过，只追加新记录，不覆盖已有数据。
      </el-alert>

      <!-- 数据整理：一键修复历史乱码编码 -->
      <el-card shadow="never" class="panel">
        <template #header><b>数据整理（修复乱码编码）</b></template>
        <p class="desc">重跑一次全量派生，把历史单据里残留的商品「乱码编码」（<code>N</code> 开头）改回正式商品编码，并重建商品历史价、库存、供应商链接。等价于把每张单据重新保存一次，但一键完成。<b>不会改动你的金额、数量等历史数据。</b></p>
        <el-button type="warning" :loading="normalizing" @click="doNormalize">一键修复乱码编码</el-button>
      </el-card>

      <!-- 导出备份 -->
      <el-card shadow="never" class="panel">
        <template #header><b>全量导出备份</b></template>
        <p class="desc">将当前全部数据保存为一个 JSON 文件（含商品、客户、供应商、销售单、采购单、收款单、付款单、订单草稿、退款/核销单，以及客户/供应商的预存款、预付款流水）。</p>
        <el-button type="primary" :loading="exporting" @click="doExport">导出全部数据</el-button>
      </el-card>

      <!-- 导入恢复 -->
      <el-card shadow="never" class="panel">
        <template #header><b>全量导入恢复</b></template>
        <p class="desc">选择 JSON 备份文件，校验通过后会显示数据摘要，确认后才写入。<b class="danger-text">导入会覆盖全部现有数据，且不可撤销。</b></p>
        <el-upload
          drag
          accept=".json"
          :auto-upload="false"
          :file-list="fileList"
          :on-change="onFileChange"
          :on-remove="onFileRemove"
          class="backup-upload"
        >
          <div class="upload-inner">
            <el-icon class="upload-icon"><UploadFilled /></el-icon>
            <div>将 JSON 备份文件拖到此处，或<b>点击选择文件</b></div>
            <div class="upload-hint">仅支持本页面导出的 .json 备份文件</div>
          </div>
        </el-upload>

        <el-alert v-if="parseError" type="error" :closable="false" show-icon :title="parseError" class="parse-alert" />

        <!-- 校验通过：显示摘要，等待确认 -->
        <div v-if="pending" class="summary">
          <div class="summary-title">备份文件摘要</div>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="导出时间">{{ pending.exportedAt || '未知' }}</el-descriptions-item>
            <el-descriptions-item label="文件大小">{{ pending.sizeText }}</el-descriptions-item>
            <el-descriptions-item label="商品">{{ pending.counts.items }} 条</el-descriptions-item>
            <el-descriptions-item label="客户">{{ pending.counts.customers }} 条</el-descriptions-item>
            <el-descriptions-item label="供应商">{{ pending.counts.suppliers }} 条</el-descriptions-item>
            <el-descriptions-item label="销售单">{{ pending.counts.sales }} 单</el-descriptions-item>
            <el-descriptions-item label="采购单">{{ pending.counts.purchases }} 单</el-descriptions-item>
            <el-descriptions-item v-if="pending.counts.orders != null" label="订单草稿">{{ pending.counts.orders }} 单</el-descriptions-item>
            <el-descriptions-item v-if="pending.counts.refunds != null" label="退款/核销">{{ pending.counts.refunds }} 单</el-descriptions-item>
          </el-descriptions>
          <div class="import-bar">
            <el-button type="danger" :loading="importing" @click="doImport">确认导入（覆盖现有数据）</el-button>
            <el-button @click="cancelPending">取消</el-button>
          </div>
        </div>
      </el-card>

      <!-- 分类导入导出 -->
      <el-card shadow="never" class="panel">
        <template #header><b>分类导入导出（按编码/单号去重）</b></template>
        <p class="desc">
          九种数据类型各自独立导出、导入（含订单草稿与退款/核销单）。导入时先与库内现有数据比对：<b class="ok-text">编码/单号已存在的自动跳过</b>，
          客户/供应商还会按名称查重（防止同名多码把一家单位拆成两份档案），只追加真正的新记录，已有数据不会被覆盖或删除。
        </p>
        <el-table :data="typeRows" border size="small" class="type-table">
          <el-table-column label="数据类型" prop="label" min-width="90" align="center" />
          <el-table-column label="库内数量" min-width="100" align="center">
            <template #default="{ row }">
              <span v-if="row.count == null">—</span>
              <span v-else>{{ row.count }} {{ row.unit }}</span>
            </template>
          </el-table-column>
          <el-table-column label="导出" min-width="130" align="center">
            <template #default="{ row }">
              <el-button size="small" :loading="row.exporting" @click="exportType(row)">导出{{ row.label }}</el-button>
            </template>
          </el-table-column>
          <el-table-column label="导入（去重合并）" min-width="230">
            <template #default="{ row }">
              <el-upload
                class="upload-inline"
                :auto-upload="false"
                :show-file-list="false"
                accept=".json"
                :on-change="(f) => onImportFile(row, f)"
              >
                <el-button size="small">选择文件</el-button>
              </el-upload>
              <el-button size="small" class="paste-btn" @click="openPaste(row)">粘贴文本</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

    </el-card>

    <!-- 分类导入：比对预览弹窗（确认前不写任何数据） -->
    <el-dialog
      v-model="previewVisible"
      :title="preview ? `导入${preview.label} · 比对预览` : '导入预览'"
      width="760px"
      top="8vh"
      @closed="preview = null"
    >
      <div v-if="previewLoading" v-loading="true" class="preview-loading" />
      <template v-else-if="preview">
        <el-alert type="info" :closable="false" show-icon class="preview-alert">
          来源：{{ preview.source }} · 解析到 {{ preview.total }} 条记录 · 确认后只追加「将新增」的记录
        </el-alert>
        <div class="preview-stats">
          <span class="stat-add">将新增 {{ preview.diff.added.length }}</span>
          <span class="stat-skip">重复跳过 {{ preview.diff.skippedKey.length + preview.diff.skippedName.length }}</span>
          <span class="stat-invalid">无效 {{ preview.diff.invalid.length }}</span>
        </div>
        <el-table :data="preview.rows" border size="small" max-height="360">
          <el-table-column label="编码/单号" prop="key" min-width="150" show-overflow-tooltip />
          <el-table-column label="名称" prop="name" min-width="140" show-overflow-tooltip />
          <el-table-column label="比对结果" min-width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="resultTagType(row.result)" size="small">{{ row.result }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="说明" prop="reason" min-width="150" show-overflow-tooltip />
        </el-table>
      </template>
      <template #footer>
        <el-button @click="previewVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="importing"
          :disabled="!preview || !preview.diff.added.length"
          @click="confirmImport"
        >
          确认导入（追加 {{ preview ? preview.diff.added.length : 0 }} 条）
        </el-button>
      </template>
    </el-dialog>

    <!-- 粘贴文本导入 -->
    <el-dialog v-model="pasteVisible" :title="pasteRow ? `粘贴${pasteRow.label} JSON` : '粘贴导入'" width="680px" top="10vh">
      <el-input
        v-model="pasteText"
        type="textarea"
        :rows="12"
        placeholder="粘贴以前导出的 JSON 内容。支持裸数组 [{...}]、{ data: [...] }、{ items: [...] } 等格式"
      />
      <template #footer>
        <el-button @click="pasteVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmPaste">解析并比对</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'
import { api } from '../api'
import { diffImport, extractRecords } from '../utils/dedupe'
import { todayCN } from '../utils/time.js'

const exporting = ref(false)
const importing = ref(false)
const normalizing = ref(false)
const fileList = ref([])
const pending = ref(null)   // 校验通过的备份：{ data, counts, exportedAt, sizeText }
const parseError = ref('')

// 备份「全量导入」必须完整包含的 5 类核心数据（缺一类就拒绝，避免导入半截数据把库写坏）
const DATA_KEYS = ['items', 'customers', 'suppliers', 'sales', 'purchases']
// 全量备份/恢复实际覆盖的全部数据（含收款单/付款单；旧备份可能不含这两者，导入时按"存在才覆盖"处理，不报错）
const BACKUP_KEYS = ['items', 'customers', 'suppliers', 'sales', 'purchases', 'receipts', 'payment-vouchers']
const KEY_LABELS = {
  items: '商品', customers: '客户', suppliers: '供应商', sales: '销售单', purchases: '采购单',
  receipts: '收款单', 'payment-vouchers': '付款单', orders: '订单草稿', refunds: '退款/核销单'
}
const MAX_SIZE = 30 * 1024 * 1024   // 30MB 上限：正常备份在几百 KB~几 MB

// ---------- 分类导入导出 ----------
const TYPES = [
  { key: 'items', label: '商品', unit: '条' },
  { key: 'customers', label: '客户', unit: '条' },
  { key: 'suppliers', label: '供应商', unit: '条' },
  { key: 'sales', label: '销售单', unit: '单' },
  { key: 'purchases', label: '采购单', unit: '单' },
  { key: 'receipts', label: '收款单', unit: '单' },
  { key: 'payment-vouchers', label: '付款单', unit: '单' },
  { key: 'orders', label: '订单草稿', unit: '单' },
  { key: 'refunds', label: '退款/核销单', unit: '单' }
]
const typeRows = ref(TYPES.map(t => ({ ...t, count: null, exporting: false })))

const FETCHERS = {
  items: () => api.getItems(),
  customers: () => api.getCustomers(),
  suppliers: () => api.getSuppliers(),
  sales: () => api.getSales(),
  purchases: () => api.getPurchases(),
  receipts: () => api.getReceipts(),
  'payment-vouchers': () => api.getPaymentVouchers(),
  orders: () => api.getOrders(),
  refunds: () => api.getRefunds()
}

// 页面打开时拉一次各类型库内数量（走 15 秒内存缓存，不重复请求）
async function loadCounts() {
  await Promise.all(TYPES.map(async t => {
    try {
      const records = await FETCHERS[t.key]()
      const row = typeRows.value.find(r => r.key === t.key)
      if (row) row.count = Array.isArray(records) ? records.length : 0
    } catch { /* 拉取失败显示 —，不阻塞其他类型 */ }
  }))
}
onMounted(loadCounts)

// 分类导出：单类型打包 { app, version, type, exportedAt, count, data }
async function exportType(row) {
  row.exporting = true
  try {
    const records = await FETCHERS[row.key]()
    const payload = {
      app: 'stock-git-ai',
      version: 1,
      type: row.key,
      exportedAt: new Date().toISOString(),
      count: records.length,
      data: records
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${row.label}-${todayCN()}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    ElMessage.success(`已导出${row.label} ${records.length} ${row.unit}`)
  } catch (e) {
    ElMessage.error(`导出失败：${e.message || '网络异常'}`)
  } finally {
    row.exporting = false
  }
}

// ---------- 分类导入：解析 → 前端预比对 → 弹窗预览 → 确认写库 ----------
const previewVisible = ref(false)
const previewLoading = ref(false)
const preview = ref(null)   // { key, label, unit, source, diff, rows, total }
const pasteVisible = ref(false)
const pasteRow = ref(null)
const pasteText = ref('')

function displayNameOf(key, rec) {
  if (!rec || typeof rec !== 'object') return '—'
  if (rec.name != null && String(rec.name)) return String(rec.name)
  if (key === 'purchases' && rec.supplier) return String(rec.supplier)
  if (key === 'sales' && rec.customer) return String(rec.customer)
  if (key === 'orders') return String(rec.customer || rec.supplier || rec.remark || '—')
  if (key === 'receipts' || key === 'payment-vouchers' || key === 'refunds') {
    if (rec.party) return String(rec.party)
    if (rec.customer) return String(rec.customer)
    if (rec.supplier) return String(rec.supplier)
  }
  return '—'
}

// 把去重结果摊平成预览明细表：主键 / 名称 / 结果 / 说明
function buildPreviewRows(key, diff) {
  const rows = []
  const field = key === 'purchases' || key === 'sales' ? 'id' : 'code'
  const push = (rec, result, reason) => rows.push({
    key: rec && rec[field] != null && String(rec[field]) !== '' ? String(rec[field]) : '—',
    name: displayNameOf(key, rec),
    result,
    reason: reason || ''
  })
  diff.added.forEach(r => push(r, '新增'))
  diff.skippedKey.forEach(r => push(r, '重复跳过', `${field === 'id' ? '单号' : '编码'}在库内已存在`))
  diff.skippedName.forEach(r => push(r, '同名跳过', `库内已有同名${KEY_LABELS[key] || ''}`))
  diff.invalid.forEach(x => push(x.record, '无效', x.reason))
  return rows
}

// 解析文本并拉库内数据做预比对（纯前端计算，不写库）
async function openPreview(row, text, source) {
  const records = extractRecords(row.key, text)
  if (!records || !records.length) {
    ElMessage.error(`无法解析导入内容：不是有效的 JSON，或其中没有${row.label}记录数组`)
    return
  }
  previewLoading.value = true
  previewVisible.value = true
  try {
    const existing = await FETCHERS[row.key]()
    const diff = diffImport(row.key, records, existing || [])
    preview.value = {
      key: row.key,
      label: row.label,
      unit: row.unit,
      source,
      diff,
      rows: buildPreviewRows(row.key, diff),
      total: diff.added.length + diff.skippedKey.length + diff.skippedName.length + diff.invalid.length
    }
  } catch (e) {
    previewVisible.value = false
    ElMessage.error(`获取现有数据失败：${e.message || '网络异常'}`)
  } finally {
    previewLoading.value = false
  }
}

function onImportFile(row, file) {
  const f = file && file.raw
  if (!f) return
  if (f.size > MAX_SIZE) {
    ElMessage.error(`文件过大（${(f.size / 1024 / 1024).toFixed(1)}MB，上限 30MB），请确认是本系统导出的 JSON 文件`)
    return
  }
  const reader = new FileReader()
  reader.onload = () => openPreview(row, String(reader.result || ''), f.name)
  reader.onerror = () => ElMessage.error('文件读取失败，请重试')
  reader.readAsText(f)
}

function openPaste(row) {
  pasteRow.value = row
  pasteText.value = ''
  pasteVisible.value = true
}

function confirmPaste() {
  const text = pasteText.value
  const row = pasteRow.value
  if (!text.trim()) { ElMessage.warning('请先粘贴 JSON 内容'); return }
  pasteVisible.value = false
  openPreview(row, text, '粘贴的文本')
}

// 确认导入：只传预览判定为「新增」的记录；服务端会重新比对一次（预览到确认之间数据可能变化），以服务端结果为准
async function confirmImport() {
  const p = preview.value
  if (!p || !p.diff.added.length) return
  importing.value = true
  try {
    const r = await api.importMerge(p.key, p.diff.added)
    const skip = (r.skippedKey || 0) + (r.skippedName || 0)
    ElMessage.success(
      `导入完成：新增 ${r.added} ${p.unit}${skip ? `，跳过重复 ${skip}` : ''}${r.invalid ? `，无效 ${r.invalid}` : ''}，当前共 ${r.total} ${p.unit}`
    )
    previewVisible.value = false
    loadCounts()
  } catch (e) {
    ElMessage.error(`导入失败：${e.message || '网络异常'}。已写入的部分会保留，可重试同一文件（按编码/单号去重，不会重复叠加）`)
  } finally {
    importing.value = false
  }
}

function resultTagType(result) {
  if (result === '新增') return 'success'
  if (result === '无效') return 'danger'
  return 'info'
}

// 数据整理：确认后调用后端 /normalize 重跑全量派生，修复历史单据乱码编码，完成后刷新页面
async function doNormalize() {
  try {
    await ElMessageBox.confirm(
      '将重跑全量派生数据，修复历史单据中的商品乱码编码（N 开头），并重建历史价、库存与供应商链接。\n\n此操作不会改动金额、数量等历史数据。是否继续？',
      '数据整理确认',
      { type: 'warning', confirmButtonText: '开始修复', cancelButtonText: '取消' }
    )
  } catch { return }
  normalizing.value = true
  try {
    const r = await api.normalizeData()
    if (r && r.ok) {
      ElMessage.success('修复完成，页面即将刷新')
      setTimeout(() => window.location.reload(), 800)
    } else {
      ElMessage.error('修复未返回成功状态')
    }
  } catch (e) {
    ElMessage.error(`修复失败：${e.message || '网络异常'}。本次未改动任何数据`)
  } finally {
    normalizing.value = false
  }
}

// 拉全站数据打包成 JSON 并触发浏览器下载
async function doExport() {
  exporting.value = true
  try {
    const [items, customers, suppliers, sales, purchases, receipts, paymentVouchers, orders, refunds] = await Promise.all([
      api.getItems(), api.getCustomers(), api.getSuppliers(), api.getSales(), api.getPurchases(),
      api.getReceipts(), api.getPaymentVouchers(), api.getOrders(), api.getRefunds()
    ])
    const payload = {
      app: 'stock-git-ai',
      version: 1,
      exportedAt: new Date().toISOString(),
      data: { items, customers, suppliers, sales, purchases, receipts, 'payment-vouchers': paymentVouchers, orders, refunds }
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `进销存数据备份-${todayCN()}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    ElMessage.success(`已导出：商品 ${items.length} · 客户 ${customers.length} · 供应商 ${suppliers.length} · 销售 ${sales.length} · 采购 ${purchases.length} · 收款单 ${receipts.length} · 付款单 ${paymentVouchers.length} · 订单草稿 ${orders.length} · 退款/核销 ${refunds.length}`)
  } catch (e) {
    ElMessage.error(`导出失败：${e.message || '网络异常'}`)
  } finally {
    exporting.value = false
  }
}

// 选中文件：只保留最后一个，读取并校验，通过后生成摘要等待确认（此阶段不写任何数据）
function onFileChange(file, list) {
  fileList.value = list.slice(-1)
  pending.value = null
  parseError.value = ''
  const f = file && file.raw
  if (!f) return
  if (f.size > MAX_SIZE) {
    parseError.value = `文件过大（${(f.size / 1024 / 1024).toFixed(1)}MB，上限 30MB），请确认是本系统导出的备份文件`
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result))
      const d = parsed && parsed.data
      if (!d || typeof d !== 'object') throw new Error('不是有效的备份文件（缺少 data 字段）')
      const missing = DATA_KEYS.filter(k => !Array.isArray(d[k]))
      if (missing.length) throw new Error(`数据不完整，缺少：${missing.map(k => KEY_LABELS[k]).join('、')}`)
      pending.value = {
        data: d,
        exportedAt: parsed.exportedAt || '未知',
        sizeText: f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(2)} MB` : `${(f.size / 1024).toFixed(1)} KB`,
        counts: {
          items: d.items.length, customers: d.customers.length, suppliers: d.suppliers.length,
          sales: d.sales.length, purchases: d.purchases.length,
          // 订单/退款是后期加入备份集合的，旧备份没有这两个键 → 摘要里不显示、导入时也不动
          orders: Array.isArray(d.orders) ? d.orders.length : null,
          refunds: Array.isArray(d.refunds) ? d.refunds.length : null
        }
      }
    } catch (e) {
      parseError.value = `文件解析失败：${e.message || e}`
    }
  }
  reader.onerror = () => { parseError.value = '文件读取失败，请重试' }
  reader.readAsText(f)
}

function onFileRemove() {
  pending.value = null
  parseError.value = ''
}

function cancelPending() {
  pending.value = null
  fileList.value = []
  parseError.value = ''
}

// 确认导入：强确认 → 主数据先行、单据在后逐类整表写回。
// saveXxx 是整表替换语义，失败重试同一文件不会产生重复数据
async function doImport() {
  const p = pending.value
  if (!p) return
  // 覆盖摘要：核心 5 类必含；收款单/付款单若备份中存在才一并提示（旧备份可能不含）
  const summaryKeys = DATA_KEYS.concat(
    Array.isArray(p.data.receipts) ? ['receipts'] : [],
    Array.isArray(p.data['payment-vouchers']) ? ['payment-vouchers'] : [],
    Array.isArray(p.data.orders) ? ['orders'] : [],
    Array.isArray(p.data.refunds) ? ['refunds'] : []
  )
  const summary = summaryKeys.map(k => `${KEY_LABELS[k]} ${Array.isArray(p.data[k]) ? p.data[k].length : 0}`).join('、')
  try {
    await ElMessageBox.confirm(
      `确定导入该备份？\n\n将整体覆盖：${summary}\n备份导出时间：${p.exportedAt}\n\n当前库内对应数据会被替换，此操作不可撤销。建议先「导出全部数据」保存当前数据。`,
      '危险操作确认',
      { type: 'warning', confirmButtonText: '确认覆盖导入', cancelButtonText: '取消', dangerouslyUseHTMLString: false }
    )
  } catch { return }

  importing.value = true
  try {
    // 顺序：主数据 → 单据（单据保存时后端会自动推导商品/客户/供应商档案）
    await api.saveItems(p.data.items)
    await api.saveSuppliers(p.data.suppliers)
    await api.saveCustomers(p.data.customers)
    await api.savePurchases(p.data.purchases)
    await api.saveSales(p.data.sales)
    // 收款单/付款单：旧备份可能不含这两者，存在才整体覆盖，避免清空调已产生的单据
    if (Array.isArray(p.data.receipts)) await api.saveReceipts(p.data.receipts)
    if (Array.isArray(p.data['payment-vouchers'])) await api.savePaymentVouchers(p.data['payment-vouchers'])
    // 订单草稿与退款/核销单：旧备份可能不含，存在才整体覆盖（否则会无端清空现有草稿/凭证）
    if (Array.isArray(p.data.orders)) await api.restoreOrders(p.data.orders)
    if (Array.isArray(p.data.refunds)) await api.restoreRefunds(p.data.refunds)
    ElMessage.success('导入完成，页面即将刷新')
    setTimeout(() => window.location.reload(), 800)
  } catch (e) {
    ElMessage.error(`导入失败：${e.message || '网络异常'}。已写入的部分会保留，可重试同一文件（整体替换，不会重复叠加）`)
  } finally {
    importing.value = false
  }
}
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.intro { margin-bottom: 16px; line-height: 1.8; }
.panel { margin-bottom: 16px; background: var(--bg-card, #fff); }
.panel:last-child { margin-bottom: 0; }
.desc { color: var(--text-regular); font-size: var(--fs-base); margin: 0 0 12px; line-height: 1.7; }
.desc code { background: var(--bg-active, #f0f2f5); padding: 1px 6px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--color-danger, #f56c6c); }
.danger-text { color: var(--color-danger); }
.ok-text { color: var(--el-color-success); }
.backup-upload { width: 100%; }
.upload-inner { padding: 12px 0; }
.upload-icon { font-size: 40px; color: var(--text-placeholder); margin-bottom: 8px; }
.upload-hint { color: var(--text-placeholder); font-size: var(--fs-sub); margin-top: 4px; }
.parse-alert { margin-top: 12px; }
.summary { margin-top: 16px; }
.summary-title { font-weight: 600; margin-bottom: 10px; }
.import-bar { margin-top: 14px; display: flex; gap: 10px; }
.type-table { margin-bottom: 4px; }
.upload-inline { display: inline-block; vertical-align: middle; }
.paste-btn { margin-left: 8px; }
.preview-loading { height: 220px; }
.preview-alert { margin-bottom: 12px; }
.preview-stats { display: flex; gap: 20px; margin-bottom: 12px; font-size: var(--fs-base); flex-wrap: wrap; }
.stat-add { color: var(--el-color-success); font-weight: 600; }
.stat-skip { color: var(--el-color-info); }
.stat-invalid { color: var(--el-color-danger); }
</style>
