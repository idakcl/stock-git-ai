<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <b>商品管理</b>
          <el-button type="primary" @click="openDialog()">新增商品</el-button>
        </div>
      </template>
      <div class="stat-grid">
        <div class="stat-item">
          <el-statistic title="商品条目总数" :value="itemCount" suffix="条" />
          <div class="stat-sub">{{ filteredCount === itemCount ? '未筛选，显示全部' : `当前筛选 ${filteredCount} 条` }}</div>
        </div>
        <div class="stat-item">
          <el-statistic title="库存总数量" :value="stockQty" suffix="件" />
          <div class="stat-sub">按最近进价核算</div>
        </div>
        <div class="stat-item">
          <el-statistic title="库存货值" :value="stockValue" :precision="2" prefix="¥" />
          <div class="stat-sub">{{ inStockCount }} 项有库存</div>
        </div>
        <div class="stat-item">
          <el-statistic title="库存预警" :value="warningCount" suffix="项" value-style="color:var(--color-danger)" />
          <div class="stat-sub">{{ zeroStockCount }} 项零库存</div>
        </div>
      </div>
      <div class="filter-row">
        <span class="filter-label">供应商</span>
        <el-select v-model="filterSupplier" clearable filterable placeholder="全部供应商" class="filter-select">
          <el-option v-for="s in supplierOptions" :key="s.code" :label="s.label" :value="s.code" />
        </el-select>
        <span class="filter-label">客户</span>
        <el-select v-model="filterCustomer" clearable filterable placeholder="全部客户" class="filter-select">
          <el-option v-for="c in customerOptions" :key="c" :label="c" :value="c" />
        </el-select>
        <span v-if="filterSupplier || filterCustomer" class="filter-count">
          筛出 {{ filteredItems.length }} / {{ items.length }} 条
        </span>
        <el-button v-if="filterSupplier || filterCustomer" size="small" text @click="clearFilter">清除筛选</el-button>
      </div>
      <TableToolbar
        filename="商品库"
        title="商品库"
        :subtitle="exportSubtitle"
        :columns="exportColumns"
        :rows="exportRows"
      />
      <ProductTable ref="tableRef" :items="filteredItems" search-placeholder="搜索编码 / 名称" :show-cost="true" :price-columns="itemPriceColumns" :page-size="60">
        <template #actions="{ row }">
          <el-button size="small" @click="openDialog(row)">编辑</el-button>
          <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
        </template>
      </ProductTable>
    </el-card>

    <el-dialog v-model="dialog" title="商品" width="520">
      <el-form :model="form" label-width="80px">
        <el-form-item label="编码"><el-input v-model="form.code" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="单位"><el-input v-model="form.unit" /></el-form-item>
        <el-form-item label="供应商">
          <el-select
            v-model="form.suppliers"
            multiple filterable clearable
            placeholder="可多选，留空表示暂未指定"
            style="width:100%"
          >
            <el-option v-for="s in supplierOptions" :key="s.code" :label="s.label" :value="s.code" />
          </el-select>
          <div class="field-hint">更换供应商后，商品行的供应商列会同步更新；下次录入该商品的采购单时仍会自动补充新供应商</div>
        </el-form-item>
        <el-form-item label="进价"><el-input-number v-model="form.cost" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="售价"><el-input-number v-model="form.price" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="批发价"><el-input-number v-model="form.priceWholesale" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="安装师傅价"><el-input-number v-model="form.priceInstaller" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="预警值"><el-input-number v-model="form.warning" :min="0" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="商品照片"><PhotoUpload v-model="form.photos" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog=false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import ProductTable from '../components/ProductTable.vue'
import PhotoUpload from '../components/PhotoUpload.vue'
import TableToolbar from '../components/TableToolbar.vue'
import { nextEntityCode } from '../utils/code'

const items = ref([])
const stock = ref({})
const suppliers = ref([])
const customers = ref([])
// 列表筛选：按供应商；按客户（筛出「买过该商品的客户」，客户维度来自商品销售历史）
const filterSupplier = ref('')
const filterCustomer = ref('')
const dialog = ref(false)
const tableRef = ref(null)
// 正在编辑的商品原始编码：用于拦截「改成他人编码」导致覆盖对方商品
const editingCode = ref('')

// 供应商选项：存在同名不同码的重复档案（如 S00001/S00039 都叫湖南利接管件），
// 同名的在选项里补上编码后缀，避免选错
const supplierOptions = computed(() => {
  const nameCount = {}
  ;(suppliers.value || []).forEach(s => { nameCount[s.name] = (nameCount[s.name] || 0) + 1 })
  return (suppliers.value || []).map(s => ({
    code: s.code,
    label: nameCount[s.name] > 1 ? `${s.name}（${s.code}）` : s.name
  }))
})

// 筛选后的商品：传给表格，统计数据也跟着筛选范围走
const filteredItems = computed(() => items.value.filter(i => {
  if (filterSupplier.value && !(i.suppliers || []).includes(filterSupplier.value)) return false
  if (filterCustomer.value && !(i.saleHistory || []).some(h => (h.customer || '') === filterCustomer.value)) return false
  return true
}))
function clearFilter() { filterSupplier.value = ''; filterCustomer.value = '' }
// 客户选项：客户档案 + 商品销售历史里实际出现过的客户并集，避免档案不全导致选不到
const customerOptions = computed(() => {
  const set = new Set()
  ;(customers.value || []).forEach(c => { if (c.name) set.add(c.name) })
  items.value.forEach(i => (i.saleHistory || []).forEach(h => { if (h.customer) set.add(h.customer) }))
  return [...set].sort((a, b) => String(a).localeCompare(String(b), 'zh'))
})

// ---------- 商品库汇总：条目总数、库存数量/货值、预警数 ----------
const itemCount = computed(() => filteredItems.value.length)
// 当前筛选条数跟随表格搜索联动（分页前的实际命中数）
const filteredCount = computed(() => (tableRef.value && tableRef.value.filtered ? tableRef.value.filtered.length : itemCount.value) || 0)
const stockMap = computed(() => (stock.value && !Array.isArray(stock.value) ? stock.value : {}))
const stockQty = computed(() => filteredItems.value.reduce((s, i) => s + Number((stockMap.value[i.code] || {}).qty || 0), 0))
// 库存货值：Σ 数量 × 最近进价，抹掉浮点尘避免显示 -0.00
const stockValue = computed(() => {
  const v = filteredItems.value.reduce((s, i) => {
    const st = stockMap.value[i.code] || {}
    return s + Number(st.qty || 0) * Number(st.cost || 0)
  }, 0)
  const rounded = Math.round((v + Number.EPSILON) * 100) / 100
  return rounded === 0 ? 0 : rounded
})
const inStockCount = computed(() => filteredItems.value.filter(i => Number((stockMap.value[i.code] || {}).qty || 0) > 0).length)
const zeroStockCount = computed(() => itemCount.value - inStockCount.value)
// 预警：设置了预警值且库存不高于预警线
const warningCount = computed(() => filteredItems.value.filter(i => {
  const w = Number(i.warning || 0)
  if (w <= 0) return false
  const qty = Number((stockMap.value[i.code] || {}).qty || 0)
  return qty <= w
}).length)
const form = reactive({
  code:'', name:'', unit:'', photos:[], suppliers:[],
  cost:0, price:0, priceWholesale:0, priceInstaller:0,
  warning:0, remark:''
})

// 商品库价格列：售价、批发价、安装师傅价（进价不在列表展示）
const itemPriceColumns = [
  { prop: 'price', label: '售价' },
  { prop: 'priceWholesale', label: '批发价' },
  { prop: 'priceInstaller', label: '安装师傅价' }
]
// 导出/打印与列表当前页同步：取当前页数据，副标题标注输出范围（第 X/Y 页）
const exportRows = computed(() => (tableRef.value && tableRef.value.pagedRows) || items.value)
const exportSubtitle = computed(() => {
  const total = (tableRef.value && tableRef.value.filtered ? tableRef.value.filtered.length : items.value.length) || 0
  const p = (tableRef.value && tableRef.value.page) || 1
  const pc = (tableRef.value && tableRef.value.pageCount) || 1
  return `共 ${total} 条 · 导出当前第 ${p}/${pc} 页`
})
const exportColumns = [
  { label: '编码', prop: 'code' },
  { label: '名称', prop: 'name' },
  { label: '单位', prop: 'unit' },
  { label: '进价', prop: 'cost' },
  { label: '售价', prop: 'price' },
  { label: '批发价', prop: 'priceWholesale' },
  { label: '安装师傅价', prop: 'priceInstaller' },
  { label: '预警值', prop: 'warning' },
  { label: '备注', prop: 'remark' }
]

onMounted(load)
async function load() {
  try {
    const [it, st, sp, cu] = await Promise.all([api.getItems(), api.getStock(), api.getSuppliers(), api.getCustomers()])
    items.value = it || []
    stock.value = st || {}
    suppliers.value = sp || []
    customers.value = cu || []
  } catch (e) {
    items.value = []
    stock.value = {}
    suppliers.value = []
    customers.value = []
  }
}

function openDialog(row) {
  editingCode.value = row ? row.code : ''
  // 先重置为默认值再覆盖，避免上次编辑残留；品牌字段已废弃，读入时剥离
  const { brand, ...rest } = row || {}
  Object.assign(form, {
    code: nextEntityCode(items.value, 'P'), name:'', unit:'', photos:[], suppliers:[],
    cost:0, price:0, priceWholesale:0, priceInstaller:0, warning:0, remark:'',
    ...rest
  })
  // 供应商始终是数组，避免历史脏数据（字符串/null）导致多选组件异常
  form.suppliers = Array.isArray(form.suppliers) ? [...form.suppliers] : []
  dialog.value = true
}

async function save() {
  // 把编码改成别人的编码会把对方商品整条覆盖掉，先拦下来
  if (form.code && form.code !== editingCode.value && items.value.some(i => i.code === form.code)) {
    return ElMessage.error(`编码 ${form.code} 已被其他商品使用，请换一个编码`)
  }
  const idx = items.value.findIndex(i => i.code === form.code)
  // 品牌字段已废弃、零售价已并入售价：保存时剥离，数据中不再写入
  const { brand, priceRetail, ...rest } = form
  const payload = { ...rest, suppliers: Array.isArray(rest.suppliers) ? [...rest.suppliers] : [] }
  if (idx >= 0) items.value[idx] = { ...items.value[idx], ...payload, brand: undefined }
  else items.value.push({ ...payload, brand: undefined })
  // 保存失败（如 GitHub 写入出错）时明确报错，并回滚为线上数据，避免本地与线上不一致
  try {
    await api.saveItems(items.value)
  } catch (e) {
    ElMessage.error(`保存失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    await load()
    return
  }
  dialog.value = false
  ElMessage.success('已保存')
  load()
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除 ${row.name}?`, '提示', { type: 'warning' })
  } catch { return }
  items.value = items.value.filter(i => i.code !== row.code)
  try {
    await api.saveItems(items.value)
  } catch (e) {
    ElMessage.error(`删除失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    await load()
    return
  }
  ElMessage.success('已删除')
  load()
}
</script>

<style scoped>
.card-header { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 12px; }
.stat-item { padding: 12px 16px; background:var(--bg-stat); border-radius: 8px; min-width: 0; }
.stat-item .el-statistic__head,
.stat-item .el-statistic__content { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-sub { margin-top: 4px; color:var(--text-secondary); font-size:var(--fs-sub); }
.filter-row { display:flex; align-items:center; gap:var(--gap-sm); flex-wrap:wrap; margin-bottom:var(--gap-md); }
.filter-label { color:var(--text-regular); font-size:var(--fs-base); }
.filter-select { width:220px; }
.filter-count { color:var(--text-secondary); font-size:var(--fs-sub); }
.field-hint { margin-top: var(--gap-xs); color: var(--text-secondary); font-size: var(--fs-sub); line-height: 1.5; }
</style>
