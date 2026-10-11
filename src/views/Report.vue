<template>
  <div>
    <el-card>
      <template #header><b>统计报表</b></template>
      <el-row :gutter="16">
        <el-col :span="8">
          <el-statistic title="采购总额" :value="stats.purchaseTotal" :precision="2" prefix="¥" />
        </el-col>
        <el-col :span="8">
          <el-statistic title="销售总额" :value="stats.saleTotal" :precision="2" prefix="¥" />
        </el-col>
        <el-col :span="8">
          <el-statistic title="毛利" :value="stats.profit" :precision="2" prefix="¥" />
        </el-col>
      </el-row>
      <el-divider />
      <b>按商品销售汇总</b>
      <el-table :data="salesByItem" stripe style="margin-top:8px">
        <el-table-column prop="name" label="商品" />
        <el-table-column prop="qty" label="销量" width="100" />
        <el-table-column prop="amount" label="金额" width="140" />
      </el-table>
      <el-empty v-if="!salesByItem.length" description="暂无销售数据" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { api } from '../api'

const stats = reactive({ purchaseTotal: 0, saleTotal: 0, profit: 0 })
const salesByItem = ref([])

onMounted(async () => {
  try {
    const [purchases, sales, stock] = await Promise.all([
      api.getPurchases(), api.getSales(), api.getStock()
    ])
    const purchaseList = purchases || []
    const saleList = sales || []
    const stockObj = stock && !Array.isArray(stock) ? stock : {}
    stats.purchaseTotal = purchaseList.reduce((s, p) => s + (p.total || 0), 0)
    stats.saleTotal = saleList.reduce((s, p) => s + (p.total || 0), 0)

    const costMap = {}
    for (const [code, v] of Object.entries(stockObj)) costMap[code] = v.cost || 0
    const totalCost = saleList.reduce((sum, s) =>
      sum + (s.items || []).reduce((c, i) => c + i.qty * (costMap[i.code] || 0), 0), 0)
    stats.profit = stats.saleTotal - totalCost

    const agg = {}
    for (const s of saleList) {
      for (const i of (s.items || [])) {
        if (!agg[i.name]) agg[i.name] = { name: i.name, qty: 0, amount: 0 }
        agg[i.name].qty += i.qty
        agg[i.name].amount += i.total
      }
    }
    salesByItem.value = Object.values(agg).sort((a, b) => b.amount - a.amount)
  } catch (e) {
    salesByItem.value = []
  }
})
</script>
