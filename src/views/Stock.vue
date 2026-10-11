<template>
  <div>
    <el-card>
      <template #header><b>库存查询</b></template>
      <el-table :data="rows" stripe>
        <el-table-column prop="code" label="编码" width="120" />
        <el-table-column prop="name" label="名称" />
        <el-table-column prop="qty" label="库存数量" width="120" />
        <el-table-column prop="unit" label="单位" width="80" />
        <el-table-column prop="cost" label="成本价" width="120" />
        <el-table-column prop="value" label="库存金额" width="140" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.warning > 0 && row.qty <= row.warning" type="danger">预警</el-tag>
            <el-tag v-else type="success">正常</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../api'

const rows = ref([])

onMounted(async () => {
  const [stock, items] = await Promise.all([api.getStock(), api.getItems()])
  const itemMap = {}
  items.forEach(i => { itemMap[i.code] = i })
  rows.value = Object.entries(stock).map(([code, v]) => {
    const item = itemMap[code] || {}
    return {
      code,
      name: item.name || code,
      unit: item.unit || '',
      qty: v.qty || 0,
      cost: v.cost || 0,
      value: (v.qty || 0) * (v.cost || 0),
      warning: item.warning || 0
    }
  })
})
</script>
