<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title">
            <b>客户：{{ customer.name }}</b>
            <span class="sub">（{{ customer.code }}）</span>
            <el-tag v-if="customer.category" size="small" :type="categoryTagType(customer.category)" style="margin-left:8px">
              {{ customer.category }}
            </el-tag>
          </div>
          <el-button @click="$router.push('/customers')">返回列表</el-button>
        </div>
      </template>
      <div class="info">
        <span>联系人：{{ customer.contact || '—' }}</span>
        <span>电话：{{ customer.phone || '—' }}</span>
        <span>关联商品：{{ products.length }} 个</span>
        <span class="amount-item">
          应收款：<b :class="receivable ? 'amount-debt' : 'amount-zero'">¥ {{ receivable.toFixed(2) }}</b>
        </span>
        <span v-if="customer.remark">备注：{{ customer.remark }}</span>
      </div>

      <div class="filter-row">
        <span class="filter-label">时间段</span>
        <el-date-picker v-model="dateStart" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" style="width:150px" />
        <span class="filter-sep">至</span>
        <el-date-picker v-model="dateEnd" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" style="width:150px" />
        <el-button v-if="dateStart || dateEnd" text type="primary" @click="dateStart=''; dateEnd=''">清除</el-button>
      </div>

      <el-tabs v-model="tab">
        <el-tab-pane label="产品列表" name="products">
          <ProductTable :items="products" search-placeholder="搜索该客户商品" />
        </el-tab-pane>
        <el-tab-pane :label="`销售单 (${filteredSales.length})`" name="sales">
          <el-table :data="filteredSales" stripe show-summary :summary-method="summaryAmount">
            <el-table-column label="单号" width="180">
              <template #default="{ row }"><router-link :to="`/sale/${row.id}`" class="link">{{ row.id }}</router-link></template>
            </el-table-column>
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column label="商品数量" width="100">
              <template #default="{ row }">{{ orderKindCount(row) }}</template>
            </el-table-column>
            <el-table-column prop="total" label="金额" width="110">
              <template #default="{ row }">{{ Number(row.total || 0).toFixed(2) }}</template>
            </el-table-column>
            <el-table-column label="实收" width="110">
              <template #default="{ row }">{{ receivedSumOf(row).toFixed(2) }}</template>
            </el-table-column>
            <el-table-column label="结算" width="100">
              <template #default="{ row }">
                <el-tag :type="row.settle === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
                  {{ row.settle || '挂账' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
          </el-table>
          <div v-if="!filteredSales.length" class="empty">该时间段暂无销售单</div>
        </el-tab-pane>
        <el-tab-pane :label="`来往账 (${ledgerRows.length})`" name="ledger">
          <div class="balance-bar">
            <span>期初欠款：<b :class="openingBalance > 0 ? 'amount-debt' : 'amount-zero'">¥ {{ openingBalance.toFixed(2) }}</b></span>
            <span>本期应收：<b>¥ {{ ledgerRows.reduce((s, r) => s + r.amount, 0).toFixed(2) }}</b></span>
            <span>期末欠款：<b :class="closingBalance > 0 ? 'amount-debt' : 'amount-zero'">¥ {{ closingBalance.toFixed(2) }}</b></span>
          </div>
          <el-table :data="ledgerRows" stripe show-summary :summary-method="ledgerSummary">
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column prop="id" label="单号" width="180">
              <template #default="{ row }"><router-link :to="`/sale/${row.id}`" class="link">{{ row.id }}</router-link></template>
            </el-table-column>
            <el-table-column prop="summary" label="摘要" width="120" />
            <el-table-column prop="amount" label="应收金额" width="120">
              <template #default="{ row }">{{ row.amount.toFixed(2) }}</template>
            </el-table-column>
            <el-table-column prop="received" label="实收金额" width="120">
              <template #default="{ row }">{{ row.received.toFixed(2) }}</template>
            </el-table-column>
            <el-table-column prop="discount" label="优惠" width="100">
              <template #default="{ row }">
                <span v-if="row.discount > 0" class="discount">-{{ row.discount.toFixed(2) }}</span>
                <span v-else class="none">—</span>
              </template>
            </el-table-column>
            <el-table-column prop="unpaid" label="未结金额" width="120">
              <template #default="{ row }">
                <span :class="row.unpaid > 0 ? 'amount-debt' : 'none'">{{ row.unpaid.toFixed(2) }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="balance" label="累计欠款" width="130">
              <template #default="{ row }">
                <b :class="row.balance > 0 ? 'amount-debt' : 'amount-zero'">{{ row.balance.toFixed(2) }}</b>
              </template>
            </el-table-column>
            <el-table-column prop="settle" label="结算" width="100">
              <template #default="{ row }">
                <el-tag :type="row.settle === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
                  {{ row.settle || '挂账' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="!ledgerRows.length" class="empty">该时间段暂无往来记录</div>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import ProductTable from '../components/ProductTable.vue'
import { receivableOf, receivedSumOf } from '../utils/account'
import { orderKindCount } from '../utils/catalog'

const route = useRoute()
const customers = ref([])
const items = ref([])
const sales = ref([])
const tab = ref('products')
const dateStart = ref('')
const dateEnd = ref('')

const categoryTagType = (c) => ({ '批发': 'warning', '零售': 'success', '安装师傅': 'primary' }[c] || 'info')

const customer = computed(() => customers.value.find(c => c.code === route.params.code) || { code: route.params.code, name: '未知', contact: '', phone: '', remark: '', category: '' })
const saleList = computed(() => (sales.value || []).filter(s => s.customer === customer.value.name))
const products = computed(() => {
  const codes = new Set()
  saleList.value.forEach(s => (s.items || []).forEach(l => l.code && codes.add(l.code)))
  const map = Object.fromEntries((items.value || []).map(i => [i.code, i]))
  return [...codes].map(code => map[code]).filter(Boolean)
})
const filteredSales = computed(() => saleList.value.filter(s => {
  if (dateStart.value && (s.date || '') < dateStart.value) return false
  if (dateEnd.value && (s.date || '') > dateEnd.value) return false
  return true
}))

// 应收款：该客户全部销售单未结金额合计（欠款按金额计算，与结算状态无关）
const receivable = computed(() => saleList.value.reduce((sum, s) => sum + receivableOf(s), 0))

// 按单据日期排序（与筛选无关，用于计算期初）
const sortedSales = computed(() => saleList.value
  .slice()
  .sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id))))

// 期初欠款：筛选起点之前所有单据的未结金额合计（避免时间筛选丢失历史欠款）
const openingBalance = computed(() => {
  if (!dateStart.value) return 0
  return sortedSales.value
    .filter(s => (s.date || '') < dateStart.value)
    .reduce((sum, s) => sum + receivableOf(s), 0)
})

// 来往账：期初余额 + 期间逐单滚动累计 → 期末余额
const ledgerRows = computed(() => {
  let balance = openingBalance.value
  return filteredSales.value
    .slice()
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id)))
    .map(s => {
      const amount = Number(s.total || 0)
      const discount = Number(s.discount || 0)
      const received = receivedSumOf(s)
      const unpaid = Math.max(0, amount - discount - received)
      balance += unpaid
      return { date: s.date, id: s.id, summary: '销售出库', amount, discount, received, unpaid, balance, settle: s.settle || '挂账' }
    })
})

// 期末欠款 = 期初 + 本期未结
const closingBalance = computed(() => openingBalance.value + ledgerRows.value.reduce((s, r) => s + r.unpaid, 0))

// 表格底部汇总：合计金额
const summaryAmount = ({ columns, data }) => {
  const total = (data || []).reduce((sum, r) => sum + Number(r.total || 0), 0)
  return columns.map((c, idx) => {
    if (idx === 0) return '合计'
    if (c.property === 'total') return total.toFixed(2)
    return ''
  })
}

// 来往账合计行（按列的 property 匹配）：本金期为「本期发生额」，累计欠款列显示期末余额
const ledgerSummary = ({ columns, data }) => {
  const sum = (key) => (data || []).reduce((s, r) => s + (Number(r[key]) || 0), 0)
  const values = {
    amount: sum('amount').toFixed(2),
    discount: sum('discount').toFixed(2),
    received: sum('received').toFixed(2),
    unpaid: sum('unpaid').toFixed(2),
    balance: closingBalance.value.toFixed(2)
  }
  return columns.map((c, idx) => {
    if (idx === 0) return '合计（期初 ' + openingBalance.value.toFixed(2) + '）'
    return values[c.property] ?? ''
  })
}

onMounted(async () => {
  try {
    const [cu, it, sa] = await Promise.all([api.getCustomers(), api.getItems(), api.getSales()])
    customers.value = cu
    items.value = it
    sales.value = sa
  } catch (e) { customers.value = []; items.value = []; sales.value = [] }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.sub { color: #909399; font-weight: 400; }
.info { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px; color: #606266; font-size: 14px; }
.filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.filter-label { color: #606266; font-size: 14px; }
.filter-sep { color: #909399; }
.empty { color: #909399; text-align: center; padding: 24px 0; }
.amount-item { display: inline-flex; align-items: center; gap: 4px; }
.amount-debt { color: #f56c6c; font-weight: 700; }
.amount-zero { color: #c0c4cc; }
.none { color: #c0c4cc; }
.discount { color: #67c23a; }
.balance-bar { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 10px; color: #606266; font-size: 14px; }
</style>
