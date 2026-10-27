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
        <el-table-column label="单号" width="170">
          <template #default="{ row }">
            <router-link :to="`/purchase/${row.id}`" class="link">{{ row.id }}</router-link>
          </template>
        </el-table-column>
        <el-table-column label="供应商" width="170">
          <template #default="{ row }">
            <router-link v-if="supplierCodeMap[row.supplier]" :to="`/supplier/${supplierCodeMap[row.supplier]}`" class="link">{{ row.supplier }}</router-link>
            <span v-else>{{ row.supplier }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="date" label="日期" width="120" />
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
        <el-table-column label="结算" width="130">
          <template #default="{ row }">
            <el-tag :type="settleLabelOf(row) === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
              {{ settleLabelOf(row) }}
            </el-tag>
            <el-button link size="small" type="primary" style="margin-left:4px" @click="toggleSettle(row)"
              :disabled="autoSettled(row)" :title="autoSettled(row) ? '未付金额为 0，按金额自动结清' : ''">
              {{ settleLabelOf(row) === '结清' ? '改挂账' : '结清' }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="收付款单" min-width="170" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="voucherCodesOf(row).length" class="voucher-codes">{{ voucherCodesOf(row).join('、') }}</span>
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
import { payableOf, paidSumOf, ensurePayments, syncPayments, grossOf, depositSumOf, isSettledOf } from '../utils/account'
import { applyDepositFlows, removeDepositFlows } from '../utils/deposit'
import OrderEditDialog from '../components/OrderEditDialog.vue'
import OrderPhotoDialog from '../components/OrderPhotoDialog.vue'
import TableToolbar from '../components/TableToolbar.vue'
import PaymentDialog from '../components/PaymentDialog.vue'

const PAGE_SIZE = 60

const list = ref([])
const keyword = ref('')
const dateStart = ref('')
const dateEnd = ref('')
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
// 列表排序：最新的排最前面。先按日期倒序，同日再按单号倒序（单号内含录入时间 hhmmss+流水），
// 保证同日多单按开单先后正确排列，而非依赖后端存储顺序
const byNewest = (a, b) => {
  const d = String(b.date || '').localeCompare(String(a.date || ''))
  return d !== 0 ? d : String(b.id || '').localeCompare(String(a.id || ''))
}
const filtered = computed(() => list.value
  .filter(row => {
    // 搜索商品名按编码解析为当前名：单据快照名过期（商品改名前）也能命中
    if (!matchText(keyword.value, row.id, row.supplier, row.date, row.remark,
      ...(row.items || []).map(i => lineDisplayName(i, nameMap.value)), ...(row.items || []).map(i => i.code))) return false
    if (dateStart.value && (row.date || '') < dateStart.value) return false
    if (dateEnd.value && (row.date || '') > dateEnd.value) return false
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
watch([keyword, dateStart, dateEnd], () => { page.value = 1 })

// 展示层结算口径：未付金额为 0 即显示结清（无需打开编辑弹窗，旧单也生效）
const settleLabelOf = (row) => isSettledOf(payableOf(row), row.settle) ? '结清' : '挂账'
// 金额驱动结清（未付为 0 但库内仍挂账）：标签已按金额显示结清，禁止再手动改挂账
const autoSettled = (row) => payableOf(row) <= 0 && (row.settle || '挂账') !== '结清'
// 该单各笔付款流水所属的资金单据编码（FK-）：去重后展示，便于一眼看清哪张付款单覆盖本单
const voucherCodesOf = (row) => [...new Set((ensurePayments(row, 'paid') || []).map(p => p.voucher).filter(Boolean))]

// 导出/打印与列表当前页同步：副标题标注输出范围（第 X/Y 页）
const subtitle = computed(() => {
  const parts = [`共 ${filtered.value.length} 单`, `导出当前第 ${page.value}/${pageCount.value} 页`]
  if (dateStart.value || dateEnd.value) parts.push(`${dateStart.value || '不限'} ~ ${dateEnd.value || '不限'}`)
  if (keyword.value) parts.push('已按关键词筛选')
  return parts.join(' · ')
})
const exportColumns = [
  { label: '单号', prop: 'id' },
  { label: '供应商', prop: 'supplier' },
  { label: '日期', prop: 'date' },
  { label: '应付', value: r => grossOf(r).toFixed(2) },
  { label: '实付', value: r => { const n = ensurePayments(r, 'paid').length; return paidSumOf(r).toFixed(2) + (n > 1 ? `（${n}笔）` : '') } },
  { label: '优惠', value: r => (Number(r.discount || 0) ? Number(r.discount).toFixed(2) : '') },
  { label: '未付', value: r => payableOf(r).toFixed(2) },
  { label: '结算', value: r => settleLabelOf(r) },
  { label: '收付款单', value: r => voucherCodesOf(r).join('、') },
  { label: '备注', prop: 'remark' }
]

function loadAll() {
  return Promise.all([api.getPurchases(), api.getItems(), api.getSuppliers()])
}

onMounted(async () => {
  try {
    const [p, it, sup] = await loadAll()
    list.value = p
    itemOptions.value = it
    supplierOptions.value = sup
  } catch (e) {
    list.value = []
    itemOptions.value = []
    supplierOptions.value = []
  }
})

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
async function onOrderSaved({ entry, isEdit, depositDeduct }) {
  saving.value = true
  try {
    const snapshot = [...list.value]
    // 幂等合并：同单号已存在则替换，防止「保存成功但刷新失败→重复点击」造成重复单
    const exist = list.value.findIndex(p => p.id === entry.id)
    if (exist >= 0) list.value[exist] = entry
    else list.value.push(entry)
    try {
      await api.savePurchases(list.value)
    } catch (e) {
      list.value = snapshot
      ElMessage.error(`保存失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
      const [p, it, sup] = await loadAll().catch(() => [null, null, null])
      if (p) list.value = p
      if (it) itemOptions.value = it
      if (sup) supplierOptions.value = sup
      return
    }
    // 保存已成功：先关窗 + 报成功，让用户立刻得到反馈；刷新放到后面且单独容错
    dialog.value = false
    editingOrder.value = null
    ElMessage.success(isEdit ? '已保存修改' : '采购入库成功')
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
  const idx = list.value.findIndex(p => p.id === updated.id)
  if (idx >= 0) list.value[idx] = updated
  // 保存失败时弹窗保持打开（父组件不关闭），便于直接重试
  try {
    await api.savePurchases(list.value)
  } catch (e) {
    ElMessage.error(`保存失败：${e.message || '网络异常'}，请重试`)
    return
  }
  const [p, it, sup] = await loadAll()
  list.value = p
  itemOptions.value = it
  supplierOptions.value = sup
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
}

// 超付转供应商预付款
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
  // 欠款以金额为准：标记结清时，未付差额全部记为抹零优惠（不产生实际付款流水），保证状态与金额一致
  // 分支按展示口径判定（未付为 0 即视为结清），提示与分支一一对应
  const willSettle = settleLabelOf(row) !== '结清'
  if (willSettle) {
    const due = grossOf(row)
    const unpaid = payableOf(row)
    if (unpaid > 0) {
      const paid = paidSumOf(row)
      try {
        await ElMessageBox.confirm(
          `该单应付 ¥${due.toFixed(2)}，已实付 ¥${paid.toFixed(2)}，未付 ¥${unpaid.toFixed(2)}。\n标记结清将把差额 ¥${unpaid.toFixed(2)} 记为抹零优惠（不产生实际付款，现金不减少），本单按 ¥${paid.toFixed(2)} 结清。`,
          '标记结清', { type: 'warning' })
      } catch { return }
      // 抹零优惠：差额计入 discount 而非付款流水；syncPayments 按金额自动判定结清
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
      const updated = syncPayments({ ...row, discount: round2(Number(row.discount || 0) + unpaid) }, 'payable')
      const idx = list.value.findIndex(p => p.id === updated.id)
      if (idx >= 0) list.value[idx] = updated
    } else {
      row.settle = '结清'
    }
  } else {
    row.settle = '挂账'
  }
  // 保存失败时明确报错并回滚，避免页面显示已结清但线上未生效
  try {
    await api.savePurchases(list.value)
  } catch (e) {
    ElMessage.error(`操作失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    const [p, it, sup] = await loadAll()
    supplierOptions.value = sup
    list.value = p
    itemOptions.value = it
    return
  }
  ElMessage.success(willSettle ? '已标记为结清' : '已改回挂账')
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
    await loadAll().then(([p, it, sup]) => { list.value = p; itemOptions.value = it; supplierOptions.value = sup })
    return
  }
  const [p, it, sup] = await loadAll()
  supplierOptions.value = sup
  list.value = p
  itemOptions.value = it
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
.debt{color:var(--color-danger);font-weight:600;}
.calc-line{display:flex;gap:20px;flex-wrap:wrap;color:var(--text-regular);font-size:var(--fs-table);}
.calc-hint{color:var(--text-secondary);font-weight:400;}
.lines-scroll{overflow-x:auto;}
.calc-detail{display:flex;justify-content:flex-end;gap:16px;flex-wrap:wrap;margin-top:2px;color:var(--text-secondary);font-size:var(--fs-sub);}
.line-net{font-variant-numeric:tabular-nums;}
</style>
