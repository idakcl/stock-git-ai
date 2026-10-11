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

    <el-card style="margin-top:16px">
      <template #header><b>{{ periodTitle }}采购单汇总（{{ filteredPurchases.length }} 张）</b></template>
      <div class="table-wrap">
        <el-table :data="filteredPurchases" stripe show-summary :summary-method="summaryAmount">
          <el-table-column label="单号" width="180">
            <template #default="{ row }"><router-link :to="`/purchase/${row.id}`" class="link">{{ row.id }}</router-link></template>
          </el-table-column>
          <el-table-column prop="supplier" label="供应商" min-width="180" />
          <el-table-column prop="date" label="日期" width="120" />
          <el-table-column prop="total" label="金额" width="120">
            <template #default="{ row }">{{ Number(row.total || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
        </el-table>
      </div>
      <el-empty v-if="!filteredPurchases.length" :description="`${periodTitle}暂无采购单`" />
    </el-card>

    <el-card style="margin-top:16px">
      <template #header><b>{{ periodTitle }}销售单汇总（{{ filteredSales.length }} 张）</b></template>
      <div class="table-wrap">
        <el-table :data="filteredSales" stripe show-summary :summary-method="summaryAmount">
          <el-table-column label="单号" width="180">
            <template #default="{ row }"><router-link :to="`/sale/${row.id}`" class="link">{{ row.id }}</router-link></template>
          </el-table-column>
          <el-table-column prop="customer" label="客户" min-width="160" />
          <el-table-column prop="date" label="日期" width="120" />
          <el-table-column prop="total" label="金额" width="120">
            <template #default="{ row }">{{ Number(row.total || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
        </el-table>
      </div>
      <el-empty v-if="!filteredSales.length" :description="`${periodTitle}暂无销售单`" />
    </el-card>

    <el-card style="margin-top:16px">
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
          <el-table-column prop="stock" label="库存" width="100" />
          <el-table-column prop="warning" label="预警值" width="100" />
        </el-table>
      </div>
      <el-empty v-if="!lowStock.length" description="暂无低库存商品" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { api } from '../api'
import { matchText } from '../utils/search'

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

const filteredPurchases = computed(() => (purchases.value || []).filter(p => inRange(p.date)))
const filteredSales = computed(() => (sales.value || []).filter(s => inRange(s.date)))
const purchaseTotal = computed(() => filteredPurchases.value.reduce((sum, p) => sum + Number(p.total || 0), 0))
const saleTotal = computed(() => filteredSales.value.reduce((sum, s) => sum + Number(s.total || 0), 0))
const profit = computed(() => {
  const cost = filteredSales.value.reduce(
    (sum, s) => sum + (s.items || []).reduce((c, i) => c + Number(i.qty || 0) * Number(costMap.value[i.code] || 0), 0), 0)
  return saleTotal.value - cost
})
const filteredLowStock = computed(() => lowStock.value.filter(i => matchText(keyword.value, i.code, i.name)))

// 表格底部合计：每个表沿用同一逻辑
const summaryAmount = ({ columns, data }) => {
  const total = (data || []).reduce((sum, r) => sum + Number(r.total || 0), 0)
  return columns.map((c, idx) => {
    if (idx === 0) return '合计'
    if (c.property === 'total') return total.toFixed(2)
    return ''
  })
}

onMounted(async () => {
  try {
    const [items, purchaseList, saleList, stock] = await Promise.all([
      api.getItems(), api.getPurchases(), api.getSales(), api.getStock()
    ])
    purchases.value = purchaseList || []
    sales.value = saleList || []
    stats.itemCount = (items || []).length

    const stockObj = stock && !Array.isArray(stock) ? stock : {}
    const cm = {}
    for (const info of Object.values(stockObj)) {
      stats.stockValue += (info.qty || 0) * (info.cost || 0)
    }
    ;(items || []).forEach(i => { cm[i.code] = Number(i.cost || 0) })
    for (const [code, v] of Object.entries(stockObj)) cm[code] = Number(v.cost || 0)
    costMap.value = cm

    const warnMap = {}
    ;(items || []).forEach(i => { warnMap[i.code] = i.warning || 0 })
    lowStock.value = Object.entries(stockObj)
      .filter(([, v]) => (v.qty || 0) <= (warnMap[v.code] || 0))
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
.filter-label { color: #606266; font-size: 14px; }
.filter-sep { color: #909399; }
.search-input { margin: 8px 0 12px; max-width: 360px; }
</style>
