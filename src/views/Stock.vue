<template>
  <div>
    <el-card v-loading="loading">
      <template #header><b>库存查询</b></template>
      <el-input v-model="keyword" clearable placeholder="搜索编码 / 名称" class="search-input" />
      <div class="table-wrap">
      <el-table :data="filtered" stripe empty-text="暂无库存数据">
        <el-table-column prop="code" label="编码" width="120" />
        <el-table-column prop="name" label="名称" min-width="180" show-overflow-tooltip />
        <el-table-column prop="qty" label="库存数量" width="120"  align="right"/>
        <el-table-column prop="unit" label="单位" width="80" />
        <el-table-column prop="cost" label="成本价" width="120" :formatter="fmtMoney"  align="right"/>
        <el-table-column prop="value" label="库存金额" width="140" :formatter="fmtMoney"  align="right"/>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.qty < 0" type="danger">负库存</el-tag>
            <el-tag v-else-if="row.warning > 0 && row.qty <= row.warning" type="warning">预警</el-tag>
            <el-tag v-else type="success">正常</el-tag>
          </template>
        </el-table-column>
      </el-table>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'

const rows = ref([])
const keyword = ref('')
const loading = ref(true)
// 金额统一两位小数，消除 0.1*3=0.30000000000000004 这类浮点残留
const fmtMoney = (row, col, val) => (val == null || val === '' ? '—' : Math.round(Number(val) * 100) / 100)
const filtered = computed(() => rows.value.filter(i => matchText(keyword.value, i.code, i.name)))

onMounted(async () => {
  try {
    const [stock, items] = await Promise.all([api.getStock(), api.getItems()])
    const itemMap = {}
    ;(items || []).forEach(i => { itemMap[i.code] = i })
    const stockObj = stock && !Array.isArray(stock) ? stock : {}
    rows.value = Object.entries(stockObj).map(([code, v]) => {
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
  } catch (e) {
    rows.value = []
    // 明确报错：否则用户看到空表格，分不清是「真的没库存」还是「加载失败」
    ElMessage.error(`库存加载失败：${e.message || '网络异常'}`)
  } finally {
    loading.value = false
  }
})
</script>
<style scoped>
.search-input{margin-bottom:12px;max-width:360px;}
</style>
