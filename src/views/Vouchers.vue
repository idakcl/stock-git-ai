<template>
  <div v-loading="loading">
    <el-card>
      <template #header>
        <div class="card-header">
          <b>收付款单</b>
          <span class="header-sub">每一笔收付款、预存预付、超额转存、抵扣划转都自动生成一张资金单据（收款单 SK- / 付款单 FK-）</span>
        </div>
      </template>

      <div class="stat-grid">
        <div class="stat-item">
          <el-statistic title="收款单累计" :value="receiptSum" :precision="2" prefix="¥" value-style="color:var(--color-success)" />
          <div class="stat-sub">{{ receipts.length }} 张</div>
        </div>
        <div class="stat-item">
          <el-statistic title="付款单累计" :value="voucherSum" :precision="2" prefix="¥" value-style="color:var(--el-color-primary)" />
          <div class="stat-sub">{{ vouchers.length }} 张</div>
        </div>
        <div class="stat-item">
          <el-statistic title="净额（收−付）" :value="netSum" :precision="2" prefix="¥" value-style="color:var(--color-danger)" />
          <div class="stat-sub">含供应商退款 +¥{{ refundIn.toFixed(2) }} / 客户退款 −¥{{ refundOut.toFixed(2) }}</div>
        </div>
      </div>

      <el-tabs v-model="tab" class="vtabs">
        <el-tab-pane label="收款单" name="receipts" />
        <el-tab-pane label="付款单" name="payment-vouchers" />
        <el-tab-pane label="退款单 TK" name="refunds" />
        <el-tab-pane label="退货核销 HX" name="settlements" />
      </el-tabs>

      <div class="filter-bar">
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          unlink-panels
        />
        <el-button v-if="dateRange && dateRange.length" text type="primary" @click="dateRange = null">清除筛选</el-button>
        <span class="filter-label" style="margin-left:12px">往来单位</span>
        <el-select v-model="partyFilter" clearable filterable placeholder="全部往来单位" style="width:220px">
          <el-option v-for="p in partyOptions" :key="p" :label="p" :value="p" />
        </el-select>
        <span class="filter-hint">按单据日期 / 往来单位筛选</span>
      </div>

      <TableToolbar
        :filename="`收付款单-${tabLabel}`"
        :title="`收付款单·${tabLabel}`"
        :subtitle="subtitle"
        :columns="listColumns"
        :rows="filteredList"
      />
      <div class="table-wrap">
        <el-table :data="pagedList" stripe @row-click="openDrawer">
          <el-table-column prop="code" label="资金单据编号" width="200" show-overflow-tooltip>
            <template #default="{ row }"><router-link :to="{ path: '/vouchers', query: { code: row.code } }" class="link" @click.stop>{{ row.code }}</router-link></template>
          </el-table-column>
          <el-table-column label="类别" width="120">
            <template #default="{ row }">
              <el-tag size="small" :type="categoryTagType(row.category)" disable-transitions>{{ categoryLabel(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="tab === 'refunds' || tab === 'settlements'" label="方向" width="145"><template #default="{ row }">{{ row.direction === 'to_customer' ? '退给客户' : '收供应商退款' }}</template></el-table-column>
          <el-table-column prop="party" label="往来单位" min-width="160" show-overflow-tooltip />
          <el-table-column prop="date" label="日期" width="130" />
          <el-table-column label="本次金额" width="130" align="right">
            <template #default="{ row }">{{ Number(row.total || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
          <el-table-column label="操作" width="90" align="center">
            <template #default="{ row }">
              <el-button size="small" @click.stop="openDrawer(row)">查看</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <el-empty v-if="!filteredList.length" :description="loadError ? `资金单据读取失败：${loadError}` : `暂无${tabLabel}——收款/付款/结清、预存预付与超额转存时自动生成`" />
      <el-pagination
        v-if="filteredList.length"
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :page-sizes="[20, 50, 100]"
        :total="filteredList.length"
        :pager-count="5"
        layout="total, sizes, prev, pager, next"
        background
        class="voucher-pagination"
      />
      <div class="sum-bar" v-if="filteredList.length">
        合计（筛选后）：<b>¥ {{ sumTotal.toFixed(2) }}</b>
        <span class="sum-note">· 共 {{ filteredList.length }} 张{{ tabLabel }}</span>
      </div>
    </el-card>

    <el-alert v-if="!loading && route.query.code && !current && !loadError" title="未找到该资金单据，请核对编号或刷新重试" type="warning" :closable="false" />
    <!-- 明细抽屉：URL 保存单据编号，支持直接打开、刷新和浏览器后退。 -->
    <el-drawer v-model="drawer" :title="current ? `资金单据详情 · ${current.code}` : ''" size="min(780px, 96vw)" direction="rtl">
      <template v-if="current">
        <el-descriptions :column="1" border size="small" class="vh">
          <el-descriptions-item label="资金单据编号">{{ current.code }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ current.kind === 'refund' ? (current.direction === 'to_customer' ? '退给客户' : '收供应商退款') : current.kind === 'receivable' ? '收款单（客户）' : '付款单（供应商）' }}</el-descriptions-item>
          <el-descriptions-item v-if="current.kind === 'refund'" label="核销金额">{{ Number(current.settlementTotal || 0).toFixed(2) }}（非现金核销不计入资金净额）</el-descriptions-item>
          <el-descriptions-item label="类别">{{ categoryLabel(current) }}</el-descriptions-item>
          <el-descriptions-item label="往来单位">{{ current.party }}</el-descriptions-item>
          <el-descriptions-item label="日期">{{ current.date }}</el-descriptions-item>
          <el-descriptions-item label="本次金额">¥ {{ Number(current.total || 0).toFixed(2) }}</el-descriptions-item>
          <el-descriptions-item label="备注">{{ current.remark || '—' }}</el-descriptions-item>
        </el-descriptions>
        <div class="drawer-toolbar">
          <el-button size="small" type="primary" @click="exportVoucher">导出本单 CSV</el-button>
        </div>
        <el-table :data="current.items || []" stripe border size="small" class="v-items">
          <el-table-column label="关联采购 / 销售单" min-width="210" show-overflow-tooltip>
            <template #default="{ row }">
              <router-link v-if="row.orderId && ['sale', 'purchase'].includes(row.orderType)" :to="{ path: `${row.orderType === 'sale' ? '/sale/' : '/purchase/'}${encodeURIComponent(row.orderId)}` }" class="link">{{ row.orderType === 'sale' ? '销售单' : '采购单' }} · {{ row.orderId }}</router-link>
              <span v-else class="none">{{ row.orderId || row.note || '无关联采购 / 销售单（纯资金业务）' }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="date" label="日期" width="120" />
          <el-table-column label="本次金额" width="110" align="right">
            <template #default="{ row }">{{ Number(row.amount || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="本次优惠" width="100" align="right">
            <template #default="{ row }">{{ Number(row.discount || 0) > 0 ? Number(row.discount).toFixed(2) : '—' }}</template>
          </el-table-column>
          <el-table-column label="结算" width="80" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.settle != null" :type="row.settle ? 'success' : 'danger'" size="small" disable-transitions>{{ row.settle ? '结清' : '挂账' }}</el-tag>
              <span v-else class="none">—</span>
            </template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip>
            <template #default="{ row }">{{ row.remark || (row.role === 'offset-target' ? '被抵扣欠款' : row.role === 'return' ? '退货结算' : '—') }}</template>
          </el-table-column>
        </el-table>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import TableToolbar from '../components/TableToolbar.vue'
import { downloadCSV } from '../utils/export'
import { VOUCHER_CATEGORY } from '../utils/voucherFlow'

const loading = ref(true)
const tab = ref('receipts')
const receipts = ref([])
const vouchers = ref([])
const refunds = ref([])
// 集合读取失败标记：以前失败会被静默吞掉，页面只显示「暂无收款单」，
// 让人以为「一张单据都没生成」，实际是数据仓里还没有 receipts.json（GET 直接 500）
const loadError = ref('')
const route = useRoute(), router = useRouter()
const current = computed(() => {
  const row = [...receipts.value, ...vouchers.value, ...refunds.value].find(v => v.code === route.query.code)
  return row ? { ...row, items: enrichedItems(row) } : null
})
const drawer = computed({
  get: () => !!current.value,
  set: open => {
    if (!open) {
      const { code, ...query } = route.query
      router.replace({ path: route.path, query })
    }
  }
})
watch(current, row => {
  if (row) tab.value = row.kind === 'refund' || /^(TK|HX)-/.test(row.code)
    ? (row.category === 'refund' ? 'refunds' : 'settlements')
    : (row.kind === 'receivable' || row.code.startsWith('SK-') ? 'receipts' : 'payment-vouchers')
})
// 源单据日期/备注：用于抽屉明细展示（单号链接 + 日期 + 备注，避免单据内重复存冗余）
const orderMeta = ref({})

const tabLabel = computed(() => ({ receipts: '收款单', 'payment-vouchers': '付款单', refunds: '退款单', settlements: '退货核销单' })[tab.value])
const currentList = computed(() => tab.value === 'receipts' ? receipts.value : tab.value === 'payment-vouchers' ? vouchers.value : refunds.value.filter(v => tab.value === 'refunds' ? v.category === 'refund' : v.category !== 'refund'))

// 时间段筛选（按单据日期）+ 往来单位筛选：清空后回退为全量
const dateRange = ref(null)
const partyFilter = ref('')
const filteredList = computed(() => {
  let out = currentList.value
  if (dateRange.value && dateRange.value.length) {
    const [s, e] = dateRange.value
    out = out.filter(v => v.date >= s && v.date <= e)
  }
  if (partyFilter.value) out = out.filter(v => v.party === partyFilter.value)
  // 默认按单据日期倒序（最新在前），同日按单据编码倒序
  return [...out].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.code || '').localeCompare(a.code || ''))
})
const page = ref(1), pageSize = ref(20)
const pagedList = computed(() => filteredList.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
watch([tab, dateRange, partyFilter, pageSize], () => { page.value = 1 })
watch(() => filteredList.value.length, count => {
  page.value = Math.min(page.value, Math.max(1, Math.ceil(count / pageSize.value)))
})
const sumTotal = computed(() => filteredList.value.reduce((a, v) => a + Number(v.total || 0), 0))
// 往来单位下拉选项（收款单 + 付款单去重）
const partyOptions = computed(() => [...new Set([...receipts.value, ...vouchers.value, ...refunds.value].map(v => v.party).filter(Boolean))])
// 累计总览（全部，不随筛选变化）：收款单合计 / 付款单合计 / 净额
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const receiptSum = computed(() => (receipts.value || []).reduce((s, v) => s + Number(v.total || 0), 0))
const voucherSum = computed(() => (vouchers.value || []).reduce((s, v) => s + Number(v.total || 0), 0))
const refundIn = computed(() => refunds.value.filter(v => v.category === 'refund' && v.direction === 'from_supplier').reduce((s, v) => s + v.total, 0))
const refundOut = computed(() => refunds.value.filter(v => v.category === 'refund' && v.direction === 'to_customer').reduce((s, v) => s + v.total, 0))
const netSum = computed(() => round2(receiptSum.value - voucherSum.value + refundIn.value - refundOut.value))

const listColumns = [
  { label: '资金单据编号', prop: 'code' },
  { label: '类别', value: r => categoryLabel(r) },
  { label: '往来单位', prop: 'party' },
  { label: '日期', prop: 'date' },
  { label: '本次金额', value: r => Number(r.total || 0).toFixed(2) },
  { label: '备注', prop: 'remark' }
]
const subtitle = computed(() => `${tabLabel.value}共 ${filteredList.value.length} 张 · 合计 ¥${sumTotal.value.toFixed(2)}`)

// 抽屉明细行：补上源单据的日期与备注（与 Vouchers 单据模型一致，remark 置末列）
function enrichedItems(voucher) {
  return (voucher.items || []).map(it => {
    const orderType = it.orderType || (voucher.kind === 'receivable' || voucher.code.startsWith('SK-') || voucher.direction === 'to_customer' ? 'sale' : 'purchase')
    const meta = orderMeta.value[`${orderType}:${it.orderId}`] || {}
    return { ...it, orderType, date: meta.date || it.date || '', remark: it.remark || meta.remark || '' }
  })
}

function openDrawer(row) {
  if (!row || !row.code) return
  router.push({ path: '/vouchers', query: { ...route.query, code: row.code } })
}

// 业务子类别保持独立，普通单据按收付方向分别命名。
function categoryLabel(row) {
  const type = row.kind === 'receivable' || row.code?.startsWith('SK-') ? '收款单' : '付款单'
  if (!row.category || row.category === 'normal') return type
  return ({ refund: '现金退款', 'return-offset': '退货抵欠款', 'return-deposit': '退货转余额' })[row.category] || VOUCHER_CATEGORY[row.category] || type
}
function categoryTagType(cat) {
  if (cat === 'deposit-recharge') return 'warning'
  if (cat === 'deposit-over') return 'info'
  if (cat === 'deposit-deduct') return 'success'
  return ''
}

// 导出当前查看的单据明细（单号 / 日期 / 本次金额 / 本次优惠 / 结算 / 备注）
const voucherColumns = [
  { label: '单号', prop: 'orderId' },
  { label: '日期', prop: 'date' },
  { label: '本次金额', value: r => Number(r.amount || 0).toFixed(2) },
  { label: '本次优惠', value: r => Number(r.discount || 0) > 0 ? Number(r.discount).toFixed(2) : '' },
  { label: '结算', value: r => r.settle ? '结清' : '挂账' },
  { label: '备注', prop: 'remark' }
]
function exportVoucher() {
  if (!current.value) return ElMessage.warning('请先打开一张单据')
  const rows = current.value.items
  downloadCSV(`${current.value.code}.csv`, voucherColumns, rows)
  ElMessage.success('已导出本单明细')
}

onMounted(async () => {
  // 资金单据集合是本页的主体：读失败一定要报出来，不能装作「暂无单据」
  try {
    const [rec, pv, rf] = await Promise.all([api.getReceipts(), api.getPaymentVouchers(), api.getRefunds()])
    receipts.value = rec || []
    vouchers.value = pv || []
    refunds.value = rf || []
    loadError.value = ''
  } catch (e) {
    receipts.value = []
    vouchers.value = []
    loadError.value = (e && e.message) || '网络异常'
    ElMessage.error({
      message: `收付款单读取失败：${loadError.value}（若数据仓里还没有 receipts.json / payment-vouchers.json，请先执行一次收付款或刷新重试）`,
      duration: 8000
    })
  }
  // 源单据只用于抽屉里显示单号日期/备注：取不到不影响列表本身
  try {
    const [sales, purchases] = await Promise.all([api.getSales(), api.getPurchases()])
    const meta = {}
    ;(sales || []).forEach(s => { meta[`sale:${s.id}`] = { date: s.date, remark: s.remark } })
    ;(purchases || []).forEach(p => { meta[`purchase:${p.id}`] = { date: p.date, remark: p.remark } })
    orderMeta.value = meta
  } catch (e) {
    ElMessage.warning({ message: `关联单据信息读取失败（${(e && e.message) || '网络异常'}），明细里的日期/备注可能显示为空`, duration: 6000 })
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.header-sub { color: var(--text-secondary); font-size: var(--fs-sub); font-weight: 400; }
.vtabs { margin-bottom: 12px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
.stat-item { padding: 12px 16px; background:var(--bg-stat); border-radius: 8px; min-width: 0; }
.stat-item .el-statistic__head,
.stat-item .el-statistic__content { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-sub { margin-top: 4px; color:var(--text-secondary); font-size:var(--fs-sub); }
.filter-label { color:var(--text-regular); font-size:var(--fs-base); }
.filter-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.filter-hint { color: var(--text-secondary); font-size: var(--fs-sub); }
.sum-bar { margin-top: 10px; text-align: right; color: var(--text-secondary); font-size: var(--fs-sub); }
.sum-bar b { color: var(--color-primary); font-size: 14px; }
.sum-note { margin-left: 8px; }
.table-wrap { margin-bottom: 12px; }
.voucher-pagination { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
.vh { margin-bottom: 12px; }
.drawer-toolbar { margin-bottom: 10px; }
.v-items :deep(.el-table) { font-size: var(--fs-sub); }
.link { color: var(--color-primary); text-decoration: none; }
.link:hover { text-decoration: underline; }
</style>
