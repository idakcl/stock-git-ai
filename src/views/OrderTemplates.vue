<template>
  <!-- 订单模板列表页：管理多个常用商品组合模板，支持一键转订单、打印、打印空表。
       样式与 Shares.vue 一致（el-card + card-header + el-table + 操作列）。 -->
  <el-card v-loading="loading">
    <template #header>
      <div class="card-header">
        <div class="title">
          <b>订单模板</b>
          <span class="hint">把常用商品组合存成模板，一键生成订单、打印明细或空表</span>
        </div>
        <div class="actions">
          <el-button :loading="loading" @click="load">刷新</el-button>
          <el-button type="primary" @click="openCreate">新建模板</el-button>
          <!-- 行上的 打印 / 空表 与全站其它打印共用这一份纸张与跨页表头设置 -->
          <PrintHeaderToggle />
        </div>
      </div>
    </template>

    <el-table :data="templates" stripe empty-text="暂无模板。点右上角「新建模板」开始。">
      <el-table-column label="模板名称" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">{{ row.name }}</template>
      </el-table-column>
      <el-table-column label="类型" width="100">
        <template #default="{ row }">
          <el-tag :type="row.kind === 'purchase' ? 'info' : 'success'" size="small" disable-transitions>
            {{ row.kind === 'purchase' ? '采购' : '销售' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="商品数" width="90" align="right">
        <template #default="{ row }">{{ (row.items || []).length }}</template>
      </el-table-column>
      <el-table-column label="金额" width="120" align="right">
        <template #default="{ row }">¥ {{ templateAmount(row).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="创建时间" width="170">
        <template #default="{ row }">{{ fmtCNTime(row.createdAt) || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="600" class-name="ops-col">
        <template #default="{ row }">
          <el-button size="small" type="primary" @click="openConvert(row)">转订单</el-button>
          <el-button size="small" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" plain @click="printTemplate(row, false)">打印</el-button>
          <el-button size="small" plain @click="printTemplate(row, true)">空表</el-button>
          <el-button size="small" @click="duplicate(row)">复制</el-button>
          <el-button size="small" type="danger" plain @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <!-- 新增/编辑弹窗 -->
  <TemplateFormDialog
    v-model="dialog"
    :template="editingTemplate"
    :items="itemOptions"
    :saving="saving"
    @saved="onFormSaved"
  />

  <!-- 一键转订单确认弹窗 -->
  <el-dialog v-model="convertDialog" title="从模板生成订单" width="480" :close-on-click-modal="false">
    <el-form :model="convertForm" label-width="100px">
      <el-form-item label="模板名称">
        <span>{{ convertTemplate?.name }}</span>
      </el-form-item>
      <el-form-item label="订单类型">
        <el-radio-group v-model="convertForm.kind">
          <el-radio-button value="sale">销售订单</el-radio-button>
          <el-radio-button value="purchase">采购订单</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="partyLabel">
        <el-select v-model="convertForm.party" filterable allow-create default-first-option :placeholder="`选择或输入${partyLabel}`" style="width:100%">
          <el-option v-for="p in partyOptions" :key="p.code || p.name" :label="p.name" :value="p.name" />
        </el-select>
      </el-form-item>
      <el-form-item label="日期">
        <el-date-picker v-model="convertForm.date" type="date" value-format="YYYY-MM-DD" />
      </el-form-item>
      <el-form-item label="业务单号">
        <el-input v-model="convertForm.no" maxlength="40" placeholder="选填：客户/供应商那边的单号" />
      </el-form-item>
      <el-form-item label="订单金额">
        <b>¥ {{ convertAmount.toFixed(2) }}</b>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="convertDialog = false">取消</el-button>
      <el-button type="primary" :loading="converting" @click="doConvert">生成订单</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { round2 } from '../utils/account'
import { normalizeRate } from '../utils/catalog'
import { orderAmount } from '../utils/orders'
import { fmtCNTime, todayCN } from '../utils/time'
import { printA4 } from '../utils/export'
import { repeatHeaderPref } from '../utils/printPrefs'
import PrintHeaderToggle from '../components/PrintHeaderToggle.vue'
import TemplateFormDialog from '../components/TemplateFormDialog.vue'

const router = useRouter()
const loading = ref(false)
const saving = ref(false)
const templates = ref([])
const itemOptions = ref([])
const customerOptions = ref([])
const supplierOptions = ref([])

// 弹窗状态
const dialog = ref(false)
const editingTemplate = ref(null)

// 转订单弹窗状态
const convertDialog = ref(false)
const convertTemplate = ref(null)
const converting = ref(false)
const convertForm = ref({ kind: 'sale', party: '', date: '', no: '' })

const partyLabel = computed(() => convertForm.value.kind === 'purchase' ? '供应商' : '客户')
const partyOptions = computed(() => convertForm.value.kind === 'purchase' ? supplierOptions.value : customerOptions.value)

// 模板金额：按订单口径重算（合计 × 折扣链 − 整单优惠）。
// 必须先给每行补出 total：orderAmount 的行合计只认 l.total 字段，
// 而模板存的是 qty/price/discountRate（没有 total），直接丢进去会算出 ¥0.00。
function templateAmount(tpl) {
  const items = (tpl.items || []).map(l => {
    const gross = round2(Number(l.qty || 0) * Number(l.price || 0))
    const rate = normalizeRate(l, gross)
    return { ...l, total: Math.max(0, round2(gross - round2(gross * (1 - rate)))) }
  })
  return orderAmount({ items, discountRates: [], discount: 0 })
}

// 转订单弹窗里显示的金额：与模板列表同一口径，都走 templateAmount
const convertAmount = computed(() => {
  if (!convertTemplate.value) return 0
  return templateAmount(convertTemplate.value)
})

async function load() {
  loading.value = true
  try {
    const [tpls, items, customers, suppliers] = await Promise.all([
      api.getTemplates(),
      api.getItems(),
      api.getCustomers(),
      api.getSuppliers()
    ])
    templates.value = (tpls && tpls.templates) || []
    // 上面这行必须是 .templates：接口和 /shares 一样返回 { templates: [...] } 包裹结构，
    // 直接把整个对象丢给 el-table 的 :data，表格永远渲染不出行 —— 看着就是「模板保存不了」
    itemOptions.value = items || []
    customerOptions.value = customers || []
    supplierOptions.value = suppliers || []
  } catch (e) {
    ElMessage.error(`加载失败：${e.message || '网络异常'}`)
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editingTemplate.value = null
  dialog.value = true
}

function openEdit(tpl) {
  editingTemplate.value = tpl
  dialog.value = true
}

async function onFormSaved({ id, template }) {
  saving.value = true
  try {
    if (id) {
      await api.templateOperation({ action: 'update', id, template })
      ElMessage.success('模板已更新')
    } else {
      await api.templateOperation({ action: 'create', template })
      ElMessage.success('模板已创建')
    }
    dialog.value = false
    await load()
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function duplicate(tpl) {
  try {
    await api.templateOperation({ action: 'duplicate', id: tpl.id })
    ElMessage.success('已复制模板')
    await load()
  } catch (e) {
    ElMessage.error(e.message || '复制失败')
  }
}

async function remove(tpl) {
  try {
    await ElMessageBox.confirm(
      `确定删除模板「${tpl.name}」？删除后不可恢复。`,
      '删除模板', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  } catch { return }
  try {
    await api.templateOperation({ action: 'delete', id: tpl.id })
    ElMessage.success('模板已删除')
    await load()
  } catch (e) {
    ElMessage.error(e.message || '删除失败')
  }
}

function openConvert(tpl) {
  convertTemplate.value = tpl
  convertForm.value = {
    kind: tpl.kind || 'sale',
    party: '',
    date: todayCN(),
    no: ''
  }
  convertDialog.value = true
}

async function doConvert() {
  if (!convertForm.value.party.trim()) {
    ElMessage.warning(`请填写${partyLabel.value}`)
    return
  }
  if (!convertForm.value.date) {
    ElMessage.warning('请选择日期')
    return
  }
  converting.value = true
  try {
    const tpl = convertTemplate.value
    const items = (tpl.items || []).map(it => {
      const gross = round2(Number(it.qty || 0) * Number(it.price || 0))
      const rate = normalizeRate(it, gross)
      const discount = round2(gross * (1 - rate))
      const total = Math.max(0, round2(gross - discount))
      return { ...it, discountRate: rate, discount, total }
    })
    const order = {
      kind: convertForm.value.kind,
      customer: convertForm.value.kind === 'sale' ? convertForm.value.party : '',
      supplier: convertForm.value.kind === 'purchase' ? convertForm.value.party : '',
      date: convertForm.value.date,
      no: convertForm.value.no,
      items,
      discountRates: [],
      discount: 0,
      remark: `从模板「${tpl.name}」生成`
    }
    const r = await api.orderOperation({ action: 'save', order })
    convertDialog.value = false
    ElMessage.success({ message: `订单 ${r.code} 已生成`, duration: 3000 })
    // 跳转到订单详情页
    router.push(`/order/${r.code}`)
  } catch (e) {
    ElMessage.error(e.message || '生成订单失败')
  } finally {
    converting.value = false
  }
}

// 打印模板：empty=true 时只打印商品名称/编码/单位，不出现数量/单价/金额；纸张跟「打印设置」走
function printTemplate(tpl, empty = false) {
  const title = `订单模板 · ${tpl.name}`
  const subtitle = `${tpl.kind === 'purchase' ? '采购' : '销售'}模板 · ${(tpl.items || []).length} 项商品`
  const items = tpl.items || []

  if (empty) {
    // 空表是「手写单」：商品/编码/单位照常印出来当底稿，数量/单价/金额留白格，
    // 现场填数、回去再录单。列必须出现，否则拿到纸的人不知道该往哪写。
    const columns = [
      { prop: 'code', label: '编码' },
      { prop: 'name', label: '商品名称' },
      { prop: 'unit', label: '单位' },
      { prop: 'qty', label: '数量' },
      { prop: 'price', label: '单价' },
      { prop: 'amount', label: '金额' }
    ]
    const rows = items.map(it => ({
      code: it.code || '', name: it.name || '', unit: it.unit || '',
      qty: '', price: '', amount: ''
    }))
    printA4(title, columns, rows, subtitle, [], [], '', repeatHeaderPref.value)
  } else {
    // 正常打印：带数量、单价、折扣、小计
    const columns = [
      { prop: 'code', label: '编码' },
      { prop: 'name', label: '商品名称' },
      { prop: 'unit', label: '单位' },
      { prop: 'qty', label: '数量' },
      { prop: 'price', label: '单价' },
      { prop: 'discountRate', label: '折扣' },
      { prop: 'total', label: '小计' }
    ]
    const rows = items.map(it => {
      const gross = round2(Number(it.qty || 0) * Number(it.price || 0))
      const rate = normalizeRate(it, gross)
      const discount = round2(gross * (1 - rate))
      const total = Math.max(0, round2(gross - discount))
      return {
        code: it.code || '',
        name: it.name || '',
        unit: it.unit || '',
        qty: it.qty,
        price: it.price.toFixed(2),
        discountRate: rate < 1 ? rate.toFixed(2) : '',
        total: total.toFixed(2)
      }
    })
    const headerFields = [['合计', `¥ ${templateAmount(tpl).toFixed(2)}`, 'xl']]
    printA4(title, columns, rows, subtitle, headerFields, [], '', repeatHeaderPref.value)
  }
}

onMounted(load)
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hint { color: var(--text-secondary); font-size: var(--fs-sub); }
.actions { display: flex; gap: 8px; }
</style>
