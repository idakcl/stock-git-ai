<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header"><b>供应商</b><el-button type="primary" @click="openDialog()">新增</el-button></div>
      </template>
      <el-input v-model="keyword" clearable placeholder="搜索编码 / 名称 / 联系人 / 电话" class="search-input" />
      <TableToolbar
        filename="供应商"
        title="供应商"
        :subtitle="subtitle"
        :columns="exportColumns"
        :rows="paged"
      />
      <div class="table-wrap">
      <el-table :data="paged" stripe>
        <el-table-column prop="code" label="编码" width="120" />
        <el-table-column label="名称" min-width="200">
          <template #default="{ row }">
            <router-link :to="`/supplier/${row.code}`" class="link">{{ row.name }}</router-link>
          </template>
        </el-table-column>
        <el-table-column prop="contact" label="联系人" width="130" />
        <el-table-column prop="phone" label="电话" width="130" />
        <el-table-column label="应付款" width="130">
          <template #default="{ row }">
            <span :class="payableMap[row.name] ? 'amount-debt' : 'amount-zero'">
              ¥ {{ Number(payableMap[row.name] || 0).toFixed(2) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-button size="small" @click="openDialog(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
      <el-pagination
        v-model:current-page="page"
        :page-size="PAGE_SIZE"
        :total="filtered.length"
        layout="total, prev, pager, next"
        background
        class="pager"
      />
    </el-card>
    <el-dialog v-model="dialog" title="供应商" width="420">
      <el-form :model="form" label-width="80px">
        <el-form-item label="编码"><el-input v-model="form.code" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="联系人"><el-input v-model="form.contact" /></el-form-item>
        <el-form-item label="电话"><el-input v-model="form.phone" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialog=false">取消</el-button><el-button type="primary" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'
import { nextEntityCode } from '../utils/code'
import { payableOf } from '../utils/account'
import TableToolbar from '../components/TableToolbar.vue'

const PAGE_SIZE = 60

const list = ref([])
const purchases = ref([])
const keyword = ref('')
const page = ref(1)
const dialog = ref(false)
const form = reactive({ code:'', name:'', contact:'', phone:'', remark:'' })
const filtered = computed(() => list.value.filter(i => matchText(keyword.value, i.code, i.name, i.contact, i.phone, i.remark)))
const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
watch(keyword, () => { page.value = 1 })

// 导出/打印与列表当前页同步：副标题标注输出范围（第 X/Y 页）
const subtitle = computed(() => `共 ${filtered.value.length} 条 · 导出当前第 ${page.value}/${pageCount.value} 页`)

const exportColumns = [
  { label: '编码', prop: 'code' },
  { label: '名称', prop: 'name' },
  { label: '联系人', prop: 'contact' },
  { label: '电话', prop: 'phone' },
  { label: '应付款', value: r => Number(payableMap.value[r.name] || 0).toFixed(2) },
  { label: '备注', prop: 'remark' }
]

// 应付款：该供应商全部采购单的未结金额合计（欠款按金额计算，与结算状态无关）
const payableMap = computed(() => {
  const map = {}
  for (const p of purchases.value || []) {
    const name = p.supplier || ''
    map[name] = (map[name] || 0) + payableOf(p)
  }
  return map
})

onMounted(load)
async function load() {
  try {
    const [sp, pu] = await Promise.all([api.getSuppliers(), api.getPurchases()])
    list.value = sp
    purchases.value = pu
  } catch (e) { list.value = []; purchases.value = [] }
}
function openDialog(row) { if (row) Object.assign(form, row); else Object.assign(form, { code: nextEntityCode(list.value, 'S'), name:'', contact:'', phone:'', remark:'' }); dialog.value = true }
async function save() {
  // 供应商不允许同名：采购单是按「名称」匹配供应商档案的，
  // 重名会让单据挂到错误的档案上（历史上出现过 S00001/S00039 重复建档，商品被拆到两个码下）
  const name = (form.name || '').trim()
  if (!name) return ElMessage.warning('请填写供应商名称')
  const dup = list.value.find(i => i.code !== form.code && (i.name || '').trim() === name)
  if (dup) return ElMessage.error(`已存在同名供应商「${name}」（${dup.code}），请换一个名称，或直接在原档案上修改`)
  const idx = list.value.findIndex(i => i.code === form.code)
  if (idx >= 0) list.value[idx] = { ...list.value[idx], ...form }
  else list.value.push({ ...form })
  // 保存失败（如 GitHub 写入出错）时明确报错，并回滚为线上数据
  try {
    await api.saveSuppliers(list.value)
  } catch (e) {
    ElMessage.error(`保存失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    await load()
    return
  }
  dialog.value = false; ElMessage.success('已保存'); load()
}
async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除 ${row.name}?`, '提示', { type: 'warning' })
  } catch { return }
  list.value = list.value.filter(i => i.code !== row.code)
  try {
    await api.saveSuppliers(list.value)
  } catch (e) {
    ElMessage.error(`删除失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    await load()
    return
  }
  ElMessage.success('已删除')
  load()
}
</script>
<style scoped>
.card-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}
.search-input{margin-bottom:12px;max-width:360px;}
.amount-debt{color:#f56c6c;font-weight:600;}
.amount-zero{color:#c0c4cc;}
.pager{margin-top:12px;justify-content:flex-end;}
</style>
