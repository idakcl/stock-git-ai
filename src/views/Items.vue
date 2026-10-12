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
          <el-statistic title="库存预警" :value="warningCount" suffix="项" value-style="color:#f56c6c" />
          <div class="stat-sub">{{ zeroStockCount }} 项零库存</div>
        </div>
      </div>
      <TableToolbar
        filename="商品库"
        title="商品库"
        :subtitle="exportSubtitle"
        :columns="exportColumns"
        :rows="exportRows"
      />
      <ProductTable ref="tableRef" :items="items" search-placeholder="搜索编码 / 名称" show-price-tiers :page-size="60">
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
        <el-form-item label="进价"><el-input-number v-model="form.cost" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="售价"><el-input-number v-model="form.price" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="批发价"><el-input-number v-model="form.priceWholesale" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="零售价"><el-input-number v-model="form.priceRetail" :min="0" :precision="2" /></el-form-item>
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
const dialog = ref(false)
const tableRef = ref(null)

// ---------- 商品库汇总：条目总数、库存数量/货值、预警数 ----------
const itemCount = computed(() => items.value.length)
// 当前筛选条数跟随表格搜索联动（分页前的实际命中数）
const filteredCount = computed(() => (tableRef.value && tableRef.value.filtered ? tableRef.value.filtered.length : itemCount.value) || 0)
const stockMap = computed(() => (stock.value && !Array.isArray(stock.value) ? stock.value : {}))
const stockQty = computed(() => Object.values(stockMap.value).reduce((s, v) => s + Number(v && v.qty || 0), 0))
// 库存货值：Σ 数量 × 最近进价，抹掉浮点尘避免显示 -0.00
const stockValue = computed(() => {
  const v = Object.values(stockMap.value).reduce((s, x) => s + Number(x && x.qty || 0) * Number(x && x.cost || 0), 0)
  const rounded = Math.round((v + Number.EPSILON) * 100) / 100
  return rounded === 0 ? 0 : rounded
})
const inStockCount = computed(() => items.value.filter(i => Number((stockMap.value[i.code] || {}).qty || 0) > 0).length)
const zeroStockCount = computed(() => itemCount.value - inStockCount.value)
// 预警：设置了预警值且库存不高于预警线
const warningCount = computed(() => items.value.filter(i => {
  const w = Number(i.warning || 0)
  if (w <= 0) return false
  const qty = Number((stockMap.value[i.code] || {}).qty || 0)
  return qty <= w
}).length)
const form = reactive({
  code:'', name:'', unit:'', photos:[],
  cost:0, price:0, priceWholesale:0, priceRetail:0, priceInstaller:0,
  warning:0, remark:''
})

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
  { label: '零售价', prop: 'priceRetail' },
  { label: '安装师傅价', prop: 'priceInstaller' },
  { label: '预警值', prop: 'warning' },
  { label: '备注', prop: 'remark' }
]

onMounted(load)
async function load() {
  try {
    const [it, st] = await Promise.all([api.getItems(), api.getStock()])
    items.value = it || []
    stock.value = st || {}
  } catch (e) {
    items.value = []
    stock.value = {}
  }
}

function openDialog(row) {
  // 先重置为默认值再覆盖，避免上次编辑残留；品牌字段已废弃，读入时剥离
  const { brand, ...rest } = row || {}
  Object.assign(form, {
    code: nextEntityCode(items.value, 'P'), name:'', unit:'', photos:[],
    cost:0, price:0, priceWholesale:0, priceRetail:0, priceInstaller:0, warning:0, remark:'',
    ...rest
  })
  dialog.value = true
}

async function save() {
  const idx = items.value.findIndex(i => i.code === form.code)
  // 品牌字段已废弃：保存时剥离，数据中不再写入
  const { brand, ...rest } = form
  if (idx >= 0) items.value[idx] = { ...items.value[idx], ...rest, brand: undefined }
  else items.value.push({ ...rest, brand: undefined })
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
.stat-item { padding: 12px 16px; background: #f8f9fb; border-radius: 8px; min-width: 0; }
.stat-item .el-statistic__head,
.stat-item .el-statistic__content { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-sub { margin-top: 4px; color: #909399; font-size: 12px; }
</style>
