<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title">
            <b>采购单：{{ purchase.id }}</b>
          </div>
          <el-button @click="$router.push('/purchases')">返回列表</el-button>
        </div>
      </template>
      <div class="info">
        <span>供应商：{{ purchase.supplier }}</span>
        <span>日期：{{ purchase.date }}</span>
        <span>合计：¥ {{ Number(purchase.total || 0).toFixed(2) }}</span>
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
      <div v-if="(purchase.photos || []).length" class="photos-block">
        <div class="photos-title">原始单据照片（{{ (purchase.photos || []).length }} 张）</div>
        <PhotoThumbs :value="purchase.photos" />
      </div>
      <ProductTable :items="detailItems" search-placeholder="搜索本单商品">
        <template #extra>
          <el-table-column prop="_qty" label="本次数量" width="100" />
          <el-table-column prop="_price" label="本次单价" width="100" />
          <el-table-column prop="_total" label="本次金额" width="100" />
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
      <el-table :data="payments" stripe size="small" empty-text="暂无付款记录，可点右上角「记录付款」分多笔登记">
        <el-table-column type="index" label="#" width="46" />
        <el-table-column prop="date" label="日期" width="140" />
        <el-table-column label="金额" width="130">
          <template #default="{ row }">{{ Number(row.amount || 0).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
      </el-table>
    </el-card>

    <PaymentDialog v-model="payDialog" :order="purchase" kind="payable" @saved="onPaySaved" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import ProductTable from '../components/ProductTable.vue'
import PhotoThumbs from '../components/PhotoThumbs.vue'
import PaymentDialog from '../components/PaymentDialog.vue'
import { payableOf, grossOf, paidSumOf, ensurePayments } from '../utils/account'
import { lineDisplayName } from '../utils/catalog'

const route = useRoute()
const purchases = ref([])
const items = ref([])
const payDialog = ref(false)
const purchase = computed(() => purchases.value.find(p => p.id === route.params.id) || { id: route.params.id, supplier: '', date: '', total: 0, items: [] })

// 应付(合计−优惠) 与 未付(应付−累计实付)，与全站统一规则一致
const dueAmount = computed(() => grossOf(purchase.value))
const unpaid = computed(() => payableOf(purchase.value))
const paidSum = computed(() => paidSumOf(purchase.value))
const payments = computed(() => ensurePayments(purchase.value, 'paid'))

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
      _total: line.total
    }
  })
})

async function onPaySaved(updated) {
  const idx = purchases.value.findIndex(p => p.id === updated.id)
  if (idx >= 0) purchases.value[idx] = updated
  await api.savePurchases(purchases.value)
  ElMessage.success('已保存付款流水')
}

onMounted(async () => {
  try {
    const [p, it] = await Promise.all([api.getPurchases(), api.getItems()])
    purchases.value = p
    items.value = it
  } catch (e) { purchases.value = []; items.value = [] }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.info { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px; color: #606266; font-size: 14px; align-items: center; }
.photos-block { margin-bottom: 12px; }
.photos-title { font-weight: 600; margin-bottom: 6px; color: #409eff; }
.pay-card { margin-top: 12px; }
.debt { color: #f56c6c; }
.zero { color: #67c23a; }
</style>
