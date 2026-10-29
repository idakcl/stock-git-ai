<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header"><b>销售出库</b><el-button type="primary" @click="openDialog()">新增销售</el-button></div>
      </template>
      <el-input v-model="keyword" clearable placeholder="搜索单号 / 客户 / 商品" class="search-input" />
      <div class="filter-row">
        <span class="filter-label">时间段</span>
        <el-date-picker v-model="dateStart" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" style="width:150px" />
        <span class="filter-sep">至</span>
        <el-date-picker v-model="dateEnd" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" style="width:150px" />
        <el-button v-if="dateStart || dateEnd" text type="primary" @click="dateStart=''; dateEnd=''">清除</el-button>
        <el-button :type="onlyReturns ? 'primary' : 'default'" @click="onlyReturns = !onlyReturns">
          {{ onlyReturns ? '显示全部单据' : '仅显示退款单' }}
        </el-button>
      </div>
      <TableToolbar
        filename="销售单"
        title="销售单"
        :subtitle="subtitle"
        :columns="exportColumns"
        :rows="paged"
      />
      <div class="table-wrap">
      <el-table :data="paged" stripe show-summary :summary-method="summaryAmount">
        <el-table-column label="单号" width="190" class-name="id-col">
          <template #default="{ row }"><router-link :to="`/sale/${row.id}`" class="link" :class="{ 'return-code': isReturn(row) }">{{ row.id }}</router-link></template>
        </el-table-column>
        <el-table-column label="客户" width="150">
          <template #default="{ row }">
            <router-link v-if="customerCodeMap[row.customer]" :to="`/customer/${customerCodeMap[row.customer]}`" class="link">{{ row.customer }}</router-link>
            <span v-else>{{ row.customer }}</span>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ orderTimeOf(row) }}</template>
        </el-table-column>
        <el-table-column label="商品数量" width="100" align="right">
          <template #default="{ row }">{{ orderKindCount(row) }}</template>
        </el-table-column>
        <el-table-column label="商品编码" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="itemCodesOf(row).length" class="item-codes">{{ itemCodesOf(row).join('、') }}</span>
            <span v-else class="none">—</span>
          </template>
        </el-table-column>
        <el-table-column label="应收" width="110" align="right">
          <template #default="{ row }">{{ grossOf(row).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="实收" width="120" align="right">
          <template #default="{ row }">
            <span>{{ receivedSumOf(row).toFixed(2) }}</span>
            <span v-if="(ensurePayments(row, 'received')).length" class="pay-count">（{{ ensurePayments(row, 'received').length }} 笔）</span>
          </template>
        </el-table-column>
        <el-table-column label="优惠" width="100" align="right">
          <template #default="{ row }">
            <span v-if="Number(row.discount || 0) > 0" class="discount" title="抹零优惠，未实际收款">-{{ Number(row.discount).toFixed(2) }}</span>
            <span v-else class="none">—</span>
          </template>
        </el-table-column>
        <el-table-column label="未收" width="110" align="right">
          <template #default="{ row }">
            <span :class="receivableOf(row) > 0 ? 'debt' : 'none'">{{ receivableOf(row).toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结算状态" width="130">
          <template #default="{ row }">
            <el-tag :type="settleLabelOf(row) === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
              {{ settleLabelOf(row) }}
            </el-tag>
            <!-- 未收为 0 且无抹零优惠时不显示；两个改账动作：改结清＝结清未收差额，改挂账＝撤销抹零优惠、恢复未收 -->
            <el-button v-if="!isReturn(row) && settleActionOf(row) !== 'none'" link size="small" type="primary" style="margin-left:4px" @click="toggleSettle(row)">
              {{ settleActionOf(row) === 'settle' ? '改结清' : '改挂账' }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="收付款单" min-width="170" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="voucherCodesOf(row).length" class="voucher-codes"><template v-for="(code, index) in voucherCodesOf(row)" :key="code"><span v-if="index">、</span><router-link :to="{ path: '/vouchers', query: { code } }" class="link" @click.stop>{{ code }}</router-link></template></span>
            <span v-else class="none">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" width="140" show-overflow-tooltip />
        <el-table-column label="操作" width="400" class-name="ops-col">
          <template #default="{ row }"><el-button size="small" @click="$router.push(`/sale/${row.id}`)">查看</el-button><el-button size="small" type="primary" @click="openDialog(row)">编辑</el-button><el-button size="small" type="success" @click="openPay(row)">收款</el-button><el-button size="small" type="warning" @click="openPhotos(row)">照片{{ (row.photos || []).length ? `(${row.photos.length})` : '' }}</el-button><el-button size="small" type="danger" @click="remove(row)">删除</el-button></template>
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
    </el-card>

    <OrderEditDialog
      v-model="dialog"
      :order="editingOrder"
      :list="list"
      :items="itemOptions"
      :customers="customerOptions"
      kind="receivable"
      :saving="saving"
      @saved="onOrderSaved"
    />

    <PaymentDialog v-model="payDialog" :order="payOrder" kind="receivable" :deposit-balance="customerDepositBalance(payOrder)" @saved="onPaySaved" />

    <!-- 轻量补照片：给已有单据传原始单据照片，只更新 photos 字段 -->
    <OrderPhotoDialog v-model="photoDialog" :order="photoOrder" @saved="onPhotosSaved" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'
import { orderKindCount, lineDisplayName, itemNameMap } from '../utils/catalog'
import { receivableOf, receivedSumOf, ensurePayments, syncPayments, grossOf, depositSumOf, isSettledOf, settleActionOf, round2 } from '../utils/account'
import { isReturn } from '../utils/refunds.js'
import { applyDepositFlows, removeDepositFlows } from '../utils/deposit'
// 资金单据联动：任何一笔实际收付款都必须落到收款单（SK-），见 utils/voucherFlow.js
import { savePaymentWithVouchers, voucherNotices } from '../utils/voucherFlow'
import OrderEditDialog from '../components/OrderEditDialog.vue'
import OrderPhotoDialog from '../components/OrderPhotoDialog.vue'
import TableToolbar from '../components/TableToolbar.vue'
import PaymentDialog from '../components/PaymentDialog.vue'
import { todayCN, orderTimeOf } from '../utils/time.js'

const PAGE_SIZE = 60
// 客户类别 → 商品上的对应分级售价字段

const list = ref([])
const keyword = ref('')
const dateStart = ref('')
const dateEnd = ref('')
// 退款单筛选：只保留红字退货/退款单（XT-），便于快速对账
const onlyReturns = ref(false)
const page = ref(1)
const itemOptions = ref([])
const customerOptions = ref([])
// 客户名 → 编码：列表里点名字跳转详情页
const customerCodeMap = computed(() => {
  const m = {}
  ;(customerOptions.value || []).forEach(c => { if (c && c.name) m[c.name] = c.code })
  return m
})
const dialog = ref(false)
// 保存中标记：配合按钮 loading 防止双击重复提交（会生成两张同内容单据、库存翻倍）
const saving = ref(false)
const payDialog = ref(false)
const payOrder = ref({})
// 轻量补照片弹窗（不改动单据其他信息，仅合并 photos 字段）
const photoDialog = ref(false)
const photoOrder = ref(null)

// 商品编码 → 主数据当前名（搜索按编码解析，单据快照名过期也能命中）
const nameMap = computed(() => itemNameMap(itemOptions.value))
// 列表排序：按记录时间（精确到秒）倒序，最新在最上面；同一秒再按单号倒序。
// 记录时间优先从单号解析（单号内含 YYYYMMDDHHmmss），退货单等回退 createdAt。
const byNewest = (a, b) => {
  const t = String(orderTimeOf(b)).localeCompare(String(orderTimeOf(a)))
  return t !== 0 ? t : String(b.id || '').localeCompare(String(a.id || ''))
}
const filtered = computed(() => list.value
  .filter(row => {
    // 搜索商品名按编码解析为当前名：单据快照名过期（商品改名前）也能命中
    if (!matchText(keyword.value, row.id, row.customer, row.date, orderTimeOf(row), row.remark,
      ...(row.items || []).map(i => lineDisplayName(i, nameMap.value)), ...(row.items || []).map(i => i.code))) return false
    if (dateStart.value && (row.date || '') < dateStart.value) return false
    if (dateEnd.value && (row.date || '') > dateEnd.value) return false
    if (onlyReturns.value && !isReturn(row)) return false
    return true
  })
  .sort(byNewest)
)

// 表格底部汇总：基于「全部筛选结果」，不受分页影响
const summaryAmount = ({ columns }) => {
  const rows = filtered.value
  const total = rows.reduce((sum, r) => sum + Number(r.total || 0), 0)
  const settled = rows.filter(r => settleLabelOf(r) === '结清').length
  return columns.map((c, idx) => {
    if (idx === 0) return `合计（${rows.length} 单，结清 ${settled}）`
    if (c.label === '应收') return rows.reduce((s, r) => s + grossOf(r), 0).toFixed(2)
    return ''
  })
}

const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
watch([keyword, dateStart, dateEnd, onlyReturns], () => { page.value = 1 })

// 展示层结算口径：未收金额为 0 即显示结清（无需打开编辑弹窗，旧单也生效）
const settleLabelOf = (row) => isSettledOf(receivableOf(row), row.settle) ? '结清' : '挂账'
// 该单各笔收款流水所属的资金单据编码（SK-）：去重后展示，便于一眼看清哪张收款单覆盖本单
const voucherCodesOf = (row) => [...new Set((ensurePayments(row, 'received') || []).map(p => p.voucher).filter(Boolean))]
// 该单各商品的编码（P…）：去重后展示，便于一眼看清本单涉及哪些商品
const itemCodesOf = (row) => [...new Set((row.items || []).map(i => i.code).filter(Boolean))]

// 导出/打印与列表当前页同步：副标题标注输出范围（第 X/Y 页）
const subtitle = computed(() => {
  const parts = [`共 ${filtered.value.length} 单`, `导出当前第 ${page.value}/${pageCount.value} 页`]
  if (dateStart.value || dateEnd.value) parts.push(`${dateStart.value || '不限'} ~ ${dateEnd.value || '不限'}`)
  if (onlyReturns.value) parts.push('仅退款单')
  if (keyword.value) parts.push('已按关键词筛选')
  return parts.join(' · ')
})
const exportColumns = [
  { label: '单号', prop: 'id' },
  { label: '客户', prop: 'customer' },
  { label: '时间', value: r => orderTimeOf(r) },
  { label: '商品数量', value: r => orderKindCount(r) },
  { label: '商品编码', value: r => itemCodesOf(r).join('、') },
  { label: '应收', value: r => grossOf(r).toFixed(2) },
  { label: '实收', value: r => { const n = ensurePayments(r, 'received').length; return receivedSumOf(r).toFixed(2) + (n > 1 ? `（${n}笔）` : '') } },
  { label: '优惠', value: r => (Number(r.discount || 0) ? Number(r.discount).toFixed(2) : '') },
  { label: '未收', value: r => receivableOf(r).toFixed(2) },
  { label: '结算状态', value: r => settleLabelOf(r) },
  { label: '资金单据编号', value: r => voucherCodesOf(r).join('、') },
  { label: '备注', prop: 'remark' }
]

function loadAll() {
  return Promise.all([api.getSales(), api.getItems(), api.getCustomers()])
}

// 线上全量数据是否可靠加载。保存走「整表覆盖」语义（提交整个 sales 数组），
// 一旦列表因加载失败变空，保存就会用「只有这一张新单」的数组覆盖 sales.json，历史单据全被抹掉。
// 因此加载失败必须标记出来，并在保存前强制补齐，补不齐就拒绝提交。
const loadFailed = ref(false)

onMounted(async () => {
  try {
    const [s, it, cu] = await loadAll()
    list.value = s
    itemOptions.value = it
    customerOptions.value = cu
    loadFailed.value = false
  } catch (e) {
    // 不清空已有列表：清空过一次保存就能把线上单据覆盖没了
    loadFailed.value = true
    ElMessage.error({ message: `销售数据加载失败（${e.message || '网络异常'}），请退出本页重新进入；加载成功前不会允许保存，以免覆盖线上单据`, duration: 6000 })
  }
})

// 提交整表前确保本地是线上全量：未加载成功过或列表为空时，先重新拉一次
async function ensureLoaded() {
  if (!loadFailed.value && list.value.length) return true
  const r = await loadAll().catch(() => null)
  if (!r) return false
  const [s, it, cu] = r
  list.value = s
  itemOptions.value = it
  customerOptions.value = cu
  loadFailed.value = false
  return true
}

// 写成功/回滚后的回读只服务于显示：失败既不抛错也不清空，保留本地数据，下次进入页面自动重拉。
// （此前这里用未捕获的 Promise.all，回读一失败就把已落库的删除/结清显示成「没生效」，用户会反复点）
async function refreshFromServer() {
  try {
    const [s, it, cu] = await Promise.all([api.getSales(), api.getItems(), api.getCustomers()])
    list.value = s
    itemOptions.value = it
    customerOptions.value = cu
  } catch { /* 保留本地数据 */ }
}

// 编辑中的单据：null 表示新增
const editingOrder = ref(null)
function openDialog(row) {
  editingOrder.value = row || null
  dialog.value = true
}

// 单据保存（新增/编辑均由弹窗组装好 entry 后交回本地落库）：
// 合并进列表 → 整表保存 → 失败回滚并保持弹窗打开便于重试，成功则立即关窗报成功再后台刷新。
// 刷新走独立容错：保存已落库，刷新失败只保留本地数据，绝不让弹窗卡在「存了却不开工」状态
// （否则用户会重复点击，把同一单再 push 一遍生成重复单据）
async function onOrderSaved({ entry, isEdit, depositDeduct, payRows, items }) {
  saving.value = true
  try {
    // 红线：本地不是线上全量时绝不提交整表（会覆盖掉未加载到的历史单据）
    if (!(await ensureLoaded())) {
      ElMessage.error('线上数据未能加载，已取消保存（避免用空列表覆盖历史单据）。请检查网络后重试。')
      return
    }
    // 本次是否新增了商品（商品库出现了新 code）：先落库商品库，再保存单据。
    // 顺序不能反——先 saveItems 让后端 derive 按 code 命中、不重复建档，避免产生第二个 P 编码
    const hasNewItems = items && items.some(i => !itemOptions.value.some(x => x.code === i.code))
    if (hasNewItems) {
      try { await api.saveItems(items) } catch (e) {
        ElMessage.error(`商品落库失败：${e.message || '网络异常'}，新商品未保存（可在商品库手动补建）`)
      }
    }
    // 新增单的「本次实收 / 预收款抵扣」与编辑单的「补收差额」（payRows）都是真实资金变动，
    // 必须同步开收款单：先分配编号回写到流水，再整表保存，最后写收款单集合
    const newRows = isEdit ? (payRows || []) : (entry.payments || [])
    // 幂等合并（同单号已存在则替换，防重复点击生成两张同内容单）+ 资金单据联动，一次落库
    const r = await savePaymentWithVouchers(api, 'receivable', list.value, entry, newRows, null)
    if (r.stage === 'orders') {
      ElMessage.error(`保存失败：${(r.error && r.error.message) || '网络异常'}，本地改动已回滚，请重试`)
      const [s, it] = await Promise.all([api.getSales(), api.getItems()]).catch(() => [null, null])
      if (s) list.value = s
      if (it) itemOptions.value = it
      return
    }
    list.value = r.merged
    // 保存已成功：先关窗 + 报成功，让用户立刻得到反馈；刷新放到后面且单独容错
    dialog.value = false
    editingOrder.value = null
    ElMessage.success(isEdit ? '已保存修改' : '销售出库成功')
    // 本地先刷新商品库（含新商品），避免闪烁；随后后台再拉一次服务端值
    if (hasNewItems) itemOptions.value = items
    // 商品销售价历史、库存、客户档案均由后端自动推导（销售单里的新客户会自动建档）
    try {
      const [s, it, cu] = await Promise.all([api.getSales(), api.getItems(), api.getCustomers()])
      list.value = s
      itemOptions.value = it
      customerOptions.value = cu
    } catch { /* 刷新失败：保留本地数据，下次进入页面会自动重拉 */ }
    // 新增单用预收款抵扣：从客户档案按订单 id 幂等扣减（资金不泄漏）
    if (depositDeduct && Number(depositDeduct.amount) > 0) {
      const cu2 = await applyDepositFlows(api, 'receivable', entry.customer, entry.id, 0, depositDeduct.amount).catch(() => null)
      if (cu2) customerOptions.value = cu2
      ElMessage.success(`已从客户预收款扣减 ¥${Number(depositDeduct.amount).toFixed(2)}`)
    }
    voucherNotices('receivable', r).forEach(n => ElMessage[n.type]({ message: n.text, duration: n.duration }))
  } finally {
    saving.value = false
  }
}

// 打开某单的收款流水弹窗
function openPay(row) {
  payOrder.value = row
  payDialog.value = true
}

// 当前单据对应客户的预存款可用余额（用于收款时「用预存款支付」抵扣）
function customerDepositBalance(row) {
  const c = customerOptions.value.find(x => x.name === (row && row.customer))
  return depositSumOf(c && c.deposits)
}

// 打开某单的轻量补照片弹窗
function openPhotos(row) {
  photoOrder.value = row
  photoDialog.value = true
}

// 保存照片：仅合并 photos 字段后整单保存，单号/金额/明细/流水等一律不动
async function onPhotosSaved(photos) {
  const order = photoOrder.value
  const idx = list.value.findIndex(s => s.id === order?.id)
  if (idx < 0) return
  const origin = list.value[idx]
  list.value[idx] = { ...origin, photos }
  try {
    await api.saveSales(list.value)
  } catch (e) {
    list.value[idx] = origin
    ElMessage.error(`保存失败：${e.message || '网络异常'}，请重试`)
    return
  }
  photoDialog.value = false
  photoOrder.value = null
  ElMessage.success('已更新单据照片')
}

async function onPaySaved(updated, payload) {
  // 先分配收款单编号并回写到本次新增流水上，再整表落库：
  // 「流水 ↔ 收款单」在同一次保存里就绑定好，列表「收付款单」列不再常显「—」
  const r = await savePaymentWithVouchers(api, 'receivable', list.value, updated, payload?.newRows, payload?.add)
  if (r.stage === 'orders') {
    // 保存失败时弹窗保持打开（父组件不关闭），便于直接重试
    ElMessage.error(`保存失败：${(r.error && r.error.message) || '网络异常'}，请重试`)
    return
  }
  list.value = r.merged
  list.value = await api.getSales().catch(() => list.value)
  payDialog.value = false
  ElMessage.success('已保存收款流水')
  // 超收转客户预存款 / 用预存款抵扣：按订单 id 幂等重建流水，重复保存不会重复加减（资金不泄漏）
  const addAmt = Number(payload?.add?.amount || 0)
  const deductAmt = Number(payload?.deduct?.amount || 0)
  if (addAmt > 0 || deductAmt > 0) {
    const list2 = await applyDepositFlows(api, 'receivable', updated.customer, updated.id, addAmt, deductAmt)
    if (list2) customerOptions.value = list2
    const parts = []
    if (addAmt > 0) parts.push(`存入客户预存款 ¥${addAmt.toFixed(2)}`)
    if (deductAmt > 0) parts.push(`扣减客户预存款 ¥${deductAmt.toFixed(2)}`)
    if (parts.length) ElMessage.success(parts.join('；'))
  }
  // 每一笔新增收款流水各开一张收款单（关联本销售单号）；预存款抵扣为划转单；超额转存无单号
  voucherNotices('receivable', r).forEach(n => ElMessage[n.type]({ message: n.text, duration: n.duration }))
}

async function toggleSettle(row) {
  // 三个动作与 account.settleActionOf 统一口径：
  //   settle：仍有未收 → 点「改结清」，收款结清（生成收款单）或差额记优惠（无资金单据）
  //   unrest：金额已平但有抹零优惠 → 改挂账＝撤销优惠，未收恢复
  //   none：不显示按钮
  const action = settleActionOf(row, 'receivable')
  if (action === 'none') return
  const idx = list.value.findIndex(s => s.id === row.id)
  if (idx < 0) return
  if (action === 'unrest') {
    const discount = round2(Number(row.discount || 0))
    try {
      await ElMessageBox.confirm(
        `本单应收已结清，其中抹零优惠 ¥${discount.toFixed(2)} 未实际收款。\n` +
        `改挂账将撤销这笔优惠，未收恢复为 ¥${discount.toFixed(2)}，结算状态回到「挂账」。\n` +
        `如果钱其实已经收到，请用「收款」补登记，而不是改挂账。`,
        '确认改挂账', { type: 'warning', confirmButtonText: '确认改挂账', cancelButtonText: '取消' })
    } catch { return }
    const updated = syncPayments({ ...row, discount: 0 }, 'receivable')
    list.value[idx] = updated
    try {
      await api.saveSales(list.value)
    } catch (e) {
      list.value[idx] = row
      ElMessage.error(`操作失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
      await refreshFromServer()
      return
    }
    ElMessage.success(`已改回挂账：未收恢复 ¥${discount.toFixed(2)}`)
    return
  }
  // action === 'settle'：未收 > 0，差额必须由用户当场选「收款结清」或「差额记优惠」
  const due = grossOf(row)
  const unpaid = receivableOf(row)
  const received = receivedSumOf(row)
  let mode = 'cash'
  try {
    await ElMessageBox.confirm(
      `该单应收 ¥${due.toFixed(2)}，已实收 ¥${received.toFixed(2)}，未收 ¥${unpaid.toFixed(2)}。\n` +
      `· 「收款结清」：把 ¥${unpaid.toFixed(2)} 记为一笔实际收款，并生成收款单（现金增加）\n` +
      `· 「差额记优惠」：¥${unpaid.toFixed(2)} 作为抹零优惠核销，钱未收到，因此不生成收款单`,
      '确认改结清', {
        type: 'warning',
        confirmButtonText: '收款结清',
        cancelButtonText: '差额记优惠',
        distinguishCancelAndClose: true
      })
  } catch (e) {
    // close（点 X / ESC）= 放弃操作；cancel = 明确选择「差额记优惠」
    if (e !== 'cancel') return
    mode = 'discount'
  }
  if (mode === 'cash') {
    const payments = ensurePayments(row, 'received')
    const mid = `n${Date.now().toString(36)}`
    payments.push({ date: todayCN(), amount: unpaid, remark: '结清收款', time: new Date().toISOString(), mid })
    const newRows = [payments[payments.length - 1]]
    const updated = syncPayments({ ...row, payments }, 'receivable')
    const r = await savePaymentWithVouchers(api, 'receivable', list.value, updated, newRows, null)
    if (r.stage === 'orders') {
      ElMessage.error(`操作失败：${(r.error && r.error.message) || '网络异常'}，本地改动已回滚，请重试`)
      await refreshFromServer()
      return
    }
    list.value = r.merged
    ElMessage.success(`已收款结清：¥${unpaid.toFixed(2)} 已入账`)
    voucherNotices('receivable', r).forEach(n => ElMessage[n.type]({ message: n.text, duration: n.duration }))
    return
  }
  // 抹零优惠：差额计入 discount 而非收款流水；syncPayments 按金额自动判定结清
  const updated = syncPayments({ ...row, discount: round2(Number(row.discount || 0) + unpaid) }, 'receivable')
  list.value[idx] = updated
  try {
    await api.saveSales(list.value)
  } catch (e) {
    list.value[idx] = row
    ElMessage.error(`操作失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    await refreshFromServer()
    return
  }
  ElMessage.success(`已按抹零优惠结清 ¥${unpaid.toFixed(2)}（无资金变动，未生成收款单）`)
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除销售单 ${row.id}?\n删除后库存与历史价会自动重算。`, '提示', { type: 'warning' })
  } catch { return }
  list.value = list.value.filter(s => s.id !== row.id)
  try {
    await api.saveSales(list.value)
  } catch (e) {
    ElMessage.error(`删除失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    await refreshFromServer()
    return
  }
  // 删除已落库：回读只为显示最新值，失败也不能让已成功的删除看起来没生效
  await refreshFromServer()
  // 删除单据时同步清掉其超收转存/抵扣标记的预存款流水（含历史无标记抵扣的补回），避免删除后余额残留幽灵流水或预存款丢失
  const cu2 = await removeDepositFlows(api, 'receivable', row.customer, row.id, row).catch(() => null)
  if (cu2) customerOptions.value = cu2
  // 删掉末页最后一条后页码要回退，否则停留在已不存在的页上会看到空白表格
  if (page.value > pageCount.value) page.value = pageCount.value
  ElMessage.success('已删除')
}
</script>
<style scoped>
.card-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}
.search-input{margin-bottom:12px;max-width:360px;}
.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.filter-label{color:var(--text-regular);font-size:var(--fs-base);}
.filter-sep{color:var(--text-secondary);}
.pager{margin-top:12px;justify-content:flex-end;}
.discount{color:var(--color-success);}
.none{color:var(--text-placeholder);}
.debt{color:var(--color-danger);font-weight:600;}
.calc-line{display:flex;gap:20px;flex-wrap:wrap;color:var(--text-regular);font-size:var(--fs-table);}
.calc-hint{color:var(--text-secondary);font-weight:400;}
.lines-scroll{overflow-x:auto;}
.calc-detail{display:flex;justify-content:flex-end;gap:16px;flex-wrap:wrap;margin-top:2px;color:var(--text-secondary);font-size:var(--fs-sub);}
.line-net{font-variant-numeric:tabular-nums;}
.paid-summary{display:flex;gap:8px;flex-wrap:wrap;color:var(--text-regular);font-size:var(--fs-table);align-items:baseline;}
.paid-summary .hint{color:var(--text-placeholder);}
.pay-count{color:var(--text-secondary);font-size:var(--fs-sub);margin-left:2px;}
.voucher-codes{color:var(--text-secondary);}
.item-codes{color:var(--text-secondary);}
</style>
