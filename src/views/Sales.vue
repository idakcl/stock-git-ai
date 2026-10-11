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
      </div>
      <div class="table-wrap">
      <el-table :data="filtered" stripe show-summary :summary-method="summaryAmount">
        <el-table-column label="单号" width="160">
          <template #default="{ row }"><router-link :to="`/sale/${row.id}`" class="link">{{ row.id }}</router-link></template>
        </el-table-column>
        <el-table-column prop="customer" label="客户" width="140" />
        <el-table-column prop="date" label="日期" width="120" />
        <el-table-column label="商品" min-width="200">
          <template #default="{ row }">{{ row.items.map(i => `${i.name}×${i.qty}`).join('、') }}</template>
        </el-table-column>
        <el-table-column prop="total" label="金额" width="100" />
        <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
        <el-table-column label="" width="80">
          <template #default="{ row }"><el-button size="small" @click="$router.push(`/sale/${row.id}`)">查看</el-button></template>
        </el-table-column>
      </el-table>
      </div>
    </el-card>

    <el-dialog v-model="dialog" title="销售出库" width="560">
      <el-form :model="form" label-width="80px">
        <el-form-item label="客户">
          <el-select
            v-model="form.customer"
            filterable
            allow-create
            default-first-option
            placeholder="选择或输入客户"
            style="width:100%"
            @change="onCustomerChange"
          >
            <el-option v-for="c in customerOptions" :key="c.code" :label="`${c.name} (${c.code})`" :value="c.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="日期"><el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
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
      <template #footer><el-button @click="dialog=false">取消</el-button><el-button type="primary" @click="save">保存出库</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'
import { resolveLine } from '../utils/catalog'
import { genOrderId } from '../utils/code'

const list = ref([])
const keyword = ref('')
const dateStart = ref('')
const dateEnd = ref('')
const itemOptions = ref([])
const customerOptions = ref([])
const dialog = ref(false)
const form = reactive({ customer:'', date:'', remark:'', lines:[] })

const totalAmount = computed(() => form.lines.reduce((s, l) => s + (l.qty||0) * (l.price||0), 0))
const filtered = computed(() => list.value.filter(row => {
  if (!matchText(keyword.value, row.id, row.customer, row.date, row.remark, ...(row.items || []).map(i => i.name))) return false
  if (dateStart.value && (row.date || '') < dateStart.value) return false
  if (dateEnd.value && (row.date || '') > dateEnd.value) return false
  return true
}))

// 表格底部汇总：合计金额
const summaryAmount = ({ columns, data }) => {
  const total = (data || []).reduce((sum, r) => sum + Number(r.total || 0), 0)
  return columns.map((c, idx) => {
    if (idx === 0) return '合计'
    if (c.property === 'total') return total.toFixed(2)
    return ''
  })
}

// 按「某客户最近一次销售价」带出单价；没历史则用商品当前售价
function customerPriceFor(code) {
  if (!form.customer || !code) return null
  const item = itemOptions.value.find(i => i.code === code)
  if (!item) return null
  const hist = (item.saleHistory || []).filter(h => h.customer === form.customer)
  if (!hist.length) return null
  const latest = hist.reduce((a, b) => ((a.date || '') > (b.date || '') ? a : b))
  return latest.price
}

onMounted(async () => {
  try {
    list.value = await api.getSales()
    itemOptions.value = await api.getItems()
    customerOptions.value = await api.getCustomers()
  } catch (e) {
    list.value = []
    itemOptions.value = []
    customerOptions.value = []
  }
})

function openDialog() {
  Object.assign(form, { customer:'', date: new Date().toISOString().slice(0,10), remark:'', lines: [{code:'', name:'', qty:1, price:0}] })
  dialog.value = true
}

function onItemChange(row) {
  const found = itemOptions.value.find(i => i.code === row.code || i.name === row.code)
  if (found) {
    row.code = found.code
    row.name = found.name
    // 优先带出该客户最近一次成交价，其次商品当前售价
    const recent = customerPriceFor(found.code)
    row.price = recent != null ? recent : (found.price || 0)
  } else {
    row.name = row.code
  }
}

// 更换客户后，按新客户的最近售价刷新已填行的单价（仍可手动改）
function onCustomerChange() {
  form.lines.forEach(l => {
    if (!l.code) return
    const recent = customerPriceFor(l.code)
    if (recent != null) l.price = recent
  })
}

async function save() {
  if (!form.customer) return ElMessage.warning('请填写客户')
  if (!form.lines.length || form.lines.some(l => !l.code && !l.name)) return ElMessage.warning('请完整填写销售明细')
  let catalog = [...itemOptions.value]
  const resolved = []
  form.lines.forEach((l, idx) => {
    const result = resolveLine(catalog, l, idx)
    if (result.line) {
      catalog = result.items
      resolved.push(result.line)
    }
  })
  if (!resolved.length) return ElMessage.warning('请完整填写销售明细')
  const entry = {
    id: genOrderId('X', list.value, form.date),
    customer: form.customer,
    date: form.date,
    remark: form.remark || '',
    items: resolved,
    total: resolved.reduce((s, l) => s + l.total, 0)
  }
  list.value.push(entry)
  await api.saveSales(list.value)
  // 商品销售价历史、库存均由后端自动推导
  itemOptions.value = await api.getItems().catch(() => itemOptions.value)
  dialog.value = false
  ElMessage.success('销售出库成功')
}
</script>
<style scoped>
.card-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}
.search-input{margin-bottom:12px;max-width:360px;}
.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.filter-label{color:#606266;font-size:14px;}
.filter-sep{color:#909399;}
</style>
