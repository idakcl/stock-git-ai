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
        <span v-if="supplier.remark">备注：{{ supplier.remark }}</span>
      </div>

      <el-tabs v-model="tab">
        <el-tab-pane label="产品列表" name="products">
          <ProductTable :items="products" search-placeholder="搜索该供应商商品" />
        </el-tab-pane>
        <el-tab-pane :label="`采购单 (${filteredPurchases.length})`" name="purchases">
          <div class="filter-row">
            <span class="filter-label">时间段</span>
            <el-date-picker v-model="dateStart" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" style="width:150px" />
            <span class="filter-sep">至</span>
            <el-date-picker v-model="dateEnd" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" style="width:150px" />
            <el-button v-if="dateStart || dateEnd" text type="primary" @click="dateStart=''; dateEnd=''">清除</el-button>
          </div>
          <el-table :data="filteredPurchases" stripe>
            <el-table-column label="单号" width="180">
              <template #default="{ row }"><router-link :to="`/purchase/${row.id}`" class="link">{{ row.id }}</router-link></template>
            </el-table-column>
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column prop="total" label="金额" width="110" />
            <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
          </el-table>
          <div v-if="!filteredPurchases.length" class="empty">该时间段暂无采购单</div>
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
</style>
