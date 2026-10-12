<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header"><b>采购入库</b><el-button type="primary" @click="openDialog()">新增采购</el-button></div>
      </template>
      <el-input v-model="keyword" clearable placeholder="搜索单号 / 供应商 / 商品" class="search-input" />
      <div class="filter-row">
        <span class="filter-label">时间段</span>
        <el-date-picker v-model="dateStart" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" style="width:150px" />
        <span class="filter-sep">至</span>
        <el-date-picker v-model="dateEnd" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" style="width:150px" />
        <el-button v-if="dateStart || dateEnd" text type="primary" @click="dateStart=''; dateEnd=''">清除</el-button>
      </div>
      <TableToolbar
        filename="采购单"
        title="采购单"
        :subtitle="subtitle"
        :columns="exportColumns"
        :rows="paged"
      />
      <div class="table-wrap">
      <el-table :data="paged" stripe show-summary :summary-method="summaryAmount">
        <el-table-column label="单号" width="170">
          <template #default="{ row }">
            <router-link :to="`/purchase/${row.id}`" class="link">{{ row.id }}</router-link>
          </template>
        </el-table-column>
        <el-table-column prop="supplier" label="供应商" width="170" />
        <el-table-column prop="date" label="日期" width="120" />
        <el-table-column prop="total" label="金额" width="110">
          <template #default="{ row }">{{ Number(row.total || 0).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="实付" width="120">
          <template #default="{ row }">
            <span>{{ paidSumOf(row).toFixed(2) }}</span>
            <span v-if="(ensurePayments(row, 'paid')).length" class="pay-count">（{{ ensurePayments(row, 'paid').length }} 笔）</span>
          </template>
        </el-table-column>
        <el-table-column label="优惠" width="100">
          <template #default="{ row }">
            <span v-if="Number(row.discount || 0) > 0" class="discount">-{{ Number(row.discount).toFixed(2) }}</span>
            <span v-else class="none">—</span>
          </template>
        </el-table-column>
        <el-table-column label="未付" width="110">
          <template #default="{ row }">
            <span :class="payableOf(row) > 0 ? 'debt' : 'none'">{{ payableOf(row).toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结算" width="130">
          <template #default="{ row }">
            <el-tag :type="row.settle === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
              {{ row.settle || '挂账' }}
            </el-tag>
            <el-button link size="small" type="primary" style="margin-left:4px" @click="toggleSettle(row)">
              {{ row.settle === '结清' ? '改挂账' : '结清' }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
        <el-table-column label="操作" width="250">
          <template #default="{ row }">
            <el-button size="small" @click="$router.push(`/purchase/${row.id}`)">查看</el-button>
            <el-button size="small" type="primary" @click="openDialog(row)">编辑</el-button>
            <el-button size="small" type="success" @click="openPay(row)">付款</el-button>
            <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
      <el-pagination
        v-model:current-page="page"
        :page-size="PAGE_SIZE"
        :total="filtered.length"
        layout="total, prev, pager, next"
        background
        class="pager"
      />
    </el-card>

    <el-dialog v-model="dialog" :title="editingId ? '编辑采购单' : '采购入库'" width="620">
      <el-form :model="form" label-width="80px">
        <el-form-item label="供应商"><el-input v-model="form.supplier" /></el-form-item>
        <el-form-item label="日期"><el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="结算">
          <el-radio-group v-model="form.settle">
            <el-radio-button label="挂账" />
            <el-radio-button label="结清" />
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="单据照片"><PhotoUpload v-model="form.photos" /></el-form-item>
        <el-form-item label="优惠金额">
          <el-input-number v-model="form.discount" :min="0" :precision="2" :controls="false" style="width:100%" />
        </el-form-item>
        <el-form-item label="实付金额">
          <div class="paid-summary">
            <span>累计实付：<b>{{ paidSumOf(editOrder).toFixed(2) }}</b></span>
            <span v-if="payCount > 0">（{{ payCount }} 笔，见「付款」流水）</span>
            <span v-else class="hint">未付款，可在列表点「付款」分多笔记录</span>
          </div>
        </el-form-item>
        <el-form-item label=" ">
          <div class="calc-line">
            <span>应付：<b>{{ payableTotal.toFixed(2) }}</b></span>
            <span>未付：<b :class="unpaidAmount > 0 ? 'debt' : 'none'">{{ unpaidAmount.toFixed(2) }}</b></span>
          </div>
        </el-form-item>
      </el-form>
      <el-table :data="form.lines" stripe>
        <el-table-column label="商品" min-width="180">
          <template #default="{ row }">
            <el-select
              v-model="row.code"
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入商品"
              style="width:100%"
              @change="onItemChange(row)"
            >
              <el-option v-for="i in itemOptions" :key="i.code" :label="`${i.name} (${i.code})`" :value="i.code" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="数量" width="100">
          <template #default="{ row }"><el-input-number v-model="row.qty" :min="1" size="small" /></template>
        </el-table-column>
        <el-table-column label="单价" width="100">
          <template #default="{ row }"><el-input-number v-model="row.price" :min="0" :precision="2" size="small" /></template>
        </el-table-column>
        <el-table-column label="" width="60">
          <template #default="{ $index }"><el-button size="small" type="danger" @click="form.lines.splice($index,1)">×</el-button></template>
        </el-table-column>
      </el-table>
      <div style="margin-top:8px"><el-button size="small" @click="form.lines.push({code:'',name:'',qty:1,price:0})">添加行</el-button></div>
      <div style="margin-top:12px;text-align:right">
        <b>合计：¥ {{ totalAmount.toFixed(2) }}</b>
        <span class="calc-hint" style="margin-left:12px">应付 {{ payableTotal.toFixed(2) }} · 未付 {{ unpaidAmount.toFixed(2) }}</span>
      </div>
      <template #footer><el-button @click="dialog=false">取消</el-button><el-button type="primary" @click="save">保存入库</el-button></template>
    </el-dialog>

    <PaymentDialog v-model="payDialog" :order="payOrder" kind="payable" @saved="onPaySaved" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'
import { resolveLine } from '../utils/catalog'
import { genOrderId } from '../utils/code'
import { payableOf, paidSumOf, ensurePayments, appendPayment, grossOf } from '../utils/account'
import PhotoUpload from '../components/PhotoUpload.vue'
import TableToolbar from '../components/TableToolbar.vue'
import PaymentDialog from '../components/PaymentDialog.vue'

const PAGE_SIZE = 60

const list = ref([])
const keyword = ref('')
const dateStart = ref('')
const dateEnd = ref('')
const page = ref(1)
const itemOptions = ref([])
const dialog = ref(false)
const editingId = ref('')
const form = reactive({ supplier:'', date:'', remark:'', settle:'挂账', photos:[], discount:0, lines:[] })
const payDialog = ref(false)
const payOrder = ref({})

// 编辑中的原始单据（用于展示累计实付，实付不在表单里改，统一走「付款」流水）
const editOrder = computed(() => (editingId.value ? list.value.find(p => p.id === editingId.value) : null) || {})
const payCount = computed(() => ensurePayments(editOrder.value, 'paid').length)

// 账务规则（与 src/utils/account.js 一致）：欠款按金额计算，与结算状态无关
//   应付 = 合计 − 优惠 ；未付 = max(0, 应付 − 累计实付[付款流水])
const payableTotal = computed(() => Math.max(0, totalAmount.value - Number(form.discount || 0)))
const unpaidAmount = computed(() => Math.max(0, payableTotal.value - paidSumOf(editOrder.value)))

const totalAmount = computed(() => form.lines.reduce((s, l) => s + (l.qty||0) * (l.price||0), 0))
const filtered = computed(() => list.value.filter(row => {
  if (!matchText(keyword.value, row.id, row.supplier, row.date, row.remark, ...(row.items || []).map(i => i.name))) return false
  if (dateStart.value && (row.date || '') < dateStart.value) return false
  if (dateEnd.value && (row.date || '') > dateEnd.value) return false
  return true
}))

// 表格底部汇总：基于「全部筛选结果」，不受分页影响
const summaryAmount = ({ columns }) => {
  const rows = filtered.value
  const total = rows.reduce((sum, r) => sum + Number(r.total || 0), 0)
  const settled = rows.filter(r => (r.settle || '挂账') === '结清').length
  return columns.map((c, idx) => {
    if (idx === 0) return `合计（${rows.length} 单，结清 ${settled}）`
    if (c.property === 'total') return total.toFixed(2)
    return ''
  })
}

const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
watch([keyword, dateStart, dateEnd], () => { page.value = 1 })

// 导出/打印与列表当前页同步：副标题标注输出范围（第 X/Y 页）
const subtitle = computed(() => {
  const parts = [`共 ${filtered.value.length} 单`, `导出当前第 ${page.value}/${pageCount.value} 页`]
  if (dateStart.value || dateEnd.value) parts.push(`${dateStart.value || '不限'} ~ ${dateEnd.value || '不限'}`)
  if (keyword.value) parts.push('已按关键词筛选')
  return parts.join(' · ')
})
const exportColumns = [
  { label: '单号', prop: 'id' },
  { label: '供应商', prop: 'supplier' },
  { label: '日期', prop: 'date' },
  { label: '金额', value: r => Number(r.total || 0).toFixed(2) },
  { label: '实付', value: r => { const n = ensurePayments(r, 'paid').length; return paidSumOf(r).toFixed(2) + (n > 1 ? `（${n}笔）` : '') } },
  { label: '优惠', value: r => (Number(r.discount || 0) ? Number(r.discount).toFixed(2) : '') },
  { label: '未付', value: r => payableOf(r).toFixed(2) },
  { label: '结算', value: r => (r.settle || '挂账') },
  { label: '备注', prop: 'remark' }
]

function loadAll() {
  return Promise.all([api.getPurchases(), api.getItems()])
}

onMounted(async () => {
  try {
    const [p, it] = await loadAll()
    list.value = p
    itemOptions.value = it
  } catch (e) {
    list.value = []
    itemOptions.value = []
  }
})

function openDialog(row) {
  if (row) {
    editingId.value = row.id
    Object.assign(form, {
      supplier: row.supplier || '',
      date: row.date || '',
      remark: row.remark || '',
      settle: row.settle || '挂账',
      photos: [...(row.photos || [])],
      discount: Number(row.discount || 0),
      lines: (row.items || []).map(i => ({ code: i.code, name: i.name, qty: i.qty, price: i.price }))
    })
  } else {
    editingId.value = ''
    Object.assign(form, { supplier:'', date: new Date().toISOString().slice(0,10), remark:'', settle:'挂账', photos:[], discount:0, lines: [{code:'', name:'', qty:1, price:0}] })
  }
  dialog.value = true
}

function onItemChange(row) {
  const found = itemOptions.value.find(i => i.code === row.code || i.name === row.code)
  if (found) {
    row.code = found.code
    row.name = found.name
    if (!row.price) row.price = found.cost || found.price || 0
  } else {
    row.name = row.code
  }
}

async function save() {
  if (!form.supplier) return ElMessage.warning('请填写供应商')
  if (!form.lines.length || form.lines.some(l => !l.code && !l.name)) return ElMessage.warning('请完整填写采购明细')
  let catalog = [...itemOptions.value]
  const resolved = []
  form.lines.forEach((l, idx) => {
    const result = resolveLine(catalog, { ...l, cost: l.price }, idx)
    if (result.line) {
      catalog = result.items
      resolved.push(result.line)
    }
  })
  if (!resolved.length) return ElMessage.warning('请完整填写采购明细')
  const amount = resolved.reduce((s, l) => s + l.total, 0)
  const discountVal = Number(form.discount || 0)
  const isEdit = !!editingId.value
  const origin = isEdit ? list.value.find(p => p.id === editingId.value) : null
  // 收付款统一走 payments 流水（编辑时保留原流水）；标记结清时自动补一笔差额付款，保证状态与金额一致
  let entry = {
    ...(origin || {}),
    supplier: form.supplier,
    date: form.date,
    remark: form.remark || '',
    settle: form.settle || '挂账',
    photos: [...(form.photos || [])],
    discount: discountVal,
    items: resolved,
    total: amount
  }
  if (!isEdit) {
    entry = { id: genOrderId('B', list.value, form.date), ...entry, payments: [], paid: 0 }
  }
  if (form.settle === '结清') {
    const unpaid = payableOf({ total: amount, discount: discountVal, paid: paidSumOf(entry) })
    if (unpaid > 0) entry = appendPayment(entry, 'payable', { date: form.date, amount: unpaid, remark: '结清付款' })
  }
  entry.paid = paidSumOf(entry)
  // 编辑时沿用原单号，新增才生成新单号
  if (isEdit) {
    const idx = list.value.findIndex(p => p.id === editingId.value)
    if (idx >= 0) list.value[idx] = entry
  } else {
    list.value.push(entry)
  }
  // 保存失败（如 GitHub 写入出错）时明确报错，弹窗不关闭、本地回滚为线上数据
  try {
    await api.savePurchases(list.value)
  } catch (e) {
    ElMessage.error(`保存失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    const [p, it] = await loadAll()
    list.value = p
    itemOptions.value = it
    return
  }
  // 商品建档、库存、供应商关系均由后端自动推导
  itemOptions.value = await api.getItems().catch(() => itemOptions.value)
  dialog.value = false
  editingId.value = ''
  ElMessage.success(isEdit ? '已保存修改' : '采购入库成功')
}

// 打开某单的付款流水弹窗
function openPay(row) {
  payOrder.value = row
  payDialog.value = true
}

async function onPaySaved(updated) {
  const idx = list.value.findIndex(p => p.id === updated.id)
  if (idx >= 0) list.value[idx] = updated
  // 保存失败时弹窗保持打开（父组件不关闭），便于直接重试
  try {
    await api.savePurchases(list.value)
  } catch (e) {
    ElMessage.error(`保存失败：${e.message || '网络异常'}，请重试`)
    return
  }
  const [p, it] = await loadAll()
  list.value = p
  itemOptions.value = it
  payDialog.value = false
  ElMessage.success('已保存付款流水')
}

async function toggleSettle(row) {
  // 欠款以金额为准：标记结清时自动补一笔差额付款，保证状态与金额一致
  if ((row.settle || '挂账') !== '结清') {
    const due = grossOf(row)
    const unpaid = payableOf(row)
    if (unpaid > 0) {
      try {
        await ElMessageBox.confirm(
          `该单应付 ¥${due.toFixed(2)}，仍有未付 ¥${unpaid.toFixed(2)}。\n标记结清会自动记一笔 ¥${unpaid.toFixed(2)} 的付款（欠款以金额计算）。`,
          '标记结清', { type: 'warning' })
      } catch { return }
      const updated = appendPayment(row, 'payable', { date: new Date().toISOString().slice(0, 10), amount: unpaid, remark: '结清付款' })
      const idx = list.value.findIndex(p => p.id === updated.id)
      if (idx >= 0) list.value[idx] = updated
    } else {
      row.settle = '结清'
    }
  } else {
    row.settle = '挂账'
  }
  // 保存失败时明确报错并回滚，避免页面显示已结清但线上未生效
  try {
    await api.savePurchases(list.value)
  } catch (e) {
    ElMessage.error(`操作失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    const [p, it] = await loadAll()
    list.value = p
    itemOptions.value = it
    return
  }
  // 以保存后的最新状态判断提示（差额付款路径下 row 本身未被就地修改）
  const fresh = list.value.find(p => p.id === row.id)
  ElMessage.success(fresh && fresh.settle === '结清' ? '已标记为结清' : '已改回挂账')
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除采购单 ${row.id}?\n删除后库存与历史价会自动重算。`, '提示', { type: 'warning' })
  } catch { return }
  list.value = list.value.filter(p => p.id !== row.id)
  try {
    await api.savePurchases(list.value)
  } catch (e) {
    ElMessage.error(`删除失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    await loadAll().then(([p, it]) => { list.value = p; itemOptions.value = it })
    return
  }
  const [p, it] = await loadAll()
  list.value = p
  itemOptions.value = it
  ElMessage.success('已删除')
}
</script>
<style scoped>
.card-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}
.search-input{margin-bottom:12px;max-width:360px;}
.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.filter-label{color:#606266;font-size:14px;}
.filter-sep{color:#909399;}
.pager{margin-top:12px;justify-content:flex-end;}
.discount{color:#67c23a;}
.none{color:#c0c4cc;}
.debt{color:#f56c6c;font-weight:600;}
.calc-line{display:flex;gap:20px;flex-wrap:wrap;color:#606266;font-size:13px;}
.calc-hint{color:#909399;font-weight:400;}
</style>
