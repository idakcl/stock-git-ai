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
      <div class="table-wrap">
      <el-table :data="filtered" stripe show-summary :summary-method="summaryAmount">
        <el-table-column label="单号" width="170">
          <template #default="{ row }">
            <router-link :to="`/purchase/${row.id}`" class="link">{{ row.id }}</router-link>
          </template>
        </el-table-column>
        <el-table-column prop="supplier" label="供应商" width="170" />
        <el-table-column prop="date" label="日期" width="120" />
        <el-table-column prop="total" label="金额" width="110">
          <template #default="{ row }">{{ Number(row.total || 0).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="结算" width="130">
          <template #default="{ row }">
            <el-tag :type="row.settle === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
              {{ row.settle || '挂账' }}
            </el-tag>
            <el-button link size="small" type="primary" style="margin-left:4px" @click="toggleSettle(row)">
              {{ row.settle === '结清' ? '改挂账' : '结清' }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
        <el-table-column label="操作" width="190">
          <template #default="{ row }">
            <el-button size="small" @click="$router.push(`/purchase/${row.id}`)">查看</el-button>
            <el-button size="small" type="primary" @click="openDialog(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
    </el-card>

    <el-dialog v-model="dialog" :title="editingId ? '编辑采购单' : '采购入库'" width="620">
      <el-form :model="form" label-width="80px">
        <el-form-item label="供应商"><el-input v-model="form.supplier" /></el-form-item>
        <el-form-item label="日期"><el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="结算">
          <el-radio-group v-model="form.settle">
            <el-radio-button label="挂账" />
            <el-radio-button label="结清" />
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="单据照片"><PhotoUpload v-model="form.photos" /></el-form-item>
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
      <div style="margin-top:12px;text-align:right"><b>合计：¥ {{ totalAmount.toFixed(2) }}</b></div>
      <template #footer><el-button @click="dialog=false">取消</el-button><el-button type="primary" @click="save">保存入库</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'
import { resolveLine } from '../utils/catalog'
import { genOrderId } from '../utils/code'
import PhotoUpload from '../components/PhotoUpload.vue'

const list = ref([])
const keyword = ref('')
const dateStart = ref('')
const dateEnd = ref('')
const itemOptions = ref([])
const dialog = ref(false)
const editingId = ref('')
const form = reactive({ supplier:'', date:'', remark:'', settle:'挂账', photos:[], lines:[] })

const totalAmount = computed(() => form.lines.reduce((s, l) => s + (l.qty||0) * (l.price||0), 0))
const filtered = computed(() => list.value.filter(row => {
  if (!matchText(keyword.value, row.id, row.supplier, row.date, row.remark, ...(row.items || []).map(i => i.name))) return false
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

function loadAll() {
  return Promise.all([api.getPurchases(), api.getItems()])
}

onMounted(async () => {
  try {
    const [p, it] = await loadAll()
    list.value = p
    itemOptions.value = it
  } catch (e) {
    list.value = []
    itemOptions.value = []
  }
})

function openDialog(row) {
  if (row) {
    editingId.value = row.id
    Object.assign(form, {
      supplier: row.supplier || '',
      date: row.date || '',
      remark: row.remark || '',
      settle: row.settle || '挂账',
      photos: [...(row.photos || [])],
      lines: (row.items || []).map(i => ({ code: i.code, name: i.name, qty: i.qty, price: i.price }))
    })
  } else {
    editingId.value = ''
    Object.assign(form, { supplier:'', date: new Date().toISOString().slice(0,10), remark:'', settle:'挂账', photos:[], lines: [{code:'', name:'', qty:1, price:0}] })
  }
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
  const amount = resolved.reduce((s, l) => s + l.total, 0)
  const isEdit = !!editingId.value
  // 编辑时沿用原单号，新增才生成新单号
  if (editingId.value) {
    const idx = list.value.findIndex(p => p.id === editingId.value)
    if (idx >= 0) {
      list.value[idx] = {
        ...list.value[idx],
        supplier: form.supplier,
        date: form.date,
        remark: form.remark || '',
        settle: form.settle || '挂账',
        photos: [...(form.photos || [])],
        items: resolved,
        total: amount
      }
    }
  } else {
    const entry = {
      id: genOrderId('B', list.value, form.date),
      supplier: form.supplier,
      date: form.date,
      remark: form.remark || '',
      settle: form.settle || '挂账',
      photos: [...(form.photos || [])],
      items: resolved,
      total: amount
    }
    list.value.push(entry)
  }
  await api.savePurchases(list.value)
  // 商品建档、库存、供应商关系均由后端自动推导
  itemOptions.value = await api.getItems().catch(() => itemOptions.value)
  dialog.value = false
  editingId.value = ''
  ElMessage.success(isEdit ? '已保存修改' : '采购入库成功')
}

async function toggleSettle(row) {
  row.settle = row.settle === '结清' ? '挂账' : '结清'
  await api.savePurchases(list.value)
  ElMessage.success(row.settle === '结清' ? '已标记为结清' : '已改回挂账')
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除采购单 ${row.id}?\n删除后库存与历史价会自动重算。`, '提示', { type: 'warning' })
  } catch { return }
  list.value = list.value.filter(p => p.id !== row.id)
  await api.savePurchases(list.value)
  const [p, it] = await loadAll()
  list.value = p
  itemOptions.value = it
  ElMessage.success('已删除')
}
</script>
<style scoped>
.card-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}
.search-input{margin-bottom:12px;max-width:360px;}
.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.filter-label{color:#606266;font-size:14px;}
.filter-sep{color:#909399;}
</style>
