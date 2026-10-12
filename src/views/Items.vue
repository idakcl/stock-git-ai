<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <b>商品管理</b>
          <el-button type="primary" @click="openDialog()">新增商品</el-button>
        </div>
      </template>
      <TableToolbar
        filename="商品库"
        title="商品库"
        :subtitle="exportSubtitle"
        :columns="exportColumns"
        :rows="exportRows"
      />
      <ProductTable ref="tableRef" :items="items" search-placeholder="搜索编码 / 名称" show-price-tiers :page-size="60">
        <template #actions="{ row }">
          <el-button size="small" @click="openDialog(row)">编辑</el-button>
          <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
        </template>
      </ProductTable>
    </el-card>

    <el-dialog v-model="dialog" title="商品" width="520">
      <el-form :model="form" label-width="80px">
        <el-form-item label="编码"><el-input v-model="form.code" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="单位"><el-input v-model="form.unit" /></el-form-item>
        <el-form-item label="进价"><el-input-number v-model="form.cost" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="售价"><el-input-number v-model="form.price" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="批发价"><el-input-number v-model="form.priceWholesale" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="零售价"><el-input-number v-model="form.priceRetail" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="安装师傅价"><el-input-number v-model="form.priceInstaller" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="预警值"><el-input-number v-model="form.warning" :min="0" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="商品照片"><PhotoUpload v-model="form.photos" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog=false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import ProductTable from '../components/ProductTable.vue'
import PhotoUpload from '../components/PhotoUpload.vue'
import TableToolbar from '../components/TableToolbar.vue'
import { nextEntityCode } from '../utils/code'

const items = ref([])
const dialog = ref(false)
const tableRef = ref(null)
const form = reactive({
  code:'', name:'', unit:'', photos:[],
  cost:0, price:0, priceWholesale:0, priceRetail:0, priceInstaller:0,
  warning:0, remark:''
})

// 导出/打印与列表当前页同步：取当前页数据，副标题标注输出范围（第 X/Y 页）
const exportRows = computed(() => (tableRef.value && tableRef.value.pagedRows) || items.value)
const exportSubtitle = computed(() => {
  const total = (tableRef.value && tableRef.value.filtered ? tableRef.value.filtered.length : items.value.length) || 0
  const p = (tableRef.value && tableRef.value.page) || 1
  const pc = (tableRef.value && tableRef.value.pageCount) || 1
  return `共 ${total} 条 · 导出当前第 ${p}/${pc} 页`
})
const exportColumns = [
  { label: '编码', prop: 'code' },
  { label: '名称', prop: 'name' },
  { label: '单位', prop: 'unit' },
  { label: '进价', prop: 'cost' },
  { label: '售价', prop: 'price' },
  { label: '批发价', prop: 'priceWholesale' },
  { label: '零售价', prop: 'priceRetail' },
  { label: '安装师傅价', prop: 'priceInstaller' },
  { label: '预警值', prop: 'warning' },
  { label: '备注', prop: 'remark' }
]

onMounted(load)
async function load() {
  try { items.value = await api.getItems() } catch (e) { items.value = [] }
}

function openDialog(row) {
  // 先重置为默认值再覆盖，避免上次编辑残留；品牌字段已废弃，读入时剥离
  const { brand, ...rest } = row || {}
  Object.assign(form, {
    code: nextEntityCode(items.value, 'P'), name:'', unit:'', photos:[],
    cost:0, price:0, priceWholesale:0, priceRetail:0, priceInstaller:0, warning:0, remark:'',
    ...rest
  })
  dialog.value = true
}

async function save() {
  const idx = items.value.findIndex(i => i.code === form.code)
  // 品牌字段已废弃：保存时剥离，数据中不再写入
  const { brand, ...rest } = form
  if (idx >= 0) items.value[idx] = { ...items.value[idx], ...rest, brand: undefined }
  else items.value.push({ ...rest, brand: undefined })
  await api.saveItems(items.value)
  dialog.value = false
  ElMessage.success('已保存')
  load()
}

async function remove(row) {
  await ElMessageBox.confirm(`确定删除 ${row.name}?`, '提示', { type: 'warning' })
  items.value = items.value.filter(i => i.code !== row.code)
  await api.saveItems(items.value)
  ElMessage.success('已删除')
  load()
}
</script>

<style scoped>
.card-header { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
</style>
