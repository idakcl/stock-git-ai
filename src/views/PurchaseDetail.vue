<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title">
            <b>采购单：{{ purchase.id }}</b>
          </div>
          <el-button @click="$router.push('/purchases')">返回列表</el-button>
        </div>
      </template>
      <div class="info">
        <span>供应商：{{ purchase.supplier }}</span>
        <span>日期：{{ purchase.date }}</span>
        <span>金额：¥ {{ purchase.total }}</span>
        <span v-if="purchase.remark">备注：{{ purchase.remark }}</span>
      </div>
      <ProductTable :items="detailItems" search-placeholder="搜索本单商品">
        <template #extra>
          <el-table-column prop="_qty" label="本次数量" width="100" />
          <el-table-column prop="_price" label="本次单价" width="100" />
          <el-table-column prop="_total" label="本次金额" width="100" />
        </template>
      </ProductTable>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import ProductTable from '../components/ProductTable.vue'

const route = useRoute()
const purchases = ref([])
const items = ref([])
const purchase = computed(() => purchases.value.find(p => p.id === route.params.id) || { id: route.params.id, supplier: '', date: '', total: 0, items: [] })

const detailItems = computed(() => {
  const map = Object.fromEntries((items.value || []).map(i => [i.code, i]))
  return (purchase.value.items || []).map(line => {
    const base = map[line.code] || {}
    return {
      ...base,
      code: line.code,
      name: line.name || base.name || line.code,
      suppliers: base.suppliers || [],
      purchaseHistory: base.purchaseHistory || [],
      saleHistory: base.saleHistory || [],
      package: base.package,
      unit: base.unit || '',
      cost: line.price,
      price: base.price != null ? base.price : line.price,
      _qty: line.qty,
      _price: line.price,
      _total: line.total
    }
  })
})

onMounted(async () => {
  try {
    const [p, it] = await Promise.all([api.getPurchases(), api.getItems()])
    purchases.value = p
    items.value = it
  } catch (e) { purchases.value = []; items.value = [] }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.info { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px; color: #606266; font-size: 14px; }
</style>
