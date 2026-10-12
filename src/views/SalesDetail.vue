<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title">
            <b>销售单：{{ sale.id }}</b>
          </div>
          <el-button @click="$router.push('/sales')">返回列表</el-button>
        </div>
      </template>
      <div class="info">
        <span>客户：{{ sale.customer }}</span>
        <span>日期：{{ sale.date }}</span>
        <span>合计：¥ {{ Number(sale.total || 0).toFixed(2) }}</span>
        <span>优惠：¥ {{ Number(sale.discount || 0).toFixed(2) }}</span>
        <span>应收：¥ {{ dueAmount.toFixed(2) }}</span>
        <span>实收：¥ {{ receivedSum.toFixed(2) }}<template v-if="payments.length">（{{ payments.length }} 笔）</template></span>
        <span>
          未收：<b :class="unpaid > 0 ? 'debt' : 'zero'">¥ {{ unpaid.toFixed(2) }}</b>
        </span>
        <span>
          结算：
          <el-tag :type="sale.settle === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
            {{ sale.settle || '挂账' }}
          </el-tag>
        </span>
        <span v-if="sale.remark">备注：{{ sale.remark }}</span>
      </div>
      <div v-if="(sale.photos || []).length" class="photos-block">
        <div class="photos-title">原始单据照片</div>
        <PhotoThumbs :value="sale.photos" />
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
          <b>收款记录（{{ payments.length }} 笔 · 累计 ¥ {{ receivedSum.toFixed(2) }} / 应收 ¥ {{ dueAmount.toFixed(2) }}）</b>
          <el-button type="primary" size="small" @click="payDialog = true">记录收款</el-button>
        </div>
      </template>
      <el-table :data="payments" stripe size="small" empty-text="暂无收款记录，可点右上角「记录收款」分多笔登记">
        <el-table-column type="index" label="#" width="46" />
        <el-table-column prop="date" label="日期" width="140" />
        <el-table-column label="金额" width="130">
          <template #default="{ row }">{{ Number(row.amount || 0).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
      </el-table>
    </el-card>

    <PaymentDialog v-model="payDialog" :order="sale" kind="receivable" @saved="onPaySaved" />
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
import { receivableOf, grossOf, receivedSumOf, ensurePayments } from '../utils/account'

const route = useRoute()
const sales = ref([])
const items = ref([])
const payDialog = ref(false)
const sale = computed(() => sales.value.find(s => s.id === route.params.id) || { id: route.params.id, customer: '', date: '', total: 0, items: [] })

// 应收(合计−优惠) 与 未收(应收−累计实收)，与全站统一规则一致
const dueAmount = computed(() => grossOf(sale.value))
const unpaid = computed(() => receivableOf(sale.value))
const receivedSum = computed(() => receivedSumOf(sale.value))
const payments = computed(() => ensurePayments(sale.value, 'received'))

const detailItems = computed(() => {
  const map = Object.fromEntries((items.value || []).map(i => [i.code, i]))
  return (sale.value.items || []).map(line => {
    const base = map[line.code] || {}
    return {
      ...base,
      code: line.code,
      name: line.name || base.name || line.code,
      suppliers: base.suppliers || [],
      purchaseHistory: base.purchaseHistory || [],
      saleHistory: base.saleHistory || [],
      package: base.package,
      unit: base.unit || '',
      price: line.price,
      _qty: line.qty,
      _price: line.price,
      _total: line.total
    }
  })
})

async function onPaySaved(updated) {
  const idx = sales.value.findIndex(s => s.id === updated.id)
  if (idx >= 0) sales.value[idx] = updated
  await api.saveSales(sales.value)
  ElMessage.success('已保存收款流水')
}

onMounted(async () => {
  try {
    const [s, it] = await Promise.all([api.getSales(), api.getItems()])
    sales.value = s
    items.value = it
  } catch (e) { sales.value = []; items.value = [] }
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
