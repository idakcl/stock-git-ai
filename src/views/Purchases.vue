<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header"><b>采购入库</b><el-button type="primary" @click="openDialog()">新增采购</el-button></div>
      </template>
      <el-input v-model="keyword" clearable placeholder="搜索单号 / 供应商 / 商品" class="search-input" />
      <div class="table-wrap">
      <el-table :data="filtered" stripe>
        <el-table-column prop="id" label="单号" width="120" />
        <el-table-column prop="supplier" label="供应商" width="140" />
        <el-table-column prop="date" label="日期" width="120" />
        <el-table-column prop="items" label="商品" min-width="200">
          <template #default="{ row }">{{ row.items.map(i => `${i.name}×${i.qty}`).join('、') }}</template>
        </el-table-column>
        <el-table-column prop="total" label="金额" width="100" />
      </el-table>
      </div>
    </el-card>

    <el-dialog v-model="dialog" title="采购入库" width="560">
      <el-form :model="form" label-width="80px">
        <el-form-item label="供应商"><el-input v-model="form.supplier" /></el-form-item>
        <el-form-item label="日期"><el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      </el-form>
      <el-table :data="form.lines" stripe>
        <el-table-column label="商品" min-width="180">
          <template #default="{ row }">
            <el-select
              v-model="row.code"
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入商品"
              style="width:100%"
              @change="onItemChange(row)"
            >
              <el-option v-for="i in itemOptions" :key="i.code" :label="`${i.name} (${i.code})`" :value="i.code" />
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
      <div style="margin-top:8px"><el-button size="small" @click="form.lines.push({code:'',name:'',qty:1,price:0})">添加行</el-button></div>
      <div style="margin-top:12px;text-align:right"><b>合计：¥ {{ totalAmount }}</b></div>
      <template #footer><el-button @click="dialog=false">取消</el-button><el-button type="primary" @click="save">保存入库</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'
import { resolveLine } from '../utils/catalog'

const list = ref([])
const keyword = ref('')
const itemOptions = ref([])
const dialog = ref(false)
const form = reactive({ supplier:'', date:'', lines:[] })

const totalAmount = computed(() => form.lines.reduce((s, l) => s + (l.qty||0) * (l.price||0), 0))
const filtered = computed(() => list.value.filter(row => matchText(
  keyword.value,
  row.id,
  row.supplier,
  row.date,
  ...(row.items || []).map(i => i.name)
)))

onMounted(async () => {
  try {
    list.value = await api.getPurchases()
    itemOptions.value = await api.getItems()
  } catch (e) {
    list.value = []
    itemOptions.value = []
  }
})

function openDialog() {
  Object.assign(form, { supplier:'', date: new Date().toISOString().slice(0,10), lines: [{code:'', name:'', qty:1, price:0}] })
  dialog.value = true
}

function onItemChange(row) {
  const found = itemOptions.value.find(i => i.code === row.code || i.name === row.code)
  if (found) {
    row.code = found.code
    row.name = found.name
    if (!row.price) row.price = found.cost || found.price || 0
  } else {
    row.name = row.code
  }
}

async function save() {
  if (!form.supplier) return ElMessage.warning('请填写供应商')
  if (!form.lines.length || form.lines.some(l => !l.code && !l.name)) return ElMessage.warning('请完整填写采购明细')
  let catalog = [...itemOptions.value]
  const resolved = []
  form.lines.forEach((l, idx) => {
    const result = resolveLine(catalog, { ...l, cost: l.price }, idx)
    if (result.line) {
      catalog = result.items
      resolved.push(result.line)
    }
  })
  if (!resolved.length) return ElMessage.warning('请完整填写采购明细')
  const entry = {
    id: 'P' + Date.now(),
    supplier: form.supplier,
    date: form.date,
    items: resolved,
    total: resolved.reduce((s, l) => s + l.total, 0)
  }
  const currentStock = await api.getStock()
  const newStock = { ...currentStock }
  for (const l of resolved) {
    if (!newStock[l.code]) newStock[l.code] = { qty: 0, cost: 0 }
    newStock[l.code].qty += l.qty
    newStock[l.code].cost = l.price
  }
  list.value.push(entry)
  await api.savePurchases(list.value)
  if (catalog.length !== itemOptions.value.length) {
    await api.saveItems(catalog)
    itemOptions.value = catalog
  }
  await api.saveStock(newStock)
  dialog.value = false
  ElMessage.success('采购入库成功')
}
</script>
<style scoped>
.card-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}
.search-input{margin-bottom:12px;max-width:360px;}
</style>
