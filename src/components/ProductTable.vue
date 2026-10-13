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
      <el-table :data="pagedRows" stripe>
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="history">
              <div class="history-title">历史采购价</div>
              <el-table :data="row.purchaseHistory || []" size="small" border>
                <el-table-column prop="date" label="日期" width="120" />
                <el-table-column label="采购单" width="160">
                  <template #default="{ row: h }"><router-link v-if="h.id" :to="`/purchase/${h.id}`" class="link">{{ h.id }}</router-link><span v-else>—</span></template>
                </el-table-column>
                <el-table-column label="供应商" min-width="160" show-overflow-tooltip>
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
                <el-table-column prop="customer" label="客户" min-width="160" show-overflow-tooltip />
                <el-table-column prop="qty" label="数量" width="80" />
                <el-table-column prop="price" label="单价" width="90" />
                <el-table-column prop="total" label="金额" width="100" />
              </el-table>
              <div v-if="row.package" class="history-title" style="margin-top:12px">规格/包装：{{ row.package }}</div>
              <div class="history-title" style="margin-top:12px">
                分级售价：批发 {{ fmt(row.priceWholesale) }} / 零售 {{ fmt(row.priceRetail) }} / 安装师傅 {{ fmt(row.priceInstaller) }}
              </div>
              <div v-if="row.remark" class="history-title" style="margin-top:12px">备注：{{ row.remark }}</div>
              <div v-if="(row.photos || []).length" class="history-title" style="margin-top:12px">商品照片</div>
              <PhotoThumbs v-if="(row.photos || []).length" :value="row.photos" style="margin-top:6px" />
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="code" label="编码" width="120" />
        <el-table-column label="名称" min-width="220">
          <template #default="{ row }">
            <span>{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="unit" label="单位" width="80" />
        <el-table-column label="供应商" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ supplierNames(row) }}</template>
        </el-table-column>
        <el-table-column prop="cost" label="进价" width="100" />
        <el-table-column prop="price" label="售价" width="100" />
        <template v-if="showPriceTiers">
          <el-table-column prop="priceWholesale" label="批发价" width="100" />
          <el-table-column prop="priceRetail" label="零售价" width="100" />
          <el-table-column prop="priceInstaller" label="安装师傅价" width="110" />
        </template>
        <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
        <slot name="extra" />
        <el-table-column v-if="$slots.actions" label="操作" width="160">
          <template #default="{ row }"><slot name="actions" :row="row" /></template>
        </el-table-column>
      </el-table>
    </div>
    <el-pagination
      v-if="pageSize"
      v-model:current-page="page"
      :page-size="pageSize"
      :total="filtered.length"
      layout="total, prev, pager, next"
      background
      class="pager"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { api } from '../api'
import { matchText } from '../utils/search'
import PhotoThumbs from './PhotoThumbs.vue'

const props = defineProps({
  items: { type: Array, default: () => [] },
  searchable: { type: Boolean, default: true },
  searchPlaceholder: { type: String, default: '搜索编码 / 名称' },
  // 是否显示批发价/零售价/安装师傅价三列
  showPriceTiers: { type: Boolean, default: false },
  // 每页条数，0 表示不分页
  pageSize: { type: Number, default: 0 }
})

const keyword = ref('')
const suppliers = ref([])
const supplierMap = computed(() => {
  const m = {}
  ;(suppliers.value || []).forEach(s => { m[s.code] = s.name })
  return m
})
const filtered = computed(() => (props.items || []).filter(i => matchText(
  keyword.value, i.code, i.name, i.unit, i.remark, ...(i.suppliers || [])
)))

const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / props.pageSize)))
const pagedRows = computed(() => {
  if (!props.pageSize) return filtered.value
  const start = (page.value - 1) * props.pageSize
  return filtered.value.slice(start, start + props.pageSize)
})
// 筛选条件变化后回到第一页
watch(keyword, () => { page.value = 1 })
watch(() => props.items, () => { page.value = 1 })
const fmt = (v) => (v === '' || v == null ? '—' : Number(v))
// 供应商列显示：按名称去重后再拼接（档案中存在同名不同码的重复建档），
// 避免同一家供应商在商品行里重复出现、把列撑得过长
// 注意：supplierMap 是 computed ref，在 script 函数中须用 .value 取值
const supplierNames = (row) => {
  const names = (row.suppliers || []).map(c => supplierMap.value[c] || c).filter(Boolean)
  return [...new Set(names)].join('、') || '—'
}

// 供父组件获取当前筛选结果与当前页数据（用于导出/打印）
defineExpose({ filtered, pagedRows, page, pageCount })

onMounted(async () => {
  try { suppliers.value = await api.getSuppliers() } catch (e) { suppliers.value = [] }
})
</script>

<style scoped>
.search-input { margin-bottom: 12px; max-width: 360px; }
.pager { margin-top: 12px; justify-content: flex-end; }
/* 展开区与商品行保持同一字号字重：标题不再加粗变色，避免折叠内容显得比商品行大 */
.history { padding: 8px 16px; font-size: 13px; color: #606266; }
.history-title { font-weight: 400; margin-bottom: 6px; color: #303133; }
/* 内表显式钉死与商品行相同的字号：EP small 默认 12px，防止样式顺序变化时内表字号漂移 */
.history :deep(.el-table) { font-size: 13px; }
</style>
