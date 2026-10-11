<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header"><b>商品管理</b><el-button type="primary" @click="openDialog()">新增商品</el-button></div>
      </template>
      <ProductTable :items="items" search-placeholder="搜索编码 / 名称">
        <template #actions="{ row }">
          <el-button size="small" @click="openDialog(row)">编辑</el-button>
          <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
        </template>
      </ProductTable>
    </el-card>

    <el-dialog v-model="dialog" title="商品" width="420">
      <el-form :model="form" label-width="80px">
        <el-form-item label="编码"><el-input v-model="form.code" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="单位"><el-input v-model="form.unit" /></el-form-item>
        <el-form-item label="品牌"><el-input v-model="form.brand" /></el-form-item>
        <el-form-item label="进价"><el-input-number v-model="form.cost" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="售价"><el-input-number v-model="form.price" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="预警值"><el-input-number v-model="form.warning" :min="0" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog=false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import ProductTable from '../components/ProductTable.vue'
import { nextEntityCode } from '../utils/code'

const items = ref([])
const dialog = ref(false)
const form = reactive({ code:'', name:'', unit:'', brand:'', cost:0, price:0, warning:0, remark:'' })

onMounted(load)
async function load() {
  try { items.value = await api.getItems() } catch (e) { items.value = [] }
}

function openDialog(row) {
  if (row) Object.assign(form, row)
  else Object.assign(form, { code: nextEntityCode(items.value, 'P'), name:'', unit:'', brand:'', cost:0, price:0, warning:0, remark:'' })
  dialog.value = true
}

async function save() {
  const idx = items.value.findIndex(i => i.code === form.code)
  if (idx >= 0) items.value[idx] = { ...items.value[idx], ...form }
  else items.value.push({ ...form })
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
