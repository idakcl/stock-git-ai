<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title">
            <b>供应商：{{ supplier.name }}</b>
            <span class="sub">（{{ supplier.code }}）</span>
          </div>
          <el-button @click="$router.push('/suppliers')">返回列表</el-button>
        </div>
      </template>
      <div class="info">
        <span>联系人：{{ supplier.contact || '—' }}</span>
        <span>电话：{{ supplier.phone || '—' }}</span>
        <span>关联商品：{{ products.length }} 个</span>
        <span class="amount-item">
          应付款：<b :class="payable ? 'amount-debt' : 'amount-zero'">¥ {{ payable.toFixed(2) }}</b>
        </span>
        <span v-if="supplier.remark">备注：{{ supplier.remark }}</span>
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
          <ProductTable :items="products" search-placeholder="搜索该供应商商品" />
        </el-tab-pane>
        <el-tab-pane :label="`采购单 (${filteredPurchases.length})`" name="purchases">
          <el-table :data="filteredPurchases" stripe show-summary :summary-method="summaryAmount">
            <el-table-column label="单号" width="180">
              <template #default="{ row }"><router-link :to="`/purchase/${row.id}`" class="link">{{ row.id }}</router-link></template>
            </el-table-column>
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column prop="total" label="金额" width="110">
              <template #default="{ row }">{{ Number(row.total || 0).toFixed(2) }}</template>
            </el-table-column>
            <el-table-column label="实付" width="110">
              <template #default="{ row }">{{ row.paid != null ? Number(row.paid).toFixed(2) : '—' }}</template>
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
          <div v-if="!filteredPurchases.length" class="empty">该时间段暂无采购单</div>
        </el-tab-pane>
        <el-tab-pane :label="`来往账 (${ledgerRows.length})`" name="ledger">
          <div class="balance-bar">
            <span>期初欠款：<b :class="openingBalance > 0 ? 'amount-debt' : 'amount-zero'">¥ {{ openingBalance.toFixed(2) }}</b></span>
            <span>本期应付：<b>¥ {{ ledgerRows.reduce((s, r) => s + r.amount, 0).toFixed(2) }}</b></span>
            <span>期末欠款：<b :class="closingBalance > 0 ? 'amount-debt' : 'amount-zero'">¥ {{ closingBalance.toFixed(2) }}</b></span>
          </div>
          <el-table :data="ledgerRows" stripe show-summary :summary-method="ledgerSummary">
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column prop="id" label="单号" width="180">
              <template #default="{ row }"><router-link :to="`/purchase/${row.id}`" class="link">{{ row.id }}</router-link></template>
            </el-table-column>
            <el-table-column prop="summary" label="摘要" width="120" />
            <el-table-column prop="amount" label="应付金额" width="120">
              <template #default="{ row }">{{ row.amount.toFixed(2) }}</template>
            </el-table-column>
            <el-table-column prop="paid" label="实付金额" width="120">
              <template #default="{ row }">{{ row.paid.toFixed(2) }}</template>
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
import { payableOf } from '../utils/account'

const route = useRoute()
const suppliers = ref([])
const items = ref([])
const purchases = ref([])
const tab = ref('products')
const dateStart = ref('')
const dateEnd = ref('')

const supplier = computed(() => suppliers.value.find(s => s.code === route.params.code) || { code: route.params.code, name: '未知', contact: '', phone: '', remark: '' })
const products = computed(() => {
  const codes = new Set(supplier.value.products || [])
  return items.value.filter(i => codes.has(i.code))
})
const purchaseList = computed(() => (purchases.value || []).filter(p => p.supplier === supplier.value.name))
const filteredPurchases = computed(() => purchaseList.value.filter(p => {
  if (dateStart.value && (p.date || '') < dateStart.value) return false
  if (dateEnd.value && (p.date || '') > dateEnd.value) return false
  return true
}))

// 应付款：该供应商全部采购单未结金额合计（欠款按金额计算，与结算状态无关）
const payable = computed(() => purchaseList.value.reduce((sum, p) => sum + payableOf(p), 0))

// 按单据日期排序（与筛选无关，用于计算期初）
const sortedPurchases = computed(() => purchaseList.value
  .slice()
  .sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id))))

// 期初欠款：筛选起点之前所有单据的未结金额合计（避免时间筛选丢失历史欠款）
const openingBalance = computed(() => {
  if (!dateStart.value) return 0
  return sortedPurchases.value
    .filter(p => (p.date || '') < dateStart.value)
    .reduce((sum, p) => sum + payableOf(p), 0)
})

// 来往账：期初余额 + 期间逐单滚动累计 → 期末余额
const ledgerRows = computed(() => {
  let balance = openingBalance.value
  return filteredPurchases.value
    .slice()
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id)))
    .map(p => {
      const amount = Number(p.total || 0)
      const discount = Number(p.discount || 0)
      const paid = p.paid != null ? Number(p.paid) : 0
      const unpaid = Math.max(0, amount - discount - paid)
      balance += unpaid
      return { date: p.date, id: p.id, summary: '采购入库', amount, discount, paid, unpaid, balance, settle: p.settle || '挂账' }
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
    paid: sum('paid').toFixed(2),
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
    const [sp, it, pu] = await Promise.all([api.getSuppliers(), api.getItems(), api.getPurchases()])
    suppliers.value = sp
    items.value = it
    purchases.value = pu
  } catch (e) { suppliers.value = []; items.value = []; purchases.value = [] }
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
