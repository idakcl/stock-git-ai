<template>
  <div v-loading="loading">
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title">
            <b>采购单：{{ purchase.id }}</b>
          </div>
          <!-- 单据不存在（已删除/链接失效）时禁用写操作，避免把占位空单当成新增保存 -->
          <div class="actions">
            <el-button type="primary" :disabled="!found" @click="editDialog = true">编辑</el-button>
            <el-button type="danger" :disabled="!found" @click="removeOrder">删除</el-button>
            <el-button @click="$router.push('/purchases')">返回列表</el-button>
          </div>
        </div>
      </template>
      <div class="info">
        <span>供应商：{{ purchase.supplier }}</span>
        <span>日期：{{ purchase.date }}</span>
        <span>合计：¥ {{ Number(purchase.total || 0).toFixed(2) }}<template v-if="lineDiscountSum > 0">（已含单项折扣）</template></span>
        <span v-if="lineDiscountSum > 0">原价合计：¥ {{ grossSum.toFixed(2) }}（单项折扣 -¥ {{ lineDiscountSum.toFixed(2) }}）</span>
        <span>优惠：¥ {{ Number(purchase.discount || 0).toFixed(2) }}<template v-if="Number(purchase.discount || 0) > 0">（抹零优惠，未实际付款）</template></span>
        <span>应付：¥ {{ dueAmount.toFixed(2) }}</span>
        <span>实付：¥ {{ paidSum.toFixed(2) }}<template v-if="payments.length">（{{ payments.length }} 笔）</template></span>
        <span>
          未付：<b :class="unpaid > 0 ? 'debt' : 'zero'">¥ {{ unpaid.toFixed(2) }}</b>
        </span>
        <span>
          结算：
          <el-tag :type="purchase.settle === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
            {{ purchase.settle || '挂账' }}
          </el-tag>
        </span>
        <span v-if="purchase.remark">备注：{{ purchase.remark }}</span>
      </div>
      <div class="photos-block">
        <div class="photos-title">
          <span>原始单据照片<template v-if="(purchase.photos || []).length">（{{ (purchase.photos || []).length }} 张）</template></span>
          <el-button size="small" type="primary" @click="photoDialog = true">
            {{ (purchase.photos || []).length ? '添加照片' : '上传原始单据照片' }}
          </el-button>
        </div>
        <PhotoThumbs v-if="(purchase.photos || []).length" :value="purchase.photos" />
      </div>
      <ProductTable :items="detailItems" search-placeholder="搜索本单商品">
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
          <b>付款记录（{{ payments.length }} 笔 · 累计 ¥ {{ paidSum.toFixed(2) }} / 应付 ¥ {{ dueAmount.toFixed(2) }}<template v-if="Number(purchase.discount || 0) > 0"> · 抹零优惠 ¥ {{ Number(purchase.discount).toFixed(2) }}（未实际付款）</template>）</b>
          <el-button type="primary" size="small" @click="payDialog = true">记录付款</el-button>
        </div>
      </template>
      <div class="table-wrap">
      <el-table :data="payments" stripe empty-text="暂无付款记录，可点右上角「记录付款」分多笔登记">
        <el-table-column type="index" label="#" width="46" />
        <el-table-column prop="date" label="日期" width="140" />
        <el-table-column label="金额" width="130" align="right">
          <template #default="{ row }">{{ Number(row.amount || 0).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
      </el-table>
      </div>
    </el-card>

    <PaymentDialog v-model="payDialog" :order="purchase" kind="payable" :deposit-balance="supplierAdvanceBalance" @saved="onPaySaved" />

    <!-- 就地编辑本单：与列表页「编辑」共用同一个弹窗组件 -->
    <OrderEditDialog
      v-model="editDialog"
      :order="purchase"
      :list="purchases"
      :items="items"
      kind="payable"
      :saving="saving"
      @saved="onOrderSaved"
    />

    <!-- 轻量补照片：仅更新本单 photos 字段 -->
    <OrderPhotoDialog v-model="photoDialog" :order="purchase" @saved="onPhotosSaved" />
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
import { payableOf, grossOf, paidSumOf, ensurePayments, depositSumOf } from '../utils/account'
import { lineDisplayName } from '../utils/catalog'

const route = useRoute()
const router = useRouter()
const purchases = ref([])
const items = ref([])
// 供应商档案：付款时「用预付款支付」抵扣需要读取/扣减供应商预付款余额
const suppliers = ref([])
// 数据加载中：全量单据/商品拉取期间显示遮罩，避免白屏被误判为"点了没反应"
const loading = ref(true)
const payDialog = ref(false)
const photoDialog = ref(false)
const editDialog = ref(false)
// 保存中标记：配合弹窗按钮 loading，防止双击重复提交
const saving = ref(false)
// 单据是否真实存在：不存在时禁用编辑/删除，避免把占位空单当新增保存
const found = computed(() => purchases.value.some(p => p.id === route.params.id))
const purchase = computed(() => purchases.value.find(p => p.id === route.params.id) || { id: route.params.id, supplier: '', date: '', total: 0, items: [] })

// 当前采购单对应供应商的预付款可用余额（用于付款时「用预付款支付」抵扣）
const supplierAdvanceBalance = computed(() => {
  const s = suppliers.value.find(x => x.name === purchase.value.supplier)
  return depositSumOf(s && s.advances)
})

// 应付(合计−优惠) 与 未付(应付−累计实付)，与全站统一规则一致
const dueAmount = computed(() => grossOf(purchase.value))
const unpaid = computed(() => payableOf(purchase.value))
const paidSum = computed(() => paidSumOf(purchase.value))
const payments = computed(() => ensurePayments(purchase.value, 'paid'))

// 明细行原价合计与单项折扣合计（合计字段为折后金额）
const grossSum = computed(() => (purchase.value.items || []).reduce((s, l) => s + Number(l.qty || 0) * Number(l.price || 0), 0))
const lineDiscountSum = computed(() => (purchase.value.items || []).reduce((s, l) => s + Number(l.discount || 0), 0))

const detailItems = computed(() => {
  const nameMap = Object.fromEntries((items.value || []).map(i => [i.code, i.name || '']))
  return (purchase.value.items || []).map(line => {
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
      cost: line.price,
      price: base.price != null ? base.price : line.price,
      _qty: line.qty,
      _price: line.price,
      _discount: Number(line.discount || 0),
      _discountRate: line.discountRate,
      _total: line.total
    }
  })
})

async function onPaySaved(updated, payload) {
  const idx = purchases.value.findIndex(p => p.id === updated.id)
  if (idx >= 0) purchases.value[idx] = updated
  try {
    await api.savePurchases(purchases.value)
  } catch (e) {
    // 保存失败要回滚并明确报错：否则界面显示已付款、线上其实没变，且弹窗不关可重复提交
    const fresh = await api.getPurchases().catch(() => null)
    if (fresh) purchases.value = fresh
    ElMessage.error(`保存失败：${e.message || '网络异常'}，本地改动已回滚`)
    return
  }
  payDialog.value = false
  ElMessage.success('已保存付款流水')
  // 超付转预付款 / 用预付款抵扣：按名字定位供应商档案后写入或扣减 advances
  if (payload?.add && Number(payload.add.amount) > 0) await applySupplierAdvance(updated.supplier, payload.add, false)
  if (payload?.deduct && Number(payload.deduct.amount) > 0) await applySupplierAdvance(updated.supplier, payload.deduct, true)
}

// 供应商预付款变动：isDeduct=true 时记负值扣减余额，否则记正值存入
async function applySupplierAdvance(name, entry, isDeduct) {
  try {
    const list = await api.getSuppliers()
    const s = list.find(x => x.name === name)
    if (!s) return ElMessage.warning(`供应商「${name || '未知'}」不在名单中，预付款未${isDeduct ? '扣减' : '存入'}`)
    s.advances = [...(s.advances || []), {
      date: entry.date,
      amount: isDeduct ? -Number(entry.amount) : Number(entry.amount),
      remark: entry.remark || (isDeduct ? '抵扣货款' : '超付转预付款'),
      time: entry.time || new Date().toISOString()
    }]
    await api.saveSuppliers(list)
    suppliers.value = list
    ElMessage.success(isDeduct ? `已从供应商预付款扣减 ¥${Number(entry.amount).toFixed(2)}` : `已存入供应商预付款 ¥${Number(entry.amount).toFixed(2)}`)
  } catch (e) {
    ElMessage.error(`预付款${isDeduct ? '扣减' : '保存'}失败：${e.message || e}，请到供应商详情手动调整`)
  }
}

// 保存照片：仅合并 photos 字段，单据其他信息与付款流水不动
async function onPhotosSaved(photos) {
  const cur = purchase.value
  const idx = purchases.value.findIndex(p => p.id === cur.id)
  if (idx < 0) return
  const origin = purchases.value[idx]
  purchases.value[idx] = { ...origin, photos }
  try {
    await api.savePurchases(purchases.value)
  } catch (e) {
    purchases.value[idx] = origin
    ElMessage.error(`保存失败：${e.message || '网络异常'}，请重试`)
    return
  }
  photoDialog.value = false
  ElMessage.success('已更新单据照片')
}

// 编辑本单：弹窗组装好 entry 后在此落库，保存成功后重拉数据，页面原地刷新
async function onOrderSaved({ entry }) {
  saving.value = true
  try {
    const snapshot = [...purchases.value]
    const idx = purchases.value.findIndex(p => p.id === entry.id)
    if (idx >= 0) purchases.value[idx] = entry
    try {
      await api.savePurchases(purchases.value)
    } catch (e) {
      purchases.value = snapshot
      ElMessage.error(`保存失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
      return
    }
    // 商品建档、库存、历史价均由后端自动推导，重拉保证页面与线上一致
    const [p, it, sup] = await Promise.all([api.getPurchases(), api.getItems(), api.getSuppliers()])
    purchases.value = p
    items.value = it
    suppliers.value = sup
    editDialog.value = false
    ElMessage.success('已保存修改')
  } finally { saving.value = false }
}

// 删除本单：库存与历史价由后端自动重算；删除成功后必须跳回列表，否则路由 id 失效只剩占位空单
async function removeOrder() {
  try {
    await ElMessageBox.confirm(
      `确定删除采购单 ${purchase.value.id}?\n删除后库存与历史价会自动重算，删除后将返回采购列表。`,
      '提示', { type: 'warning' })
  } catch { return }
  saving.value = true
  try {
    const snapshot = [...purchases.value]
    purchases.value = purchases.value.filter(p => p.id !== purchase.value.id)
    try {
      await api.savePurchases(purchases.value)
    } catch (e) {
      purchases.value = snapshot
      ElMessage.error(`删除失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
      return
    }
    ElMessage.success('已删除')
    router.push('/purchases')
  } finally { saving.value = false }
}

onMounted(async () => {
  try {
    const [p, it, sup] = await Promise.all([api.getPurchases(), api.getItems(), api.getSuppliers()])
    purchases.value = p
    items.value = it
    suppliers.value = sup
  } catch (e) { purchases.value = []; items.value = [] }
  finally { loading.value = false }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.info { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px; color:var(--text-regular); font-size:var(--fs-base); align-items: center; }
.photos-block { margin-bottom: 12px; }
.photos-title { font-weight: 600; margin-bottom: 6px; color:var(--color-primary); display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.pay-card { margin-top: 12px; }
.debt { color:var(--color-danger); }
.zero { color:var(--color-success); }
.none { color:var(--text-placeholder); }
.discount { color:var(--color-success); }
</style>
