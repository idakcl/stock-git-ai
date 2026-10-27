<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <b>来往账</b>
          <span class="header-sub">客户应收与供应商应付合并视图，看清全网资金往来净额</span>
        </div>
      </template>

      <div class="filter-row">
        <span class="filter-label">类型</span>
        <el-select v-model="typeFilter" clearable placeholder="全部" style="width:140px">
          <el-option label="应收（客户）" value="receivable" />
          <el-option label="应付（供应商）" value="payable" />
        </el-select>
        <span class="filter-label" style="margin-left:12px">时间段</span>
        <el-date-picker v-model="dateStart" type="date" value-format="YYYY-MM-DD" placeholder="开始" style="width:140px" />
        <span class="filter-sep">至</span>
        <el-date-picker v-model="dateEnd" type="date" value-format="YYYY-MM-DD" placeholder="结束" style="width:140px" />
        <el-button v-if="dateStart || dateEnd" text type="primary" @click="dateStart=''; dateEnd=''">清除</el-button>
        <el-checkbox v-model="onlyOpen" style="margin-left:12px">仅看有余额</el-checkbox>
      </div>
      <div class="filter-row">
        <el-input v-model="keyword" clearable placeholder="搜索往来单位 / 单号 / 备注" class="search-input" />
      </div>

      <div class="stat-grid">
        <div class="stat-item">
          <el-statistic title="应收合计（折后）" :value="stats.recv" :precision="2" prefix="¥" />
          <div class="stat-sub">客户侧</div>
        </div>
        <div class="stat-item">
          <el-statistic title="应付合计（折后）" :value="stats.pay" :precision="2" prefix="¥" />
          <div class="stat-sub">供应商侧</div>
        </div>
        <div class="stat-item">
          <el-statistic title="往来净额" :value="stats.net" :precision="2" prefix="¥" value-style="color:var(--color-danger)" />
          <div class="stat-sub">未收 − 未付</div>
        </div>
        <div class="stat-item">
          <el-statistic title="单据总数" :value="stats.count" :precision="0" />
          <div class="stat-sub">应收 {{ stats.recvCount }} · 应付 {{ stats.payCount }}</div>
        </div>
      </div>

      <!-- 净额分布与排行：按净额正负拆分占比 + Top 债权/债务 -->
      <div class="net-breakdown" v-if="netBreakdown.total > 0">
        <div class="net-side">
          <div class="net-side-title">净额构成（未收 − 未付）</div>
          <div class="net-bar-row">
            <span class="net-bar-label">应收净额（客户欠我方）</span>
            <div class="net-bar-track"><div class="net-bar-fill recv" :style="{ width: netBreakdown.recvNetPct + '%' }"></div></div>
            <span class="net-bar-val amount-in">¥ {{ netBreakdown.recvNet.toFixed(2) }} · {{ netBreakdown.recvNetPct.toFixed(1) }}%</span>
          </div>
          <div class="net-bar-row">
            <span class="net-bar-label">应付净额（我方欠供应商）</span>
            <div class="net-bar-track"><div class="net-bar-fill pay" :style="{ width: netBreakdown.payNetPct + '%' }"></div></div>
            <span class="net-bar-val amount-out">¥ {{ netBreakdown.payNet.toFixed(2) }} · {{ netBreakdown.payNetPct.toFixed(1) }}%</span>
          </div>
          <div class="net-side-subtitle net-side-title-row">
            <span>金额区间分布（按净额绝对值）</span>
            <TableToolbar filename="来往账-净额区间分布" title="来往账·净额区间分布" :subtitle="bucketSubtitle" :columns="bucketColumns" :rows="bucketExportRows" />
          </div>
          <div class="net-bar-row" v-for="b in bucketBreakdown.buckets" :key="b.key">
            <span class="net-bar-label">{{ b.label }}</span>
            <div class="net-bar-track"><div class="net-bar-fill bucket" :style="{ width: bucketPct[b.key] + '%' }"></div></div>
            <span class="net-bar-val">¥ {{ b.amount.toFixed(2) }} · {{ bucketPct[b.key].toFixed(1) }}%（{{ b.count }} 家）</span>
          </div>
        </div>
        <div class="net-side">
          <div class="net-side-title net-side-title-row">
            <span>往来排行（按净额）</span>
            <TableToolbar filename="来往账-债权债务排行" title="来往账·债权债务排行" :subtitle="rankSubtitle" :columns="rankColumns" :rows="rankExportRows" />
          </div>
          <div class="rank-group">
            <div class="rank-head">债权 Top · 客户欠我方</div>
            <div class="rank-list">
              <div class="rank-empty" v-if="!topDebtors.length">——</div>
              <div class="rank-item" v-for="(r, i) in topDebtors" :key="'d' + r.party">
                <span class="rank-no">{{ i + 1 }}</span>
                <router-link :to="`${r.partyPath}${r.code || ''}`" class="rank-name link">{{ r.party }}</router-link>
                <span class="rank-tag recv">欠我</span>
                <span class="rank-amt amount-in">+{{ r.net.toFixed(2) }}</span>
              </div>
            </div>
          </div>
          <div class="rank-group">
            <div class="rank-head">债务 Top · 我方欠供应商</div>
            <div class="rank-list">
              <div class="rank-empty" v-if="!topCreditors.length">——</div>
              <div class="rank-item" v-for="(r, i) in topCreditors" :key="'c' + r.party">
                <span class="rank-no">{{ i + 1 }}</span>
                <router-link :to="`${r.partyPath}${r.code || ''}`" class="rank-name link">{{ r.party }}</router-link>
                <span class="rank-tag pay">我欠</span>
                <span class="rank-amt amount-out">{{ r.net.toFixed(2) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <el-tabs v-model="tab" class="funds-tabs">
        <el-tab-pane label="按往来单位汇总" name="byParty">
          <TableToolbar
            filename="来往账-按单位汇总"
            title="来往账·按单位汇总"
            :subtitle="subtitle"
            :columns="partyColumns"
            :rows="partyPaged"
          />
          <div class="table-wrap">
            <el-table :data="partyPaged" stripe show-summary :summary-method="partySummary" :default-sort="{ prop: 'net', order: 'descending' }" @sort-change="onPartySortChange">
              <el-table-column label="往来单位" min-width="180" show-overflow-tooltip>
                <template #default="{ row }">
                  <router-link :to="`${row.partyPath}${row.code || ''}`" class="link">{{ row.party }}</router-link>
                </template>
              </el-table-column>
              <el-table-column label="类型" width="100" align="center">
                <template #default="{ row }">
                  <el-tag :type="row.type === '客户' ? 'success' : (row.type === '供应商' ? 'warning' : '')" size="small" disable-transitions>{{ row.type }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="count" label="单数" width="80" align="right" />
              <el-table-column label="应收(折后)" width="120" align="right">
                <template #default="{ row }"><span :class="row.recv > 0 ? 'amount-in' : 'none'">{{ row.recv > 0 ? row.recv.toFixed(2) : '—' }}</span></template>
              </el-table-column>
              <el-table-column label="实收" width="110" align="right">
                <template #default="{ row }"><span :class="row.recvPaid > 0 ? 'amount-in' : 'none'">{{ row.recvPaid > 0 ? row.recvPaid.toFixed(2) : '—' }}</span></template>
              </el-table-column>
              <el-table-column label="应付(折后)" width="120" align="right">
                <template #default="{ row }"><span :class="row.pay > 0 ? 'amount-out' : 'none'">{{ row.pay > 0 ? row.pay.toFixed(2) : '—' }}</span></template>
              </el-table-column>
              <el-table-column label="实付" width="110" align="right">
                <template #default="{ row }"><span :class="row.payPaid > 0 ? 'amount-out' : 'none'">{{ row.payPaid > 0 ? row.payPaid.toFixed(2) : '—' }}</span></template>
              </el-table-column>
              <el-table-column label="净额(未收−未付)" width="140" align="right" prop="net" sortable="custom">
                <template #default="{ row }">
                  <span :class="row.net > 0 ? 'amount-in' : 'amount-out'">{{ row.net > 0 ? '+' : '' }}{{ row.net.toFixed(2) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="90" class-name="ops-col">
                <template #default="{ row }">
                  <el-button size="small" @click="$router.push(`${row.partyPath}${row.code || ''}`)">明细</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <el-pagination v-model:current-page="partyPage" :page-size="PAGE_SIZE" :total="partyFiltered.length" layout="total, prev, pager, next" background class="pager" />
          <el-empty v-if="!partyFiltered.length" description="暂无往来单位数据" />
        </el-tab-pane>

        <el-tab-pane label="单据明细" name="orders">
          <div class="table-wrap">
            <el-table :data="orderPaged" stripe show-summary :summary-method="orderSummary">
              <el-table-column label="类型" width="90" align="center">
                <template #default="{ row }">
                  <el-tag :type="row._kind === 'receivable' ? 'success' : 'warning'" size="small" disable-transitions>{{ row._type }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="单号" width="180">
                <template #default="{ row }"><router-link :to="`${row._detail}${row.id}`" class="link">{{ row.id }}</router-link></template>
              </el-table-column>
              <el-table-column label="往来单位" min-width="150" show-overflow-tooltip>
                <template #default="{ row }">
                  <router-link v-if="row.code" :to="`${row._partyPath}${row.code}`" class="link">{{ row._party }}</router-link>
                  <span v-else>{{ row._party }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="date" label="日期" width="120" />
              <el-table-column :label="orderDueLabel" width="120" align="right">
                <template #default="{ row }">{{ grossOf(row).toFixed(2) }}</template>
              </el-table-column>
              <el-table-column :label="orderPaidLabel" width="120" align="right">
                <template #default="{ row }">{{ paidOf(row).toFixed(2) }}</template>
              </el-table-column>
              <el-table-column label="未收/未付" width="120" align="right">
                <template #default="{ row }"><span :class="netOf(row, row._kind) > 0 ? 'debt' : 'none'">{{ netOf(row, row._kind).toFixed(2) }}</span></template>
              </el-table-column>
              <el-table-column label="结算" width="90">
                <template #default="{ row }">
                  <el-tag :type="isSettledOf(netOf(row, row._kind)) ? 'success' : 'danger'" size="small" disable-transitions>{{ isSettledOf(netOf(row, row._kind)) ? '结清' : '挂账' }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="remark" label="备注" width="120" show-overflow-tooltip />
              <el-table-column label="操作" width="100" class-name="ops-col">
                <template #default="{ row }">
                  <el-button size="small" :type="row._kind === 'receivable' ? 'success' : 'warning'" @click="openPay(row)">{{ row._kind === 'receivable' ? '收款' : '付款' }}</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <el-pagination v-model:current-page="orderPage" :page-size="PAGE_SIZE" :total="orderFiltered.length" layout="total, prev, pager, next" background class="pager" />
          <el-empty v-if="!orderFiltered.length" description="暂无单据数据" />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <PaymentDialog v-model="payDialog" :order="payOrder" :kind="payOrder._kind || 'receivable'" :deposit-balance="depositBalanceOf(payOrder)" @saved="onPaySaved" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { grossOf, netOf, isSettledOf, round2, ensurePayments, depositSumOf } from '../utils/account'
import { applyDepositFlows } from '../utils/deposit'
import { matchText } from '../utils/search'
import TableToolbar from '../components/TableToolbar.vue'
import PaymentDialog from '../components/PaymentDialog.vue'

const PAGE_SIZE = 60
const salesList = ref([])
const purchasesList = ref([])
const customers = ref([])
const suppliers = ref([])

const typeFilter = ref('')
const dateStart = ref('')
const dateEnd = ref('')
const keyword = ref('')
const onlyOpen = ref(false)
const tab = ref('byParty')
const partyPage = ref(1)
const orderPage = ref(1)
const partySortOrder = ref('descending') // 净额列受控排序：descending/ascending/null（全量，跨分页一致）

function onPartySortChange({ prop, order }) {
  if (prop === 'net') partySortOrder.value = order
}
const payDialog = ref(false)
const payOrder = ref({})

// 往来单位名 → 编码，供列表点名跳转详情
const customerCode = computed(() => { const m = {}; (customers.value || []).forEach(c => { if (c && c.name) m[c.name] = c.code }); return m })
const supplierCode = computed(() => { const m = {}; (suppliers.value || []).forEach(s => { if (s && s.name) m[s.name] = s.code }); return m })
const codeOf = (name, kind) => kind === 'payable' ? (supplierCode.value[name] || '') : (customerCode.value[name] || '')

// 合并单据：销售单 = 应收，采购单 = 应付
const ordersAll = computed(() => {
  const sales = (salesList.value || []).map(s => ({
    ...s, _type: '应收', _kind: 'receivable', _party: s.customer, _detail: '/sale/', _partyPath: '/customer/', code: codeOf(s.customer, 'receivable')
  }))
  const pur = (purchasesList.value || []).map(p => ({
    ...p, _type: '应付', _kind: 'payable', _party: p.supplier, _detail: '/purchase/', _partyPath: '/supplier/', code: codeOf(p.supplier, 'payable')
  }))
  return [...sales, ...pur]
})

const paidOf = (o) => round2(grossOf(o) - netOf(o, o._kind))

const orderFiltered = computed(() => (ordersAll.value || []).filter(o => {
  if (dateStart.value && (o.date || '') < dateStart.value) return false
  if (dateEnd.value && (o.date || '') > dateEnd.value) return false
  if (typeFilter.value && o._kind !== typeFilter.value) return false
  if (onlyOpen.value && isSettledOf(netOf(o, o._kind))) return false
  if (!matchText(keyword.value, o.id, o._party, o.date, o.remark)) return false
  return true
}))
const orderPaged = computed(() => orderFiltered.value.slice((orderPage.value - 1) * PAGE_SIZE, orderPage.value * PAGE_SIZE))
watch([keyword, dateStart, dateEnd, typeFilter, onlyOpen], () => { orderPage.value = 1 })

// 按往来单位合并：客户记应收，供应商记应付（同名同时为客户/供应商则合并为「客户/供应商」）
const partyRows = computed(() => {
  const map = {}
  const add = (name, type, kind, gross, paid, count, code, partyPath) => {
    let g = map[name]
    if (!g) { g = { party: name, type, code: code || '', partyPath, count: 0, recv: 0, recvPaid: 0, pay: 0, payPaid: 0 }; map[name] = g }
    else { if (g.type !== type) g.type = '客户/供应商'; if (!g.code && code) g.code = code }
    g.count += count
    if (kind === 'receivable') { g.recv += gross; g.recvPaid += paid }
    else { g.pay += gross; g.payPaid += paid }
  }
  for (const c of (customers.value || [])) {
    const ss = (salesList.value || []).filter(s => s.customer === c.name)
    const gross = ss.reduce((s, r) => s + grossOf(r), 0)
    const net = ss.reduce((s, r) => s + netOf(r, 'receivable'), 0)
    add(c.name, '客户', 'receivable', gross, gross - net, ss.length, c.code, '/customer/')
  }
  for (const s of (suppliers.value || [])) {
    const pp = (purchasesList.value || []).filter(p => p.supplier === s.name)
    const gross = pp.reduce((s, r) => s + grossOf(r), 0)
    const net = pp.reduce((s, r) => s + netOf(r, 'payable'), 0)
    add(s.name, '供应商', 'payable', gross, gross - net, pp.length, s.code, '/supplier/')
  }
  for (const g of Object.values(map)) g.net = round2((g.recv - g.recvPaid) - (g.pay - g.payPaid))
  return Object.values(map)
})

const partyFiltered = computed(() => {
  const rows = partyRows.value.filter(g => {
    if (typeFilter.value === 'receivable' && g.recv <= 0 && g.type !== '客户') return false
    if (typeFilter.value === 'payable' && g.pay <= 0 && g.type !== '供应商') return false
    if (onlyOpen.value && Math.abs(g.net) <= 1e-6) return false
    if (!matchText(keyword.value, g.party)) return false
    return true
  })
  if (partySortOrder.value === 'ascending') rows.sort((a, b) => a.net - b.net)
  else if (partySortOrder.value === 'descending') rows.sort((a, b) => b.net - a.net)
  else rows.sort((a, b) => (a.party < b.party ? -1 : a.party > b.party ? 1 : 0)) // 取消排序时按单位名
  return rows
})
const partyPaged = computed(() => partyFiltered.value.slice((partyPage.value - 1) * PAGE_SIZE, partyPage.value * PAGE_SIZE))
watch([keyword, dateStart, dateEnd, typeFilter, onlyOpen], () => { partyPage.value = 1 })

const stats = computed(() => {
  const rows = partyFiltered.value
  const recvCount = (salesList.value || []).length
  const payCount = (purchasesList.value || []).length
  return {
    recv: round2(rows.reduce((s, r) => s + r.recv, 0)),
    pay: round2(rows.reduce((s, r) => s + r.pay, 0)),
    net: round2(rows.reduce((s, r) => s + r.net, 0)),
    count: recvCount + payCount,
    recvCount, payCount
  }
})

// 净额分布：按净额正负拆分（应收净额 = 客户欠我方，应付净额 = 我方欠供应商），用于占比展示
const netBreakdown = computed(() => {
  const rows = partyFiltered.value
  const recvNet = round2(rows.reduce((s, r) => s + (r.net > 0 ? r.net : 0), 0))
  const payNet = round2(rows.reduce((s, r) => s + (r.net < 0 ? -r.net : 0), 0))
  const total = recvNet + payNet
  return {
    recvNet, payNet, total,
    recvNetPct: total > 0 ? round2((recvNet / total) * 100) : 0,
    payNetPct: total > 0 ? round2((payNet / total) * 100) : 0
  }
})

// 往来排行：债权 Top（客户欠我方，net 最大正值）、债务 Top（我方欠供应商，net 最小负值），随筛选/时间段联动
const topDebtors = computed(() => partyFiltered.value.filter(r => r.net > 0).sort((a, b) => b.net - a.net).slice(0, 5))
const topCreditors = computed(() => partyFiltered.value.filter(r => r.net < 0).sort((a, b) => a.net - b.net).slice(0, 5))

// 金额区间分布：按净额绝对值分桶（>1万 / 1千~1万 / ≤1千），统计各桶金额合计与单位数占比
const bucketBreakdown = computed(() => {
  const rows = partyFiltered.value
  const defs = [
    { key: 'gt1w', label: '> 1万', test: v => v > 10000 },
    { key: 'mid', label: '1千 ~ 1万', test: v => v > 1000 && v <= 10000 },
    { key: 'lt1k', label: '≤ 1千', test: v => v <= 1000 }
  ]
  const buckets = defs.map(d => {
    const items = rows.filter(r => d.test(Math.abs(r.net)))
    return { key: d.key, label: d.label, amount: round2(items.reduce((s, r) => s + Math.abs(r.net), 0)), count: items.length }
  })
  const total = round2(buckets.reduce((s, b) => s + b.amount, 0))
  const pct = {}
  buckets.forEach(b => { pct[b.key] = total > 0 ? round2((b.amount / total) * 100) : 0 })
  return { buckets, total, pct }
})
const bucketPct = computed(() => bucketBreakdown.value.pct)

// 金额区间分桶导出数据：区间 / 金额合计 / 占比 / 单位数，随筛选与时间段联动
const bucketSubtitle = computed(() => '按净额绝对值分桶（随筛选 / 时间段联动）')
const bucketColumns = [
  { label: '区间', prop: '区间' },
  { label: '金额合计(¥)', prop: '金额合计' },
  { label: '占比(%)', prop: '占比' },
  { label: '单位数', prop: '单位数' }
]
const bucketExportRows = computed(() => bucketBreakdown.value.buckets.map(b => ({
  区间: b.label,
  金额合计: b.amount.toFixed(2),
  占比: bucketPct.value[b.key].toFixed(1),
  单位数: b.count
})))

// 往来排行导出数据（债权 Top + 债务 Top 合并，带类别与排名）
const rankSubtitle = computed(() => '债权 Top 5 与债务 Top 5（随筛选 / 时间段联动）')
const rankColumns = [
  { label: '排名', prop: '排名' },
  { label: '类别', prop: '类别' },
  { label: '往来单位', prop: '往来单位' },
  { label: '净额', prop: '净额' }
]
const rankExportRows = computed(() => [
  ...topDebtors.value.map((r, i) => ({ 排名: i + 1, 类别: '债权·客户欠我方', 往来单位: r.party, 净额: '+' + r.net.toFixed(2) })),
  ...topCreditors.value.map((r, i) => ({ 排名: i + 1, 类别: '债务·我方欠供应商', 往来单位: r.party, 净额: r.net.toFixed(2) }))
])

const subtitle = computed(() => {
  const parts = [`共 ${partyFiltered.value.length} 个往来单位`]
  if (dateStart.value || dateEnd.value) parts.push(`${dateStart.value || '不限'} ~ ${dateEnd.value || '不限'}`)
  if (typeFilter.value) parts.push(typeFilter.value === 'receivable' ? '应收（客户）' : '应付（供应商）')
  return parts.join(' · ')
})

const partyColumns = [
  { label: '往来单位', prop: 'party' },
  { label: '类型', value: r => r.type },
  { label: '单数', value: r => r.count },
  { label: '应收(折后)', value: r => r.recv > 0 ? r.recv.toFixed(2) : '—' },
  { label: '实收', value: r => r.recvPaid > 0 ? r.recvPaid.toFixed(2) : '—' },
  { label: '应付(折后)', value: r => r.pay > 0 ? r.pay.toFixed(2) : '—' },
  { label: '实付', value: r => r.payPaid > 0 ? r.payPaid.toFixed(2) : '—' },
  { label: '净额(未收−未付)', value: r => (r.net > 0 ? '+' : '') + r.net.toFixed(2) }
]

const orderDueLabel = computed(() => typeFilter.value === 'payable' ? '应付' : '应收')
const orderPaidLabel = computed(() => typeFilter.value === 'payable' ? '实付' : '实收')

const partySummary = ({ columns, data }) => {
  const sum = (k) => (data || []).reduce((s, r) => s + r[k], 0)
  return columns.map((c, idx) => {
    if (idx === 0) return '合计'
    if (c.label === '单数') return sum('count')
    if (c.label === '应收(折后)') return sum('recv').toFixed(2)
    if (c.label === '实收') return sum('recvPaid').toFixed(2)
    if (c.label === '应付(折后)') return sum('pay').toFixed(2)
    if (c.label === '实付') return sum('payPaid').toFixed(2)
    if (c.label === '净额(未收−未付)') return sum('net').toFixed(2)
    return ''
  })
}
const orderSummary = ({ columns }) => {
  const rows = orderFiltered.value
  const due = rows.reduce((s, r) => s + grossOf(r), 0)
  const paid = rows.reduce((s, r) => s + paidOf(r), 0)
  const net = rows.reduce((s, r) => s + netOf(r, r._kind), 0)
  return columns.map((c, idx) => {
    if (idx === 0) return `合计（${rows.length} 单）`
    if (c.label === orderDueLabel.value) return due.toFixed(2)
    if (c.label === orderPaidLabel.value) return paid.toFixed(2)
    if (c.label === '未收/未付') return net.toFixed(2)
    return ''
  })
}

// 往来单位预存款/预付款可用余额（供「用预存款支付」抵扣）
const depositBalanceOf = (row) => {
  const src = row && row._kind === 'receivable' ? customers.value : suppliers.value
  const name = row && (row._kind === 'receivable' ? row.customer : row.supplier)
  const p = (src || []).find(x => x.name === name)
  return depositSumOf(p && (row._kind === 'receivable' ? p.deposits : p.advances))
}

function openPay(row) {
  payOrder.value = row
  payDialog.value = true
}

// 保存登记收/付款：写回源单据 → 持久化 → 重新拉取，并处理超额转存/抵扣的预存款流水
async function onPaySaved(updated, payload) {
  const kind = updated._kind === 'payable' ? 'payable' : 'receivable'
  const src = kind === 'receivable' ? salesList.value : purchasesList.value
  const idx = (src || []).findIndex(r => r.id === updated.id)
  if (idx >= 0) {
    src[idx] = {
      ...src[idx],
      payments: updated.payments,
      received: updated.received,
      paid: updated.paid,
      discount: updated.discount
    }
  }
  try {
    await (kind === 'receivable' ? api.saveSales(salesList.value) : api.savePurchases(purchasesList.value))
  } catch (e) {
    ElMessage.error(`保存失败：${e.message || '网络异常'}，请重试`)
    return
  }
  const [sales, pur, cust, sup] = await Promise.all([
    api.getSales(), api.getPurchases(), api.getCustomers(), api.getSuppliers()
  ])
  salesList.value = sales || []
  purchasesList.value = pur || []
  customers.value = cust || []
  suppliers.value = sup || []
  payDialog.value = false
  ElMessage.success(`已保存${kind === 'receivable' ? '收款' : '付款'}流水`)
  // 超额转存预存款/预付款、用预存款/预付款抵扣：按订单 id 幂等重建流水（资金不泄漏）
  const addAmt = Number(payload?.add?.amount || 0)
  const deductAmt = Number(payload?.deduct?.amount || 0)
  if (addAmt > 0 || deductAmt > 0) {
    const name = kind === 'receivable' ? updated.customer : updated.supplier
    const list2 = await applyDepositFlows(api, kind, name, updated.id, addAmt, deductAmt)
    if (list2) { if (kind === 'receivable') customers.value = list2; else suppliers.value = list2 }
    const parts = []
    const depWord = kind === 'receivable' ? '客户预存款' : '供应商预付款'
    if (addAmt > 0) parts.push(`存入${depWord} ¥${addAmt.toFixed(2)}`)
    if (deductAmt > 0) parts.push(`扣减${depWord} ¥${deductAmt.toFixed(2)}`)
    if (parts.length) ElMessage.success(parts.join('；'))
  }
}

onMounted(async () => {
  try {
    const [sales, pur, cust, sup] = await Promise.all([
      api.getSales(), api.getPurchases(), api.getCustomers(), api.getSuppliers()
    ])
    salesList.value = sales || []
    purchasesList.value = pur || []
    customers.value = cust || []
    suppliers.value = sup || []
  } catch (e) {
    salesList.value = []
    purchasesList.value = []
    customers.value = []
    suppliers.value = []
  }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.header-sub { color: var(--text-secondary); font-size: var(--fs-sub); font-weight: 400; }
.filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.filter-label { color: var(--text-regular); font-size: var(--fs-base); }
.filter-sep { color: var(--text-secondary); }
.search-input { max-width: 380px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
.stat-item { padding: 12px 16px; background: var(--bg-stat); border-radius: 8px; min-width: 0; }
.stat-item .el-statistic__head,
.stat-item .el-statistic__content { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-sub { margin-top: 4px; color: var(--text-secondary); font-size: var(--fs-sub); }
.funds-tabs { margin-top: 12px; }
.pager { margin-top: 12px; justify-content: flex-end; }
.net-breakdown { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
.net-side { padding: 12px 16px; background: var(--bg-stat); border-radius: 8px; min-width: 0; }
.net-side-title { font-weight: 600; margin-bottom: 10px; color: var(--text-regular); font-size: var(--fs-base); }
.net-side-title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.net-side-title-row :deep(.export-bar) { margin-bottom: 0; }
.net-side-subtitle.net-side-title-row { align-items: center; }
.net-side-subtitle { font-weight: 600; margin: 14px 0 10px; color: var(--text-regular); font-size: var(--fs-sub); border-top: 1px dashed var(--el-border-color-lighter); padding-top: 10px; }
.net-bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.net-bar-label { width: 160px; color: var(--text-regular); font-size: var(--fs-sub); flex-shrink: 0; }
.net-bar-track { flex: 1; min-width: 80px; height: 12px; background: var(--el-fill-color-light); border-radius: 6px; overflow: hidden; }
.net-bar-fill { height: 100%; border-radius: 6px; transition: width .3s ease; }
.net-bar-fill.recv { background: var(--color-success); }
.net-bar-fill.pay { background: var(--el-color-primary); }
.net-bar-fill.bucket { background: var(--el-color-warning); }
.net-bar-val { font-size: var(--fs-sub); font-weight: 600; white-space: nowrap; }
.rank-group { margin-bottom: 10px; }
.rank-head { font-size: var(--fs-sub); color: var(--text-secondary); margin-bottom: 6px; }
.rank-list { display: flex; flex-direction: column; gap: 4px; }
.rank-item { display: flex; align-items: center; gap: 8px; font-size: var(--fs-base); }
.rank-no { width: 18px; height: 18px; line-height: 18px; text-align: center; border-radius: 50%; background: var(--el-fill-color); color: var(--text-secondary); font-size: var(--fs-sub); flex-shrink: 0; }
.rank-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rank-tag { font-size: var(--fs-sub); padding: 0 6px; border-radius: 4px; }
.rank-tag.recv { color: var(--color-success); background: var(--el-color-success-light-9); }
.rank-tag.pay { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.rank-amt { font-weight: 600; white-space: nowrap; }
.rank-empty { color: var(--text-placeholder); font-size: var(--fs-sub); }
@media (max-width: 720px) {
  .net-breakdown { grid-template-columns: 1fr; }
  .net-bar-label { width: 100%; }
}
.amount-in { color: var(--color-success); font-weight: 600; }
.amount-out { color: var(--el-color-primary); font-weight: 600; }
.debt { color: var(--color-danger); font-weight: 600; }
.none { color: var(--text-placeholder); }
.link { color: var(--color-primary); text-decoration: none; }
.link:hover { text-decoration: underline; }
</style>
