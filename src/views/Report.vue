<template>
  <div>
    <!-- 全局筛选：时间段对上下两个分区同时生效；选择会记住，刷新页面后保留 -->
    <el-card>
      <template #header>
        <div class="card-header">
          <b>统计报表</b>
          <el-button v-if="dateStart || dateEnd" text type="primary" @click="dateStart=''; dateEnd=''">清除时间段</el-button>
        </div>
      </template>
      <div class="filter-row">
        <span class="filter-label">时间段</span>
        <el-date-picker v-model="dateStart" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" style="width:150px" />
        <span class="filter-sep">至</span>
        <el-date-picker v-model="dateEnd" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" style="width:150px" />
        <el-tag v-if="dateStart || dateEnd" type="info" effect="plain" size="small">{{ dateStart || '不限' }} ~ {{ dateEnd || '不限' }}</el-tag>
        <span class="filter-hint">时间段对下方采购、销售两个分区同时生效 · 筛选条件自动记住，刷新后保留</span>
      </div>
    </el-card>

    <!-- 采购与应付款：供应商筛选只作用于本分区 -->
    <el-card class="section-card">
      <template #header>
        <div class="card-header">
          <b>采购与应付款</b>
          <span class="section-sub">供应商：{{ supplierFilter || '全部' }}<template v-if="dateStart || dateEnd"> · {{ dateStart || '不限' }} ~ {{ dateEnd || '不限' }}</template></span>
        </div>
      </template>
      <div class="filter-row">
        <span class="filter-label">供应商</span>
        <el-select v-model="supplierFilter" clearable filterable placeholder="全部供应商" style="width:260px">
          <el-option v-for="s in supplierOptions" :key="s" :label="s" :value="s" />
        </el-select>
        <span class="filter-hint">只影响本分区、月度趋势及下方商品采购汇总</span>
      </div>
      <div class="stat-grid">
        <div class="stat-item">
          <el-statistic title="采购总额" :value="stats.purchaseTotal" :precision="2" prefix="¥" />
          <div class="stat-sub">{{ filteredPurchases.length }} 单</div>
        </div>
        <div class="stat-item">
          <el-statistic title="累计实付" :value="stats.purchasePaid" :precision="2" prefix="¥" />
          <div class="stat-sub">{{ stats.purchasePayCount }} 笔付款流水</div>
        </div>
        <div class="stat-item">
          <el-statistic title="应付款（未付合计）" :value="stats.payable" :precision="2" prefix="¥" value-style="color:#f56c6c" />
          <div class="stat-sub">共 {{ stats.payableCount }} 单 · 未付清 {{ stats.payableOpen }} 单</div>
        </div>
      </div>
      <!-- 迷你趋势条：按月采购金额，随本分区筛选联动 -->
      <div class="trend-block">
        <div class="trend-head">
          <span class="trend-title">月度采购趋势</span>
          <span class="trend-caption">{{ trendMonths[0] }} ~ {{ trendMonths[trendMonths.length - 1] }} · 合计 ¥{{ purchaseTrendTotal }}</span>
        </div>
        <div class="trend-bars">
          <div
            v-for="b in purchaseTrend"
            :key="b.month"
            class="trend-bar"
            :class="{ 'is-zero': b.amount <= 0 }"
            :style="b.amount > 0 ? { height: Math.max(6, b.pct) + '%' } : {}"
            :title="`${b.month} 采购 ¥${b.amount.toFixed(2)}`"
          />
        </div>
        <div class="trend-labels">
          <span v-for="b in purchaseTrend" :key="b.month">{{ b.month.slice(5) }}月</span>
        </div>
      </div>
    </el-card>

    <!-- 销售与应收款：客户筛选只作用于本分区 -->
    <el-card class="section-card">
      <template #header>
        <div class="card-header">
          <b>销售与应收款</b>
          <span class="section-sub">客户：{{ customerFilter || '全部' }}<template v-if="dateStart || dateEnd"> · {{ dateStart || '不限' }} ~ {{ dateEnd || '不限' }}</template></span>
        </div>
      </template>
      <div class="filter-row">
        <span class="filter-label">客户</span>
        <el-select v-model="customerFilter" clearable filterable placeholder="全部客户" style="width:260px">
          <el-option v-for="c in customerOptions" :key="c" :label="c" :value="c" />
        </el-select>
        <span class="filter-hint">只影响本分区、月度趋势及下方商品销售汇总</span>
      </div>
      <div class="stat-grid">
        <div class="stat-item">
          <el-statistic title="销售总额" :value="stats.saleTotal" :precision="2" prefix="¥" />
          <div class="stat-sub">{{ filteredSales.length }} 单</div>
        </div>
        <div class="stat-item">
          <el-statistic title="毛利" :value="stats.profit" :precision="2" prefix="¥" />
          <div class="stat-sub">销售总额 − 销售成本</div>
        </div>
        <div class="stat-item">
          <el-statistic title="应收款（未收合计）" :value="stats.receivable" :precision="2" prefix="¥" value-style="color:#f56c6c" />
          <div class="stat-sub">共 {{ stats.receivableCount }} 单 · 未收清 {{ stats.receivableOpen }} 单</div>
        </div>
      </div>
      <!-- 迷你趋势条：按月销售金额，随本分区筛选联动 -->
      <div class="trend-block">
        <div class="trend-head">
          <span class="trend-title">月度销售趋势</span>
          <span class="trend-caption">{{ trendMonths[0] }} ~ {{ trendMonths[trendMonths.length - 1] }} · 合计 ¥{{ saleTrendTotal }}</span>
        </div>
        <div class="trend-bars">
          <div
            v-for="b in saleTrend"
            :key="b.month"
            class="trend-bar sale"
            :class="{ 'is-zero': b.amount <= 0 }"
            :style="b.amount > 0 ? { height: Math.max(6, b.pct) + '%' } : {}"
            :title="`${b.month} 销售 ¥${b.amount.toFixed(2)}`"
          />
        </div>
        <div class="trend-labels">
          <span v-for="b in saleTrend" :key="b.month">{{ b.month.slice(5) }}月</span>
        </div>
      </div>
    </el-card>

    <!-- 按商品销售汇总：随客户 + 时间段 + 关键词联动 -->
    <el-card class="section-card">
      <template #header>
        <div class="card-header">
          <b>按商品销售汇总</b>
          <span class="section-sub">随「客户 + 时间段」筛选联动</span>
        </div>
      </template>
      <el-input v-model="keyword" clearable placeholder="搜索商品名称" class="search-input" />
      <div class="table-wrap">
      <el-table :data="filteredSalesByItem" stripe style="margin-top:8px" show-summary :summary-method="itemSummary">
        <el-table-column prop="name" label="商品" />
        <el-table-column prop="qty" label="销量" width="100" />
        <el-table-column prop="amount" label="金额" width="140">
          <template #default="{ row }">{{ Number(row.amount || 0).toFixed(2) }}</template>
        </el-table-column>
      </el-table>
      </div>
      <el-empty v-if="!filteredSalesByItem.length" description="暂无销售数据" />
    </el-card>

    <!-- 按商品采购汇总：随供应商 + 时间段 + 关键词联动，按进价口径看采购维度 -->
    <el-card class="section-card">
      <template #header>
        <div class="card-header">
          <b>按商品采购汇总</b>
          <span class="section-sub">随「供应商 + 时间段」筛选联动</span>
        </div>
      </template>
      <el-input v-model="purchaseKeyword" clearable placeholder="搜索商品名称" class="search-input" />
      <div class="table-wrap">
      <el-table :data="filteredPurchasesByItem" stripe style="margin-top:8px" show-summary :summary-method="purchaseItemSummary">
        <el-table-column prop="name" label="商品" />
        <el-table-column prop="orders" label="采购单数" width="110" />
        <el-table-column prop="qty" label="采购数量" width="110" />
        <el-table-column prop="avgPrice" label="平均进价" width="120">
          <template #default="{ row }">{{ row.qty > 0 ? (row.amount / row.qty).toFixed(2) : '—' }}</template>
        </el-table-column>
        <el-table-column prop="amount" label="采购金额" width="140">
          <template #default="{ row }">{{ Number(row.amount || 0).toFixed(2) }}</template>
        </el-table-column>
      </el-table>
      </div>
      <el-empty v-if="!filteredPurchasesByItem.length" description="暂无采购数据" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { api } from '../api'
import { matchText } from '../utils/search'
import { receivableOf, payableOf, ensurePayments } from '../utils/account'

const purchases = ref([])
const sales = ref([])
const stock = ref({})
const keyword = ref('')
const purchaseKeyword = ref('')
const dateStart = ref('')
const dateEnd = ref('')
const supplierFilter = ref('')
const customerFilter = ref('')

// ---------- 筛选条件本地记忆：刷新页面后恢复上次选择 ----------
const FILTERS_KEY = 'report-filters-v1'
function saveFilters() {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({
      dateStart: dateStart.value, dateEnd: dateEnd.value,
      supplierFilter: supplierFilter.value, customerFilter: customerFilter.value,
      keyword: keyword.value, purchaseKeyword: purchaseKeyword.value
    }))
  } catch (e) { /* 隐私模式等场景下忽略 */ }
}
function restoreFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || 'null')
    if (!saved || typeof saved !== 'object') return
    dateStart.value = saved.dateStart || ''
    dateEnd.value = saved.dateEnd || ''
    supplierFilter.value = saved.supplierFilter || ''
    customerFilter.value = saved.customerFilter || ''
    keyword.value = saved.keyword || ''
    purchaseKeyword.value = saved.purchaseKeyword || ''
  } catch (e) { /* 数据损坏时按默认空筛选 */ }
}
watch([dateStart, dateEnd, supplierFilter, customerFilter, keyword, purchaseKeyword], saveFilters)

// 筛选口径：时间段对采购/销售同时生效；供应商只影响采购与应付款，客户只影响销售与应收款
const filteredPurchases = computed(() => (purchases.value || []).filter(p => {
  if (dateStart.value && (p.date || '') < dateStart.value) return false
  if (dateEnd.value && (p.date || '') > dateEnd.value) return false
  if (supplierFilter.value && p.supplier !== supplierFilter.value) return false
  return true
}))
const filteredSales = computed(() => (sales.value || []).filter(s => {
  if (dateStart.value && (s.date || '') < dateStart.value) return false
  if (dateEnd.value && (s.date || '') > dateEnd.value) return false
  if (customerFilter.value && s.customer !== customerFilter.value) return false
  return true
}))

// 下拉选项取自全部单据中出现过的往来单位
const supplierOptions = computed(() => [...new Set((purchases.value || []).map(p => p.supplier).filter(Boolean))])
const customerOptions = computed(() => [...new Set((sales.value || []).map(s => s.customer).filter(Boolean))])

const stats = reactive({
  purchaseTotal: 0, purchasePaid: 0, purchasePayCount: 0,
  saleTotal: 0, profit: 0,
  payable: 0, payableCount: 0, payableOpen: 0,
  receivable: 0, receivableCount: 0, receivableOpen: 0
})

// 所有指标随筛选实时重算（watch 监听筛选后的计算结果）
function recompute() {
  const pList = filteredPurchases.value
  const sList = filteredSales.value
  stats.purchaseTotal = pList.reduce((s, p) => s + Number(p.total || 0), 0)
  stats.saleTotal = sList.reduce((s, p) => s + Number(s.total || 0), 0)

  const stockObj = stock.value && !Array.isArray(stock.value) ? stock.value : {}
  const costMap = {}
  for (const [code, v] of Object.entries(stockObj)) costMap[code] = v.cost || 0
  const totalCost = sList.reduce((sum, s) =>
    sum + (s.items || []).reduce((c, i) => c + i.qty * (costMap[i.code] || 0), 0), 0)
  stats.profit = stats.saleTotal - totalCost

  // 采购：累计实付与流水笔数（付款流水）
  stats.purchasePaid = pList.reduce((s, p) => s + ensurePayments(p, 'paid').reduce((t, x) => t + Number(x.amount || 0), 0), 0)
  stats.purchasePayCount = pList.reduce((s, p) => s + ensurePayments(p, 'paid').length, 0)

  // 应收/应付：按金额规则（与 src/utils/account.js 一致），欠款与结算状态解耦
  stats.payable = pList.reduce((sum, p) => sum + payableOf(p), 0)
  stats.payableCount = pList.length
  stats.payableOpen = pList.filter(p => payableOf(p) > 0).length
  stats.receivable = sList.reduce((sum, s) => sum + receivableOf(s), 0)
  stats.receivableCount = sList.length
  stats.receivableOpen = sList.filter(s => receivableOf(s) > 0).length
}
watch([filteredPurchases, filteredSales, stock], recompute, { immediate: true })

// ---------- 迷你趋势条：按月聚合，尊重时间段范围 ----------
function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String(total % 12 + 1).padStart(2, '0')}`
}
function monthRange(startKey, endKey) {
  const out = []
  let cur = startKey
  let guard = 0
  while (cur <= endKey && guard++ < 120) { out.push(cur); cur = shiftMonth(cur, 1) }
  return out
}
// 月份范围：选了时间段就按头尾月；未选时默认近 12 个月
const trendMonths = computed(() => {
  const now = new Date()
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  let start = dateStart.value ? dateStart.value.slice(0, 7) : shiftMonth(cur, -11)
  let end = dateEnd.value ? dateEnd.value.slice(0, 7) : cur
  if (start > end) [start, end] = [end, start]
  return monthRange(start, end)
})
function buildTrend(list) {
  const map = {}
  for (const row of list) {
    const k = (row.date || '').slice(0, 7)
    if (!k) continue
    map[k] = (map[k] || 0) + Number(row.total || 0)
  }
  const max = Object.values(map).reduce((a, b) => Math.max(a, b), 0)
  return trendMonths.value.map(m => {
    const amount = map[m] || 0
    return { month: m, amount, pct: max > 0 ? amount / max * 100 : 0 }
  })
}
const purchaseTrend = computed(() => buildTrend(filteredPurchases.value))
const saleTrend = computed(() => buildTrend(filteredSales.value))
const purchaseTrendTotal = computed(() => purchaseTrend.value.reduce((s, b) => s + b.amount, 0).toFixed(2))
const saleTrendTotal = computed(() => saleTrend.value.reduce((s, b) => s + b.amount, 0).toFixed(2))

// ---------- 按商品销售汇总（原逻辑保留） ----------
const salesByItem = computed(() => {
  const agg = {}
  for (const s of filteredSales.value) {
    for (const i of (s.items || [])) {
      if (!agg[i.name]) agg[i.name] = { name: i.name, qty: 0, amount: 0 }
      agg[i.name].qty += Number(i.qty || 0)
      agg[i.name].amount += Number(i.total || 0)
    }
  }
  return Object.values(agg).sort((a, b) => b.amount - a.amount)
})
const filteredSalesByItem = computed(() => salesByItem.value.filter(i => matchText(keyword.value, i.name)))

// ---------- 按商品采购汇总：进价维度（采购单数/数量/金额） ----------
const purchasesByItem = computed(() => {
  const agg = {}
  for (const p of filteredPurchases.value) {
    const seen = new Set()
    for (const i of (p.items || [])) {
      if (!agg[i.name]) agg[i.name] = { name: i.name, orders: 0, qty: 0, amount: 0 }
      const g = agg[i.name]
      if (!seen.has(i.name)) { g.orders += 1; seen.add(i.name) }
      g.qty += Number(i.qty || 0)
      g.amount += Number(i.total || 0)
    }
  }
  return Object.values(agg).sort((a, b) => b.amount - a.amount)
})
const filteredPurchasesByItem = computed(() => purchasesByItem.value.filter(i => matchText(purchaseKeyword.value, i.name)))

// 表格底部合计：基于全部筛选结果
const itemSummary = ({ columns, data }) => {
  const qty = (data || []).reduce((s, r) => s + Number(r.qty || 0), 0)
  const amount = (data || []).reduce((s, r) => s + Number(r.amount || 0), 0)
  return columns.map((c, idx) => {
    if (idx === 0) return '合计'
    if (c.property === 'qty') return qty
    if (c.property === 'amount') return amount.toFixed(2)
    return ''
  })
}
const purchaseItemSummary = ({ columns, data }) => {
  const orders = (data || []).reduce((s, r) => s + Number(r.orders || 0), 0)
  const qty = (data || []).reduce((s, r) => s + Number(r.qty || 0), 0)
  const amount = (data || []).reduce((s, r) => s + Number(r.amount || 0), 0)
  return columns.map((c, idx) => {
    if (idx === 0) return '合计'
    if (c.property === 'orders') return orders
    if (c.property === 'qty') return qty
    if (c.property === 'avgPrice') return qty > 0 ? (amount / qty).toFixed(2) : '—'
    if (c.property === 'amount') return amount.toFixed(2)
    return ''
  })
}

onMounted(async () => {
  // 先恢复上次筛选，再加载数据，保证刷新后筛选与数据同时就位
  restoreFilters()
  try {
    const [p, s, st] = await Promise.all([api.getPurchases(), api.getSales(), api.getStock()])
    purchases.value = p || []
    sales.value = s || []
    stock.value = st || {}
  } catch (e) {
    purchases.value = []
    sales.value = []
    stock.value = {}
  }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.section-card { margin-top: 16px; }
.section-sub { color: #909399; font-size: 12px; font-weight: 400; }
.filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.filter-label { color: #606266; font-size: 14px; }
.filter-sep { color: #909399; }
.filter-hint { color: #c0c4cc; font-size: 12px; }
.search-input { margin: 8px 0 12px; max-width: 360px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
.stat-item { padding: 12px 16px; background: #f8f9fb; border-radius: 8px; min-width: 0; }
.stat-item .el-statistic__head,
.stat-item .el-statistic__content { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-sub { margin-top: 4px; color: #909399; font-size: 12px; }
/* 迷你趋势条：纯 CSS 柱状图，随分区筛选联动 */
.trend-block { margin-top: 12px; border-top: 1px dashed #ebeef5; padding-top: 10px; }
.trend-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.trend-title { font-size: 13px; color: #606266; font-weight: 600; }
.trend-caption { font-size: 12px; color: #909399; }
.trend-bars { display: flex; align-items: flex-end; gap: 3px; height: 64px; }
.trend-bar { flex: 1; min-width: 0; border-radius: 2px 2px 0 0; background: #e6a23c; transition: height .2s; }
.trend-bar.sale { background: #409eff; }
.trend-bar.is-zero { height: 2px; background: #ebeef5; }
.trend-labels { display: flex; gap: 3px; margin-top: 4px; }
.trend-labels span { flex: 1; min-width: 0; text-align: center; font-size: 10px; color: #c0c4cc; white-space: nowrap; overflow: hidden; }
</style>
