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
      </div>
      <ProductTable :items="products" search-placeholder="搜索该供应商商品" />
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
const supplier = computed(() => suppliers.value.find(s => s.code === route.params.code) || { code: route.params.code, name: '未知', contact: '', phone: '' })
const products = computed(() => {
  const codes = new Set(supplier.value.products || [])
  return items.value.filter(i => codes.has(i.code))
})

onMounted(async () => {
  try {
    const [sp, it] = await Promise.all([api.getSuppliers(), api.getItems()])
    suppliers.value = sp
    items.value = it
  } catch (e) { suppliers.value = []; items.value = [] }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.sub { color: #909399; font-weight: 400; }
.info { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px; color: #606266; font-size: 14px; }
</style>
