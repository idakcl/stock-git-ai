<template>
  <div>
    <el-input
      v-if="searchable"
      v-model="keyword"
      clearable
      :placeholder="searchPlaceholder"
      class="search-input"
    />
    <div class="table-wrap">
      <el-table :data="filtered" stripe>
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="history">
              <div class="history-title">历史采购价</div>
              <el-table :data="row.purchaseHistory || []" size="small" border>
                <el-table-column prop="date" label="日期" width="120" />
                <el-table-column label="采购单" width="160">
                  <template #default="{ row: h }"><router-link v-if="h.id" :to="`/purchase/${h.id}`" class="link">{{ h.id }}</router-link><span v-else>—</span></template>
                </el-table-column>
                <el-table-column label="供应商" min-width="160">
                  <template #default="{ row: h }">{{ h.supplierName || (supplierMap[h.supplier] || h.supplier || '') }}</template>
                </el-table-column>
                <el-table-column prop="qty" label="数量" width="80" />
                <el-table-column prop="price" label="单价" width="90" />
                <el-table-column prop="total" label="金额" width="100" />
              </el-table>
              <div class="history-title" style="margin-top:12px">历史销售价</div>
              <el-table :data="row.saleHistory || []" size="small" border>
                <el-table-column prop="date" label="日期" width="120" />
                <el-table-column label="销售单" width="160">
                  <template #default="{ row: h }"><router-link v-if="h.id" :to="`/sale/${h.id}`" class="link">{{ h.id }}</router-link><span v-else>—</span></template>
                </el-table-column>
                <el-table-column prop="customer" label="客户" min-width="160" />
                <el-table-column prop="qty" label="数量" width="80" />
                <el-table-column prop="price" label="单价" width="90" />
                <el-table-column prop="total" label="金额" width="100" />
              </el-table>
              <div v-if="row.package" class="history-title" style="margin-top:12px">规格/包装：{{ row.package }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="code" label="编码" width="120" />
        <el-table-column prop="name" label="名称" />
        <el-table-column prop="unit" label="单位" width="80" />
        <el-table-column label="供应商" min-width="160">
          <template #default="{ row }">{{ (row.suppliers || []).map(c => supplierMap[c] || c).join('、') || '—' }}</template>
        </el-table-column>
        <el-table-column prop="cost" label="进价" width="100" />
        <el-table-column prop="price" label="售价" width="100" />
        <slot name="extra" />
        <el-table-column v-if="$slots.actions" label="操作" width="160">
          <template #default="{ row }"><slot name="actions" :row="row" /></template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { api } from '../api'
import { matchText } from '../utils/search'

const props = defineProps({
  items: { type: Array, default: () => [] },
  searchable: { type: Boolean, default: true },
  searchPlaceholder: { type: String, default: '搜索编码 / 名称' }
})

const keyword = ref('')
const suppliers = ref([])
const supplierMap = computed(() => {
  const m = {}
  ;(suppliers.value || []).forEach(s => { m[s.code] = s.name })
  return m
})
const filtered = computed(() => (props.items || []).filter(i => matchText(
  keyword.value, i.code, i.name, i.unit, ...(i.suppliers || [])
)))
onMounted(async () => {
  try { suppliers.value = await api.getSuppliers() } catch (e) { suppliers.value = [] }
})
</script>

<style scoped>
.search-input { margin-bottom: 12px; max-width: 360px; }
.history { padding: 8px 16px; }
.history-title { font-weight: 600; margin-bottom: 6px; color: #409eff; }
</style>
