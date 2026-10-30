<template>
  <div v-loading="loading">
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title">
            <b>{{ isPurchase ? '采购订单' : '销售订单' }}：<span>{{ order.id }}</span></b>
            <el-tag :type="order.status === POSTED ? 'success' : 'warning'" size="small" disable-transitions class="status-tag">{{ orderStatusText(order.status) }}</el-tag>
          </div>
          <div class="actions">
            <el-checkbox v-if="!externalView" v-model="hidePrice" class="hide-price-cb">隐藏单价与金额</el-checkbox>
            <el-checkbox v-if="!priceHidden" v-model="showSellPrice" class="opt-cb">显示售价</el-checkbox>
            <el-checkbox v-if="!priceHidden" v-model="showCostCol" class="opt-cb">显示进价</el-checkbox>
            <el-checkbox v-if="!priceHidden" v-model="showHistory" class="opt-cb">展开历史价与商品档案</el-checkbox>
            <el-checkbox v-model="externalView" class="opt-cb">对外查看（隐藏价格·只读）</el-checkbox>
            <el-checkbox v-model="showPartyInfo" class="opt-cb">{{ isPurchase ? '显示供应商信息详情' : '显示客户信息详情' }}</el-checkbox>
            <el-button :disabled="!found" @click="doExport">导出CSV</el-button>
            <el-button :disabled="!found" @click="doPrint">打印(A4)</el-button>
            <el-button v-if="!externalView" type="primary" :disabled="!found || order.status === POSTED" @click="editDialog = true">编辑</el-button>
            <el-button @click="$router.push('/orders')">返回列表</el-button>
          </div>
        </div>
      </template>

      <el-alert v-if="externalView" class="external-banner" type="info" :closable="false" show-icon
        title="对外查看模式：价格与金额已隐藏，页面只读" />
      <el-alert v-if="found && order.status === DRAFT && !deposits.length" class="external-banner" type="info" :closable="false" show-icon
        title="未过账订单：不占库存、不计应收/应付；点「过账」才生成正式销售/采购单。" />

      <div class="info">
        <span>{{ isPurchase ? '供应商' : '客户' }}：
          <router-link v-if="partyCode" :to="`${isPurchase ? '/supplier/' : '/customer/'}${partyCode}`" class="link">{{ party }}</router-link>
          <span v-else>{{ party || '—' }}</span>
        </span>
        <template v-if="showPartyInfo">
          <span>联系人：{{ partyInfo.contact || '—' }}</span>
          <span>电话：{{ partyInfo.phone || '—' }}</span>
          <span>地址：{{ partyInfo.address || '—' }}</span>
        </template>
        <span>记录时间：{{ orderTimeOf(order) }}</span>
        <span>业务单号：{{ order.no && order.no !== order.id ? order.no : '—' }}</span>
        <span v-if="order.postedOrderId">关联单据：
          <router-link :to="`${isPurchase ? '/purchase/' : '/sale/'}${order.postedOrderId}`" class="link">{{ order.postedOrderId }}</router-link>
        </span>
        <template v-if="!priceHidden">
          <span>合计：¥ {{ netSum.toFixed(2) }}<template v-if="lineDiscountSum > 0">（已含单项折扣）</template></span>
          <span v-if="lineDiscountSum > 0">原价合计：¥ {{ grossSum.toFixed(2) }}（单项折扣 -¥ {{ lineDiscountSum.toFixed(2) }}）</span>
          <span v-if="orderRateText">整单折扣：{{ orderRateText }}（减 ¥{{ discountAmount.toFixed(2) }}）</span>
          <span v-if="hasDiscount">折后金额：¥ {{ discountedTotal.toFixed(2) }}</span>
          <span>整单优惠：¥ {{ Number(order.discount || 0).toFixed(2) }}</span>
          <span>订单金额：¥ {{ totalAmount.toFixed(2) }}</span>
          <span>已收订金：¥ {{ depositSum.toFixed(2) }}<template v-if="deposits.length">（{{ deposits.length }} 笔）</template></span>
          <span>{{ isPurchase ? '未付' : '未收' }}：<b :class="owed > 0 ? 'debt' : 'zero'">¥ {{ owed.toFixed(2) }}</b></span>
        </template>
        <span v-else class="price-hidden-note">（价格与金额已隐藏）</span>
        <span class="remark-cell">
          备注：<span v-if="order.remark">{{ order.remark }}</span><span v-else class="none">—</span>
        </span>
      </div>

      <div class="photos-block">
        <div class="photos-title">
          <span>原始单据照片<template v-if="photos.length">（{{ photos.length }} 张）</template></span>
        </div>
        <PhotoThumbs v-if="photos.length" :value="photos" />
        <span v-else class="none">—</span>
      </div>

      <ProductTable :items="detailItems" search-placeholder="搜索本单商品" :price-columns="tablePriceColumns"
        :show-cost="showCostCol && !priceHidden" :remark-last="true" :show-history="showHistory && !priceHidden">
        <template #extra>
          <el-table-column prop="_qty" label="本次数量" width="100" align="right" />
          <el-table-column v-if="!priceHidden" prop="_price" label="本次单价" width="100" align="right" />
          <el-table-column v-if="!priceHidden" label="本次折扣" width="100" align="right">
            <template #default="{ row }">
              <span v-if="Number(row._discount || 0) > 0" class="discount" :title="`折扣率 ${row._discountRate} · 原价 ¥${(Number(row._qty || 0) * Number(row._price || 0)).toFixed(2)}`">-{{ Number(row._discount).toFixed(2) }}</span>
              <span v-else class="none">—</span>
            </template>
          </el-table-column>
          <el-table-column v-if="!priceHidden" prop="_total" label="本次金额" width="100" align="right" />
        </template>
      </ProductTable>
    </el-card>

    <el-card v-if="!externalView && deposits.length" class="dep-card">
      <template #header>
        <div class="card-header">
          <b v-if="priceHidden">订金记录（{{ deposits.length }} 笔 · 金额已隐藏）</b>
          <b v-else>订金记录（{{ deposits.length }} 笔 · 累计 ¥ {{ depositSum.toFixed(2) }}）</b>
        </div>
      </template>
      <div class="table-wrap">
        <el-table :data="deposits" stripe>
          <el-table-column type="index" label="#" width="46" />
          <el-table-column label="时间" width="170">
            <template #default="{ row }">{{ fmtCNTime(row.time) || row.date }}</template>
          </el-table-column>
          <el-table-column v-if="!priceHidden" label="金额" width="130" align="right">
            <template #default="{ row }">{{ Number(row.amount || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
          <el-table-column label="资金单据编号" width="170" show-overflow-tooltip>
            <template #default="{ row }">
              <router-link v-if="row.voucher" :to="{ path: '/vouchers', query: { code: row.voucher } }" class="link">{{ row.voucher }}</router-link>
              <span v-else>—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>

    <OrderFormDialog
      v-model="editDialog"
      :order="order"
      :items="items"
      :customers="customers"
      :suppliers="suppliers"
      :saving="saving"
      @saved="onFormSaved"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import ProductTable from '../components/ProductTable.vue'
import PhotoThumbs from '../components/PhotoThumbs.vue'
import OrderFormDialog from '../components/OrderFormDialog.vue'
import { orderAmount, orderDepositSum, orderStatusText, DRAFT, POSTED } from '../utils/orders.js'
import { round2, discountRatesTextOf, effectiveRateOf } from '../utils/account'
import { lineDisplayName, normalizeRate } from '../utils/catalog'
import { downloadCSV, printA4 } from '../utils/export'
import { fmtCNTime, orderTimeOf } from '../utils/time.js'

const route = useRoute()
const orders = ref([])
const items = ref([])
const customers = ref([])
const suppliers = ref([])
const loading = ref(true)
const saving = ref(false)
const editDialog = ref(false)

const found = computed(() => orders.value.some(o => o.id === route.params.id))
const order = computed(() => orders.value.find(o => o.id === route.params.id) || {
  id: route.params.id, status: DRAFT, kind: 'sale', customer: '', date: '', no: '', items: [], deposits: [], photos: []
})
const isPurchase = computed(() => order.value.kind === 'purchase')
const party = computed(() => (isPurchase.value ? order.value.supplier : order.value.customer) || '')
const partyInfo = computed(() => (isPurchase.value ? suppliers.value : customers.value).find(x => x.name === party.value) || {})
const partyCode = computed(() => partyInfo.value.code || '')
const deposits = computed(() => order.value.deposits || [])
const photos = computed(() => order.value.photos || [])
const nameMap = computed(() => Object.fromEntries((items.value || []).map(i => [i.code, i.name || ''])))

// ---- 明细行金额：与订单弹窗、正式单据同一口径 ----
const lineGross = (l) => round2(Number(l.qty || 0) * Number(l.price || 0))
const lineRate = (l) => normalizeRate(l, lineGross(l))
const lineDiscount = (l) => round2(lineGross(l) * (1 - lineRate(l)))
const lineTotal = (l) => Math.max(0, round2(lineGross(l) - lineDiscount(l)))

const detailItems = computed(() => (order.value.items || []).map(line => {
  const base = (items.value || []).find(i => i.code === line.code) || {}
  return {
    ...base,
    code: line.code,
    name: lineDisplayName(line, nameMap.value),
    unit: base.unit || '',
    // 售价 / 进价 取自商品档案，与「本次单价」区分：订单谈的是本单价，档案价只作参照
    price: base.price,
    cost: base.cost,
    _qty: Number(line.qty || 0),
    _price: Number(line.price || 0),
    _discountRate: lineRate(line),
    _discount: lineDiscount(line),
    _total: lineTotal(line)
  }
}))

const grossSum = computed(() => round2((order.value.items || []).reduce((s, l) => s + lineGross(l), 0)))
const lineDiscountSum = computed(() => round2((order.value.items || []).reduce((s, l) => s + lineDiscount(l), 0)))
const netSum = computed(() => round2((order.value.items || []).reduce((s, l) => s + lineTotal(l), 0)))
const orderRateText = computed(() => discountRatesTextOf(order.value))
const discountAmount = computed(() => Math.max(0, round2(netSum.value * (1 - effectiveRateOf(order.value)))))
const discountedTotal = computed(() => round2(netSum.value * effectiveRateOf(order.value)))
const totalAmount = computed(() => orderAmount(order.value))
const depositSum = computed(() => orderDepositSum(order.value))
const owed = computed(() => Math.max(0, round2(totalAmount.value - depositSum.value)))
const hasDiscount = computed(() => Boolean(orderRateText.value) || lineDiscountSum.value > 0)

// ---- 勾选项：与销售/采购详情页同一口径 ----
const hidePrice = ref(false)
const showSellPrice = ref(false)
const showCostCol = ref(false)
const showHistory = ref(false)
const externalView = ref(false)
const showPartyInfo = ref(false)
const priceHidden = computed(() => hidePrice.value || externalView.value)
// 档案售价默认收起（与「本次单价」重复）；勾「显示售价」才出现
const tablePriceColumns = computed(() => (!priceHidden.value && showSellPrice.value) ? [{ prop: 'price', label: '售价' }] : [])

// ---- 导出 CSV / 打印(A4)：与页面开关同一口径 ----
const exportColumns = computed(() => {
  const cols = [
    { label: '编码', prop: 'code' },
    { label: '名称', value: r => lineDisplayName(r, nameMap.value) },
    { label: '单位', prop: 'unit' }
  ]
  if (showCostCol.value && !priceHidden.value) {
    cols.push({ label: '进价', value: r => (r.cost == null || r.cost === '' ? '' : Number(r.cost).toFixed(2)) })
  }
  if (showSellPrice.value && !priceHidden.value) {
    cols.push({ label: '售价', value: r => (r.price == null || r.price === '' ? '' : Number(r.price).toFixed(2)) })
  }
  cols.push({ label: '本次数量', value: r => Number(r._qty || 0) })
  if (!priceHidden.value) {
    cols.push(
      { label: '本次单价', value: r => Number(r._price || 0).toFixed(2) },
      { label: '折扣率', value: r => Number(r._discountRate || 1).toFixed(2) },
      { label: '本次折扣', value: r => Number(r._discount || 0).toFixed(2) },
      { label: '本次金额', value: r => Number(r._total || 0).toFixed(2) }
    )
  }
  return cols
})

const docSubtitle = computed(() => `共 ${detailItems.value.length} 项商品 · ${orderStatusText(order.value.status)}`)
const docHeaderFields = computed(() => {
  const fields = [
    ['订单号', order.value.id],
    ['业务单号', order.value.no && order.value.no !== order.value.id ? order.value.no : '—'],
    [isPurchase.value ? '供应商' : '客户', party.value || '—']
  ]
  if (showPartyInfo.value) {
    const p = partyInfo.value
    fields.push(['联系人', p.contact || '—'], ['电话', p.phone || '—'], ['地址', p.address || '—'])
  }
  fields.push(['日期', order.value.date], ['状态', orderStatusText(order.value.status)])
  if (order.value.postedOrderId) fields.push(['关联单据', order.value.postedOrderId])
  if (!priceHidden.value) {
    fields.push(['合计', `¥${netSum.value.toFixed(2)}`])
    if (lineDiscountSum.value > 0) fields.push(['原价合计', `¥${grossSum.value.toFixed(2)}（单项折扣 -¥${lineDiscountSum.value.toFixed(2)}）`])
    if (orderRateText.value) fields.push(['整单折扣', `${orderRateText.value}（减 ¥${discountAmount.value.toFixed(2)}）`])
    if (hasDiscount.value) fields.push(['折后金额', `¥${discountedTotal.value.toFixed(2)}`])
    fields.push(
      ['整单优惠', `¥${Number(order.value.discount || 0).toFixed(2)}`],
      ['订单金额', `¥${totalAmount.value.toFixed(2)}`],
      ['已收订金', `¥${depositSum.value.toFixed(2)}`],
      [isPurchase.value ? '未付' : '未收', `¥${owed.value.toFixed(2)}`]
    )
  }
  fields.push(['备注', order.value.remark || '—'])
  return fields
})

function doExport() {
  if (!detailItems.value.length) return ElMessage.warning('本订单暂无商品明细')
  downloadCSV(`${isPurchase.value ? '采购' : '销售'}订单-${order.value.id}.csv`, exportColumns.value, detailItems.value, docHeaderFields.value)
  ElMessage.success(`已导出 ${detailItems.value.length} 行${priceHidden.value ? '（已隐藏单价与金额）' : ''}`)
}

function doPrint() {
  if (!detailItems.value.length) return ElMessage.warning('本订单暂无商品明细')
  const title = `${isPurchase.value ? '采购' : '销售'}订单 ${order.value.id}`
  printA4(title, exportColumns.value, detailItems.value, docSubtitle.value, docHeaderFields.value)
}

async function onFormSaved({ draft, isEdit }) {
  saving.value = true
  try {
    const r = await api.orderOperation({ action: 'save', order: draft })
    ElMessage.success(isEdit ? `订单已更新：${r.code}` : `订单已创建：${r.code}`)
    editDialog.value = false
    await load()
  } catch (e) {
    if (e.status === 409) ElMessage.error('数据已被其他操作更新，请刷新后重试')
    else if (e.status && e.status >= 500) ElMessage.error(`${e.message || '网络异常'}，请以刷新后的数据为准`)
    else ElMessage.error(e.message || '订单保存失败')
  } finally { saving.value = false }
}

async function load() {
  loading.value = true
  try {
    const [o, it, cu, sup] = await Promise.all([api.getOrders(), api.getItems(), api.getCustomers(), api.getSuppliers()])
    orders.value = o || []
    items.value = it || []
    customers.value = cu || []
    suppliers.value = sup || []
  } catch (e) {
    ElMessage.error({ message: `订单加载失败（${e.message || '网络异常'}），请返回列表重试`, duration: 6000 })
  } finally { loading.value = false }
}

onMounted(load)
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.status-tag { margin-left: 2px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.hide-price-cb { margin-right: 4px; white-space: nowrap; }
.opt-cb { margin-right: 4px; white-space: nowrap; }
.opt-cb :deep(.el-checkbox__label) { font-size: var(--fs-sub); color: var(--text-regular); }
.hide-price-cb :deep(.el-checkbox__label) { font-size: var(--fs-sub); color: var(--text-regular); }
.info { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px; color: var(--text-regular); font-size: var(--fs-base); align-items: center; }
.external-banner { margin-bottom: 12px; }
.price-hidden-note { color: var(--text-secondary); }
.remark-cell { display: inline-flex; align-items: center; gap: 4px; }
.photos-block { margin-bottom: 12px; }
.photos-title { font-weight: 600; margin-bottom: 6px; color: var(--color-primary); display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.dep-card { margin-top: 12px; }
</style>
