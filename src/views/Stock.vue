<template>
  <div>
    <el-card v-loading="loading">
      <template #header><b>库存查询</b></template>
      <el-input v-model="keyword" clearable placeholder="搜索编码 / 名称" class="search-input" />
      <div class="table-wrap">
      <el-table :data="paged" stripe empty-text="暂无库存数据">
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
      <!-- 分页：库存是全量商品逐条列出，几百行一次性渲染在手机上滚动成本很高。
           默认 50 行/页，搜索时自动回到第 1 页（否则会出现「搜到了但停在空页」）。 -->
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="size"
        :page-sizes="[50, 100, 200]"
        :total="filtered.length"
        layout="total, sizes, prev, pager, next"
        background
        class="pager" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'

const rows = ref([])
const keyword = ref('')
const loading = ref(true)
// 金额统一两位小数，消除 0.1*3=0.30000000000000004 这类浮点残留
const fmtMoney = (row, col, val) => (val == null || val === '' ? '—' : Math.round(Number(val) * 100) / 100)
const filtered = computed(() => rows.value.filter(i => matchText(keyword.value, i.code, i.name)))
// 分页只影响渲染，不影响搜索口径：先过滤再切片，计数与表格同源
const page = ref(1)
const size = ref(50)
const paged = computed(() => {
  const start = (page.value - 1) * size.value
  return filtered.value.slice(start, start + size.value)
})
watch(keyword, () => { page.value = 1 })
// 条数变化（换每页大小）后页码可能越界，夹回最后一页，避免空白页
watch([filtered, size], () => {
  const max = Math.max(1, Math.ceil(filtered.value.length / size.value))
  if (page.value > max) page.value = max
})

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
.pager{margin-top:12px;justify-content:flex-end;}
@media (max-width: 640px) {
  /* 手机上一行放不下 total+sizes+翻页，只保留页码与上一页/下一页 */
  .pager :deep(.el-pagination__sizes), .pager :deep(.el-pagination__total) { display: none; }
  .pager { justify-content: center; }
}
</style>
