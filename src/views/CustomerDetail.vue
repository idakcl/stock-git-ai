<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title">
            <b>客户：{{ customer.name }}</b>
            <span class="sub">（{{ customer.code }}）</span>
          </div>
          <el-button @click="$router.push('/customers')">返回列表</el-button>
        </div>
      </template>
      <div class="info">
        <span>联系人：{{ customer.contact || '—' }}</span>
        <span>电话：{{ customer.phone || '—' }}</span>
        <span>关联商品：{{ products.length }} 个</span>
        <span v-if="customer.remark">备注：{{ customer.remark }}</span>
      </div>

      <el-tabs v-model="tab">
        <el-tab-pane label="产品列表" name="products">
          <ProductTable :items="products" search-placeholder="搜索该客户商品" />
        </el-tab-pane>
        <el-tab-pane :label="`销售单 (${filteredSales.length})`" name="sales">
          <div class="filter-row">
            <span class="filter-label">时间段</span>
            <el-date-picker v-model="dateStart" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" style="width:150px" />
            <span class="filter-sep">至</span>
            <el-date-picker v-model="dateEnd" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" style="width:150px" />
            <el-button v-if="dateStart || dateEnd" text type="primary" @click="dateStart=''; dateEnd=''">清除</el-button>
          </div>
          <el-table :data="filteredSales" stripe>
            <el-table-column label="单号" width="180">
              <template #default="{ row }"><router-link :to="`/sale/${row.id}`" class="link">{{ row.id }}</router-link></template>
            </el-table-column>
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column label="商品" min-width="200">
              <template #default="{ row }">{{ row.items.map(i => `${i.name}×${i.qty}`).join('、') }}</template>
            </el-table-column>
            <el-table-column prop="total" label="金额" width="110" />
            <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
          </el-table>
          <div v-if="!filteredSales.length" class="empty">该时间段暂无销售单</div>
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

const route = useRoute()
const customers = ref([])
const items = ref([])
const sales = ref([])
const tab = ref('products')
const dateStart = ref('')
const dateEnd = ref('')

const customer = computed(() => customers.value.find(c => c.code === route.params.code) || { code: route.params.code, name: '未知', contact: '', phone: '', remark: '' })
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
</style>
