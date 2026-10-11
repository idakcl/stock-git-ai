<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header"><b>商品管理</b><el-button type="primary" @click="openDialog()">新增商品</el-button></div>
      </template>
      <el-input v-model="keyword" clearable placeholder="搜索编码 / 名称" class="search-input" />
      <div class="table-wrap">
      <el-table :data="filtered" stripe>
        <el-table-column prop="code" label="编码" width="120" />
        <el-table-column prop="name" label="名称" />
        <el-table-column prop="unit" label="单位" width="80" />
        <el-table-column prop="cost" label="进价" width="100" />
        <el-table-column prop="price" label="售价" width="100" />
        <el-table-column prop="warning" label="预警值" width="100" />
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-button size="small" @click="openDialog(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
    </el-card>

    <el-dialog v-model="dialog" title="商品" width="420">
      <el-form :model="form" label-width="80px">
        <el-form-item label="编码"><el-input v-model="form.code" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="单位"><el-input v-model="form.unit" /></el-form-item>
        <el-form-item label="进价"><el-input-number v-model="form.cost" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="售价"><el-input-number v-model="form.price" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="预警值"><el-input-number v-model="form.warning" :min="0" /></el-form-item>
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
import { matchText } from '../utils/search'

const items = ref([])
const keyword = ref('')
const dialog = ref(false)
const form = reactive({ code:'', name:'', unit:'', cost:0, price:0, warning:0 })
const filtered = computed(() => items.value.filter(i => matchText(keyword.value, i.code, i.name, i.unit)))

onMounted(load)
async function load() {
  try { items.value = await api.getItems() } catch (e) { items.value = [] }
}

function openDialog(row) {
  if (row) Object.assign(form, row)
  else Object.assign(form, { code:'', name:'', unit:'', cost:0, price:0, warning:0 })
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
.search-input { margin-bottom: 12px; max-width: 360px; }
</style>
