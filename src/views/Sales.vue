<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header"><b>销售出库</b><el-button type="primary" @click="openDialog()">新增销售</el-button></div>
      </template>
      <div class="table-wrap">
      <el-table :data="list" stripe>
        <el-table-column prop="id" label="单号" width="120" />
        <el-table-column prop="customer" label="客户" width="140" />
        <el-table-column prop="date" label="日期" width="120" />
        <el-table-column label="商品" min-width="200">
          <template #default="{ row }">{{ row.items.map(i => `${i.name}×${i.qty}`).join('、') }}</template>
        </el-table-column>
        <el-table-column prop="total" label="金额" width="100" />
      </el-table>
      </div>
    </el-card>

    <el-dialog v-model="dialog" title="销售出库" width="560">
      <el-form :model="form" label-width="80px">
        <el-form-item label="客户"><el-input v-model="form.customer" /></el-form-item>
        <el-form-item label="日期"><el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      </el-form>
      <el-table :data="form.lines" stripe>
        <el-table-column label="商品" min-width="160">
          <template #default="{ row }">
            <el-select v-model="row.code" placeholder="选择商品" style="width:100%">
              <el-option v-for="i in itemOptions" :key="i.code" :label="i.name" :value="i.code" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="数量" width="100">
          <template #default="{ row }"><el-input-number v-model="row.qty" :min="1" size="small" /></template>
        </el-table-column>
        <el-table-column label="单价" width="100">
          <template #default="{ row }"><el-input-number v-model="row.price" :min="0" :precision="2" size="small" /></template>
        </el-table-column>
        <el-table-column label="" width="60">
          <template #default="{ $index }"><el-button size="small" type="danger" @click="form.lines.splice($index,1)">×</el-button></template>
        </el-table-column>
      </el-table>
      <div style="margin-top:8px"><el-button size="small" @click="form.lines.push({code:'',qty:1,price:0})">添加行</el-button></div>
      <div style="margin-top:12px;text-align:right"><b>合计：¥ {{ totalAmount }}</b></div>
      <template #footer><el-button @click="dialog=false">取消</el-button><el-button type="primary" @click="save">保存出库</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'

const list = ref([])
const itemOptions = ref([])
const dialog = ref(false)
const form = reactive({ customer:'', date:'', lines:[] })

const totalAmount = computed(() => form.lines.reduce((s, l) => s + (l.qty||0) * (l.price||0), 0))

onMounted(async () => {
  try {
    list.value = await api.getSales()
    itemOptions.value = await api.getItems()
  } catch (e) {
    list.value = []
    itemOptions.value = []
  }
})

function openDialog() {
  Object.assign(form, { customer:'', date: new Date().toISOString().slice(0,10), lines: [{code:'', qty:1, price:0}] })
  dialog.value = true
}

async function save() {
  if (!form.customer) return ElMessage.warning('请填写客户')
  if (!form.lines.length || form.lines.some(l => !l.code)) return ElMessage.warning('请完整填写销售明细')
  const currentStock = await api.getStock()
  for (const l of form.lines) {
    const s = currentStock[l.code]
    if (!s || s.qty < l.qty) return ElMessage.warning(`库存不足：${l.code}`)
  }
  const entry = {
    id: 'S' + Date.now(),
    customer: form.customer,
    date: form.date,
    items: form.lines.map(l => {
      const item = itemOptions.value.find(i => i.code === l.code)
      return { code: l.code, name: item?.name || l.code, qty: l.qty, price: l.price, total: l.qty * l.price }
    }),
    total: totalAmount.value
  }
  list.value.push(entry)
  await api.saveSales(list.value)
  const newStock = { ...currentStock }
  for (const l of form.lines) {
    newStock[l.code].qty -= l.qty
    if (newStock[l.code].qty < 0) newStock[l.code].qty = 0
  }
  await api.saveStock(newStock)
  dialog.value = false
  ElMessage.success('销售出库成功')
}
</script>
<style scoped>.card-header{display:flex;justify-content:space-between;align-items:center;}</style>
