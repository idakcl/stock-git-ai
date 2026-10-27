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
            <el-table :data="partyPaged" stripe show-summary :summary-method="partySummary" :default-sort="{ prop: 'net', order: 'descending' }">
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
              <el-table-column label="净额(未收−未付)" width="140" align="right" prop="net" sortable>
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
            </el-table>
          </div>
          <el-pagination v-model:current-page="orderPage" :page-size="PAGE_SIZE" :total="orderFiltered.length" layout="total, prev, pager, next" background class="pager" />
          <el-empty v-if="!orderFiltered.length" description="暂无单据数据" />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { api } from '../api'
import { grossOf, netOf, isSettledOf, round2 } from '../utils/account'
import { matchText } from '../utils/search'
import TableToolbar from '../components/TableToolbar.vue'

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

const partyFiltered = computed(() => partyRows.value.filter(g => {
  if (typeFilter.value === 'receivable' && g.recv <= 0 && g.type !== '客户') return false
  if (typeFilter.value === 'payable' && g.pay <= 0 && g.type !== '供应商') return false
  if (onlyOpen.value && Math.abs(g.net) <= 1e-6) return false
  if (!matchText(keyword.value, g.party)) return false
  return true
}).sort((a, b) => b.net - a.net))
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
.amount-in { color: var(--color-success); font-weight: 600; }
.amount-out { color: var(--el-color-primary); font-weight: 600; }
.debt { color: var(--color-danger); font-weight: 600; }
.none { color: var(--text-placeholder); }
.link { color: var(--color-primary); text-decoration: none; }
.link:hover { text-decoration: underline; }
</style>
