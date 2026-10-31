<template>
  <div>
    <!-- 整页开单（/orders/new，按钮已去掉，仅保留路由供书签/外链直接打开）：
         同一份列表组件只留订单表单，过账、订金、状态迁移等链路仍走这里 -->
    <el-card v-if="!entry" v-loading="loading">
      <template #header>
        <div class="card-header">
          <b>订单</b>
          <div class="header-ops">
            <!-- 清空未过账订单：一次请求删干净，避免几十张草稿各写一次 git 提交；
                 已过账与已收订金的订单会保留（前者连着正式单据、后者凭证已开），数量见按钮 -->
            <el-button type="danger" :disabled="!draftCount || busy || loading"
              title="删除未过账且未收订金的订单；已过账 / 已收订金的会保留" @click="clearDrafts">
              清空未过账订单{{ draftCount ? `（${draftCount}）` : '' }}
            </el-button>
            <el-button @click="openTemplatePicker">从模板导入</el-button>
            <el-button type="primary" @click="openCreate">新建订单</el-button>
          </div>
        </div>
      </template>
      <el-alert type="info" :closable="false" show-icon
        title="订单是未过账单据：不占库存、不计应收/应付。收订金会开真实收款单；点「过账」才生成正式销售/采购单。" />
      <el-input v-model="keyword" clearable placeholder="搜索订单号 / 往来单位 / 商品" class="search-input" />
      <div class="filter-row">
        <span class="filter-label">状态</span>
        <el-select v-model="status" style="width:170px">
          <el-option value="all" label="显示全部订单" />
          <el-option value="draft" label="仅显示未过账订单" />
          <el-option value="posted" label="仅显示已过账订单" />
        </el-select>
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
      <!-- 勾选后批量操作：打印列表 / 打印详情（可直接打印或隐藏金额）/ 批量删除 -->
      <div class="export-bar">
        <!-- 纸张只有一个来源：「打印设置」，所以这里也只剩一个打印按钮 -->
        <el-button size="small" :disabled="!selected.length" @click="printSelectedList()">打印勾选订单列表</el-button>
        <el-button size="small" :disabled="!selected.length" @click="openDetailPrint">打印勾选订单详情页</el-button>
        <el-button size="small" :disabled="!paged.length" @click="exportPageCsv">导出CSV（当前页）</el-button>
        <el-button size="small" type="danger" plain :disabled="!selected.length || busy" @click="removeSelected">
          删除勾选{{ selected.length ? `（${selected.length}）` : '' }}
        </el-button>
        <!-- 跨页是否重复商品表头：行打印、列表打印、批量详情打印都用这一个选择 -->
        <PrintHeaderToggle />
        <span class="sel-hint">已勾选 {{ selected.length }} 单 / 本页 {{ paged.length }} 单</span>
      </div>
      <div class="table-wrap">
        <el-table ref="tableRef" :data="paged" row-key="id" stripe show-summary :summary-method="summaryAmount"
          @selection-change="onSelectionChange">
          <el-table-column type="selection" width="46" reserve-selection />
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
              <el-tag :type="row.status === POSTED ? 'success' : 'warning'" size="small" disable-transitions>{{ orderStatusText(row.status) }}</el-tag>
              <router-link v-if="row.postedOrderId" :to="`${row.kind === 'purchase' ? '/purchase/' : '/sale/'}${row.postedOrderId}`" class="link posted-link">{{ row.postedOrderId }}</router-link>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="640" class-name="ops-col">
            <template #default="{ row }">
              <el-button size="small" type="primary" :disabled="row.status === POSTED" @click="openEdit(row)">编辑</el-button>
              <el-button size="small" type="success" :disabled="row.status === POSTED" @click="openDeposit(row)">收订金</el-button>
              <el-button size="small" type="warning" :disabled="row.status === POSTED || busy" @click="post(row)">过账</el-button>
              <el-button size="small" :disabled="row.status !== POSTED || busy" @click="unpost(row)">撤销过账</el-button>
              <el-button size="small" type="danger" :disabled="row.status === POSTED || busy" @click="remove(row)">删除</el-button>
              <el-button size="small" plain @click="openRemark(row)">备注</el-button>
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

    <!-- 整页开单占位：数据还在路上就说「正在准备」，加载失败才给返回入口（ready 只在成功时置真） -->
    <el-card v-if="entry && !dialog">
      <div class="entry-loading">
        <template v-if="loading">正在准备开单…</template>
        <template v-else>订单数据未能加载，无法开单。<el-button size="small" @click="$router.replace('/orders')">返回列表</el-button></template>
      </div>
    </el-card>

    <OrderFormDialog
      v-model="dialog"
      :order="editingOrder"
      :items="itemOptions"
      :customers="customerOptions"
      :suppliers="supplierOptions"
      :saving="saving"
      :standalone="entry"
      @saved="onFormSaved"
    />

    <!-- 轻量补备注：只改 remark 字段，已过账的订单也能补 -->
    <OrderRemarkDialog v-model="remarkDialog" :order="remarkOrder"
      placeholder="例如：客户要求月底前交货、发票待补、尾款下周付…" @saved="onRemarkSaved" />

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

    <!-- 打印勾选订单详情页：直接打印 or 隐藏金额打印（单价、折扣、合计、订金等全部金额都不出现） -->
    <el-dialog v-model="detailPrintDialog" title="打印勾选订单详情页" width="420" :close-on-click-modal="false">
      <div class="print-choice">
        <p class="print-hint">将打印 {{ selected.length }} 张订单，每张单独起一页{{ repeatHeaderPref ? '（明细超过一页时自动续页并重复表头）' : '（明细不切片，商品表头只印在每张单据的第一页）' }}。</p>
        <!-- 纸张与跨页表头都来自「打印设置」（全局同一份偏好），这里只留打印动作 -->
        <div class="print-paper">
          <!-- 批量打印每张单的标头字段数略有差异，面板按第一张勾选的单据估算标头行数 -->
          <PrintHeaderToggle
            :head-title="batchHeadSample.title"
            :head-subtitle="batchHeadSample.subtitle"
            :head-fields="batchHeadSample.fields" />
        </div>
        <el-button type="primary" class="print-btn" @click="printSelectedDetails(false)">直接打印</el-button>
        <el-button class="print-btn" @click="printSelectedDetails(true)">隐藏金额打印</el-button>
        <p class="print-note">隐藏金额会把单价、折扣、行金额、订单金额、订金、未收/未付等所有金额信息一并去掉。</p>
      </div>
      <template #footer>
        <el-button @click="detailPrintDialog = false">取消</el-button>
      </template>
    </el-dialog>

    <!-- 从订单模板导入：选一个模板 → 把它的商品明细预填进「新建订单」表单，
         客户/日期/整单折扣仍在表单里现场填，导入后可以先改再保存（不是直接落库） -->
    <el-dialog v-model="templatePicker" title="从订单模板导入" width="680" :close-on-click-modal="false">
      <el-table v-loading="templatesLoading" :data="templates" max-height="360"
        empty-text="还没有模板，请先到「订单模板」页新建">
        <el-table-column label="模板名称" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{ row.name }}</template>
        </el-table-column>
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag :type="row.kind === 'purchase' ? 'info' : 'success'" size="small" disable-transitions>
              {{ row.kind === 'purchase' ? '采购' : '销售' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="商品数" width="90" align="right">
          <template #default="{ row }">{{ (row.items || []).length }}</template>
        </el-table-column>
        <el-table-column label="金额" width="120" align="right">
          <template #default="{ row }">¥ {{ templateAmount(row).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="110">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="importTemplate(row)">导入</el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="$router.push('/templates')">去维护模板</el-button>
        <el-button @click="templatePicker = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
// 新页面开单：/orders/new 复用本页组件，只靠路由 meta 切换成整页表单
import { useEntryMode } from '../utils/entryMode'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'
import { lineDisplayName, itemNameMap, normalizeRate } from '../utils/catalog'
import { round2, discountRatesTextOf, effectiveRateOf, allocateUnitOf } from '../utils/account'
import { downloadCSV, printA4, printA4Sections, joinLimited } from '../utils/export'
import { repeatHeaderPref } from '../utils/printPrefs'
import PrintHeaderToggle from '../components/PrintHeaderToggle.vue'
import { orderAmount, orderDepositSum, orderStatusText, isUnposted, LEGACY_DRAFT, POSTED, orderKeys } from '../utils/orders.js'
import { todayCN, orderTimeOf } from '../utils/time.js'
import OrderFormDialog from '../components/OrderFormDialog.vue'
import OrderRemarkDialog from '../components/OrderRemarkDialog.vue'

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
// 默认只看未过账订单；已过账的要切到「仅显示已过账订单」或「显示全部订单」才看得到
const status = ref('draft')
const kind = ref('all')
const dateStart = ref('')
const dateEnd = ref('')
const page = ref(1)
const dialog = ref(false)
// 整页开单（/orders/new）：隐藏列表、订单表单铺满屏幕；保存仍走本页的 orderOperation，不另写开单页
const { entry, backToList } = useEntryMode('/orders')
const editingOrder = ref(null)
const depositDialog = ref(false)
const depositOrder = ref(null)
const depositForm = ref({ amount: 0, date: todayCN(), remark: '' })
const tableRef = ref(null)
const selected = ref([])
const detailPrintDialog = ref(false)
// 批量打印详情页的纸张：选一次，直接打印 / 隐藏金额打印都用它
// 从模板导入：模板列表按需拉一次（打开选择框时才请求，不拖慢订单列表首屏）
const templatePicker = ref(false)
const templates = ref([])
const templatesLoading = ref(false)
const remarkDialog = ref(false)
const remarkOrder = ref(null)

const partyOf = (row) => (row && row.kind === 'purchase' ? row.supplier : row && row.customer) || ''
const depositSumOf = (row) => orderDepositSum(row)
const nameMap = computed(() => itemNameMap(itemOptions.value))
const itemNamesOf = (row) => [...new Set((row.items || []).map(i => lineDisplayName(i, nameMap.value)).filter(Boolean))]

const filtered = computed(() => list.value
  .filter(row => {
    if (status.value === 'draft' && !isUnposted(row.status)) return false
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
// 换筛选条件后旧勾选可能已经不在列表里，直接清空，避免「看不见的单被打印/删除」
watch([keyword, status, kind, dateStart, dateEnd], () => {
  page.value = 1
  tableRef.value?.clearSelection()
  selected.value = []
})

const summaryAmount = ({ columns }) => {
  const rows = filtered.value
  return columns.map((c) => {
    if (c.label === '订单号') return `合计（${rows.length} 单，未过账 ${rows.filter(r => r.status !== POSTED).length}）`
    if (c.label === '订单金额') return rows.reduce((s, r) => s + orderAmount(r), 0).toFixed(2)
    return ''
  })
}
const STATUS_TEXT = { all: '显示全部订单', draft: '仅显示未过账订单', posted: '仅显示已过账订单' }
const subtitle = computed(() => {
  const parts = [`共 ${filtered.value.length} 单`, STATUS_TEXT[status.value]]
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
  { label: '状态', value: r => orderStatusText(r.status) },
  { label: '过账单号', prop: 'postedOrderId' },
  { label: '备注', prop: 'remark' }
]
// 打印时商品名称最多留 3 个，其余用省略号，避免一个单元格把页面撑开；CSV 仍导出完整清单
const printColumns = exportColumns.map(c => (c.label === '商品' ? { ...c, value: r => joinLimited(itemNamesOf(r)) } : c))

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
// 行级折扣：有才打印「折扣率 / 折扣金额」两列
const hasLineDiscountOf = (row) => (row.items || []).some(l => {
  const r = Number(l.discountRate)
  return Number(l.discount || 0) > 0 || (Number.isFinite(r) && r > 0 && r < 1)
})
// 明细行附加「摊完整单折扣后的金额 / 单价」，各行金额合计与单头折后金额一致
// 单价只是行金额÷数量的换算，不参与任何加总，所以不会把总额带偏
const lineRowsWithNet = (row) => {
  const items = row.items || []
  const { nets, units } = allocateUnitOf(items.map(lineTotal), items.map(l => Number(l.qty || 0)), effectiveRateOf(row))
  return items.map((l, i) => ({ ...l, _net: nets[i], _unitNet: units[i] }))
}

// 单张订单的明细列：订单行没有单位/备注，只打真实的字段；
// 没有行折扣时隐藏「折扣率 / 折扣金额」，有整单折扣时追加「折后单价 / 折后金额」
const orderLineColumnsFor = (row) => {
  const cols = [
    { label: '编码', prop: 'code' },
    { label: '名称', value: r => lineDisplayName(r, nameMap.value) },
    { label: '数量', value: r => Number(r.qty || 0) },
    { label: '单价', value: r => Number(r.price || 0).toFixed(2) }
  ]
  if (hasLineDiscountOf(row)) {
    cols.push(
      { label: '折扣率', value: r => lineRate(r).toFixed(2) },
      { label: '折扣金额', value: r => lineDiscount(r).toFixed(2) }
    )
  }
  cols.push({ label: '本次金额', value: r => lineTotal(r).toFixed(2) })
  if (discountRatesTextOf(row)) {
    cols.push(
      { label: '折后单价', value: r => Number(r._unitNet || 0).toFixed(2) },
      { label: '折后金额', value: r => Number(r._net || 0).toFixed(2) }
    )
  }
  return cols
}

// 单头信息：与屏幕上的口径一致；业务单号单独一行，打印出去能对上客户/供应商那边的单号
const orderHeaderFields = (row) => {
  const fields = [
    ['订单号', row.id],
    ['业务单号', row.no && row.no !== row.id ? row.no : '—'],
    [row.kind === 'purchase' ? '供应商' : '客户', partyOf(row) || '—'],
    ['日期', row.date],
    ['状态', orderStatusText(row.status)]
  ]
  if (row.postedOrderId) fields.push(['关联单据', row.postedOrderId])
  if (linesDiscountTotal(row) > 0) {
    fields.push(['原价合计', `¥${linesGrossTotal(row).toFixed(2)}（单项折扣 -¥${linesDiscountTotal(row).toFixed(2)}）`])
  }
  if (discountRatesTextOf(row)) fields.push(['整单折扣', `${discountRatesTextOf(row)}（减 ¥${orderRateDiscount(row).toFixed(2)}）`, 'hl'])
  if (Number(row.discount || 0) > 0) fields.push(['整单优惠', `¥${Number(row.discount).toFixed(2)}`])
  fields.push(
    // 订单金额放大到两倍：批量打印多张订单详情时，一眼能看清每张单的成交金额
    ['订单金额', `¥${orderAmount(row).toFixed(2)}`, 'xl'],
    ['已收订金', `¥${depositSumOf(row).toFixed(2)}`],
    [row.kind === 'purchase' ? '未付' : '未收', `¥${owedOf(row).toFixed(2)}`],
    ['备注', row.remark || '—']
  )
  return fields
}

function exportOrderCsv(row) {
  const items = row.items || []
  if (!items.length) return ElMessage.warning('该订单没有商品明细')
  downloadCSV(`${row.kind === 'purchase' ? '采购' : '销售'}订单-${row.id}.csv`, orderLineColumnsFor(row), lineRowsWithNet(row), orderHeaderFields(row))
  ElMessage.success(`已导出 ${items.length} 行`)
}

function printOrder(row) {
  const items = row.items || []
  if (!items.length) return ElMessage.warning('该订单没有商品明细')
  const title = `${row.kind === 'purchase' ? '采购' : '销售'}订单 ${row.id}`
  printA4(title, orderLineColumnsFor(row), lineRowsWithNet(row), `共 ${items.length} 项商品`, orderHeaderFields(row), [], '', repeatHeaderPref.value)
}

// ---- 勾选后的批量操作 ----
function onSelectionChange(rows) { selected.value = rows }
// 勾选的订单可能跨页（表格开了 reserve-selection），统一按时间倒序排列后再打印
const selectedSorted = computed(() => [...selected.value].sort((a, b) =>
  String(orderTimeOf(b)).localeCompare(String(orderTimeOf(a))) || String(b.id || '').localeCompare(String(a.id || ''))))

function exportPageCsv() {
  if (!paged.value.length) return ElMessage.warning('当前页没有可导出的订单')
  downloadCSV('订单.csv', exportColumns, paged.value)
  ElMessage.success(`已导出当前页 ${paged.value.length} 行`)
}

function printSelectedList() {
  const rows = selectedSorted.value
  if (!rows.length) return ElMessage.warning('请先勾选订单')
  const total = round2(rows.reduce((s, r) => s + orderAmount(r), 0))
  printA4('订单列表', printColumns, rows, `勾选 ${rows.length} 单 · 订单金额合计 ¥${total.toFixed(2)}`, [], [], '', repeatHeaderPref.value)
}

function openDetailPrint() {
  if (!selected.value.length) return ElMessage.warning('请先勾选订单')
  detailPrintDialog.value = true
}

// 隐藏金额的明细列：只保留编码/名称/数量，单价、折扣率、折扣金额、折后金额一律不出现
const maskedLineColumns = [
  { label: '编码', prop: 'code' },
  { label: '名称', value: r => lineDisplayName(r, nameMap.value) },
  { label: '数量', value: r => Number(r.qty || 0) }
]
// 隐藏金额的单头：订单号、业务单号、往来单位、日期、关联单据、备注；不含金额，也不显示内部状态
const maskedHeaderFields = (row) => {
  const fields = [
    ['订单号', row.id],
    ['业务单号', row.no && row.no !== row.id ? row.no : '—'],
    [row.kind === 'purchase' ? '供应商' : '客户', partyOf(row) || '—'],
    ['日期', row.date]
  ]
  if (row.postedOrderId) fields.push(['关联单据', row.postedOrderId])
  fields.push(['备注', row.remark || '—'])
  return fields
}

// 打印设置面板估算标头行数用：取第一张勾选订单的标题/副标题/单头字段
const batchHeadSample = computed(() => {
  const row = selected.value[0]
  if (!row) return { title: '', subtitle: '', fields: [] }
  return {
    title: `${row.kind === 'purchase' ? '采购' : '销售'}订单 ${row.id}`,
    subtitle: `共 ${(row.items || []).length} 项商品`,
    fields: orderHeaderFields(row)
  }
})

// 每张订单单独一页；masked=true 时所有金额字段（单价/折扣/合计/订金/未收）都不进打印
function printSelectedDetails(masked) {  const rows = selectedSorted.value
  if (!rows.length) return ElMessage.warning('请先勾选订单')
  const sections = rows.map(row => {
    const items = row.items || []
    return {
      title: `${row.kind === 'purchase' ? '采购' : '销售'}订单 ${row.id}`,
      subtitle: `共 ${items.length} 项商品`,
      headerFields: masked ? maskedHeaderFields(row) : orderHeaderFields(row),
      columns: masked ? maskedLineColumns : orderLineColumnsFor(row),
      rows: masked ? items : lineRowsWithNet(row)
    }
  })
  detailPrintDialog.value = false
  printA4Sections(sections, masked ? '订单详情（隐藏金额）' : '订单详情', '', repeatHeaderPref.value)
}

// 批量删除：一次请求、一次提交；已过账/已收订金的由服务端跳过并回报数量
async function removeSelected() {
  const rows = selected.value
  if (!rows.length) return
  try {
    await ElMessageBox.confirm(
      `将批量删除勾选的 ${rows.length} 张订单（已过账 / 已收订金的会自动跳过），删除后不可恢复。`,
      '删除勾选订单', { type: 'warning', confirmButtonText: `删除 ${rows.length} 张` }
    )
  } catch { return }
  busy.value = true
  try {
    const r = await api.orderOperation({ action: 'deleteMany', orderIds: rows.map(o => o.id) })
    ElMessage.success(`已删除 ${r.removed || 0} 张订单${r.skipped ? `，跳过 ${r.skipped} 张（已过账 / 已收订金）` : ''}`)
    tableRef.value?.clearSelection()
    selected.value = []
    await load()
  } catch (e) { fail(e, '删除失败') } finally { busy.value = false }
}

// 历史状态迁移：早期订单状态存的是「草稿」，进订单页时静默改写成「未过账」（成功一次即止，失败下次再试）
let legacyMigrating = false

async function load() {
  loading.value = true
  try {
    const [o, it, cu, sup] = await Promise.all([api.getOrders(), api.getItems(), api.getCustomers(), api.getSuppliers()])
    let orders = o || []
    if (!legacyMigrating && orders.some(x => x.status === LEGACY_DRAFT)) {
      legacyMigrating = true
      try {
        await api.orderOperation({ action: 'migrateStatus' })
        orders = await api.getOrders() || []
      } catch { legacyMigrating = false }
    }
    list.value = orders
    itemOptions.value = it || []
    customerOptions.value = cu || []
    supplierOptions.value = sup || []
    ready.value = true
    // 数据重新拉取后旧的勾选对象已经过期（可能已删除/已过账），统一清空
    tableRef.value?.clearSelection()
    selected.value = []
  } catch (e) {
    ElMessage.error({ message: `订单数据加载失败（${e.message || '网络异常'}），请退出本页重新进入`, duration: 6000 })
  } finally { loading.value = false }
}

function openCreate() { editingOrder.value = null; dialog.value = true }
function openEdit(row) { editingOrder.value = row; dialog.value = true }
function openRemark(row) { remarkOrder.value = row; remarkDialog.value = true }

// ---- 从订单模板导入 ----
// 模板只存「数量 / 单价 / 行折扣率」，金额一律按订单口径现场算，
// 与订单模板页、转订单三条路径共用同一算法，不存在两套数字。
function templateAmount(tpl) {
  const items = (tpl.items || []).map(l => {
    const gross = round2(Number(l.qty || 0) * Number(l.price || 0))
    const rate = normalizeRate(l, gross)
    return { ...l, total: Math.max(0, round2(gross - round2(gross * (1 - rate)))) }
  })
  return orderAmount({ items, discountRates: [], discount: 0 })
}

async function openTemplatePicker() {
  templatePicker.value = true
  // 已经取过就不再打接口：订单页是高频页，模板列表在一次进入里基本不会变
  if (templates.value.length || templatesLoading.value) return
  templatesLoading.value = true
  try {
    const r = await api.getTemplates()
    // 接口给的是 { templates: [...] } 包裹结构（与 /shares 一致），不是裸数组
    templates.value = (r && r.templates) || []
  } catch (e) {
    ElMessage.error(`模板加载失败：${e.message || '网络异常'}`)
  } finally {
    templatesLoading.value = false
  }
}

// 导入 = 用模板明细预填「新建订单」表单（不带 id，所以表单仍按新建处理）：
// 客户、日期、整单折扣都留给用户现场填，改完再保存，不会一点就落库
function importTemplate(tpl) {
  const items = (tpl.items || []).map(l => {
    const gross = round2(Number(l.qty || 0) * Number(l.price || 0))
    const rate = normalizeRate(l, gross)
    return {
      code: l.code, name: l.name, unit: l.unit,
      qty: Number(l.qty || 0), price: Number(l.price || 0),
      discountRate: rate,
      discountRates: Array.isArray(l.discountRates) && l.discountRates.length ? l.discountRates.map(Number) : []
    }
  })
  if (!items.length) return ElMessage.warning('该模板没有商品明细')
  templatePicker.value = false
  editingOrder.value = {
    kind: tpl.kind === 'purchase' ? 'purchase' : 'sale',
    date: todayCN(),
    items,
    discountRates: [],
    discount: 0,
    remark: `来自模板「${tpl.name}」`
  }
  dialog.value = true
}

// 整页开单的进出：直接打开 /orders/new 时组件实例被复用，靠 watch(entry) 打开表单；
// 直接访问 /orders/new 走 onMounted（数据取齐后再开）；表单一关就回列表。
// 注意不能把自动开窗放进 load()：保存成功后也会 load()，那时路由还在切回列表，
// 会把刚存完的页面又顶开一张空表单。
watch(entry, (v) => { if (v) openCreate() })
watch(dialog, (v) => { if (!v) backToList() })

// 备注只改 remark：走独立 action，已过账的订单也能补，不碰金额/明细/凭证
async function onRemarkSaved(text) {
  const row = remarkOrder.value
  if (!row) return
  busy.value = true
  try {
    await api.orderOperation({ action: 'remark', orderId: row.id, remark: text })
    remarkDialog.value = false
    ElMessage.success(text ? '已保存备注' : '已清空备注')
    await load()
  } catch (e) { fail(e, '备注保存失败') } finally { busy.value = false }
}
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
    await ElMessageBox.confirm('撤销过账会把生成的单据删掉、订单退回未过账。已收过款的单据不允许撤销。是否继续？', '撤销过账', { type: 'warning' })
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

// 清空未过账订单：只删「未过账 + 没收过订金」的单（未过账但收过订金的凭证已开，删了会成孤儿），
// 按钮上的数字就是真会删掉的张数，确认框再把保留原因说清楚
async function clearDrafts() {
  const n = draftCount.value
  if (!n) return
  const keptDeposit = list.value.filter(o => o.status !== POSTED && orderDepositSum(o) > 0).length
  try {
    await ElMessageBox.confirm(
      `将删除 ${n} 张未过账订单，删除后不可恢复。${keptDeposit ? `另有 ${keptDeposit} 张未过账订单因已收订金会保留；` : ''}已过账订单不受影响。`,
      '清空未过账订单', { type: 'warning', confirmButtonText: '全部删除' }
    )
  } catch { return }
  busy.value = true
  try {
    const r = await api.orderOperation({ action: 'clearDrafts' })
    ElMessage.success(`已清空 ${r.removed || 0} 张未过账订单${r.skipped ? `，保留 ${r.skipped} 张（已过账 / 已收订金）` : ''}`)
    tableRef.value?.clearSelection()
    selected.value = []
    await load()
  } catch (e) { fail(e, '清空未过账订单失败') } finally { busy.value = false }
}

onMounted(async () => {
  await load()
  // 整页开单：数据取齐了才开窗（ready 只在成功时置真，加载失败就留在占位提示，不给一张存不了的表单）
  if (entry.value && ready.value) openCreate()
})
</script>

<style scoped>
.card-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}
.header-ops{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.entry-loading{padding:48px 0;text-align:center;color:var(--text-secondary);}
.search-input{margin:12px 0 12px;max-width:360px;}
.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.filter-label{color:var(--text-regular);font-size:var(--fs-base);}
.filter-sep{color:var(--text-secondary);}
.pager{margin-top:12px;justify-content:flex-end;}
/* 勾选后的批量操作栏（原 TableToolbar 换成勾选驱动） */
.export-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.sel-hint{color:var(--text-secondary);font-size:var(--fs-sub);}
.print-choice{display:flex;flex-direction:column;gap:8px;}
.print-hint{margin:0 0 4px;color:var(--text-regular);}
.print-btn{margin-left:0!important;}
.print-note{margin:8px 0 0;color:var(--text-secondary);font-size:var(--fs-sub);line-height:1.6;}
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
