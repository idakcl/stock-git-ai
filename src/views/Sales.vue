<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header"><b>销售出库</b><el-button type="primary" @click="openDialog()">新增销售</el-button></div>
      </template>
      <el-input v-model="keyword" clearable placeholder="搜索单号 / 客户 / 商品" class="search-input" />
      <div class="filter-row">
        <span class="filter-label">时间段</span>
        <el-date-picker v-model="dateStart" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" style="width:150px" />
        <span class="filter-sep">至</span>
        <el-date-picker v-model="dateEnd" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" style="width:150px" />
        <el-button v-if="dateStart || dateEnd" text type="primary" @click="dateStart=''; dateEnd=''">清除</el-button>
      </div>
      <TableToolbar
        filename="销售单"
        title="销售单"
        :subtitle="subtitle"
        :columns="exportColumns"
        :rows="paged"
      />
      <div class="table-wrap">
      <el-table :data="paged" stripe show-summary :summary-method="summaryAmount">
        <el-table-column label="单号" width="170">
          <template #default="{ row }"><router-link :to="`/sale/${row.id}`" class="link">{{ row.id }}</router-link></template>
        </el-table-column>
        <el-table-column prop="customer" label="客户" width="150" />
        <el-table-column prop="date" label="日期" width="120" />
        <el-table-column label="商品数量" width="100">
          <template #default="{ row }">{{ orderKindCount(row) }}</template>
        </el-table-column>
        <el-table-column prop="total" label="金额" width="110">
          <template #default="{ row }">{{ Number(row.total || 0).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="实收" width="120">
          <template #default="{ row }">
            <span>{{ receivedSumOf(row).toFixed(2) }}</span>
            <span v-if="(ensurePayments(row, 'received')).length" class="pay-count">（{{ ensurePayments(row, 'received').length }} 笔）</span>
          </template>
        </el-table-column>
        <el-table-column label="优惠" width="100">
          <template #default="{ row }">
            <span v-if="Number(row.discount || 0) > 0" class="discount" title="抹零优惠，未实际收款">-{{ Number(row.discount).toFixed(2) }}</span>
            <span v-else class="none">—</span>
          </template>
        </el-table-column>
        <el-table-column label="未收" width="110">
          <template #default="{ row }">
            <span :class="receivableOf(row) > 0 ? 'debt' : 'none'">{{ receivableOf(row).toFixed(2) }}</span>
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
        <el-table-column label="操作" width="300">
          <template #default="{ row }">
            <el-button size="small" @click="$router.push(`/sale/${row.id}`)">查看</el-button>
            <el-button size="small" type="primary" @click="openDialog(row)">编辑</el-button>
            <el-button size="small" type="success" @click="openPay(row)">收款</el-button>
            <el-button size="small" type="warning" @click="openPhotos(row)">照片{{ (row.photos || []).length ? `(${row.photos.length})` : '' }}</el-button>
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

    <el-dialog v-model="dialog" :title="editingId ? '编辑销售单' : '销售出库'" width="620">
      <el-form :model="form" label-width="80px">
        <el-form-item label="客户">
          <el-select
            v-model="form.customer"
            filterable
            allow-create
            default-first-option
            placeholder="选择或输入客户"
            style="width:100%"
            @change="onCustomerChange"
          >
            <el-option v-for="c in customerOptions" :key="c.code" :label="`${c.name} (${c.code})`" :value="c.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="日期"><el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="结算">
          <el-radio-group v-model="form.settle">
            <el-radio-button label="挂账" />
            <el-radio-button label="结清" />
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="单据照片"><PhotoUpload ref="photoUpload" v-model="form.photos" /></el-form-item>
        <el-form-item label="优惠金额">
          <el-input-number v-model="form.discount" :min="0" :precision="2" :controls="false" style="width:100%" />
        </el-form-item>
        <el-form-item label="实收金额">
          <div class="paid-summary">
            <span>累计实收：<b>{{ receivedSumOf(editOrder).toFixed(2) }}</b></span>
            <span v-if="payCount > 0">（{{ payCount }} 笔，见「收款」流水）</span>
            <span v-else class="hint">未收款，可在列表点「收款」分多笔记录</span>
          </div>
        </el-form-item>
        <el-form-item label=" ">
          <div class="calc-line">
            <span>应收：<b>{{ receivableTotal.toFixed(2) }}</b></span>
            <span>未收：<b :class="unpaidAmount > 0 ? 'debt' : 'none'">{{ unpaidAmount.toFixed(2) }}</b></span>
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
        <span class="calc-hint" style="margin-left:12px">应收 {{ receivableTotal.toFixed(2) }} · 未收 {{ unpaidAmount.toFixed(2) }}</span>
      </div>
      <template #footer><el-button @click="dialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存出库</el-button></template>
    </el-dialog>

    <PaymentDialog v-model="payDialog" :order="payOrder" kind="receivable" @saved="onPaySaved" />

    <!-- 轻量补照片：给已有单据传原始单据照片，只更新 photos 字段 -->
    <OrderPhotoDialog v-model="photoDialog" :order="photoOrder" @saved="onPhotosSaved" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'
import { resolveLine, orderKindCount, lineDisplayName, itemNameMap } from '../utils/catalog'
import { genOrderId } from '../utils/code'
import { receivableOf, receivedSumOf, ensurePayments, appendPayment, syncPayments, grossOf } from '../utils/account'
import PhotoUpload from '../components/PhotoUpload.vue'
import OrderPhotoDialog from '../components/OrderPhotoDialog.vue'
import TableToolbar from '../components/TableToolbar.vue'
import PaymentDialog from '../components/PaymentDialog.vue'

const PAGE_SIZE = 60
// 客户类别 → 商品上的对应分级售价字段
const CATEGORY_PRICE_FIELD = { '批发': 'priceWholesale', '零售': 'priceRetail', '安装师傅': 'priceInstaller' }

const list = ref([])
const keyword = ref('')
const dateStart = ref('')
const dateEnd = ref('')
const page = ref(1)
const itemOptions = ref([])
const customerOptions = ref([])
const dialog = ref(false)
// 保存中标记：配合按钮 loading 防止双击重复提交（会生成两张同内容单据、库存翻倍）
const saving = ref(false)
const editingId = ref('')
const form = reactive({ customer:'', date:'', remark:'', settle:'挂账', photos:[], discount:0, lines:[] })
const photoUpload = ref(null)
const payDialog = ref(false)
const payOrder = ref({})
// 轻量补照片弹窗（不改动单据其他信息，仅合并 photos 字段）
const photoDialog = ref(false)
const photoOrder = ref(null)

// 编辑中的原始单据（用于展示累计实收，实收不在表单里改，统一走「收款」流水）
const editOrder = computed(() => (editingId.value ? list.value.find(s => s.id === editingId.value) : null) || {})
const payCount = computed(() => ensurePayments(editOrder.value, 'received').length)

// 账务规则（与 src/utils/account.js 一致）：欠款按金额计算，与结算状态无关
//   应收 = 合计 − 优惠 ；未收 = max(0, 应收 − 累计实收[收款流水])
const receivableTotal = computed(() => Math.max(0, totalAmount.value - Number(form.discount || 0)))
const unpaidAmount = computed(() => Math.max(0, receivableTotal.value - receivedSumOf(editOrder.value)))

const totalAmount = computed(() => form.lines.reduce((s, l) => s + (l.qty||0) * (l.price||0), 0))
// 商品编码 → 主数据当前名（搜索按编码解析，单据快照名过期也能命中）
const nameMap = computed(() => itemNameMap(itemOptions.value))
const filtered = computed(() => list.value.filter(row => {
  // 搜索商品名按编码解析为当前名：单据快照名过期（商品改名前）也能命中
  if (!matchText(keyword.value, row.id, row.customer, row.date, row.remark,
    ...(row.items || []).map(i => lineDisplayName(i, nameMap.value)), ...(row.items || []).map(i => i.code))) return false
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
  { label: '客户', prop: 'customer' },
  { label: '日期', prop: 'date' },
  { label: '商品数量', value: r => orderKindCount(r) },
  { label: '金额', value: r => Number(r.total || 0).toFixed(2) },
  { label: '实收', value: r => { const n = ensurePayments(r, 'received').length; return receivedSumOf(r).toFixed(2) + (n > 1 ? `（${n}笔）` : '') } },
  { label: '优惠', value: r => (Number(r.discount || 0) ? Number(r.discount).toFixed(2) : '') },
  { label: '未收', value: r => receivableOf(r).toFixed(2) },
  { label: '结算', value: r => (r.settle || '挂账') },
  { label: '备注', prop: 'remark' }
]

// 当前所选客户的类别
const customerCategory = computed(() => {
  const c = (customerOptions.value || []).find(c => c.name === form.customer)
  return c && c.category ? c.category : ''
})

// 按客户类别取对应分级售价（批发→批发价 / 零售→零售价 / 安装师傅→安装师傅价）
function tierPriceFor(item) {
  const field = CATEGORY_PRICE_FIELD[customerCategory.value]
  if (!field) return null
  const v = item?.[field]
  return (v !== '' && v != null && Number(v) > 0) ? Number(v) : null
}

// 按「某客户最近一次销售价」带出单价；没历史则用商品当前售价
function customerPriceFor(code) {
  if (!form.customer || !code) return null
  const item = itemOptions.value.find(i => i.code === code)
  if (!item) return null
  const hist = (item.saleHistory || []).filter(h => h.customer === form.customer)
  if (!hist.length) return null
  const latest = hist.reduce((a, b) => ((a.date || '') > (b.date || '') ? a : b))
  return latest.price
}

// 单价优先级：该客户最近成交价(历史成交价最优先) → 客户类别对应分级售价 → 商品当前售价
function autoPriceFor(item) {
  const recent = customerPriceFor(item.code)
  if (recent != null) return recent
  const tier = tierPriceFor(item)
  if (tier != null) return tier
  return item.price || 0
}

function loadAll() {
  return Promise.all([api.getSales(), api.getItems(), api.getCustomers()])
}

onMounted(async () => {
  try {
    const [s, it, cu] = await loadAll()
    list.value = s
    itemOptions.value = it
    customerOptions.value = cu
  } catch (e) {
    list.value = []
    itemOptions.value = []
    customerOptions.value = []
  }
})

function openDialog(row) {
  if (row) {
    editingId.value = row.id
    Object.assign(form, {
      customer: row.customer || '',
      date: row.date || '',
      remark: row.remark || '',
      settle: row.settle || '挂账',
      photos: [...(row.photos || [])],
      discount: Number(row.discount || 0),
      lines: (row.items || []).map(i => ({ code: i.code, name: i.name, qty: i.qty, price: i.price }))
    })
  } else {
    editingId.value = ''
    Object.assign(form, { customer:'', date: new Date().toISOString().slice(0,10), remark:'', settle:'挂账', photos:[], discount:0, lines: [{code:'', name:'', qty:1, price:0}] })
  }
  dialog.value = true
}

function onItemChange(row) {
  const found = itemOptions.value.find(i => i.code === row.code || i.name === row.code)
  if (found) {
    row.code = found.code
    row.name = found.name
    row.price = autoPriceFor(found)
  } else {
    row.name = row.code
  }
}

// 更换客户后，按新客户的类别价/最近售价刷新已填行的单价（仍可手动改）
function onCustomerChange() {
  form.lines.forEach(l => {
    if (!l.code) return
    const item = itemOptions.value.find(i => i.code === l.code)
    if (item) l.price = autoPriceFor(item)
  })
}

async function doSave() {
  if (photoUpload.value && photoUpload.value.isUploading()) return ElMessage.warning('照片正在上传中，请等待上传完成后再保存')
  if (!form.customer) return ElMessage.warning('请填写客户')
  if (!form.lines.length || form.lines.some(l => !l.code && !l.name)) return ElMessage.warning('请完整填写销售明细')
  let catalog = [...itemOptions.value]
  const resolved = []
  form.lines.forEach((l, idx) => {
    const result = resolveLine(catalog, l, idx)
    if (result.line) {
      catalog = result.items
      resolved.push(result.line)
    }
  })
  if (!resolved.length) return ElMessage.warning('请完整填写销售明细')
  const amount = resolved.reduce((s, l) => s + l.total, 0)
  const discountVal = Number(form.discount || 0)
  const isEdit = !!editingId.value
  const origin = isEdit ? list.value.find(s => s.id === editingId.value) : null
  // 收付款统一走 payments 流水（编辑时保留原流水）；标记结清时自动补一笔差额收款，保证状态与金额一致
  let entry = {
    ...(origin || {}),
    customer: form.customer,
    date: form.date,
    remark: form.remark || '',
    settle: form.settle || '挂账',
    photos: [...(form.photos || [])],
    discount: discountVal,
    items: resolved,
    total: amount
  }
  if (!isEdit) {
    entry = { id: genOrderId('X', list.value, form.date), ...entry, payments: [], received: 0 }
  }
  if (form.settle === '结清') {
    const unpaid = receivableOf({ total: amount, discount: discountVal, received: receivedSumOf(entry) })
    if (unpaid > 0) entry = appendPayment(entry, 'receivable', { date: form.date, amount: unpaid, remark: '结清收款' })
  }
  entry.received = receivedSumOf(entry)
  // 编辑时沿用原单号，新增才生成新单号
  if (isEdit) {
    const idx = list.value.findIndex(s => s.id === editingId.value)
    if (idx >= 0) list.value[idx] = entry
  } else {
    list.value.push(entry)
  }
  // 保存失败（如 GitHub 写入出错）时明确报错，弹窗不关闭、本地回滚为线上数据
  try {
    await api.saveSales(list.value)
  } catch (e) {
    ElMessage.error(`保存失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    const [s, it] = await Promise.all([api.getSales(), api.getItems()])
    list.value = s
    itemOptions.value = it
    return
  }
  // 商品销售价历史、库存均由后端自动推导
  const [s, it] = await Promise.all([api.getSales(), api.getItems()])
  list.value = s
  itemOptions.value = it
  dialog.value = false
  editingId.value = ''
  ElMessage.success(isEdit ? '已保存修改' : '销售出库成功')
}

// 保存入口：加锁 + 按钮 loading，双击只会执行一次
async function save() {
  if (saving.value) return
  saving.value = true
  try {
    await doSave()
  } finally {
    saving.value = false
  }
}

// 打开某单的收款流水弹窗
function openPay(row) {
  payOrder.value = row
  payDialog.value = true
}

// 打开某单的轻量补照片弹窗
function openPhotos(row) {
  photoOrder.value = row
  photoDialog.value = true
}

// 保存照片：仅合并 photos 字段后整单保存，单号/金额/明细/流水等一律不动
async function onPhotosSaved(photos) {
  const order = photoOrder.value
  const idx = list.value.findIndex(s => s.id === order?.id)
  if (idx < 0) return
  const origin = list.value[idx]
  list.value[idx] = { ...origin, photos }
  try {
    await api.saveSales(list.value)
  } catch (e) {
    list.value[idx] = origin
    ElMessage.error(`保存失败：${e.message || '网络异常'}，请重试`)
    return
  }
  photoDialog.value = false
  photoOrder.value = null
  ElMessage.success('已更新单据照片')
}

async function onPaySaved(updated) {
  const idx = list.value.findIndex(s => s.id === updated.id)
  if (idx >= 0) list.value[idx] = updated
  // 保存失败时弹窗保持打开（父组件不关闭），便于直接重试
  try {
    await api.saveSales(list.value)
  } catch (e) {
    ElMessage.error(`保存失败：${e.message || '网络异常'}，请重试`)
    return
  }
  list.value = await api.getSales().catch(() => list.value)
  payDialog.value = false
  ElMessage.success('已保存收款流水')
}

async function toggleSettle(row) {
  // 欠款以金额为准：标记结清时，未收差额全部记为抹零优惠（不产生实际收款流水），保证状态与金额一致
  if ((row.settle || '挂账') !== '结清') {
    const due = grossOf(row)
    const unpaid = receivableOf(row)
    if (unpaid > 0) {
      const received = receivedSumOf(row)
      try {
        await ElMessageBox.confirm(
          `该单应收 ¥${due.toFixed(2)}，已实收 ¥${received.toFixed(2)}，未收 ¥${unpaid.toFixed(2)}。\n标记结清将把差额 ¥${unpaid.toFixed(2)} 记为抹零优惠（不产生实际收款，现金不增加），本单按 ¥${received.toFixed(2)} 结清。`,
          '标记结清', { type: 'warning' })
      } catch { return }
      // 抹零优惠：差额计入 discount 而非收款流水；syncPayments 按金额自动判定结清
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
      const updated = syncPayments({ ...row, discount: round2(Number(row.discount || 0) + unpaid) }, 'receivable')
      const idx = list.value.findIndex(s => s.id === updated.id)
      if (idx >= 0) list.value[idx] = updated
    } else {
      row.settle = '结清'
    }
  } else {
    row.settle = '挂账'
  }
  // 保存失败时明确报错并回滚，避免页面显示已结清但线上未生效
  try {
    await api.saveSales(list.value)
  } catch (e) {
    ElMessage.error(`操作失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    const [s, it] = await Promise.all([api.getSales(), api.getItems()])
    list.value = s
    itemOptions.value = it
    return
  }
  // 以保存后的最新状态判断提示（差额收款路径下 row 本身未被就地修改）
  const fresh = list.value.find(s => s.id === row.id)
  ElMessage.success(fresh && fresh.settle === '结清' ? '已标记为结清' : '已改回挂账')
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除销售单 ${row.id}?\n删除后库存与历史价会自动重算。`, '提示', { type: 'warning' })
  } catch { return }
  list.value = list.value.filter(s => s.id !== row.id)
  try {
    await api.saveSales(list.value)
  } catch (e) {
    ElMessage.error(`删除失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    const [s, it] = await Promise.all([api.getSales(), api.getItems()])
    list.value = s
    itemOptions.value = it
    return
  }
  const [s, it] = await Promise.all([api.getSales(), api.getItems()])
  list.value = s
  itemOptions.value = it
  // 删掉末页最后一条后页码要回退，否则停留在已不存在的页上会看到空白表格
  if (page.value > pageCount.value) page.value = pageCount.value
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
.paid-summary{display:flex;gap:8px;flex-wrap:wrap;color:#606266;font-size:13px;align-items:baseline;}
.paid-summary .hint{color:#c0c4cc;}
.pay-count{color:#909399;font-size:12px;margin-left:2px;}
</style>
