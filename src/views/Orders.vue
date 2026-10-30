<template>
  <div>
    <el-card v-loading="loading">
      <template #header>
        <div class="card-header">
          <b>订单（未过账）</b>
          <div class="header-ops">
            <!-- 清空草稿：一次请求删干净，避免几十张草稿各写一次 git 提交；
                 已过账与已收订金的订单不在其中（前者连着正式单据、后者凭证已开） -->
            <el-button type="danger" :disabled="!draftCount || busy || loading" @click="clearDrafts">
              清空草稿{{ draftCount ? `（${draftCount}）` : '' }}
            </el-button>
            <el-button type="primary" @click="openCreate">新建订单</el-button>
          </div>
        </div>
      </template>
      <el-alert type="info" :closable="false" show-icon
        title="订单只是草稿：不占库存、不计应收/应付。收订金会开真实收款单；点「过账」才生成正式销售/采购单。" />
      <el-input v-model="keyword" clearable placeholder="搜索订单号 / 往来单位 / 商品" class="search-input" />
      <div class="filter-row">
        <span class="filter-label">状态</span>
        <el-radio-group v-model="status">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="draft">草稿</el-radio-button>
          <el-radio-button value="posted">已过账</el-radio-button>
        </el-radio-group>
        <span class="filter-label">类型</span>
        <el-radio-group v-model="kind">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="sale">销售</el-radio-button>
          <el-radio-button value="purchase">采购</el-radio-button>
        </el-radio-group>
        <span class="filter-label">时间段</span>
        <el-date-picker v-model="dateStart" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" style="width:150px" />
        <span class="filter-sep">至</span>
        <el-date-picker v-model="dateEnd" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" style="width:150px" />
        <el-button v-if="dateStart || dateEnd" text type="primary" @click="dateStart=''; dateEnd=''">清除</el-button>
        <el-button :disabled="loading" @click="load">刷新</el-button>
      </div>
      <TableToolbar filename="订单" title="订单" :subtitle="subtitle" :columns="exportColumns" :rows="paged" />
      <div class="table-wrap">
        <el-table :data="paged" stripe show-summary :summary-method="summaryAmount">
          <el-table-column label="订单号" width="210" class-name="id-col">
            <template #default="{ row }">
              <router-link :to="`/order/${row.id}`" class="link">{{ row.id }}</router-link>
              <span v-if="depositSumOf(row) > 0" class="dep-flag" :title="`已收订金 ¥${depositSumOf(row).toFixed(2)}`">订</span>
              <div v-if="row.no && row.no !== row.id" class="biz-no" :title="row.no">业务单号 {{ row.no }}</div>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="90">
            <template #default="{ row }">
              <el-tag :type="row.kind === 'purchase' ? 'info' : 'success'" size="small" disable-transitions>{{ row.kind === 'purchase' ? '采购' : '销售' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="往来单位" min-width="150">
            <template #default="{ row }">{{ partyOf(row) || '—' }}</template>
          </el-table-column>
          <el-table-column label="时间" width="170">
            <template #default="{ row }">{{ orderTimeOf(row) }}</template>
          </el-table-column>
          <el-table-column label="商品" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="itemNamesOf(row).length" class="item-codes">{{ itemNamesOf(row).join('、') }}</span>
              <span v-else class="none">—</span>
            </template>
          </el-table-column>
          <el-table-column label="订单金额" width="120" align="right">
            <template #default="{ row }">{{ orderAmount(row).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="已收订金" width="120" align="right">
            <template #default="{ row }">
              <span v-if="depositSumOf(row) > 0" class="paid">{{ depositSumOf(row).toFixed(2) }}</span>
              <span v-else class="none">—</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="200">
            <template #default="{ row }">
              <el-tag :type="row.status === POSTED ? 'success' : 'warning'" size="small" disable-transitions>{{ row.status }}</el-tag>
              <router-link v-if="row.postedOrderId" :to="`${row.kind === 'purchase' ? '/purchase/' : '/sale/'}${row.postedOrderId}`" class="link posted-link">{{ row.postedOrderId }}</router-link>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="470" class-name="ops-col">
            <template #default="{ row }">
              <el-button size="small" type="primary" :disabled="row.status === POSTED" @click="openEdit(row)">编辑</el-button>
              <el-button size="small" type="success" :disabled="row.status === POSTED" @click="openDeposit(row)">收订金</el-button>
              <el-button size="small" type="warning" :disabled="row.status === POSTED || busy" @click="post(row)">过账</el-button>
              <el-button size="small" :disabled="row.status !== POSTED || busy" @click="unpost(row)">撤销过账</el-button>
              <el-button size="small" type="danger" :disabled="row.status === POSTED || busy" @click="remove(row)">删除</el-button>
              <el-button size="small" plain @click="printOrder(row)">打印</el-button>
              <el-button size="small" plain @click="exportOrderCsv(row)">CSV</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <el-pagination
        v-model:current-page="page"
        :page-size="PAGE_SIZE"
        :total="filtered.length"
        layout="total, prev, pager, next"
        background
        class="pager"
      />
      <el-empty v-if="ready && !filtered.length" description="暂无订单，点右上角「新建订单」开始" />
    </el-card>

    <OrderFormDialog
      v-model="dialog"
      :order="editingOrder"
      :items="itemOptions"
      :customers="customerOptions"
      :suppliers="supplierOptions"
      :saving="saving"
      @saved="onFormSaved"
    />

    <!-- 收订金：直接开一张真实收款单/付款单（SK-/FK-），过账时这笔会搬成单据的第一条流水 -->
    <el-dialog v-model="depositDialog" :title="`收订金 · ${depositOrder?.id || ''}`" width="440" :close-on-click-modal="false">
      <el-form label-width="100px" :disabled="saving">
        <el-form-item label="往来单位"><el-input :model-value="partyOf(depositOrder || {})" disabled /></el-form-item>
        <el-form-item label="订金金额">
          <el-input-number v-model="depositForm.amount" :min="0.01" :precision="2" :controls="false" style="width:180px" />
          <span class="calc-hint" style="margin-left:8px">订单金额 ¥{{ depositOrder ? orderAmount(depositOrder).toFixed(2) : '0.00' }}</span>
        </el-form-item>
        <el-form-item label="日期"><el-date-picker v-model="depositForm.date" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="depositForm.remark" maxlength="200" placeholder="例如：微信定金 / 签约订金" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="saving" @click="depositDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitDeposit">确认收订金</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'
import { lineDisplayName, itemNameMap, normalizeRate } from '../utils/catalog'
import { round2, discountRatesTextOf, effectiveRateOf } from '../utils/account'
import { downloadCSV, printA4 } from '../utils/export'
import { orderAmount, orderDepositSum, DRAFT, POSTED, orderKeys } from '../utils/orders.js'
import { todayCN, orderTimeOf } from '../utils/time.js'
import OrderFormDialog from '../components/OrderFormDialog.vue'
import TableToolbar from '../components/TableToolbar.vue'

const PAGE_SIZE = 60

const list = ref([])
const itemOptions = ref([])
const customerOptions = ref([])
const supplierOptions = ref([])
const loading = ref(true)
const ready = ref(false)
const busy = ref(false)
const saving = ref(false)
// 订金凭证（SK-/FK- 的 items[].orderType === 'order'）在资金单据页点单号会跳到这里并带上订单号，
// 用 route.query.kw 预填关键词，落地就是一行，不用用户在几百张草稿里手搜。
const route = useRoute()
const keyword = ref(String(route.query?.kw || ''))
const status = ref('all')
const kind = ref('all')
const dateStart = ref('')
const dateEnd = ref('')
const page = ref(1)
const dialog = ref(false)
const editingOrder = ref(null)
const depositDialog = ref(false)
const depositOrder = ref(null)
const depositForm = ref({ amount: 0, date: todayCN(), remark: '' })

const partyOf = (row) => (row && row.kind === 'purchase' ? row.supplier : row && row.customer) || ''
const depositSumOf = (row) => orderDepositSum(row)
const nameMap = computed(() => itemNameMap(itemOptions.value))
const itemNamesOf = (row) => [...new Set((row.items || []).map(i => lineDisplayName(i, nameMap.value)).filter(Boolean))]

const filtered = computed(() => list.value
  .filter(row => {
    if (status.value === 'draft' && row.status !== DRAFT) return false
    if (status.value === 'posted' && row.status !== POSTED) return false
    if (kind.value !== 'all' && row.kind !== kind.value) return false
    if (dateStart.value && (row.date || '') < dateStart.value) return false
    if (dateEnd.value && (row.date || '') > dateEnd.value) return false
    if (!matchText(keyword.value, row.id, row.no, partyOf(row), row.date, orderTimeOf(row), row.remark,
      ...itemNamesOf(row), ...(row.items || []).map(i => i.code))) return false
    return true
  })
  .sort((a, b) => String(orderTimeOf(b)).localeCompare(String(orderTimeOf(a))) || String(b.id || '').localeCompare(String(a.id || '')))
)
const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
// 可清空的草稿数：与后端 clearDrafts 的判据一一对应（未过账 + 没收过订金），按钮上的数字就是「真会删掉的张数」
const draftCount = computed(() => list.value.filter(o => o.status !== POSTED && orderDepositSum(o) === 0).length)
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
watch([keyword, status, kind, dateStart, dateEnd], () => { page.value = 1 })

const summaryAmount = ({ columns }) => {
  const rows = filtered.value
  return columns.map((c, idx) => {
    if (idx === 0) return `合计（${rows.length} 单，草稿 ${rows.filter(r => r.status === DRAFT).length}）`
    if (c.label === '订单金额') return rows.reduce((s, r) => s + orderAmount(r), 0).toFixed(2)
    return ''
  })
}
const subtitle = computed(() => {
  const parts = [`共 ${filtered.value.length} 单`, `导出当前第 ${page.value}/${pageCount.value} 页`]
  if (status.value !== 'all') parts.push(status.value === 'draft' ? '仅草稿' : '仅已过账')
  if (kind.value !== 'all') parts.push(kind.value === 'purchase' ? '仅采购' : '仅销售')
  if (dateStart.value || dateEnd.value) parts.push(`${dateStart.value || '不限'} ~ ${dateEnd.value || '不限'}`)
  if (keyword.value) parts.push('已按关键词筛选')
  return parts.join(' · ')
})
const exportColumns = [
  { label: '订单号', prop: 'id' },
  { label: '业务单号', value: r => r.no || '' },
  { label: '类型', value: r => (r.kind === 'purchase' ? '采购' : '销售') },
  { label: '往来单位', value: r => partyOf(r) },
  { label: '时间', value: r => orderTimeOf(r) },
  { label: '商品', value: r => itemNamesOf(r).join('、') },
  { label: '订单金额', value: r => orderAmount(r).toFixed(2) },
  { label: '已收订金', value: r => depositSumOf(r).toFixed(2) },
  { label: '状态', prop: 'status' },
  { label: '过账单号', prop: 'postedOrderId' },
  { label: '备注', prop: 'remark' }
]

// ---- 单张订单打印 / 导出 ----
// 行金额与订单弹窗、正式单据同一口径：原价＝数量×单价，折后＝原价×(1−折扣率)
const lineGross = (l) => round2(Number(l.qty || 0) * Number(l.price || 0))
const lineRate = (l) => normalizeRate(l, lineGross(l))
const lineDiscount = (l) => round2(lineGross(l) * (1 - lineRate(l)))
const lineTotal = (l) => Math.max(0, round2(lineGross(l) - lineDiscount(l)))
const linesGrossTotal = (row) => round2((row.items || []).reduce((s, l) => s + lineGross(l), 0))
const linesNetTotal = (row) => round2((row.items || []).reduce((s, l) => s + lineTotal(l), 0))
const linesDiscountTotal = (row) => round2((row.items || []).reduce((s, l) => s + lineDiscount(l), 0))
const orderRateDiscount = (row) => Math.max(0, round2(linesNetTotal(row) * (1 - effectiveRateOf(row))))
const owedOf = (row) => Math.max(0, round2(orderAmount(row) - depositSumOf(row)))

// 单张订单的明细列：订单行没有单位/备注，只打真实的字段
const orderLineColumns = [
  { label: '编码', prop: 'code' },
  { label: '名称', value: r => lineDisplayName(r, nameMap.value) },
  { label: '数量', value: r => Number(r.qty || 0) },
  { label: '单价', value: r => Number(r.price || 0).toFixed(2) },
  { label: '折扣率', value: r => lineRate(r).toFixed(2) },
  { label: '折扣金额', value: r => lineDiscount(r).toFixed(2) },
  { label: '折后金额', value: r => lineTotal(r).toFixed(2) }
]

// 单头信息：与屏幕上的口径一致；业务单号单独一行，打印出去能对上客户/供应商那边的单号
const orderHeaderFields = (row) => {
  const fields = [
    ['订单号', row.id],
    ['业务单号', row.no && row.no !== row.id ? row.no : '—'],
    [row.kind === 'purchase' ? '供应商' : '客户', partyOf(row) || '—'],
    ['日期', row.date],
    ['状态', row.status]
  ]
  if (row.postedOrderId) fields.push(['关联单据', row.postedOrderId])
  if (linesDiscountTotal(row) > 0) {
    fields.push(['原价合计', `¥${linesGrossTotal(row).toFixed(2)}（单项折扣 -¥${linesDiscountTotal(row).toFixed(2)}）`])
  }
  if (discountRatesTextOf(row)) fields.push(['整单折扣', `${discountRatesTextOf(row)}（减 ¥${orderRateDiscount(row).toFixed(2)}）`])
  if (Number(row.discount || 0) > 0) fields.push(['整单优惠', `¥${Number(row.discount).toFixed(2)}`])
  fields.push(
    ['订单金额', `¥${orderAmount(row).toFixed(2)}`],
    ['已收订金', `¥${depositSumOf(row).toFixed(2)}`],
    [row.kind === 'purchase' ? '未付' : '未收', `¥${owedOf(row).toFixed(2)}`],
    ['备注', row.remark || '—']
  )
  return fields
}

function exportOrderCsv(row) {
  const items = row.items || []
  if (!items.length) return ElMessage.warning('该订单没有商品明细')
  downloadCSV(`${row.kind === 'purchase' ? '采购' : '销售'}订单-${row.id}.csv`, orderLineColumns, items, orderHeaderFields(row))
  ElMessage.success(`已导出 ${items.length} 行`)
}

function printOrder(row) {
  const items = row.items || []
  if (!items.length) return ElMessage.warning('该订单没有商品明细')
  const title = `${row.kind === 'purchase' ? '采购' : '销售'}订单 ${row.id}`
  printA4(title, orderLineColumns, items, `共 ${items.length} 项商品 · ${row.status}`, orderHeaderFields(row))
}

async function load() {
  loading.value = true
  try {
    const [o, it, cu, sup] = await Promise.all([api.getOrders(), api.getItems(), api.getCustomers(), api.getSuppliers()])
    list.value = o || []
    itemOptions.value = it || []
    customerOptions.value = cu || []
    supplierOptions.value = sup || []
    ready.value = true
  } catch (e) {
    ElMessage.error({ message: `订单数据加载失败（${e.message || '网络异常'}），请退出本页重新进入`, duration: 6000 })
  } finally { loading.value = false }
}

function openCreate() { editingOrder.value = null; dialog.value = true }
function openEdit(row) { editingOrder.value = row; dialog.value = true }
function openDeposit(row) {
  depositOrder.value = row
  depositForm.value = { amount: 0, date: todayCN(), remark: '' }
  depositDialog.value = true
}

// 统一错误提示：409 = 基线变了（有人同时在写），5xx = 结果不明，其余直接给服务端的业务原因
function fail(e, fallback) {
  if (e.status === 409) ElMessage.error('数据已被其他操作更新，请点「刷新」后重试')
  else if (e.status && e.status >= 500) ElMessage.error(`${e.message || '网络异常'}，请以「刷新」后的数据为准`)
  else ElMessage.error(e.message || fallback)
}

async function onFormSaved({ draft, isEdit }) {
  saving.value = true
  try {
    const r = await api.orderOperation({ action: 'save', order: draft })
    ElMessage.success(isEdit ? `订单已更新：${r.code}` : `订单已创建：${r.code}`)
    dialog.value = false
    await load()
  } catch (e) { fail(e, '订单保存失败') } finally { saving.value = false }
}

async function submitDeposit() {
  const amount = round2(Number(depositForm.value.amount || 0))
  if (!(amount > 0)) return ElMessage.warning('请填写订金金额（大于 0）')
  saving.value = true
  try {
    const r = await api.orderOperation({ action: 'deposit', orderId: depositOrder.value.id, amount, date: depositForm.value.date, remark: depositForm.value.remark })
    ElMessage.success(`已开${depositOrder.value.kind === 'purchase' ? '付款' : '收款'}单：${r.code}`)
    depositDialog.value = false
    await load()
  } catch (e) { fail(e, '订金登记失败') } finally { saving.value = false }
}

async function post(row) {
  const { listKey } = orderKeys(row.kind)
  try {
    await ElMessageBox.confirm(
      `过账后将生成正式${row.kind === 'purchase' ? '采购' : '销售'}单并计入${listKey === 'purchases' ? '应付' : '应收'}与库存${depositSumOf(row) > 0 ? `，已收订金 ¥${depositSumOf(row).toFixed(2)} 会转为第一笔${row.kind === 'purchase' ? '付款' : '收款'}` : ''}。是否继续？`,
      '确认过账', { type: 'warning' }
    )
  } catch { return }
  busy.value = true
  try {
    const r = await api.orderOperation({ action: 'post', orderId: row.id })
    ElMessage.success(`已过账：${r.code}`)
    await load()
  } catch (e) { fail(e, '过账失败') } finally { busy.value = false }
}

async function unpost(row) {
  try {
    await ElMessageBox.confirm('撤销过账会把生成的单据删掉、订单退回草稿。已收过款的单据不允许撤销。是否继续？', '撤销过账', { type: 'warning' })
  } catch { return }
  busy.value = true
  try {
    const r = await api.orderOperation({ action: 'unpost', orderId: row.id })
    ElMessage.success(`已撤销过账${r.removedDocId ? `，删除单据 ${r.removedDocId}` : ''}`)
    await load()
  } catch (e) { fail(e, '撤销过账失败') } finally { busy.value = false }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`删除订单 ${row.id}？删除后不可恢复（已收订金的订单不能删）。`, '删除订单', { type: 'warning' })
  } catch { return }
  busy.value = true
  try {
    await api.orderOperation({ action: 'delete', orderId: row.id })
    ElMessage.success('订单已删除')
    await load()
  } catch (e) { fail(e, '删除失败') } finally { busy.value = false }
}

// 清空草稿：只删「未过账 + 没收过订金」的单，数量在按钮上已经写清楚，确认框再报一次保留了多少张
async function clearDrafts() {
  const n = draftCount.value
  if (!n) return
  const kept = list.value.length - n
  try {
    await ElMessageBox.confirm(
      `将删除 ${n} 张草稿订单，删除后不可恢复。${kept ? `另有 ${kept} 张不会被删（已过账 / 已收订金的订单）。` : ''}`,
      '清空草稿', { type: 'warning', confirmButtonText: '全部删除' }
    )
  } catch { return }
  busy.value = true
  try {
    const r = await api.orderOperation({ action: 'clearDrafts' })
    ElMessage.success(`已清空 ${r.removed || 0} 张草稿${r.skipped ? `，保留 ${r.skipped} 张（已过账 / 已收订金）` : ''}`)
    await load()
  } catch (e) { fail(e, '清空草稿失败') } finally { busy.value = false }
}

onMounted(load)
</script>

<style scoped>
.card-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}
.header-ops{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.search-input{margin:12px 0 12px;max-width:360px;}
.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.filter-label{color:var(--text-regular);font-size:var(--fs-base);}
.filter-sep{color:var(--text-secondary);}
.pager{margin-top:12px;justify-content:flex-end;}
.link{color:var(--color-primary);cursor:pointer;}
.none{color:var(--text-placeholder);}
.paid{color:var(--color-success);font-weight:600;}
.item-codes{color:var(--text-secondary);}
.calc-hint{color:var(--text-secondary);font-size:var(--fs-sub);}
.posted-link{margin-left:8px;font-size:var(--fs-sub);}
/* 业务单号放在订单号下方一行，不额外占一列宽度 */
.biz-no{margin-top:2px;color:var(--text-secondary);font-size:var(--fs-sub);line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* 订金角标：与补差单徽章同款小尺寸，列表里一眼看出这张订单已经收过钱 */
.dep-flag{display:inline-block;margin-left:4px;padding:0 4px;border-radius:3px;background:var(--color-success);color:#fff;font-size:11px;line-height:16px;vertical-align:middle;}
</style>
