<template>
  <div v-loading="loading">
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title">
            <b>销售单：{{ sale.id }}</b>
          </div>
          <!-- 单据不存在（已删除/链接失效）时禁用写操作，避免把占位空单当成新增保存 -->
          <div class="actions">
            <el-checkbox v-model="hidePrice" class="hide-price-cb">隐藏单价与金额</el-checkbox>
            <el-checkbox v-model="showCostCol" class="opt-cb">显示进价</el-checkbox>
            <el-button :disabled="!found" @click="doExport">导出CSV</el-button>
            <el-button :disabled="!found" @click="doPrint">打印(A4)</el-button>
            <el-button type="primary" :disabled="!found" @click="editDialog = true">编辑</el-button>
            <el-button type="danger" :disabled="!found" @click="removeOrder">删除</el-button>
            <el-button @click="$router.push('/sales')">返回列表</el-button>
          </div>
        </div>
      </template>
      <div class="info">
        <span>客户：
          <router-link v-if="customerCodeMap[sale.customer]" :to="`/customer/${customerCodeMap[sale.customer]}`" class="link">{{ sale.customer }}</router-link>
          <span v-else>{{ sale.customer }}</span>
        </span>
        <span>日期：{{ sale.date }}</span>
        <span>合计：¥ {{ Number(sale.total || 0).toFixed(2) }}<template v-if="lineDiscountSum > 0">（已含单项折扣）</template></span>
        <span v-if="lineDiscountSum > 0">原价合计：¥ {{ grossSum.toFixed(2) }}（单项折扣 -¥ {{ lineDiscountSum.toFixed(2) }}）</span>
        <span v-if="orderRate">整单折扣：{{ orderRate }}</span>
        <span>优惠：¥ {{ Number(sale.discount || 0).toFixed(2) }}<template v-if="Number(sale.discount || 0) > 0">（抹零优惠，未实际收款）</template></span>
        <span>应收：¥ {{ dueAmount.toFixed(2) }}</span>
        <span>实收：¥ {{ receivedSum.toFixed(2) }}<template v-if="payments.length">（{{ payments.length }} 笔）</template></span>
        <span>
          未收：<b :class="unpaid > 0 ? 'debt' : 'zero'">¥ {{ unpaid.toFixed(2) }}</b>
        </span>
        <span class="settle-cell">
          结算：
          <el-tag :type="settleLabel === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
            {{ settleLabel }}
          </el-tag>
          <!-- 标记结清：未收差额记为抹零优惠，未收自动归 0（与列表页、编辑弹窗同口径） -->
          <el-button link size="small" type="primary" class="settle-btn"
            :disabled="!found || autoSettled"
            :title="autoSettled ? '未收金额为 0，按金额自动结清' : ''"
            @click="toggleSettle">
            {{ settleLabel === '结清' ? '改挂账' : '结清' }}
          </el-button>
        </span>
        <span v-if="sale.remark">备注：{{ sale.remark }}</span>
      </div>
      <div class="photos-block">
        <div class="photos-title">
          <span>原始单据照片<template v-if="(sale.photos || []).length">（{{ (sale.photos || []).length }} 张）</template></span>
          <el-button size="small" type="primary" @click="photoDialog = true">
            {{ (sale.photos || []).length ? '添加照片' : '上传原始单据照片' }}
          </el-button>
        </div>
        <PhotoThumbs v-if="(sale.photos || []).length" :value="sale.photos" />
      </div>
      <ProductTable :items="detailItems" search-placeholder="搜索本单商品" :show-cost="showCostCol">
        <template #extra>
          <el-table-column prop="_qty" label="本次数量" width="100"  align="right"/>
          <el-table-column prop="_price" label="本次单价" width="100"  align="right"/>
          <el-table-column label="本次折扣" width="100" align="right">
            <template #default="{ row }">
              <span v-if="Number(row._discount || 0) > 0" class="discount" :title="`${row._discountRate != null && row._discountRate < 1 ? `折扣率 ${row._discountRate} · ` : ''}原价 ¥${(Number(row._qty || 0) * Number(row._price || 0)).toFixed(2)}`">-{{ Number(row._discount).toFixed(2) }}</span>
              <span v-else class="none">—</span>
            </template>
          </el-table-column>
          <el-table-column prop="_total" label="本次金额" width="100"  align="right"/>
        </template>
      </ProductTable>
    </el-card>

    <el-card class="pay-card">
      <template #header>
        <div class="card-header">
          <b>收款记录（{{ payments.length }} 笔 · 累计 ¥ {{ receivedSum.toFixed(2) }} / 应收 ¥ {{ dueAmount.toFixed(2) }}<template v-if="Number(sale.discount || 0) > 0"> · 抹零优惠 ¥ {{ Number(sale.discount).toFixed(2) }}（未实际收款）</template>）</b>
          <el-button type="primary" size="small" @click="payDialog = true">记录收款</el-button>
        </div>
      </template>
      <div class="table-wrap">
      <el-table :data="payments" stripe empty-text="暂无收款记录，可点右上角「记录收款」分多笔登记">
        <el-table-column type="index" label="#" width="46" />
        <el-table-column prop="date" label="日期" width="140" />
        <el-table-column label="金额" width="130" align="right">
          <template #default="{ row }">{{ Number(row.amount || 0).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" width="160" show-overflow-tooltip />
      </el-table>
      </div>
    </el-card>

    <PaymentDialog v-model="payDialog" :order="sale" kind="receivable" :deposit-balance="customerDepositBalance" @saved="onPaySaved" />

    <!-- 就地编辑本单：与列表页「编辑」共用同一个弹窗组件（客户档案用于分级售价策略） -->
    <OrderEditDialog
      v-model="editDialog"
      :order="sale"
      :list="sales"
      :items="items"
      :customers="customers"
      kind="receivable"
      :saving="saving"
      @saved="onOrderSaved"
    />

    <!-- 轻量补照片：仅更新本单 photos 字段 -->
    <OrderPhotoDialog v-model="photoDialog" :order="sale" @saved="onPhotosSaved" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import ProductTable from '../components/ProductTable.vue'
import PhotoThumbs from '../components/PhotoThumbs.vue'
import OrderPhotoDialog from '../components/OrderPhotoDialog.vue'
import OrderEditDialog from '../components/OrderEditDialog.vue'
import PaymentDialog from '../components/PaymentDialog.vue'
import { receivableOf, grossOf, receivedSumOf, ensurePayments, depositSumOf, isSettledOf, syncPayments, round2, discountRatesTextOf } from '../utils/account'
import { downloadCSV, printA4 } from '../utils/export'
import { applyDepositFlows, removeDepositFlows } from '../utils/deposit'
import { lineDisplayName } from '../utils/catalog'

const route = useRoute()
const router = useRouter()
const sales = ref([])
const items = ref([])
// 客户档案：编辑弹窗里的单价策略（客户类别分级价 / 该客户最近成交价）依赖它
const customers = ref([])
// 数据加载中：全量单据/商品拉取期间显示遮罩，避免白屏被误判为"点了没反应"
const loading = ref(true)
const payDialog = ref(false)
const photoDialog = ref(false)
const editDialog = ref(false)
// 保存中标记：配合弹窗按钮 loading，防止双击重复提交
const saving = ref(false)
// 单据是否真实存在：不存在时禁用编辑/删除，避免把占位空单当新增保存
const found = computed(() => sales.value.some(s => s.id === route.params.id))
const sale = computed(() => sales.value.find(s => s.id === route.params.id) || { id: route.params.id, customer: '', date: '', total: 0, items: [] })
// 当前销售单对应客户的预存款可用余额（用于收款时「用预存款支付」抵扣）
const customerDepositBalance = computed(() => {
  const c = customers.value.find(x => x.name === sale.value.customer)
  return depositSumOf(c && c.deposits)
})
// 客户名 → 编码：详情页点客户名跳转客户详情
const customerCodeMap = computed(() => {
  const m = {}
  ;(customers.value || []).forEach(c => { if (c && c.name) m[c.name] = c.code })
  return m
})
// 整单折扣链文本（单级 ×0.90 / 多级 ×0.90 ×0.90 ×0.80 = ×0.65 / 无折扣空串）：与 account 口径一致
const orderRate = computed(() => discountRatesTextOf(sale.value))

// 应收(合计−优惠) 与 未收(应收−累计实收)，与全站统一规则一致
const dueAmount = computed(() => grossOf(sale.value))
const unpaid = computed(() => receivableOf(sale.value))
const receivedSum = computed(() => receivedSumOf(sale.value))
const payments = computed(() => ensurePayments(sale.value, 'received'))
// 展示层结算口径：未收金额为 0 即显示结清（无需打开编辑弹窗，旧单也生效）
const settleLabel = computed(() => isSettledOf(unpaid.value, sale.value.settle) ? '结清' : '挂账')
// 未收金额为 0 时按金额已自动结清：无需再点「结清」（与列表页 autoSettled 同口径）
const autoSettled = computed(() => unpaid.value <= 0 && (sale.value.settle || '挂账') !== '结清')

// 点「结清」：未收差额记为抹零优惠（不产生实际收款流水，现金不增加），
// 应收随之减少、未收自动归 0，syncPayments 按金额自动判定结清——状态与金额保持一致。
// 与销售列表页 toggleSettle、编辑弹窗保存逻辑三处同口径
async function toggleSettle() {
  const willSettle = settleLabel.value !== '结清'
  if (willSettle && unpaid.value > 0) {
    const due = dueAmount.value
    const received = receivedSum.value
    const gap = unpaid.value
    try {
      await ElMessageBox.confirm(
        `该单应收 ¥${due.toFixed(2)}，已实收 ¥${received.toFixed(2)}，未收 ¥${gap.toFixed(2)}。\n标记结清将把差额 ¥${gap.toFixed(2)} 记为抹零优惠（不产生实际收款，现金不增加），本单按 ¥${received.toFixed(2)} 结清。`,
        '标记结清', { type: 'warning' })
    } catch { return }
    const updated = syncPayments({ ...sale.value, discount: round2(Number(sale.value.discount || 0) + gap) }, 'receivable')
    const idx = sales.value.findIndex(s => s.id === updated.id)
    if (idx >= 0) sales.value[idx] = updated
  } else {
    // 未收已为 0：直接标记结清；或从「结清」改回「挂账」
    const idx = sales.value.findIndex(s => s.id === sale.value.id)
    if (idx >= 0) sales.value[idx] = { ...sales.value[idx], settle: willSettle ? '结清' : '挂账' }
  }
  // 保存失败：明确报错并回滚为线上数据，避免页面显示已结清但线上未生效
  try {
    await api.saveSales(sales.value)
  } catch (e) {
    ElMessage.error(`操作失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    const fresh = await api.getSales().catch(() => null)
    if (fresh) sales.value = fresh
    return
  }
  ElMessage.success(willSettle ? '已标记为结清，未收已清零' : '已改回挂账')
}

// 明细行原价合计与单项折扣合计（合计字段为折后金额）
const grossSum = computed(() => (sale.value.items || []).reduce((s, l) => s + Number(l.qty || 0) * Number(l.price || 0), 0))
const lineDiscountSum = computed(() => (sale.value.items || []).reduce((s, l) => s + Number(l.discount || 0), 0))

const detailItems = computed(() => {
  const nameMap = Object.fromEntries((items.value || []).map(i => [i.code, i.name || '']))
  return (sale.value.items || []).map(line => {
    const base = (items.value || []).find(i => i.code === line.code) || {}
    return {
      ...base,
      code: line.code,
      name: lineDisplayName(line, nameMap),
      suppliers: base.suppliers || [],
      purchaseHistory: base.purchaseHistory || [],
      saleHistory: base.saleHistory || [],
      package: base.package,
      unit: base.unit || '',
      price: line.price,
      _qty: line.qty,
      _price: line.price,
      _discount: Number(line.discount || 0),
      _discountRate: line.discountRate,
      _total: line.total
    }
  })
})

// ---- 导出 CSV / 打印(A4) ----
// 「隐藏单价与金额」勾选后剔除所有价格列，只留商品与数量：用于对外送货单、不带价对账场景
const hidePrice = ref(false)
// 销售单详情默认不展示进价（成本列），需要时勾选「显示进价」查看
const showCostCol = ref(false)
const PRICE_LABELS = ['进价', '售价', '本次单价', '本次折扣', '本次金额']
const exportColumns = computed(() => {
  let cols = [
    { label: '编码', prop: 'code' },
    { label: '名称', prop: 'name' },
    { label: '单位', prop: 'unit' },
    { label: '供应商', value: r => (r.suppliers || []).join('、') },
    { label: '进价', value: r => (r.cost == null || r.cost === '' ? '' : Number(r.cost).toFixed(2)) },
    { label: '售价', value: r => (r.price == null || r.price === '' ? '' : Number(r.price).toFixed(2)) },
    { label: '备注', prop: 'remark' },
    { label: '本次数量', prop: '_qty' },
    { label: '本次单价', value: r => (r._price == null || r._price === '' ? '' : Number(r._price).toFixed(2)) },
    { label: '本次折扣', value: r => (Number(r._discount) ? Number(r._discount).toFixed(2) : '') },
    { label: '本次金额', value: r => (r._total == null || r._total === '' ? '' : Number(r._total).toFixed(2)) }
  ]
  // 与页面表格同步：未勾选「显示进价」时，导出/打印一律不带进价列
  if (!showCostCol.value) cols = cols.filter(c => c.label !== '进价')
  // 隐藏单价与金额：剔除全部价格列（对外脱敏，优先级最高）
  if (hidePrice.value) cols = cols.filter(c => !PRICE_LABELS.includes(c.label))
  return cols
})
// 打印页副标题：商品行数摘要（完整单头信息见下方 fields 字段区，避免重复）
const docSubtitle = computed(() => `共 ${detailItems.value.length} 项商品`)
// 单头信息：客户档案全量信息 + 单据关键字段（客户/日期/合计/优惠/应收/实收/未收/结算/备注，有折扣显示折扣）。
// 「隐藏单价与金额」勾选时同步剔除金额类字段，与明细列保持同一脱敏口径
const AMOUNT_FIELD_LABELS = ['合计', '原价合计', '整单折扣', '优惠', '应收', '实收', '未收']
const docHeaderFields = computed(() => {
  const o = sale.value
  const c = (customers.value || []).find(x => x.name === o.customer) || {}
  const fields = [
    ['客户', o.customer || '—'],
    ['客户编码', c.code],
    ['联系人', c.contact],
    ['电话', c.phone],
    ['地址', c.address],
    ['类别', c.category],
    ['日期', o.date],
    ['合计', `¥${Number(o.total || 0).toFixed(2)}`]
  ]
  if (lineDiscountSum.value > 0) fields.push(['原价合计', `¥${grossSum.value.toFixed(2)}（单项折扣 -¥${lineDiscountSum.value.toFixed(2)}）`])
  if (orderRate.value) fields.push(['整单折扣', orderRate.value])
  fields.push(
    ['优惠', `¥${Number(o.discount || 0).toFixed(2)}${Number(o.discount || 0) > 0 ? '（抹零优惠，未实际收款）' : ''}`],
    ['应收', `¥${dueAmount.value.toFixed(2)}`],
    ['实收', `¥${receivedSum.value.toFixed(2)}${payments.value.length ? `（${payments.value.length} 笔）` : ''}`],
    ['未收', `¥${unpaid.value.toFixed(2)}`],
    ['结算', settleLabel.value],
    ['备注', o.remark]
  )
  if (hidePrice.value) return fields.filter(([label]) => !AMOUNT_FIELD_LABELS.includes(label))
  return fields
})
function doExport() {
  if (!detailItems.value.length) return ElMessage.warning('本单暂无商品明细')
  downloadCSV(`销售单-${sale.value.id}.csv`, exportColumns.value, detailItems.value, docHeaderFields.value)
  ElMessage.success(`已导出 ${detailItems.value.length} 行${hidePrice.value ? '（已隐藏单价与金额）' : ''}`)
}
function doPrint() {
  if (!detailItems.value.length) return ElMessage.warning('本单暂无商品明细')
  printA4(`销售单 ${sale.value.id}`, exportColumns.value, detailItems.value, docSubtitle.value, docHeaderFields.value)
}

async function onPaySaved(updated, payload) {
  const idx = sales.value.findIndex(s => s.id === updated.id)
  if (idx >= 0) sales.value[idx] = updated
  try {
    await api.saveSales(sales.value)
  } catch (e) {
    // 保存失败要回滚并明确报错：否则界面显示已收款、线上其实没变，且弹窗不关可重复提交
    const fresh = await api.getSales().catch(() => null)
    if (fresh) sales.value = fresh
    ElMessage.error(`保存失败：${e.message || '网络异常'}，本地改动已回滚`)
    return
  }
  payDialog.value = false
  ElMessage.success('已保存收款流水')
  // 超收转预存款 / 用预存款抵扣：按订单 id 幂等重建流水，重复保存不会重复加减（资金不泄漏）
  const addAmt = Number(payload?.add?.amount || 0)
  const deductAmt = Number(payload?.deduct?.amount || 0)
  if (addAmt > 0 || deductAmt > 0) {
    const list2 = await applyDepositFlows(api, 'receivable', updated.customer, updated.id, addAmt, deductAmt)
    if (list2) customers.value = list2
    const parts = []
    if (addAmt > 0) parts.push(`存入客户预存款 ¥${addAmt.toFixed(2)}`)
    if (deductAmt > 0) parts.push(`扣减客户预存款 ¥${deductAmt.toFixed(2)}`)
    if (parts.length) ElMessage.success(parts.join('；'))
  }
}

// 保存照片：仅合并 photos 字段，单据其他信息与收款流水不动
async function onPhotosSaved(photos) {
  const cur = sale.value
  const idx = sales.value.findIndex(s => s.id === cur.id)
  if (idx < 0) return
  const origin = sales.value[idx]
  sales.value[idx] = { ...origin, photos }
  try {
    await api.saveSales(sales.value)
  } catch (e) {
    sales.value[idx] = origin
    ElMessage.error(`保存失败：${e.message || '网络异常'}，请重试`)
    return
  }
  photoDialog.value = false
  ElMessage.success('已更新单据照片')
}

// 编辑本单：弹窗组装好 entry 后在此落库，保存成功后重拉数据，页面原地刷新
async function onOrderSaved({ entry, depositDeduct }) {
  saving.value = true
  try {
    const snapshot = [...sales.value]
    const idx = sales.value.findIndex(s => s.id === entry.id)
    if (idx >= 0) sales.value[idx] = entry
    try {
      await api.saveSales(sales.value)
    } catch (e) {
      sales.value = snapshot
      ElMessage.error(`保存失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
      return
    }
    // 保存已成功：先关窗报成功；刷新单独容错，失败不再卡住弹窗（避免重复点击）
    editDialog.value = false
    ElMessage.success('已保存修改')
    // 商品销售价历史、库存、客户档案均由后端自动推导，重拉保证页面与线上一致
    try {
      const [s, it, cu] = await Promise.all([api.getSales(), api.getItems(), api.getCustomers()])
      sales.value = s
      items.value = it
      customers.value = cu || []
    } catch { /* 刷新失败：保留本地数据，下次进入页面会自动重拉 */ }
    // 兜底：若带预收款抵扣（正常编辑路径不会），一并扣减
    if (depositDeduct && Number(depositDeduct.amount) > 0) {
      const cu2 = await applyDepositFlows(api, 'receivable', entry.customer, entry.id, 0, depositDeduct.amount).catch(() => null)
      if (cu2) customers.value = cu2
      ElMessage.success(`已从客户预收款扣减 ¥${Number(depositDeduct.amount).toFixed(2)}`)
    }
  } finally { saving.value = false }
}

// 删除本单：库存与历史价由后端自动重算；删除成功后必须跳回列表，否则路由 id 失效只剩占位空单
async function removeOrder() {
  try {
    await ElMessageBox.confirm(
      `确定删除销售单 ${sale.value.id}?\n删除后库存与历史价会自动重算，删除后将返回销售列表。`,
      '提示', { type: 'warning' })
  } catch { return }
  saving.value = true
  try {
    const snapshot = [...sales.value]
    sales.value = sales.value.filter(s => s.id !== sale.value.id)
    try {
      await api.saveSales(sales.value)
    } catch (e) {
      sales.value = snapshot
      ElMessage.error(`删除失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
      return
    }
    ElMessage.success('已删除')
    // 删除单据时同步清掉其超收转存/抵扣标记的预存款流水
    const cu2 = await removeDepositFlows(api, 'receivable', sale.value.customer, sale.value.id).catch(() => null)
    if (cu2) customers.value = cu2
    router.push('/sales')
  } finally { saving.value = false }
}

onMounted(async () => {
  try {
    const [s, it, cu] = await Promise.all([api.getSales(), api.getItems(), api.getCustomers()])
    sales.value = s
    items.value = it
    customers.value = cu || []
  } catch (e) { sales.value = []; items.value = []; customers.value = [] }
  finally { loading.value = false }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.hide-price-cb { margin-right: 4px; white-space: nowrap; }
.opt-cb { margin-right: 4px; white-space: nowrap; }
.opt-cb :deep(.el-checkbox__label) { font-size: var(--fs-sub); color: var(--text-regular); }
.hide-price-cb :deep(.el-checkbox__label) { font-size: var(--fs-sub); color: var(--text-regular); }
.info { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px; color:var(--text-regular); font-size:var(--fs-base); align-items: center; }
.settle-cell { display: inline-flex; align-items: center; gap: 4px; }
.settle-btn { margin-left: 2px; }
.photos-block { margin-bottom: 12px; }
.photos-title { font-weight: 600; margin-bottom: 6px; color:var(--color-primary); display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.pay-card { margin-top: 12px; }
.debt { color:var(--color-danger); }
.zero { color:var(--color-success); }
.none { color:var(--text-placeholder); }
.discount { color:var(--color-success); }
</style>
