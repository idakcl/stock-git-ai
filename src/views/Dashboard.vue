<template>
  <div>
    <el-card>
      <template #header><b>经营看板</b></template>
      <div class="stat-grid">
        <div class="stat-item"><el-statistic title="商品数" :value="stats.itemCount" /></div>
        <div class="stat-item"><el-statistic title="库存总金额" :value="stats.stockValue" :precision="2" prefix="¥" /></div>
        <div class="stat-item"><el-statistic title="采购总金额" :value="stats.purchaseTotal" :precision="2" prefix="¥" /></div>
        <div class="stat-item"><el-statistic title="销售总金额" :value="stats.saleTotal" :precision="2" prefix="¥" /></div>
      </div>
    </el-card>
    <el-card style="margin-top:16px">
      <template #header><b>低库存预警</b></template>
      <el-input v-model="keyword" clearable placeholder="搜索编码 / 名称" class="search-input" />
      <div class="table-wrap">
      <el-table :data="filteredLowStock" stripe>
        <el-table-column prop="code" label="编码" width="140" />
        <el-table-column prop="name" label="名称" />
        <el-table-column prop="stock" label="库存" width="100" />
        <el-table-column prop="warning" label="预警值" width="100" />
      </el-table>
      </div>
      <el-empty v-if="!lowStock.length" description="暂无低库存商品" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { api } from '../api'
import { matchText } from '../utils/search'

const stats = reactive({ itemCount: 0, stockValue: 0, purchaseTotal: 0, saleTotal: 0 })
const lowStock = ref([])
const keyword = ref('')
const filteredLowStock = computed(() => lowStock.value.filter(i => matchText(keyword.value, i.code, i.name)))

onMounted(async () => {
  try {
    const [items, purchases, sales, stock] = await Promise.all([
      api.getItems(), api.getPurchases(), api.getSales(), api.getStock()
    ])
    stats.itemCount = (items || []).length
    stats.purchaseTotal = (purchases || []).reduce((s, p) => s + (p.total || 0), 0)
    stats.saleTotal = (sales || []).reduce((s, p) => s + (p.total || 0), 0)
    const stockObj = stock && !Array.isArray(stock) ? stock : {}
    for (const info of Object.values(stockObj)) {
      stats.stockValue += (info.qty || 0) * (info.cost || 0)
    }
    const warnMap = {}
    ;(items || []).forEach(i => { warnMap[i.code] = i.warning || 0 })
    lowStock.value = Object.entries(stockObj)
      .filter(([, v]) => (v.qty || 0) <= (warnMap[v.code] || 0))
      .map(([code, v]) => ({ ...v, code, warning: warnMap[code] || 0 }))
  } catch (e) {
    console.error(e)
  }
})
</script>
<style scoped>
.search-input{margin-bottom:12px;max-width:360px;}
</style>
