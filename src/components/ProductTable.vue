<template>
  <div>
    <el-input
      v-if="searchable"
      v-model="keyword"
      clearable
      :placeholder="searchPlaceholder"
      class="search-input"
    />
    <div class="table-wrap" :style="maxHeightStyle">
      <el-table :data="pagedRows" stripe>
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="history">
              <div class="history-title">历史采购价</div>
              <el-table :data="sortedHistory(row.purchaseHistory)" border :fit="false">
                <el-table-column prop="date" label="日期" width="120" />
                <el-table-column label="采购单" width="190" show-overflow-tooltip>
                  <template #default="{ row: h }"><router-link v-if="h.id" :to="`/purchase/${h.id}`" class="link">{{ h.id }}</router-link><span v-else>—</span></template>
                </el-table-column>
                <el-table-column label="供应商" width="150" show-overflow-tooltip>
                  <template #default="{ row: h }">{{ h.supplierName || (supplierMap[h.supplier] || h.supplier || '') }}</template>
                </el-table-column>
                <el-table-column prop="qty" label="数量" width="80" />
                <el-table-column prop="price" label="单价" width="90" />
                <el-table-column prop="total" label="金额" width="100" :formatter="fmtMoney" />
              </el-table>
              <div class="history-title" style="margin-top:12px">历史销售价</div>
              <el-table :data="sortedHistory(row.saleHistory)" border :fit="false">
                <el-table-column prop="date" label="日期" width="120" />
                <el-table-column label="销售单" width="190" show-overflow-tooltip>
                  <template #default="{ row: h }"><router-link v-if="h.id" :to="`/sale/${h.id}`" class="link">{{ h.id }}</router-link><span v-else>—</span></template>
                </el-table-column>
                <el-table-column prop="customer" label="客户" width="150" show-overflow-tooltip />
                <el-table-column prop="qty" label="数量" width="80" />
                <el-table-column prop="price" label="单价" width="90" />
                <el-table-column prop="total" label="金额" width="100" :formatter="fmtMoney" />
              </el-table>
              <div v-if="row.package" class="history-title" style="margin-top:12px">规格/包装：{{ row.package }}</div>
              <div class="history-title" style="margin-top:12px">
                分级售价：批发 {{ fmt(row.priceWholesale) }} / 安装师傅 {{ fmt(row.priceInstaller) }}
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
        <el-table-column v-if="showCost" prop="cost" label="进价" width="100" />
        <el-table-column
          v-for="col in priceColumns"
          :key="col.prop"
          :prop="col.prop"
          :label="col.label"
          width="110"
        />
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
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { api } from '../api'
import { matchText } from '../utils/search'
import PhotoThumbs from './PhotoThumbs.vue'

const props = defineProps({
  items: { type: Array, default: () => [] },
  searchable: { type: Boolean, default: true },
  searchPlaceholder: { type: String, default: '搜索编码 / 名称' },
  // 价格列：传入要展示的价格档位。商品库/供应商下商品传三档（售价/批发价/安装师傅价）；
  // 客户详情按客户类型传对应的一档；不传时默认只显示「售价」
  priceColumns: { type: Array, default: () => [{ prop: 'price', label: '售价' }] },
  // 是否显示「进价」列；商品/供应商/客户列表无需展示成本时传 false 隐藏
  showCost: { type: Boolean, default: true },
  // 每页条数，0 表示不分页
  pageSize: { type: Number, default: 0 },
  // 表格最大高度（px）；设置后表格在卡片内形成滚动盒、表头吸顶，方便对照列
  maxHeight: { type: Number, default: 0 },
  // 为 true 时按视口高度自适应（视口高 - 偏移），尽量多显示行数且表头固定
  fillViewport: { type: Boolean, default: false }
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
// pageSize 为 0 表示不分页：此时不能做除法（会得到 Infinity），页数固定为 1
const pageCount = computed(() => (props.pageSize ? Math.max(1, Math.ceil(filtered.value.length / props.pageSize)) : 1))
const pagedRows = computed(() => {
  if (!props.pageSize) return filtered.value
  const start = (page.value - 1) * props.pageSize
  return filtered.value.slice(start, start + props.pageSize)
})
// 筛选条件变化后回到第一页
watch(keyword, () => { page.value = 1 })
watch(() => props.items, () => { page.value = 1 })
// 表格最大高度：优先用显式 maxHeight，否则 fillViewport 时按视口自适应（预留顶栏/卡片/筛选等上方高度）
const viewportMaxH = ref(0)
function recalcViewport() { viewportMaxH.value = Math.max(320, Math.round((window.innerHeight || 800) - 320)) }
const effectiveMaxH = computed(() => props.maxHeight || (props.fillViewport ? viewportMaxH.value : 0))
const maxHeightStyle = computed(() => effectiveMaxH.value ? { maxHeight: effectiveMaxH.value + 'px' } : null)
onMounted(() => { if (props.fillViewport) { recalcViewport(); window.addEventListener('resize', recalcViewport) } })
onUnmounted(() => { if (props.fillViewport) window.removeEventListener('resize', recalcViewport) })

const fmt = (v) => (v === '' || v == null ? '—' : Number(v))
// 历史价按时间倒序（最近优先）；同日按单号倒序（单号内含录入时间）。
// 后端 derive 已排序，这里前端兜底：存量数据在重建前也按时间展示
const byTimeDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id || '').localeCompare(String(a.id || ''))
const sortedHistory = (arr) => [...(arr || [])].sort(byTimeDesc)
// 金额显示去除浮点精度残留（如 5×1.91=9.549999...→9.55）
const fmtMoney = (row, col, val) => (val == null || val === '' ? '—' : Math.round(Number(val) * 100) / 100)
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
/* 内表是从属信息：比商品行（13px）小一号为 12px，行高收紧，且 :fit="false" 不铺满容器右侧留白，
   避免弹性列被拉到 800+px 后「宽框里几个字」显得字大又空 */
.history :deep(.el-table) { font-size: 12px; color: #606266; font-family: inherit; }
.history :deep(.el-table th.el-table__cell) { font-size: 12px; font-weight: 600; color: #606266; }
.history :deep(.el-table td.el-table__cell) { font-size: 12px; font-weight: 400; padding: 8px 0; }
/* 表头吸顶：表格在卡片内滚动时，列标题固定在盒子顶部，方便滚动查看时对照列 */
.table-wrap :deep(.el-table__header-wrapper) {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--bg-soft);
  box-shadow: 0 1px 0 var(--border-color);
}
</style>
