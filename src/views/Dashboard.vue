<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <b>经营看板</b>
          <div class="presets">
            <el-button
              v-for="q in quickList"
              :key="q.key"
              size="small"
              :type="quick === q.key ? 'primary' : 'default'"
              @click="applyQuick(q.key)"
            >{{ q.label }}</el-button>
          </div>
        </div>
      </template>
      <div class="filter-row">
        <span class="filter-label">时间段</span>
        <el-date-picker v-model="dateStart" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" style="width:150px" @change="quick = ''" />
        <span class="filter-sep">至</span>
        <el-date-picker v-model="dateEnd" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" style="width:150px" @change="quick = ''" />
        <el-tag v-if="rangeLabel" type="info" effect="plain">{{ rangeLabel }}</el-tag>
        <el-button v-if="dateStart || dateEnd" text type="primary" @click="clearRange">全部</el-button>
      </div>
      <div class="stat-grid">
        <div class="stat-item">
          <el-statistic :title="`${periodTitle}采购金额`" :value="purchaseTotal" :precision="2" prefix="¥" />
        </div>
        <div class="stat-item">
          <el-statistic :title="`${periodTitle}销售金额`" :value="saleTotal" :precision="2" prefix="¥" />
        </div>
        <div class="stat-item">
          <el-statistic :title="`${periodTitle}毛利`" :value="profit" :precision="2" prefix="¥" />
        </div>
        <div class="stat-item">
          <el-statistic :title="`${periodTitle}单据数`" :value="filteredPurchases.length + filteredSales.length" suffix="张" />
        </div>
      </div>
    </el-card>

    <el-card>
      <template #header><b>{{ periodTitle }}采购单汇总（{{ filteredPurchases.length }} 张）</b></template>
      <div class="filter-row">
        <span class="filter-label">按供应商</span>
        <el-select v-model="supplierFilter" clearable filterable placeholder="全部供应商" style="width:220px">
          <el-option v-for="s in supplierOptions" :key="s" :label="s" :value="s" />
        </el-select>
      </div>
      <div class="table-wrap">
        <el-table :data="pagedPurchases" stripe show-summary :summary-method="purchaseSummary">
          <el-table-column label="单号" width="180">
            <template #default="{ row }"><router-link :to="`/purchase/${row.id}`" class="link">{{ row.id }}</router-link></template>
          </el-table-column>
          <el-table-column prop="supplier" label="供应商" min-width="180" show-overflow-tooltip />
          <el-table-column prop="date" label="日期" width="120" />
          <el-table-column prop="total" label="金额" width="120" align="right">
            <template #default="{ row }">{{ Number(row.total || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="优惠" width="100" align="right">
            <template #default="{ row }">
              <span v-if="Number(row.discount || 0) > 0" class="discount" title="抹零优惠，未实际付款">-{{ Number(row.discount).toFixed(2) }}</span>
              <span v-else class="none">—</span>
            </template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" width="160" show-overflow-tooltip />
        </el-table>
      </div>
      <el-pagination
        v-model:current-page="purPage"
        :page-size="PAGE_SIZE"
        :total="filteredPurchases.length"
        layout="total, prev, pager, next"
        background
        class="pager"
      />
      <el-empty v-if="!filteredPurchases.length" :description="`${periodTitle}暂无采购单`" />
    </el-card>

    <el-card>
      <template #header><b>{{ periodTitle }}销售单汇总（{{ filteredSales.length }} 张）</b></template>
      <div class="filter-row">
        <span class="filter-label">按客户</span>
        <el-select v-model="customerFilter" clearable filterable placeholder="全部客户" style="width:220px">
          <el-option v-for="c in customerOptions" :key="c" :label="c" :value="c" />
        </el-select>
      </div>
      <div class="table-wrap">
        <el-table :data="pagedSales" stripe show-summary :summary-method="saleSummary">
          <el-table-column label="单号" width="180">
            <template #default="{ row }"><router-link :to="`/sale/${row.id}`" class="link">{{ row.id }}</router-link></template>
          </el-table-column>
          <el-table-column prop="customer" label="客户" min-width="160" show-overflow-tooltip />
          <el-table-column prop="date" label="日期" width="120" />
          <el-table-column prop="total" label="金额" width="120" align="right">
            <template #default="{ row }">{{ Number(row.total || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="优惠" width="100" align="right">
            <template #default="{ row }">
              <span v-if="Number(row.discount || 0) > 0" class="discount" title="抹零优惠，未实际收款">-{{ Number(row.discount).toFixed(2) }}</span>
              <span v-else class="none">—</span>
            </template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" width="160" show-overflow-tooltip />
        </el-table>
      </div>
      <el-pagination
        v-model:current-page="salePage"
        :page-size="PAGE_SIZE"
        :total="filteredSales.length"
        layout="total, prev, pager, next"
        background
        class="pager"
      />
      <el-empty v-if="!filteredSales.length" :description="`${periodTitle}暂无销售单`" />
    </el-card>

    <el-card>
      <template #header><b>库存概览</b></template>
      <div class="stat-grid">
        <div class="stat-item"><el-statistic title="商品数" :value="stats.itemCount" /></div>
        <div class="stat-item"><el-statistic title="库存总金额" :value="stats.stockValue" :precision="2" prefix="¥" /></div>
      </div>
      <el-divider />
      <b>低库存预警</b>
      <el-input v-model="keyword" clearable placeholder="搜索编码 / 名称" class="search-input" />
      <div class="table-wrap">
      <el-table :data="filteredLowStock" stripe>
        <el-table-column prop="code" label="编码" width="140" />
        <el-table-column prop="name" label="名称" />
        <el-table-column prop="stock" label="库存" width="100"  align="right"/>
        <el-table-column label="预警值" width="170" align="right">
          <template #default="{ row }">
            <el-input-number
              :model-value="Number(row.warning || 0)"
              :min="0"
              size="small"
              style="width:120px"
              @change="(v) => saveWarning(row, v)"
            />
          </template>
        </el-table-column>
      </el-table>
      </div>
      <el-empty v-if="!lowStock.length" description="暂无低库存商品" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'

const PAGE_SIZE = 20

function ymd(d = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function shiftDays(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return ymd(d)
}

const stats = reactive({ itemCount: 0, stockValue: 0 })
const purchases = ref([])
const sales = ref([])
const items = ref([])
const costMap = ref({})
const lowStock = ref([])
const keyword = ref('')

const quickList = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'week', label: '近7天' },
  { key: 'month', label: '本月' }
]
const quick = ref('today')
const dateStart = ref(ymd())
const dateEnd = ref(ymd())

// 汇总表：每页 20 条 + 按供应商 / 按客户筛选
const supplierFilter = ref('')
const customerFilter = ref('')
const purPage = ref(1)
const salePage = ref(1)

function applyQuick(key) {
  quick.value = key
  const today = ymd()
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  if (key === 'today') { dateStart.value = today; dateEnd.value = today }
  else if (key === 'yesterday') { const y = shiftDays(-1); dateStart.value = y; dateEnd.value = y }
  else if (key === 'week') { dateStart.value = shiftDays(-6); dateEnd.value = today }
  else if (key === 'month') { dateStart.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`; dateEnd.value = today }
}
function clearRange() { quick.value = ''; dateStart.value = ''; dateEnd.value = '' }

const rangeLabel = computed(() => {
  if (dateStart.value && dateEnd.value) return dateStart.value === dateEnd.value ? dateStart.value : `${dateStart.value} ~ ${dateEnd.value}`
  if (dateStart.value) return `${dateStart.value} 起`
  if (dateEnd.value) return `截至 ${dateEnd.value}`
  return ''
})
const periodTitle = computed(() => (dateStart.value === ymd() && dateEnd.value === ymd() ? '今日' : '本期'))

function inRange(date) {
  const d = date || ''
  if (dateStart.value && d < dateStart.value) return false
  if (dateEnd.value && d > dateEnd.value) return false
  return true
}

const filteredPurchases = computed(() => (purchases.value || []).filter(p =>
  inRange(p.date) && (!supplierFilter.value || (p.supplier || '') === supplierFilter.value)))
const filteredSales = computed(() => (sales.value || []).filter(s =>
  inRange(s.date) && (!customerFilter.value || (s.customer || '') === customerFilter.value)))

// 供应商 / 客户下拉选项（本期范围内出现过的）
const supplierOptions = computed(() => [...new Set((purchases.value || []).filter(p => inRange(p.date)).map(p => p.supplier).filter(Boolean))].sort())
const customerOptions = computed(() => [...new Set((sales.value || []).filter(s => inRange(s.date)).map(s => s.customer).filter(Boolean))].sort())

const pagedPurchases = computed(() => filteredPurchases.value.slice((purPage.value - 1) * PAGE_SIZE, purPage.value * PAGE_SIZE))
const pagedSales = computed(() => filteredSales.value.slice((salePage.value - 1) * PAGE_SIZE, salePage.value * PAGE_SIZE))
watch([dateStart, dateEnd, supplierFilter], () => { purPage.value = 1 })
watch([dateStart, dateEnd, customerFilter], () => { salePage.value = 1 })
// 金额统一两位小数，并把 -0 归一化为 0：浮点尘（如 40.29-40.29=-1.4e-14）经 toFixed(2) 会渲染成 "-0.00"
const money = (n) => {
  const v = Math.round((Number(n) + Number.EPSILON) * 100) / 100
  return v === 0 ? 0 : v
}
const purchaseTotal = computed(() => money(filteredPurchases.value.reduce((sum, p) => sum + Number(p.total || 0), 0)))
const saleTotal = computed(() => money(filteredSales.value.reduce((sum, s) => sum + Number(s.total || 0), 0)))
const profit = computed(() => {
  const cost = filteredSales.value.reduce(
    (sum, s) => sum + (s.items || []).reduce((c, i) => c + Number(i.qty || 0) * Number(costMap.value[i.code] || 0), 0), 0)
  return money(saleTotal.value - cost)
})
const filteredLowStock = computed(() => lowStock.value.filter(i => matchText(keyword.value, i.code, i.name)))

// 表格底部合计：基于「全部筛选结果」，不受分页影响
const makeSummary = (rowsGetter) => ({ columns }) => {
  const rows = rowsGetter()
  const total = rows.reduce((sum, r) => sum + Number(r.total || 0), 0)
  return columns.map((c, idx) => {
    if (idx === 0) return `合计（${rows.length} 单）`
    if (c.property === 'total') return total.toFixed(2)
    return ''
  })
}
const purchaseSummary = makeSummary(() => filteredPurchases.value)
const saleSummary = makeSummary(() => filteredSales.value)

// 低库存预警：可直接修改每个商品的预警值
async function saveWarning(row, value) {
  const v = Number(value || 0)
  const idx = items.value.findIndex(i => i.code === row.code)
  if (idx < 0) return
  items.value[idx] = { ...items.value[idx], warning: v }
  row.warning = v
  try {
    await api.saveItems(items.value)
    ElMessage.success(`${row.name || row.code} 预警值已设为 ${v}`)
  } catch (e) {
    ElMessage.error('保存失败：' + (e.message || '请重试'))
  }
}

onMounted(async () => {
  try {
    const [itemList, purchaseList, saleList, stock] = await Promise.all([
      api.getItems(), api.getPurchases(), api.getSales(), api.getStock()
    ])
    items.value = itemList || []
    purchases.value = purchaseList || []
    sales.value = saleList || []
    stats.itemCount = (itemList || []).length

    const stockObj = stock && !Array.isArray(stock) ? stock : {}
    const cm = {}
    for (const info of Object.values(stockObj)) {
      stats.stockValue += (info.qty || 0) * (info.cost || 0)
    }
    ;(itemList || []).forEach(i => { cm[i.code] = Number(i.cost || 0) })
    for (const [code, v] of Object.entries(stockObj)) cm[code] = Number(v.cost || 0)
    costMap.value = cm

    const warnMap = {}
    ;(itemList || []).forEach(i => { warnMap[i.code] = i.warning || 0 })
    lowStock.value = Object.entries(stockObj)
      // 注意：库存对象 {qty,cost} 里没有 code，阈值必须用 entries 的 key 取；
      // 用 v.code 会恒为 undefined → 阈值变 0 → 设了预警值的商品全部不显示
      .filter(([code, v]) => (v.qty || 0) <= (warnMap[code] || 0))
      .map(([code, v]) => ({ ...v, code, stock: v.qty, warning: warnMap[code] || 0 }))
  } catch (e) {
    console.error(e)
  }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.presets { display: flex; gap: 6px; flex-wrap: wrap; }
.filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.filter-label { color:var(--text-regular); font-size:var(--fs-base); }
.filter-sep { color:var(--text-secondary); }
.search-input { margin: 8px 0 12px; max-width: 360px; }
.pager { margin-top: 12px; justify-content: flex-end; }
.discount { color:var(--color-success); }
.none { color:var(--text-placeholder); }
</style>
