<template>
  <div v-loading="loading">
    <el-card>
      <template #header>
        <div class="card-header">
          <b>收付款单</b>
          <span class="header-sub">每一笔「记一笔 / 合并收付款」自动生成一张资金单据（收款单 SK- / 付款单 FK-）</span>
        </div>
      </template>

      <el-tabs v-model="tab" class="vtabs">
        <el-tab-pane label="收款单" name="receipts" />
        <el-tab-pane label="付款单" name="payment-vouchers" />
      </el-tabs>

      <TableToolbar
        :filename="`收付款单-${tabLabel}`"
        :title="`收付款单·${tabLabel}`"
        :subtitle="subtitle"
        :columns="listColumns"
        :rows="currentList"
      />
      <div class="table-wrap">
        <el-table :data="currentList" stripe @row-click="openDrawer">
          <el-table-column prop="code" label="单据编码" width="200" show-overflow-tooltip />
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
      <el-empty v-if="!currentList.length" :description="`暂无${tabLabel}`" />
    </el-card>

    <!-- 明细抽屉 -->
    <el-drawer v-model="drawer" :title="current ? current.code : ''" size="600px" direction="rtl">
      <template v-if="current">
        <el-descriptions :column="1" border size="small" class="vh">
          <el-descriptions-item label="单据编码">{{ current.code }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ current.kind === 'receivable' ? '收款单（客户）' : '付款单（供应商）' }}</el-descriptions-item>
          <el-descriptions-item label="往来单位">{{ current.party }}</el-descriptions-item>
          <el-descriptions-item label="日期">{{ current.date }}</el-descriptions-item>
          <el-descriptions-item label="本次金额">¥ {{ Number(current.total || 0).toFixed(2) }}</el-descriptions-item>
          <el-descriptions-item label="备注">{{ current.remark || '—' }}</el-descriptions-item>
        </el-descriptions>
        <div class="drawer-toolbar">
          <el-button size="small" type="primary" @click="exportVoucher">导出本单 CSV</el-button>
        </div>
        <el-table :data="current.items || []" stripe border size="small" class="v-items">
          <el-table-column label="单号" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">
              <router-link :to="row.orderType === 'sale' ? `/sale/${row.orderId}` : `/purchase/${row.orderId}`" class="link">{{ row.orderId }}</router-link>
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
              <el-tag :type="row.settle ? 'success' : 'danger'" size="small" disable-transitions>{{ row.settle ? '结清' : '挂账' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip>
            <template #default="{ row }">{{ row.remark || '—' }}</template>
          </el-table-column>
        </el-table>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import TableToolbar from '../components/TableToolbar.vue'
import { downloadCSV } from '../utils/export'

const loading = ref(true)
const tab = ref('receipts')
const receipts = ref([])
const vouchers = ref([])
const drawer = ref(false)
const current = ref(null)
// 源单据日期/备注：用于抽屉明细展示（单号链接 + 日期 + 备注，避免单据内重复存冗余）
const orderMeta = ref({})

const tabLabel = computed(() => tab.value === 'receipts' ? '收款单' : '付款单')
const currentList = computed(() => (tab.value === 'receipts' ? receipts.value : vouchers.value))

const listColumns = [
  { label: '单据编码', prop: 'code' },
  { label: '往来单位', prop: 'party' },
  { label: '日期', prop: 'date' },
  { label: '本次金额', value: r => Number(r.total || 0).toFixed(2) },
  { label: '备注', prop: 'remark' }
]
const subtitle = computed(() => `共 ${currentList.value.length} 张${tabLabel.value}`)

// 抽屉明细行：补上源单据的日期与备注（与 Vouchers 单据模型一致，remark 置末列）
function enrichedItems(items) {
  return (items || []).map(it => {
    const meta = orderMeta.value[it.orderId] || {}
    return { ...it, date: meta.date || '', remark: meta.remark || '' }
  })
}

function openDrawer(row) {
  if (!row || !row.code) return
  current.value = { ...row, items: enrichedItems(row.items) }
  drawer.value = true
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
  const rows = enrichedItems(current.value.items).map(it => ({
    单号: it.orderId,
    日期: it.date,
    本次金额: Number(it.amount || 0).toFixed(2),
    本次优惠: Number(it.discount || 0) > 0 ? Number(it.discount).toFixed(2) : '',
    结算: it.settle ? '结清' : '挂账',
    备注: it.remark || ''
  }))
  downloadCSV(`${current.value.code}.csv`, voucherColumns, rows)
  ElMessage.success('已导出本单明细')
}

onMounted(async () => {
  try {
    const [rec, pv, sales, purchases] = await Promise.all([
      api.getReceipts(), api.getPaymentVouchers(), api.getSales(), api.getPurchases()
    ])
    receipts.value = rec || []
    vouchers.value = pv || []
    const meta = {}
    ;(sales || []).forEach(s => { meta[s.id] = { date: s.date, remark: s.remark } })
    ;(purchases || []).forEach(p => { meta[p.id] = { date: p.date, remark: p.remark } })
    orderMeta.value = meta
  } catch (e) {
    receipts.value = []
    vouchers.value = []
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.header-sub { color: var(--text-secondary); font-size: var(--fs-sub); font-weight: 400; }
.vtabs { margin-bottom: 12px; }
.table-wrap { margin-bottom: 12px; }
.vh { margin-bottom: 12px; }
.drawer-toolbar { margin-bottom: 10px; }
.v-items :deep(.el-table) { font-size: var(--fs-sub); }
.link { color: var(--color-primary); text-decoration: none; }
.link:hover { text-decoration: underline; }
</style>
