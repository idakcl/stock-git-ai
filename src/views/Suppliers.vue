<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header"><b>供应商</b><el-button type="primary" @click="openDialog()">新增</el-button></div>
      </template>
      <div class="table-wrap">
      <el-table :data="list" stripe>
        <el-table-column prop="code" label="编码" width="120" />
        <el-table-column prop="name" label="名称" />
        <el-table-column prop="contact" label="联系人" width="140" />
        <el-table-column prop="phone" label="电话" width="140" />
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-button size="small" @click="openDialog(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
    </el-card>
    <el-dialog v-model="dialog" title="供应商" width="420">
      <el-form :model="form" label-width="80px">
        <el-form-item label="编码"><el-input v-model="form.code" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="联系人"><el-input v-model="form.contact" /></el-form-item>
        <el-form-item label="电话"><el-input v-model="form.phone" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialog=false">取消</el-button><el-button type="primary" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'

const list = ref([])
const dialog = ref(false)
const form = reactive({ code:'', name:'', contact:'', phone:'' })

onMounted(load)
async function load() {
  try { list.value = await api.getSuppliers() } catch (e) { list.value = [] }
}
function openDialog(row) { if (row) Object.assign(form, row); else Object.assign(form, { code:'', name:'', contact:'', phone:'' }); dialog.value = true }
async function save() {
  const idx = list.value.findIndex(i => i.code === form.code)
  if (idx >= 0) list.value[idx] = { ...list.value[idx], ...form }
  else list.value.push({ ...form })
  await api.saveSuppliers(list.value)
  dialog.value = false; ElMessage.success('已保存'); load()
}
async function remove(row) {
  await ElMessageBox.confirm(`确定删除 ${row.name}?`, '提示', { type: 'warning' })
  list.value = list.value.filter(i => i.code !== row.code)
  await api.saveSuppliers(list.value); ElMessage.success('已删除'); load()
}
</script>
<style scoped>.card-header{display:flex;justify-content:space-between;align-items:center;}</style>
