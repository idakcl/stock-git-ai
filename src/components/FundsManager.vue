<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <b>{{ L.title }}</b>
          <span class="header-sub">{{ L.subtitle }}</span>
        </div>
      </template>

      <div class="filter-row">
        <span class="filter-label">时间段</span>
        <el-date-picker v-model="dateStart" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" style="width:150px" />
        <span class="filter-sep">至</span>
        <el-date-picker v-model="dateEnd" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" style="width:150px" />
        <el-button v-if="dateStart || dateEnd" text type="primary" @click="dateStart=''; dateEnd=''">清除</el-button>
        <span class="filter-label" style="margin-left:12px">{{ L.party }}</span>
        <el-select v-model="partyFilter" clearable filterable :placeholder="`全部${L.party}`" style="width:220px">
          <el-option v-for="p in partyOptions" :key="p" :label="p" :value="p" />
        </el-select>
      </div>
      <div class="filter-row">
        <el-input v-model="keyword" clearable placeholder="搜索单号 / 商品 / 备注" class="search-input" />
      </div>

      <TableToolbar
        :filename="L.title"
        :title="L.title"
        :subtitle="subtitle"
        :columns="exportColumns"
        :rows="paged"
      />

      <div class="stat-grid">
        <div class="stat-item">
          <el-statistic :title="`${L.due}总额`" :value="stats.due" :precision="2" prefix="¥" />
          <div class="stat-sub">{{ stats.count }} 单</div>
        </div>
        <div class="stat-item">
          <el-statistic :title="`累计${L.paid}`" :value="stats.paid" :precision="2" prefix="¥" />
          <div class="stat-sub">{{ stats.payCount }} 笔流水</div>
        </div>
        <div class="stat-item">
          <el-statistic title="抹零优惠（未实际收款）" :value="stats.discount" :precision="2" prefix="¥" />
          <div class="stat-sub">{{ stats.discountCount }} 单含优惠</div>
        </div>
        <div class="stat-item">
          <el-statistic :title="`${L.unpaid}合计`" :value="stats.unpaid" :precision="2" prefix="¥" value-style="color:var(--color-danger)" />
          <div class="stat-sub">{{ stats.openCount }} 单未结清</div>
        </div>
      </div>

      <el-tabs v-model="tab" class="funds-tabs">
        <el-tab-pane label="单据明细" name="orders">
          <div class="table-wrap">
          <el-table :data="paged" stripe show-summary :summary-method="summaryAmount">
            <el-table-column label="单号" width="180">
              <template #default="{ row }">
                <router-link :to="`${L.detailPath}${row.id}`" class="link">{{ row.id }}</router-link>
              </template>
            </el-table-column>
            <el-table-column :label="L.party" min-width="150" show-overflow-tooltip>
              <template #default="{ row }">
                <router-link v-if="partyCodeMap[row[partyKey]]" :to="`${L.partyPath}${partyCodeMap[row[partyKey]]}`" class="link">{{ row[partyKey] }}</router-link>
                <span v-else>{{ row[partyKey] }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column :label="L.itemsLabel" width="100" align="right">
              <template #default="{ row }">{{ orderKindCount(row) }}</template>
            </el-table-column>
            <el-table-column :label="L.due" width="110" align="right">
              <template #default="{ row }">{{ dueOf(row).toFixed(2) }}</template>
            </el-table-column>
            <el-table-column :label="L.paid" width="120" align="right">
              <template #default="{ row }">
                <span>{{ paidSumOf(row).toFixed(2) }}</span>
                <span v-if="payCountOf(row)" class="pay-count">（{{ payCountOf(row) }} 笔）</span>
              </template>
            </el-table-column>
            <el-table-column label="优惠" width="100" align="right">
              <template #default="{ row }">
                <span v-if="Number(row.discount || 0) > 0" class="discount" title="抹零优惠，未实际收款">-{{ Number(row.discount).toFixed(2) }}</span>
                <span v-else class="none">—</span>
              </template>
            </el-table-column>
            <el-table-column :label="L.unpaid" width="110" align="right">
              <template #default="{ row }">
                <span :class="netOf(row) > 0 ? 'debt' : 'none'">{{ netOf(row).toFixed(2) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="结算" width="90">
              <template #default="{ row }">
                <el-tag :type="settleLabelOf(row) === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
                  {{ settleLabelOf(row) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="remark" label="备注" width="120" show-overflow-tooltip />
            <el-table-column label="操作" width="130" class-name="ops-col">
              <template #default="{ row }">
                <el-button size="small" @click="$router.push(`${L.detailPath}${row.id}`)">查看</el-button>
                <el-button size="small" type="success" @click="openPay(row)">{{ L.payBtn }}</el-button>
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
          <el-empty v-if="!filtered.length" :description="`暂无${L.title}数据`" />
        </el-tab-pane>

        <el-tab-pane :label="`按${L.party}汇总`" name="byParty">
          <div class="table-wrap">
          <el-table :data="byParty" stripe show-summary :summary-method="partySummary">
            <el-table-column :label="L.party" min-width="180" show-overflow-tooltip>
              <template #default="{ row }">
                <router-link :to="`${L.partyPath}${row.code || ''}`" class="link">{{ row.party }}</router-link>
              </template>
            </el-table-column>
            <el-table-column prop="count" label="单数" width="90"  align="right"/>
            <el-table-column :label="L.due" width="120" align="right">
              <template #default="{ row }">{{ row.due.toFixed(2) }}</template>
            </el-table-column>
            <el-table-column :label="L.paid" width="120" align="right">
              <template #default="{ row }">{{ row.paid.toFixed(2) }}</template>
            </el-table-column>
            <el-table-column :label="L.unpaid" width="120" align="right">
              <template #default="{ row }">
                <span :class="row.unpaid > 0 ? 'debt' : 'none'">{{ row.unpaid.toFixed(2) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="110" class-name="ops-col">
              <template #default="{ row }">
                <el-button size="small" @click="$router.push(`${L.partyPath}${row.code || ''}`)">来往账</el-button>
              </template>
            </el-table-column>
          </el-table>
          </div>
          <el-empty v-if="!byParty.length" :description="`暂无${L.title}数据`" />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <PaymentDialog v-model="payDialog" :order="payOrder" :kind="kind" :deposit-balance="depositBalanceOf(payOrder)" @saved="onPaySaved" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'
import { grossOf, netOf as netOfOrder, ensurePayments, depositSumOf, isSettledOf } from '../utils/account'
import { applyDepositFlows } from '../utils/deposit'
import { orderKindCount, lineDisplayName, itemNameMap } from '../utils/catalog'
import TableToolbar from './TableToolbar.vue'
import PaymentDialog from './PaymentDialog.vue'

const props = defineProps({
  // 'receivable' 销售应收 | 'payable' 采购应付
  kind: { type: String, default: 'receivable' }
})

const PAGE_SIZE = 60

// 文案与口径按 kind 派生
const L = computed(() => props.kind === 'payable' ? {
  title: '应付款管理', subtitle: '按供应商管理与登记采购付款',
  party: '供应商', itemsLabel: '商品数量', due: '应付', paid: '实付', unpaid: '未付',
  payBtn: '付款', detailPath: '/purchase/', partyPath: '/supplier/'
} : {
  title: '应收款管理', subtitle: '按客户管理与登记销售收款',
  party: '客户', itemsLabel: '商品数量', due: '应收', paid: '实收', unpaid: '未收',
  payBtn: '收款', detailPath: '/sale/', partyPath: '/customer/'
})

const list = ref([])
const parties = ref([]) // 客户/供应商档案（用于汇总表取 code）
const items = ref([]) // 商品档案（用于搜索按编码解析当前名）
const keyword = ref('')
const dateStart = ref('')
const dateEnd = ref('')
const partyFilter = ref('')
const page = ref(1)
const tab = ref('orders')
const payDialog = ref(false)
const payOrder = ref({})

const isPayable = computed(() => props.kind === 'payable')
const partyKey = computed(() => isPayable.value ? 'supplier' : 'customer')
// 商品编码 → 主数据当前名（搜索按编码解析，单据快照名过期也能命中）
const nameMap = computed(() => itemNameMap(items.value))

// 单笔口径：应收/应付 = 合计 − 优惠；未收/未付 = max(0, 应收/应付 − 累计实收/实付)
const dueOf = (row) => grossOf(row)
const netOf = (row) => netOfOrder(row, props.kind)
const paidSumOf = (row) => ensurePayments(row, isPayable.value ? 'paid' : 'received').reduce((s, p) => s + Number(p.amount || 0), 0)
const payCountOf = (row) => ensurePayments(row, isPayable.value ? 'paid' : 'received').length
// 展示层结算口径：未收/未付金额为 0 即显示结清（无需打开编辑弹窗，旧单也生效）
const settleLabelOf = (row) => isSettledOf(netOf(row), row.settle) ? '结清' : '挂账'
// 当前单据对应往来单位的预存款/预付款可用余额（供「用预存款支付」抵扣）
const depositBalanceOf = (row) => {
  const p = (parties.value || []).find(x => x.name === (row && row[partyKey.value]))
  return depositSumOf(p && (isPayable.value ? p.advances : p.deposits))
}

const filtered = computed(() => (list.value || []).filter(row => {
  if (dateStart.value && (row.date || '') < dateStart.value) return false
  if (dateEnd.value && (row.date || '') > dateEnd.value) return false
  if (partyFilter.value && row[partyKey.value] !== partyFilter.value) return false
  // 搜索商品名时按编码解析为商品主数据当前名：单据快照名过期也能命中（改名后老单可搜）
  if (!matchText(keyword.value, row.id, row[partyKey.value], row.date, row.remark,
    ...(row.items || []).map(i => lineDisplayName(i, nameMap.value)), ...(row.items || []).map(i => i.code))) return false
  return true
}))

const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
watch([keyword, dateStart, dateEnd, partyFilter], () => { page.value = 1 })

// 汇总卡片
const stats = reactive({ due: 0, paid: 0, unpaid: 0, count: 0, payCount: 0, openCount: 0, discount: 0, discountCount: 0 })
function recompute() {
  const rows = filtered.value
  stats.count = rows.length
  stats.due = rows.reduce((s, r) => s + dueOf(r), 0)
  stats.paid = rows.reduce((s, r) => s + paidSumOf(r), 0)
  stats.unpaid = rows.reduce((s, r) => s + netOf(r), 0)
  stats.payCount = rows.reduce((s, r) => s + payCountOf(r), 0)
  stats.openCount = rows.filter(r => netOf(r) > 0).length
  stats.discount = rows.reduce((s, r) => s + Number(r.discount || 0), 0)
  stats.discountCount = rows.filter(r => Number(r.discount || 0) > 0).length
}
watch(filtered, recompute, { immediate: true })

// 按往来单位汇总（按未收/未付降序，方便先看谁欠得多）
const byParty = computed(() => {
  const map = {}
  for (const row of filtered.value) {
    const name = row[partyKey.value] || '（未填写）'
    if (!map[name]) map[name] = { party: name, code: '', count: 0, due: 0, paid: 0, unpaid: 0 }
    const g = map[name]
    g.count += 1
    g.due += dueOf(row)
    g.paid += paidSumOf(row)
    g.unpaid += netOf(row)
  }
  // 补上往来单位编码，便于跳转详情
  for (const g of Object.values(map)) {
    const hit = (parties.value || []).find(p => p.name === g.party)
    if (hit) g.code = hit.code
  }
  return Object.values(map).sort((a, b) => b.unpaid - a.unpaid)
})

// 下拉选项：全部单据中出现过的往来单位
const partyOptions = computed(() => [...new Set((list.value || []).map(r => r[partyKey.value]).filter(Boolean))])
// 往来单位名 → 编码：列表里点名字跳转往来账详情
const partyCodeMap = computed(() => {
  const m = {}
  ;(parties.value || []).forEach(p => { if (p && p.name) m[p.name] = p.code })
  return m
})

// 导出/打印与列表当前页同步：副标题标注输出范围（第 X/Y 页）
const subtitle = computed(() => {
  const parts = [`共 ${filtered.value.length} 单`, `导出当前第 ${page.value}/${pageCount.value} 页`]
  if (dateStart.value || dateEnd.value) parts.push(`${dateStart.value || '不限'} ~ ${dateEnd.value || '不限'}`)
  if (partyFilter.value) parts.push(partyFilter.value)
  return parts.join(' · ')
})

const exportColumns = computed(() => [
  { label: '单号', prop: 'id' },
  { label: L.value.party, prop: partyKey.value },
  { label: '日期', prop: 'date' },
  { label: L.value.itemsLabel, value: r => orderKindCount(r) },
  { label: L.value.due, value: r => dueOf(r).toFixed(2) },
  { label: L.value.paid, value: r => { const n = payCountOf(r); return paidSumOf(r).toFixed(2) + (n > 1 ? `（${n}笔）` : '') } },
  { label: '优惠', value: r => Number(r.discount || 0) > 0 ? '-' + Number(r.discount).toFixed(2) : '—' },
  { label: L.value.unpaid, value: r => netOf(r).toFixed(2) },
  { label: '结算', value: r => settleLabelOf(r) },
  { label: '备注', prop: 'remark' }
])

// 表格合计行（基于全部筛选结果）
const summaryAmount = ({ columns }) => {
  const rows = filtered.value
  const sum = (fn) => rows.reduce((s, r) => s + fn(r), 0)
  return columns.map((c, idx) => {
    if (idx === 0) return `合计（${rows.length} 单）`
    if (c.property === 'date') return ''
    if (c.label === L.value.due) return sum(dueOf).toFixed(2)
    if (c.label === L.value.paid) return sum(paidSumOf).toFixed(2)
    if (c.label === '优惠') return sum(r => Number(r.discount || 0)).toFixed(2)
    if (c.label === L.value.unpaid) return sum(netOf).toFixed(2)
    return ''
  })
}

const partySummary = ({ columns, data }) => {
  const sum = (key) => (data || []).reduce((s, r) => s + r[key], 0)
  return columns.map((c, idx) => {
    if (idx === 0) return '合计'
    if (c.property === 'count') return sum('count')
    if (c.label === L.value.due) return sum('due').toFixed(2)
    if (c.label === L.value.paid) return sum('paid').toFixed(2)
    if (c.label === L.value.unpaid) return sum('unpaid').toFixed(2)
    return ''
  })
}

function openPay(row) {
  payOrder.value = row
  payDialog.value = true
}

async function onPaySaved(updated, payload) {
  const idx = list.value.findIndex(r => r.id === updated.id)
  if (idx >= 0) list.value[idx] = updated
  // 保存失败时弹窗保持打开（父组件不关闭），便于直接重试
  try {
    const save = isPayable.value ? api.savePurchases(list.value) : api.saveSales(list.value)
    await save
  } catch (e) {
    ElMessage.error(`保存失败：${e.message || '网络异常'}，请重试`)
    return
  }
  // 重新拉取，保证与后端一致
  list.value = isPayable.value ? await api.getPurchases() : await api.getSales()
  payDialog.value = false
  ElMessage.success(`已保存${L.value.payBtn}流水`)
  // 超额收付转预存款/预付款、用预存款/预付款抵扣：按订单 id 幂等重建流水（资金不泄漏）
  const addAmt = Number(payload?.add?.amount || 0)
  const deductAmt = Number(payload?.deduct?.amount || 0)
  if (addAmt > 0 || deductAmt > 0) {
    const name = isPayable.value ? updated.supplier : updated.customer
    const list2 = await applyDepositFlows(api, props.kind, name, updated.id, addAmt, deductAmt)
    if (list2) parties.value = list2
    const parts = []
    const depWord = isPayable.value ? '供应商预付款' : '客户预存款'
    if (addAmt > 0) parts.push(`存入${depWord} ¥${addAmt.toFixed(2)}`)
    if (deductAmt > 0) parts.push(`扣减${depWord} ¥${deductAmt.toFixed(2)}`)
    if (parts.length) ElMessage.success(parts.join('；'))
  }
}

onMounted(async () => {
  try {
    const [orders, ps, its] = await Promise.all([
      isPayable.value ? api.getPurchases() : api.getSales(),
      isPayable.value ? api.getSuppliers() : api.getCustomers(),
      api.getItems()
    ])
    list.value = orders || []
    parties.value = ps || []
    items.value = its || []
  } catch (e) {
    list.value = []
    parties.value = []
    items.value = []
  }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.header-sub { color:var(--text-secondary); font-size:var(--fs-sub); font-weight: 400; }
.filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.filter-label { color:var(--text-regular); font-size:var(--fs-base); }
.filter-sep { color:var(--text-secondary); }
.search-input { max-width: 360px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 4px; }
.stat-item { padding: 12px 16px; background:var(--bg-stat); border-radius: 8px; min-width: 0; }
.stat-item .el-statistic__head,
.stat-item .el-statistic__content { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-sub { margin-top: 4px; color:var(--text-secondary); font-size:var(--fs-sub); }
.funds-tabs { margin-top: 12px; }
.pager { margin-top: 12px; justify-content: flex-end; }
.pay-count { color:var(--text-secondary); font-size:var(--fs-sub); margin-left: 2px; }
.discount { color:var(--color-success); }
.none { color:var(--text-placeholder); }
.debt { color:var(--color-danger); font-weight: 600; }
</style>
