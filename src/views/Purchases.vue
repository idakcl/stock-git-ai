<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header"><b>采购入库</b><el-button type="primary" @click="openDialog()">新增采购</el-button></div>
      </template>
      <el-input v-model="keyword" clearable placeholder="搜索单号 / 供应商 / 商品" class="search-input" />
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
        filename="采购单"
        title="采购单"
        :subtitle="subtitle"
        :columns="exportColumns"
        :rows="paged"
      />
      <div class="table-wrap">
      <el-table :data="paged" stripe show-summary :summary-method="summaryAmount">
        <el-table-column label="单号" width="190" class-name="id-col">
          <template #default="{ row }">
            <router-link :to="`/purchase/${row.id}`" class="link" :class="{ 'return-code': isReturn(row) }">{{ row.id }}</router-link>
          </template>
        </el-table-column>
        <el-table-column label="供应商" width="170">
          <template #default="{ row }">
            <router-link v-if="supplierCodeMap[row.supplier]" :to="`/supplier/${supplierCodeMap[row.supplier]}`" class="link">{{ row.supplier }}</router-link>
            <span v-else>{{ row.supplier }}</span>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ orderTimeOf(row) }}</template>
        </el-table-column>
        <el-table-column label="商品编码" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="itemCodesOf(row).length" class="item-codes">{{ itemCodesOf(row).join('、') }}</span>
            <span v-else class="none">—</span>
          </template>
        </el-table-column>
        <el-table-column label="应付" width="110" align="right">
          <template #default="{ row }">{{ grossOf(row).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="实付" width="120" align="right">
          <template #default="{ row }">
            <span>{{ paidSumOf(row).toFixed(2) }}</span>
            <span v-if="(ensurePayments(row, 'paid')).length" class="pay-count">（{{ ensurePayments(row, 'paid').length }} 笔）</span>
          </template>
        </el-table-column>
        <el-table-column label="优惠" width="100" align="right">
          <template #default="{ row }">
            <span v-if="Number(row.discount || 0) > 0" class="discount" title="抹零优惠，未实际付款">-{{ Number(row.discount).toFixed(2) }}</span>
            <span v-else class="none">—</span>
          </template>
        </el-table-column>
        <el-table-column label="未付" width="110" align="right">
          <template #default="{ row }">
            <span :class="payableOf(row) > 0 ? 'debt' : 'none'">{{ payableOf(row).toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结算状态" width="130">
          <template #default="{ row }">
            <el-tag :type="settleLabelOf(row) === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
              {{ settleLabelOf(row) }}
            </el-tag>
            <!-- 未付为 0 且无抹零优惠时不显示；两个改账动作：改结清＝结清未付差额，改挂账＝撤销抹零优惠、恢复未付 -->
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
          <template #default="{ row }"><el-button size="small" @click="$router.push(`/purchase/${row.id}`)">查看</el-button><el-button size="small" type="primary" @click="openDialog(row)">编辑</el-button><el-button size="small" type="success" @click="openPay(row)">付款</el-button><el-button size="small" type="warning" @click="openPhotos(row)">照片{{ (row.photos || []).length ? `(${row.photos.length})` : '' }}</el-button><el-button size="small" type="danger" @click="remove(row)">删除</el-button></template>
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
      :suppliers="supplierOptions"
      kind="payable"
      :saving="saving"
      @saved="onOrderSaved"
    />

    <PaymentDialog v-model="payDialog" :order="payOrder" kind="payable" :deposit-balance="supplierAdvanceBalance(payOrder)" @saved="onPaySaved" />

    <!-- 轻量补照片：给已有单据传原始单据照片，只更新 photos 字段 -->
    <OrderPhotoDialog v-model="photoDialog" :order="photoOrder" @saved="onPhotosSaved" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'
import { lineDisplayName, itemNameMap } from '../utils/catalog'
import { payableOf, paidSumOf, ensurePayments, syncPayments, grossOf, depositSumOf, isSettledOf, settleActionOf, round2 } from '../utils/account'
import { isReturn } from '../utils/refunds.js'
import { applyDepositFlows, removeDepositFlows } from '../utils/deposit'
// 资金单据联动：任何一笔实际收付款都必须落到付款单（FK-），见 utils/voucherFlow.js
import { savePaymentWithVouchers, voucherNotices } from '../utils/voucherFlow'
import OrderEditDialog from '../components/OrderEditDialog.vue'
import OrderPhotoDialog from '../components/OrderPhotoDialog.vue'
import TableToolbar from '../components/TableToolbar.vue'
import PaymentDialog from '../components/PaymentDialog.vue'
import { todayCN, orderTimeOf } from '../utils/time.js'

const PAGE_SIZE = 60

const list = ref([])
const keyword = ref('')
const dateStart = ref('')
const dateEnd = ref('')
// 退款单筛选：只保留红字退货/退款单（CT-），便于快速对账
const onlyReturns = ref(false)
const page = ref(1)
const itemOptions = ref([])
// 供应商档案（预付款存这里）：付款弹窗超付部分转供应商预付款时使用
const supplierOptions = ref([])
// 供应商名 → 编码：列表里点名字跳转详情页
const supplierCodeMap = computed(() => {
  const m = {}
  ;(supplierOptions.value || []).forEach(s => { if (s && s.name) m[s.name] = s.code })
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
    if (!matchText(keyword.value, row.id, row.supplier, row.date, orderTimeOf(row), row.remark,
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
    if (c.label === '应付') return rows.reduce((s, r) => s + grossOf(r), 0).toFixed(2)
    return ''
  })
}

const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
watch([keyword, dateStart, dateEnd, onlyReturns], () => { page.value = 1 })

// 展示层结算口径：未付金额为 0 即显示结清（无需打开编辑弹窗，旧单也生效）
const settleLabelOf = (row) => isSettledOf(payableOf(row), row.settle) ? '结清' : '挂账'
// 该单各笔付款流水所属的资金单据编码（FK-）：去重后展示，便于一眼看清哪张付款单覆盖本单
const voucherCodesOf = (row) => [...new Set((ensurePayments(row, 'paid') || []).map(p => p.voucher).filter(Boolean))]
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
  { label: '供应商', prop: 'supplier' },
  { label: '时间', value: r => orderTimeOf(r) },
  { label: '商品编码', value: r => itemCodesOf(r).join('、') },
  { label: '应付', value: r => grossOf(r).toFixed(2) },
  { label: '实付', value: r => { const n = ensurePayments(r, 'paid').length; return paidSumOf(r).toFixed(2) + (n > 1 ? `（${n}笔）` : '') } },
  { label: '优惠', value: r => (Number(r.discount || 0) ? Number(r.discount).toFixed(2) : '') },
  { label: '未付', value: r => payableOf(r).toFixed(2) },
  { label: '结算状态', value: r => settleLabelOf(r) },
  { label: '资金单据编号', value: r => voucherCodesOf(r).join('、') },
  { label: '备注', prop: 'remark' }
]

function loadAll() {
  return Promise.all([api.getPurchases(), api.getItems(), api.getSuppliers()])
}

// 线上全量数据是否可靠加载。保存走「整表覆盖」语义（提交整个 purchases 数组），
// 一旦列表因加载失败变空，保存就会用「只有这一张新单」的数组覆盖 purchases.json，历史单据全被抹掉。
const loadFailed = ref(false)

onMounted(async () => {
  try {
    const [p, it, sup] = await loadAll()
    list.value = p
    itemOptions.value = it
    supplierOptions.value = sup
    loadFailed.value = false
  } catch (e) {
    // 不清空已有列表：清空过一次保存就能把线上单据覆盖没了
    loadFailed.value = true
    ElMessage.error({ message: `采购数据加载失败（${e.message || '网络异常'}），请退出本页重新进入；加载成功前不会允许保存，以免覆盖线上单据`, duration: 6000 })
  }
})

// 提交整表前确保本地是线上全量：未加载成功过或列表为空时，先重新拉一次
async function ensureLoaded() {
  if (!loadFailed.value && list.value.length) return true
  const r = await loadAll().catch(() => null)
  if (!r) return false
  const [p, it, sup] = r
  list.value = p
  itemOptions.value = it
  supplierOptions.value = sup
  loadFailed.value = false
  return true
}

// 写成功/回滚后的回读只服务于显示：失败既不抛错也不清空，保留本地数据，下次进入页面自动重拉。
// （此前这里用未捕获的 loadAll，回读一失败就把已落库的付款/删除显示成「没生效」，用户会反复点）
async function refreshFromServer() {
  try {
    const [p, it, sup] = await loadAll()
    list.value = p
    itemOptions.value = it
    supplierOptions.value = sup
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
    // 新增单的「本次实付 / 预付款抵扣」与编辑单的「补付差额」（payRows）都是真实资金变动，
    // 必须同步开付款单：先分配编号回写到流水，再整表保存，最后写付款单集合
    const newRows = isEdit ? (payRows || []) : (entry.payments || [])
    // 幂等合并（同单号已存在则替换，防重复点击生成两张同内容单）+ 资金单据联动，一次落库
    const r = await savePaymentWithVouchers(api, 'payable', list.value, entry, newRows, null)
    if (r.stage === 'orders') {
      ElMessage.error(`保存失败：${(r.error && r.error.message) || '网络异常'}，本地改动已回滚，请重试`)
      const [p, it, sup] = await loadAll().catch(() => [null, null, null])
      if (p) list.value = p
      if (it) itemOptions.value = it
      if (sup) supplierOptions.value = sup
      return
    }
    list.value = r.merged
    // 保存已成功：先关窗 + 报成功，让用户立刻得到反馈；刷新放到后面且单独容错
    dialog.value = false
    editingOrder.value = null
    ElMessage.success(isEdit ? '已保存修改' : '采购入库成功')
    // 本地先刷新商品库（含新商品），避免闪烁；随后后台再拉一次服务端值
    if (hasNewItems) itemOptions.value = items
    // 商品建档、库存、供应商关系均由后端自动推导
    try {
      itemOptions.value = await api.getItems().catch(() => itemOptions.value)
      supplierOptions.value = await api.getSuppliers().catch(() => supplierOptions.value)
    } catch { /* 刷新失败：保留本地数据，下次进入页面会自动重拉 */ }
    // 新增单用预付款抵扣：从供应商档案按订单 id 幂等扣减（资金不泄漏）
    if (depositDeduct && Number(depositDeduct.amount) > 0) {
      const sup2 = await applyDepositFlows(api, 'payable', entry.supplier, entry.id, 0, depositDeduct.amount).catch(() => null)
      if (sup2) supplierOptions.value = sup2
      ElMessage.success(`已从供应商预付款扣减 ¥${Number(depositDeduct.amount).toFixed(2)}`)
    }
    voucherNotices('payable', r).forEach(n => ElMessage[n.type]({ message: n.text, duration: n.duration }))
  } finally {
    saving.value = false
  }
}

// 打开某单的付款流水弹窗
function openPay(row) {
  payOrder.value = row
  payDialog.value = true
}

// 当前单据对应供应商的预付款可用余额（用于付款时「用预付款支付」抵扣）
function supplierAdvanceBalance(row) {
  const s = supplierOptions.value.find(x => x.name === (row && row.supplier))
  return depositSumOf(s && s.advances)
}

// 打开某单的轻量补照片弹窗
function openPhotos(row) {
  photoOrder.value = row
  photoDialog.value = true
}

// 保存照片：仅合并 photos 字段后整单保存，单号/金额/明细/流水等一律不动
async function onPhotosSaved(photos) {
  const order = photoOrder.value
  const idx = list.value.findIndex(p => p.id === order?.id)
  if (idx < 0) return
  const origin = list.value[idx]
  list.value[idx] = { ...origin, photos }
  try {
    await api.savePurchases(list.value)
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
  // 先分配付款单编号并回写到本次新增流水上，再整表落库：「流水 ↔ 付款单」在同一次保存里就绑定好
  const r = await savePaymentWithVouchers(api, 'payable', list.value, updated, payload?.newRows, payload?.add)
  if (r.stage === 'orders') {
    // 保存失败时弹窗保持打开（父组件不关闭），便于直接重试
    ElMessage.error(`保存失败：${(r.error && r.error.message) || '网络异常'}，请重试`)
    return
  }
  list.value = r.merged
  const [p, it, sup] = await loadAll().catch(() => [null, null, null])
  if (p) list.value = p
  if (it) itemOptions.value = it
  if (sup) supplierOptions.value = sup
  payDialog.value = false
  ElMessage.success('已保存付款流水')
  // 超付转供应商预付款 / 用预付款抵扣：按订单 id 幂等重建流水，重复保存不会重复加减（资金不泄漏）
  const addAmt = Number(payload?.add?.amount || 0)
  const deductAmt = Number(payload?.deduct?.amount || 0)
  if (addAmt > 0 || deductAmt > 0) {
    const list2 = await applyDepositFlows(api, 'payable', updated.supplier, updated.id, addAmt, deductAmt)
    if (list2) supplierOptions.value = list2
    const parts = []
    if (addAmt > 0) parts.push(`存入供应商预付款 ¥${addAmt.toFixed(2)}`)
    if (deductAmt > 0) parts.push(`扣减供应商预付款 ¥${deductAmt.toFixed(2)}`)
    if (parts.length) ElMessage.success(parts.join('；'))
  }
  // 每一笔新增付款流水各开一张付款单（关联本采购单号）；预付款抵扣为划转单；超额转存无单号
  voucherNotices('payable', r).forEach(n => ElMessage[n.type]({ message: n.text, duration: n.duration }))
}

async function addSupplierAdvance(name, dep) {
  try {
    const suppliers = await api.getSuppliers()
    const s = suppliers.find(x => x.name === name)
    if (!s) return ElMessage.warning(`供应商「${name || '未知'}」不在名单中，超额部分 ¥${Number(dep.amount).toFixed(2)} 未入预付款`)
    s.advances = [...(s.advances || []), {
      date: dep.date,
      amount: Number(dep.amount),
      remark: dep.remark || '超付转预付款',
      time: dep.time || new Date().toISOString()
    }]
    await api.saveSuppliers(suppliers)
    supplierOptions.value = suppliers
    ElMessage.success(`已存入供应商预付款 ¥${Number(dep.amount).toFixed(2)}`)
  } catch (e) {
    ElMessage.error(`预付款保存失败：${e.message || e}，请到供应商详情手动补记`)
  }
}

// 用预付款抵扣货款：在供应商档案 advances 中记一笔负值，扣减可用余额
async function deductSupplierAdvance(name, entry) {
  try {
    const suppliers = await api.getSuppliers()
    const s = suppliers.find(x => x.name === name)
    if (!s) return ElMessage.warning(`供应商「${name || '未知'}」不在名单中，抵扣 ¥${Number(entry.amount).toFixed(2)} 未扣减预付款`)
    s.advances = [...(s.advances || []), {
      date: entry.date,
      amount: -Number(entry.amount),
      remark: entry.remark || '抵扣货款',
      time: entry.time || new Date().toISOString()
    }]
    await api.saveSuppliers(suppliers)
    supplierOptions.value = suppliers
    ElMessage.success(`已从供应商预付款扣减 ¥${Number(entry.amount).toFixed(2)}`)
  } catch (e) {
    ElMessage.error(`预付款扣减失败：${e.message || e}，请到供应商详情手动调整`)
  }
}

async function toggleSettle(row) {
  // 三个动作与 account.settleActionOf 统一口径：
  //   settle：仍有未付 → 点「改结清」，付款结清（生成付款单）或差额记优惠（无资金单据）
  //   unrest：金额已平但有抹零优惠 → 改挂账＝撤销优惠，未付恢复
  //   none：不显示按钮
  const action = settleActionOf(row, 'payable')
  if (action === 'none') return
  const idx = list.value.findIndex(p => p.id === row.id)
  if (idx < 0) return
  if (action === 'unrest') {
    const discount = round2(Number(row.discount || 0))
    try {
      await ElMessageBox.confirm(
        `本单应付已结清，其中抹零优惠 ¥${discount.toFixed(2)} 未实际付款。\n` +
        `改挂账将撤销这笔优惠，未付恢复为 ¥${discount.toFixed(2)}，结算状态回到「挂账」。\n` +
        `如果钱其实已经付出，请用「付款」补登记，而不是改挂账。`,
        '确认改挂账', { type: 'warning', confirmButtonText: '确认改挂账', cancelButtonText: '取消' })
    } catch { return }
    const updated = syncPayments({ ...row, discount: 0 }, 'payable')
    list.value[idx] = updated
    try {
      await api.savePurchases(list.value)
    } catch (e) {
      list.value[idx] = row
      ElMessage.error(`操作失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
      await refreshFromServer()
      return
    }
    ElMessage.success(`已改回挂账：未付恢复 ¥${discount.toFixed(2)}`)
    return
  }
  // action === 'settle'：未付 > 0，差额必须由用户当场选「付款结清」或「差额记优惠」
  const due = grossOf(row)
  const unpaid = payableOf(row)
  const paid = paidSumOf(row)
  let mode = 'cash'
  try {
    await ElMessageBox.confirm(
      `该单应付 ¥${due.toFixed(2)}，已实付 ¥${paid.toFixed(2)}，未付 ¥${unpaid.toFixed(2)}。\n` +
      `· 「付款结清」：把 ¥${unpaid.toFixed(2)} 记为一笔实际付款，并生成付款单（现金减少）\n` +
      `· 「差额记优惠」：¥${unpaid.toFixed(2)} 作为抹零优惠核销，钱未付出，因此不生成付款单`,
      '确认改结清', {
        type: 'warning',
        confirmButtonText: '付款结清',
        cancelButtonText: '差额记优惠',
        distinguishCancelAndClose: true
      })
  } catch (e) {
    // close（点 X / ESC）= 放弃操作；cancel = 明确选择「差额记优惠」
    if (e !== 'cancel') return
    mode = 'discount'
  }
  if (mode === 'cash') {
    const payments = ensurePayments(row, 'paid')
    const row2 = { date: todayCN(), amount: unpaid, remark: '结清付款', time: new Date().toISOString(), mid: `n${Date.now().toString(36)}` }
    payments.push(row2)
    const updated = syncPayments({ ...row, payments }, 'payable')
    const r = await savePaymentWithVouchers(api, 'payable', list.value, updated, [row2], null)
    if (r.stage === 'orders') {
      ElMessage.error(`操作失败：${(r.error && r.error.message) || '网络异常'}，本地改动已回滚，请重试`)
      await refreshFromServer()
      return
    }
    list.value = r.merged
    ElMessage.success(`已付款结清：¥${unpaid.toFixed(2)} 已付出`)
    voucherNotices('payable', r).forEach(n => ElMessage[n.type]({ message: n.text, duration: n.duration }))
    return
  }
  // 抹零优惠：差额计入 discount 而非付款流水；syncPayments 按金额自动判定结清
  const updated = syncPayments({ ...row, discount: round2(Number(row.discount || 0) + unpaid) }, 'payable')
  list.value[idx] = updated
  try {
    await api.savePurchases(list.value)
  } catch (e) {
    list.value[idx] = row
    ElMessage.error(`操作失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    await refreshFromServer()
    return
  }
  ElMessage.success(`已按抹零优惠结清 ¥${unpaid.toFixed(2)}（无资金变动，未生成付款单）`)
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除采购单 ${row.id}?\n删除后库存与历史价会自动重算。`, '提示', { type: 'warning' })
  } catch { return }
  list.value = list.value.filter(p => p.id !== row.id)
  try {
    await api.savePurchases(list.value)
  } catch (e) {
    ElMessage.error(`删除失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    await refreshFromServer()
    return
  }
  // 删除已落库：回读只为显示最新值，失败也不能让已成功的删除看起来没生效
  await refreshFromServer()
  // 删除单据时同步清掉其超付转存/抵扣标记的预付款流水（含历史无标记抵扣的补回），避免删除后余额残留幽灵流水或预付款丢失
  const sup2 = await removeDepositFlows(api, 'payable', row.supplier, row.id, row).catch(() => null)
  if (sup2) supplierOptions.value = sup2
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
.voucher-codes{color:var(--text-secondary);}
.item-codes{color:var(--text-secondary);}
.debt{color:var(--color-danger);font-weight:600;}
.calc-line{display:flex;gap:20px;flex-wrap:wrap;color:var(--text-regular);font-size:var(--fs-table);}
.calc-hint{color:var(--text-secondary);font-weight:400;}
.lines-scroll{overflow-x:auto;}
.calc-detail{display:flex;justify-content:flex-end;gap:16px;flex-wrap:wrap;margin-top:2px;color:var(--text-secondary);font-size:var(--fs-sub);}
.line-net{font-variant-numeric:tabular-nums;}
</style>
