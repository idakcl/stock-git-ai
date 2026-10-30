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
    <el-card>
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
          <el-statistic title="应付款（未付合计）" :value="stats.payable" :precision="2" prefix="¥" value-style="color:var(--color-danger)" />
          <div class="stat-sub">共 {{ stats.payableCount }} 单 · 未付清 {{ stats.payableOpen }} 单</div>
        </div>
      </div>
      <!-- 月度趋势条：按月采购金额，随本分区筛选联动；点击柱子显示当月数额 -->
      <div class="trend-block">
        <div class="trend-head">
          <span class="trend-title">月度采购趋势</span>
          <span class="trend-caption">
            <template v-if="purchaseSelected">
              {{ purchaseSelected.month }} 采购 <b class="trend-strong">¥{{ fmtAmt(purchaseSelected.amount) }}</b> · {{ purchaseSelected.orders }} 单
              <el-button text type="primary" size="small" @click="purchaseSelectedMonth = ''">取消</el-button>
            </template>
            <template v-else>
              {{ trendMonths[0] }} ~ {{ trendMonths[trendMonths.length - 1] }} · 合计 ¥{{ purchaseTrendTotal }} · 点击柱子查看当月数额
            </template>
          </span>
        </div>
        <div class="trend-bars">
          <div
            v-for="b in purchaseTrend"
            :key="b.month"
            class="trend-col"
            :class="{ active: purchaseSelectedMonth === b.month }"
            :title="`${b.month} 采购 ¥${fmtAmt(b.amount)} · ${b.orders} 单`"
            @click="togglePurchaseMonth(b.month)"
          >
            <span v-if="purchaseSelectedMonth === b.month" class="trend-val" :style="trendValStyle(b, 'purchase')">¥{{ fmtAmt(b.amount) }}</span>
            <div class="trend-bar" :class="{ 'is-zero': b.amount <= 0 }" :style="b.amount > 0 ? { height: Math.max(6, b.pct) + '%' } : {}" />
          </div>
        </div>
        <div class="trend-labels">
          <span v-for="b in purchaseTrend" :key="b.month" :class="{ active: purchaseSelectedMonth === b.month }">{{ b.month.slice(5) }}月</span>
        </div>
      </div>
    </el-card>

    <!-- 销售与应收款：客户筛选只作用于本分区 -->
    <el-card>
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
          <el-statistic title="应收款（未收合计）" :value="stats.receivable" :precision="2" prefix="¥" value-style="color:var(--color-danger)" />
          <div class="stat-sub">共 {{ stats.receivableCount }} 单 · 未收清 {{ stats.receivableOpen }} 单</div>
        </div>
      </div>
      <!-- 月度趋势条：按月销售金额，随本分区筛选联动；点击柱子显示当月数额 -->
      <div class="trend-block">
        <div class="trend-head">
          <span class="trend-title">月度销售趋势</span>
          <span class="trend-caption">
            <template v-if="saleSelected">
              {{ saleSelected.month }} 销售 <b class="trend-strong">¥{{ fmtAmt(saleSelected.amount) }}</b> · {{ saleSelected.orders }} 单
              <el-button text type="primary" size="small" @click="saleSelectedMonth = ''">取消</el-button>
            </template>
            <template v-else>
              {{ trendMonths[0] }} ~ {{ trendMonths[trendMonths.length - 1] }} · 合计 ¥{{ saleTrendTotal }} · 点击柱子查看当月数额
            </template>
          </span>
        </div>
        <div class="trend-bars">
          <div
            v-for="b in saleTrend"
            :key="b.month"
            class="trend-col"
            :class="{ active: saleSelectedMonth === b.month }"
            :title="`${b.month} 销售 ¥${fmtAmt(b.amount)} · ${b.orders} 单`"
            @click="toggleSaleMonth(b.month)"
          >
            <span v-if="saleSelectedMonth === b.month" class="trend-val" :style="trendValStyle(b, 'sale')">¥{{ fmtAmt(b.amount) }}</span>
            <div class="trend-bar sale" :class="{ 'is-zero': b.amount <= 0 }" :style="b.amount > 0 ? { height: Math.max(6, b.pct) + '%' } : {}" />
          </div>
        </div>
        <div class="trend-labels">
          <span v-for="b in saleTrend" :key="b.month" :class="{ active: saleSelectedMonth === b.month }">{{ b.month.slice(5) }}月</span>
        </div>
      </div>
    </el-card>

    <!-- 按商品销售汇总：随客户 + 时间段 + 关键词联动 -->
    <el-card>
      <template #header>
        <div class="card-header">
          <b>按商品销售汇总</b>
          <span class="section-sub">随「客户 + 时间段」筛选联动</span>
        </div>
      </template>
      <div class="tool-row">
        <el-input v-model="keyword" clearable placeholder="搜索商品名称 / 编码" class="search-input" />
        <div class="sort-group">
          <span class="filter-label">排序</span>
          <el-radio-group v-model="saleSort" size="small">
            <el-radio-button label="amount">按金额</el-radio-button>
            <el-radio-button label="time">按时间</el-radio-button>
          </el-radio-group>
        </div>
        <TableToolbar
          filename="按商品销售汇总"
          title="按商品销售汇总"
          :subtitle="saleSubtitle"
          :columns="saleExportColumns"
          :rows="sortedSalesByItem"
        />
      </div>
      <div class="pager-info">共 {{ filteredSalesByItem.length }} 项 · 当前按{{ saleSort === 'time' ? '最近销售时间' : '金额' }}排序{{ saleAll ? '（当前展示全部）' : ` · 第 ${salePage}/${salePageCount} 页，每页 ${saleSize} 条` }}</div>
      <div class="table-wrap" ref="saleWrap">
      <el-table-v2
        v-if="saleWidth"
        :columns="saleColumns"
        :data="pagedSalesByItem"
        :width="saleWidth"
        :height="saleHeight"
        :row-height="36"
        fixed
        class="v2-table"
      >
        <template #footer>
          <div class="v2-footer">
            <span class="f-flex">合计（全部 {{ filteredSalesByItem.length }} 项）</span>
            <span class="f-num" style="width:100px">{{ saleFoot.qty }}</span>
            <span class="f-num" style="width:140px">{{ saleFoot.amount }}</span>
            <span class="f-num" style="width:120px"></span>
          </div>
        </template>
      </el-table-v2>
      </div>
      <div class="pager-row">
        <div class="pager-nav">
          <el-button size="default" :disabled="salePage <= 1 || saleAll" @click="salePage--">‹ 上一页</el-button>
          <span class="pager-pos">{{ saleAll ? `全部 ${filteredSalesByItem.length} 项` : `第 ${salePage} / ${salePageCount} 页` }}</span>
          <el-button size="default" :disabled="salePage >= salePageCount || saleAll" @click="salePage++">下一页 ›</el-button>
          <el-select v-model="saleSize" size="default" class="size-select">
            <el-option :value="60" label="60 条/页" />
            <el-option :value="100" label="100 条/页" />
            <el-option :value="200" label="200 条/页" />
          </el-select>
          <el-button text type="primary" @click="saleAll = !saleAll">
            {{ saleAll ? '恢复分页' : '显示全部' }}
          </el-button>
        </div>
      </div>
      <el-empty v-if="!filteredSalesByItem.length" description="暂无销售数据" />
    </el-card>

    <!-- 按商品采购汇总：随供应商 + 时间段 + 关键词联动，按进价口径看采购维度 -->
    <el-card>
      <template #header>
        <div class="card-header">
          <b>按商品采购汇总</b>
          <span class="section-sub">随「供应商 + 时间段」筛选联动</span>
        </div>
      </template>
      <div class="tool-row">
        <el-input v-model="purchaseKeyword" clearable placeholder="搜索商品名称 / 编码" class="search-input" />
        <div class="sort-group">
          <span class="filter-label">排序</span>
          <el-radio-group v-model="purchaseSort" size="small">
            <el-radio-button label="amount">按金额</el-radio-button>
            <el-radio-button label="time">按时间</el-radio-button>
          </el-radio-group>
        </div>
        <TableToolbar
          filename="按商品采购汇总"
          title="按商品采购汇总"
          :subtitle="purchaseSubtitle"
          :columns="purchaseExportColumns"
          :rows="sortedPurchasesByItem"
        />
      </div>
      <div class="pager-info">共 {{ filteredPurchasesByItem.length }} 项 · 当前按{{ purchaseSort === 'time' ? '最近采购时间' : '金额' }}排序{{ purchaseAll ? '（当前展示全部）' : ` · 第 ${purchasePage}/${purchasePageCount} 页，每页 ${purchaseSize} 条` }}</div>
      <div class="table-wrap" ref="purchaseWrap">
      <!-- 虚拟滚动表格：只渲染可视区域的行，1228 行也保持流畅 -->
      <el-table-v2
        v-if="purchaseWidth"
        :columns="purchaseColumns"
        :data="pagedPurchasesByItem"
        :width="purchaseWidth"
        :height="purchaseHeight"
        :row-height="36"
        fixed
        class="v2-table"
      >
        <template #footer>
          <div class="v2-footer">
            <span class="f-flex">合计（全部 {{ filteredPurchasesByItem.length }} 项）</span>
            <span class="f-num" style="width:100px">{{ purchaseFoot.orders }}</span>
            <span class="f-num" style="width:100px">{{ purchaseFoot.qty }}</span>
            <span class="f-num" style="width:110px">{{ purchaseFoot.avg }}</span>
            <span class="f-num strong" style="width:130px">{{ purchaseFoot.amount }}</span>
            <span class="f-num" style="width:120px"></span>
          </div>
        </template>
      </el-table-v2>
      </div>
      <div class="pager-row">
        <div class="pager-nav">
          <el-button size="default" :disabled="purchasePage <= 1 || purchaseAll" @click="purchasePage--">‹ 上一页</el-button>
          <span class="pager-pos">{{ purchaseAll ? `全部 ${filteredPurchasesByItem.length} 项` : `第 ${purchasePage} / ${purchasePageCount} 页` }}</span>
          <el-button size="default" :disabled="purchasePage >= purchasePageCount || purchaseAll" @click="purchasePage++">下一页 ›</el-button>
          <el-select v-model="purchaseSize" size="default" class="size-select">
            <el-option :value="60" label="60 条/页" />
            <el-option :value="100" label="100 条/页" />
            <el-option :value="200" label="200 条/页" />
          </el-select>
          <el-button text type="primary" @click="purchaseAll = !purchaseAll">
            {{ purchaseAll ? '恢复分页' : '显示全部' }}
          </el-button>
        </div>
      </div>
      <el-empty v-if="!filteredPurchasesByItem.length" description="暂无采购数据" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, h } from 'vue'
import { api } from '../api'
import { matchText } from '../utils/search'
import { aggregateByItem } from '../utils/catalog'
import { receivableOf, payableOf, ensurePayments, isVoided } from '../utils/account'
import TableToolbar from '../components/TableToolbar.vue'

const purchases = ref([])
const sales = ref([])
const stock = ref({})
const items = ref([])
const keyword = ref('')
const purchaseKeyword = ref('')
const dateStart = ref('')
const dateEnd = ref('')
const supplierFilter = ref('')
const customerFilter = ref('')

// ---------- 汇总表分页：商品上千条时一次性渲染会明显卡顿，默认每页 60 条 ----------
const salePage = ref(1)
const saleSize = ref(60)
const saleAll = ref(false)
const purchasePage = ref(1)
const purchaseSize = ref(60)
const purchaseAll = ref(false)

// ---------- 汇总表排序：按金额（默认）/ 按时间（最近一次交易日期，新的在前） ----------
const saleSort = ref('amount')
const purchaseSort = ref('amount')
watch(saleSort, () => { salePage.value = 1 })
watch(purchaseSort, () => { purchasePage.value = 1 })

// ---------- 趋势图选中月份：点击柱子显示当月数额，再点一次取消 ----------
const purchaseSelectedMonth = ref('')
const saleSelectedMonth = ref('')
const togglePurchaseMonth = (m) => { purchaseSelectedMonth.value = purchaseSelectedMonth.value === m ? '' : m }
const toggleSaleMonth = (m) => { saleSelectedMonth.value = saleSelectedMonth.value === m ? '' : m }

// ---------- 搜索防抖：避免每敲一个字都对上千行重算过滤 ----------
const debouncedKeyword = ref('')
const debouncedPurchaseKeyword = ref('')
let kTimer = null, pkTimer = null
watch(keyword, v => { clearTimeout(kTimer); kTimer = setTimeout(() => { debouncedKeyword.value = v; salePage.value = 1 }, 300) }, { immediate: true })
watch(purchaseKeyword, v => { clearTimeout(pkTimer); pkTimer = setTimeout(() => { debouncedPurchaseKeyword.value = v; purchasePage.value = 1 }, 300) }, { immediate: true })

// ---------- 筛选条件本地记忆：刷新页面后恢复上次选择 ----------
const FILTERS_KEY = 'report-filters-v1'
function saveFilters() {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({
      dateStart: dateStart.value, dateEnd: dateEnd.value,
      supplierFilter: supplierFilter.value, customerFilter: customerFilter.value,
      keyword: keyword.value, purchaseKeyword: purchaseKeyword.value,
      saleSort: saleSort.value, purchaseSort: purchaseSort.value
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
    saleSort.value = saved.saleSort === 'time' ? 'time' : 'amount'
    purchaseSort.value = saved.purchaseSort === 'time' ? 'time' : 'amount'
  } catch (e) { /* 数据损坏时按默认空筛选 */ }
}
watch([dateStart, dateEnd, supplierFilter, customerFilter, keyword, purchaseKeyword, saleSort, purchaseSort], saveFilters)

// 筛选口径：时间段对采购/销售同时生效；供应商只影响采购与应付款，客户只影响销售与应收款
const filteredPurchases = computed(() => (purchases.value || []).filter(p => {
  if (isVoided(p)) return false
  if (dateStart.value && (p.date || '') < dateStart.value) return false
  if (dateEnd.value && (p.date || '') > dateEnd.value) return false
  if (supplierFilter.value && p.supplier !== supplierFilter.value) return false
  return true
}))
const filteredSales = computed(() => (sales.value || []).filter(s => {
  if (isVoided(s)) return false
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

// 金额统一两位小数，并把 -0 归一化为 0：浮点尘（如 40.29-40.29=-1.4e-14）经 toFixed(2) 会渲染成 "-0.00"
const money = (n) => {
  const v = Math.round((Number(n) + Number.EPSILON) * 100) / 100
  return v === 0 ? 0 : v
}
// 千分位金额（趋势图标签与标题栏明细用）
const fmtAmt = (n) => Number(money(n)).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// 所有指标随筛选实时重算（watch 监听筛选后的计算结果）
function recompute() {
  const pList = filteredPurchases.value
  const sList = filteredSales.value
  stats.purchaseTotal = money(pList.reduce((s, p) => s + Number(p.total || 0), 0))
  stats.saleTotal = money(sList.reduce((sum, s) => sum + Number(s.total || 0), 0))

  const stockObj = stock.value && !Array.isArray(stock.value) ? stock.value : {}
  const costMap = {}
  for (const [code, v] of Object.entries(stockObj)) costMap[code] = v.cost || 0
  const totalCost = sList.reduce((sum, s) =>
    sum + (s.items || []).reduce((c, i) => c + i.qty * (costMap[i.code] || 0), 0), 0)
  stats.profit = money(stats.saleTotal - totalCost)

  // 采购：累计实付与流水笔数（付款流水）
  stats.purchasePaid = money(pList.reduce((s, p) => s + ensurePayments(p, 'paid').reduce((t, x) => t + Number(x.amount || 0), 0), 0))
  stats.purchasePayCount = pList.reduce((s, p) => s + ensurePayments(p, 'paid').length, 0)

  // 应收/应付：按金额规则（与 src/utils/account.js 一致），欠款与结算状态解耦
  stats.payable = money(pList.reduce((sum, p) => sum + payableOf(p), 0))
  stats.payableCount = pList.length
  stats.payableOpen = pList.filter(p => payableOf(p) > 0).length
  stats.receivable = money(sList.reduce((sum, s) => sum + receivableOf(s), 0))
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
  const map = {}, orderMap = {}
  for (const row of list) {
    const k = (row.date || '').slice(0, 7)
    if (!k) continue
    map[k] = (map[k] || 0) + Number(row.total || 0)
    orderMap[k] = (orderMap[k] || 0) + 1
  }
  const max = Object.values(map).reduce((a, b) => Math.max(a, b), 0)
  return trendMonths.value.map(m => {
    const amount = map[m] || 0
    return { month: m, amount, orders: orderMap[m] || 0, pct: max > 0 ? amount / max * 100 : 0 }
  })
}
const purchaseTrend = computed(() => buildTrend(filteredPurchases.value))
const saleTrend = computed(() => buildTrend(filteredSales.value))
const purchaseTrendTotal = computed(() => purchaseTrend.value.reduce((s, b) => s + b.amount, 0).toFixed(2))
const saleTrendTotal = computed(() => saleTrend.value.reduce((s, b) => s + b.amount, 0).toFixed(2))

// 选中月份明细：筛选变化导致该月不在趋势范围时自动失效（返回 null，标题栏回退为合计）
const purchaseSelected = computed(() => {
  if (!purchaseSelectedMonth.value) return null
  return purchaseTrend.value.find(b => b.month === purchaseSelectedMonth.value) || null
})
const saleSelected = computed(() => {
  if (!saleSelectedMonth.value) return null
  return saleTrend.value.find(b => b.month === saleSelectedMonth.value) || null
})
// 数额浮动标签：贴在柱子上方（矮柱）或柱内顶部（高柱，白字）；无金额的月份贴在图元底部
const trendValStyle = (b, type) => {
  const color = type === 'sale' ? '#409eff' : '#e6a23c'
  if (b.amount <= 0) return { bottom: '6px', color }
  if (b.pct >= 80) return { bottom: `calc(${b.pct}% - 18px)`, color: '#fff', background: 'transparent' }
  return { bottom: `calc(${Math.max(6, b.pct)}% + 4px)`, color }
}

// ---------- 按商品销售汇总（按编码分组，显示商品主数据当前名，改名不裂行） ----------
const salesByItem = computed(() => aggregateByItem(filteredSales.value, items.value))
const filteredSalesByItem = computed(() => salesByItem.value.filter(i => matchText(debouncedKeyword.value, i.name, i.code)))
// 排序：默认金额降序（aggregateByItem 已排好）；按时间时取最近销售日期降序，同日期按金额兜底
const sortedSalesByItem = computed(() => saleSort.value === 'time'
  ? [...filteredSalesByItem.value].sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || '') || b.amount - a.amount)
  : filteredSalesByItem.value)

// ---------- 按商品采购汇总：进价维度（采购单数/数量/金额，按编码分组） ----------
const purchasesByItem = computed(() => aggregateByItem(filteredPurchases.value, items.value, { withOrders: true }))
const filteredPurchasesByItem = computed(() => purchasesByItem.value.filter(i => matchText(debouncedPurchaseKeyword.value, i.name, i.code)))
// 排序：默认金额降序；按时间时取最近采购日期降序，同日期按金额兜底
const sortedPurchasesByItem = computed(() => purchaseSort.value === 'time'
  ? [...filteredPurchasesByItem.value].sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || '') || b.amount - a.amount)
  : filteredPurchasesByItem.value)

// ---------- 分页切片（合计行仍基于全部筛选结果，不受分页影响） ----------
const pagedSalesByItem = computed(() => saleAll.value
  ? sortedSalesByItem.value
  : sortedSalesByItem.value.slice((salePage.value - 1) * saleSize.value, salePage.value * saleSize.value))
const salePageCount = computed(() => Math.max(1, Math.ceil(filteredSalesByItem.value.length / saleSize.value)))
const pagedPurchasesByItem = computed(() => purchaseAll.value
  ? sortedPurchasesByItem.value
  : sortedPurchasesByItem.value.slice((purchasePage.value - 1) * purchaseSize.value, purchasePage.value * purchaseSize.value))
const purchasePageCount = computed(() => Math.max(1, Math.ceil(filteredPurchasesByItem.value.length / purchaseSize.value)))
// 筛选条件或每页条数变化时回到第一页，避免停在空白页
watch([filteredSalesByItem, filteredPurchasesByItem], () => { salePage.value = 1; purchasePage.value = 1 })
watch([saleSize, purchaseSize], () => { salePage.value = 1; purchasePage.value = 1 })

// ---------- 虚拟滚动表格：列定义 / 高度 / 宽度自适应 ----------
const saleWrap = ref(null)
const purchaseWrap = ref(null)
const saleWidth = ref(0)
const purchaseWidth = ref(0)
// 行数少时表格自适应变矮，行数多时封顶并启用虚拟滚动（只渲染可视行）
const tableHeight = (n) => Math.min(520, Math.max(120, n * 36 + 44))
const saleHeight = computed(() => tableHeight(pagedSalesByItem.value.length))
const purchaseHeight = computed(() => tableHeight(pagedPurchasesByItem.value.length))

const fmtMoney = n => Number(n || 0).toFixed(2)
const saleColumns = [
  { key: 'name', dataKey: 'name', title: '商品', flexGrow: 1, width: 200 },
  { key: 'qty', dataKey: 'qty', title: '销量', width: 100, align: 'right' },
  { key: 'amount', dataKey: 'amount', title: '金额', width: 140, align: 'right', cellRenderer: ({ cellData }) => h('span', fmtMoney(cellData)) },
  { key: 'lastDate', dataKey: 'lastDate', title: '最近销售', width: 120, align: 'center', cellRenderer: ({ cellData }) => h('span', cellData || '—') }
]
const purchaseColumns = [
  { key: 'name', dataKey: 'name', title: '商品', flexGrow: 1, width: 220 },
  { key: 'orders', dataKey: 'orders', title: '采购单数', width: 100, align: 'right' },
  { key: 'qty', dataKey: 'qty', title: '采购数量', width: 100, align: 'right' },
  { key: 'avgPrice', dataKey: 'avgPrice', title: '平均进价', width: 110, align: 'right',
    cellRenderer: ({ rowData }) => h('span', rowData.qty > 0 ? (rowData.amount / rowData.qty).toFixed(2) : '—') },
  { key: 'amount', dataKey: 'amount', title: '采购金额', width: 130, align: 'right', cellRenderer: ({ cellData }) => h('span', fmtMoney(cellData)) },
  { key: 'lastDate', dataKey: 'lastDate', title: '最近采购', width: 120, align: 'center', cellRenderer: ({ cellData }) => h('span', cellData || '—') }
]

// 合计行：始终基于全部筛选结果，不随分页/虚拟滚动/排序变化
const saleFoot = computed(() => {
  const rows = sortedSalesByItem.value
  return { qty: rows.reduce((s, r) => s + Number(r.qty || 0), 0), amount: money(rows.reduce((s, r) => s + Number(r.amount || 0), 0)) }
})
const purchaseFoot = computed(() => {
  const rows = sortedPurchasesByItem.value
  const orders = rows.reduce((s, r) => s + Number(r.orders || 0), 0)
  const qty = rows.reduce((s, r) => s + Number(r.qty || 0), 0)
  const amount = rows.reduce((s, r) => s + Number(r.amount || 0), 0)
  return { orders, qty, amount: fmtMoney(amount), avg: qty > 0 ? (amount / qty).toFixed(2) : '—' }
})

// 虚拟表格需要显式宽度：按容器实测，随窗口变化更新
function measure() {
  if (saleWrap.value) saleWidth.value = saleWrap.value.clientWidth || 0
  if (purchaseWrap.value) purchaseWidth.value = purchaseWrap.value.clientWidth || 0
}
onMounted(() => {
  measure()
  window.addEventListener('resize', measure)
})
onUnmounted(() => window.removeEventListener('resize', measure))

// ---------- 导出/打印：输出当前筛选后的全部数据（不受分页限制，顺序随当前排序） ----------
const saleExportColumns = [
  { label: '商品', prop: 'name' },
  { label: '销量', prop: 'qty' },
  { label: '金额', value: r => Number(r.amount || 0).toFixed(2) },
  { label: '最近销售', prop: 'lastDate' }
]
const purchaseExportColumns = [
  { label: '商品', prop: 'name' },
  { label: '采购单数', prop: 'orders' },
  { label: '采购数量', prop: 'qty' },
  { label: '平均进价', value: r => (r.qty > 0 ? (r.amount / r.qty).toFixed(2) : '—') },
  { label: '采购金额', value: r => Number(r.amount || 0).toFixed(2) },
  { label: '最近采购', prop: 'lastDate' }
]
const saleSubtitle = computed(() => {
  const parts = [`共 ${filteredSalesByItem.value.length} 项`, saleSort.value === 'time' ? '按最近销售时间排序' : '按金额排序']
  if (dateStart.value || dateEnd.value) parts.push(`${dateStart.value || '不限'} ~ ${dateEnd.value || '不限'}`)
  if (customerFilter.value) parts.push(customerFilter.value)
  return parts.join(' · ')
})
const purchaseSubtitle = computed(() => {
  const parts = [`共 ${filteredPurchasesByItem.value.length} 项`, purchaseSort.value === 'time' ? '按最近采购时间排序' : '按金额排序']
  if (dateStart.value || dateEnd.value) parts.push(`${dateStart.value || '不限'} ~ ${dateEnd.value || '不限'}`)
  if (supplierFilter.value) parts.push(supplierFilter.value)
  return parts.join(' · ')
})

onMounted(async () => {
  // 先恢复上次筛选，再加载数据，保证刷新后筛选与数据同时就位
  restoreFilters()
  try {
    const [p, s, st, it] = await Promise.all([api.getPurchases(), api.getSales(), api.getStock(), api.getItems()])
    purchases.value = p || []
    sales.value = s || []
    stock.value = st || {}
    items.value = it || []
  } catch (e) {
    purchases.value = []
    sales.value = []
    stock.value = {}
    items.value = []
  }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.section-sub { color:var(--text-secondary); font-size:var(--fs-sub); font-weight: 400; }
.filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.filter-label { color:var(--text-regular); font-size:var(--fs-base); }
.filter-sep { color:var(--text-secondary); }
.filter-hint { color:var(--text-placeholder); font-size:var(--fs-sub); }
.search-input { max-width: 280px; }
.tool-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 8px 0 6px; }
.pager-info { color:var(--text-secondary); font-size:var(--fs-sub); margin-bottom: 6px; }
.pager-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.pager-row :deep(.el-pagination) { padding: 0; }
.pager-nav { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pager-pos { color:var(--text-regular); font-size:var(--fs-table); min-width: 96px; text-align: center; font-variant-numeric: tabular-nums; }
.size-select { width: 116px; }
/* 虚拟滚动表格：外观对齐普通表格 */
.v2-table { border: 1px solid var(--border-color); border-radius: var(--radius-md); overflow: hidden; margin-top: 8px; }
.v2-table :deep(.el-table-v2__header-row) { background:var(--bg-soft); font-weight: 600; color:var(--text-regular); }
.v2-table :deep(.el-table-v2__row) { font-size:var(--fs-table); }
.v2-table :deep(.el-table-v2__row:hover) { background:var(--bg-page); }
.v2-table :deep(.el-table-v2__footer) { background:var(--bg-soft); font-size:var(--fs-table); }
.v2-footer { display: flex; align-items: center; width: 100%; height: 100%; padding: 0 12px; font-size:var(--fs-table); color:var(--text-regular); }
.v2-footer .f-flex { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.v2-footer .f-num { flex: none; text-align: right; padding-right: 12px; }
.v2-footer .strong { font-weight: 700; color:var(--text-primary); }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
.stat-item { padding: 12px 16px; background:var(--bg-stat); border-radius: 8px; min-width: 0; }
.stat-item .el-statistic__head,
.stat-item .el-statistic__content { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-sub { margin-top: 4px; color:var(--text-secondary); font-size:var(--fs-sub); }
/* 迷你趋势条：纯 CSS 柱状图，随分区筛选联动；点击柱子显示当月数额 */
.trend-block { margin-top: 12px; border-top: 1px dashed var(--border-color); padding-top: 10px; }
.trend-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.trend-title { font-size:var(--fs-table); color:var(--text-regular); font-weight: 600; }
.trend-caption { font-size:var(--fs-sub); color:var(--text-secondary); display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.trend-caption .trend-strong { color:var(--text-primary); font-weight: 700; }
.trend-bars { display: flex; align-items: flex-end; gap: 3px; height: 64px; }
.trend-col { flex: 1; min-width: 0; height: 100%; display: flex; align-items: flex-end; position: relative; cursor: pointer; }
.trend-col:hover .trend-bar { filter: brightness(0.92); }
.trend-col.active .trend-bar { filter: brightness(0.82); }
.trend-val { position: absolute; left: 50%; transform: translateX(-50%); white-space: nowrap; font-size: var(--fs-mini); font-weight: 700; background: rgba(255, 255, 255, .92); padding: 0 3px; border-radius: 2px; z-index: 2; pointer-events: none; }
.trend-bar { flex: 1; min-width: 0; border-radius: 2px 2px 0 0; background:var(--color-warning); transition: height .2s; }
.trend-bar.sale { background:var(--color-primary); }
.trend-bar.is-zero { height: 2px; background:var(--border-color); }
.trend-labels { display: flex; gap: 3px; margin-top: 4px; }
.trend-labels span { flex: 1; min-width: 0; text-align: center; font-size: var(--fs-mini); color: var(--text-placeholder); white-space: nowrap; overflow: hidden; }
.trend-labels span.active { color:var(--text-regular); font-weight: 700; }
/* 汇总表排序切换 */
.sort-group { display: inline-flex; align-items: center; gap: 6px; }
.sort-group .el-radio-button--small .el-radio-button__inner { padding: 5px 12px; font-size:var(--fs-sub); }
</style>
