<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header"><b>客户</b><el-button type="primary" @click="openDialog()">新增</el-button></div>
      </template>
      <div class="filter-row">
        <span class="filter-label">类别</span>
        <el-select v-model="categoryFilter" clearable placeholder="全部类别" style="width:150px">
          <el-option v-for="c in CATEGORIES" :key="c" :label="c" :value="c" />
        </el-select>
      </div>
      <el-input v-model="keyword" clearable placeholder="搜索编码 / 名称 / 联系人 / 电话" class="search-input" />
      <TableToolbar
        filename="客户"
        title="客户"
        :subtitle="subtitle"
        :columns="exportColumns"
        :rows="paged"
      />
      <div class="table-wrap">
      <el-table :data="paged" stripe>
        <el-table-column prop="code" label="编码" width="120" />
        <el-table-column label="名称" min-width="200">
          <template #default="{ row }">
            <router-link :to="`/customer/${row.code}`" class="link">{{ row.name }}</router-link>
          </template>
        </el-table-column>
        <el-table-column label="类别" width="130">
          <template #default="{ row }">
            <el-tag v-if="row.category" size="small" :type="categoryTagType(row.category)" disable-transitions>{{ row.category }}</el-tag>
            <span v-else class="none">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="contact" label="联系人" width="130" />
        <el-table-column prop="phone" label="电话" width="130" />
        <el-table-column label="应收款" width="130" align="right">
          <template #default="{ row }">
            <span :class="receivableMap[row.name] ? 'amount-debt' : 'amount-zero'">
              ¥ {{ Number(receivableMap[row.name] || 0).toFixed(2) }}
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
    <el-dialog v-model="dialog" title="客户" width="420">
      <el-form :model="form" label-width="80px">
        <el-form-item label="编码"><el-input v-model="form.code" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="联系人"><el-input v-model="form.contact" /></el-form-item>
        <el-form-item label="电话"><el-input v-model="form.phone" /></el-form-item>
        <el-form-item label="类别">
          <el-select v-model="form.category" clearable placeholder="选择客户类别" style="width:100%">
            <el-option v-for="c in CATEGORIES" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
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
import { receivableOf } from '../utils/account'
import TableToolbar from '../components/TableToolbar.vue'

const PAGE_SIZE = 60
const CATEGORIES = ['批发', '零售', '安装师傅']

const list = ref([])
const sales = ref([])
const keyword = ref('')
const categoryFilter = ref('')
const page = ref(1)
const dialog = ref(false)
const form = reactive({ code:'', name:'', contact:'', phone:'', category:'', remark:'' })

// 列表排序：最新添加的排最前面。编码为 C+5 位序号、新增时取最大序号+1，序号越大越新；
// 按编码数字部分倒序（兼容历史非定宽编码），无序号脏数据排最后
const byNewest = (a, b) => {
  const na = parseInt(String(a.code || '').replace(/\D/g, ''), 10) || 0
  const nb = parseInt(String(b.code || '').replace(/\D/g, ''), 10) || 0
  return nb - na
}
const filtered = computed(() => list.value
  .filter(i => {
    if (categoryFilter.value && (i.category || '') !== categoryFilter.value) return false
    return matchText(keyword.value, i.code, i.name, i.contact, i.phone, i.remark)
  })
  .sort(byNewest)
)
const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
watch([keyword, categoryFilter], () => { page.value = 1 })

const categoryTagType = (c) => ({ '批发': 'warning', '零售': 'success', '安装师傅': 'primary' }[c] || 'info')
// 导出/打印与列表当前页同步：副标题标注输出范围（第 X/Y 页）
const subtitle = computed(() => {
  const parts = [`共 ${filtered.value.length} 条`, `导出当前第 ${page.value}/${pageCount.value} 页`]
  if (categoryFilter.value) parts.push('类别：' + categoryFilter.value)
  return parts.join(' · ')
})
const exportColumns = [
  { label: '编码', prop: 'code' },
  { label: '名称', prop: 'name' },
  { label: '类别', prop: 'category' },
  { label: '联系人', prop: 'contact' },
  { label: '电话', prop: 'phone' },
  { label: '应收款', value: r => Number(receivableMap.value[r.name] || 0).toFixed(2) },
  { label: '备注', prop: 'remark' }
]

// 应收款：该客户全部销售单的未结金额合计（欠款按金额计算，与结算状态无关）
const receivableMap = computed(() => {
  const map = {}
  for (const s of sales.value || []) {
    const name = s.customer || ''
    map[name] = (map[name] || 0) + receivableOf(s)
  }
  return map
})

onMounted(load)
async function load() {
  try {
    const [cu, sa] = await Promise.all([api.getCustomers(), api.getSales()])
    list.value = cu
    sales.value = sa
  } catch (e) { list.value = []; sales.value = [] }
}
function openDialog(row) { if (row) Object.assign(form, row); else Object.assign(form, { code: nextEntityCode(list.value, 'C'), name:'', contact:'', phone:'', category:'', remark:'' }); dialog.value = true }
async function save() {
  const idx = list.value.findIndex(i => i.code === form.code)
  if (idx >= 0) list.value[idx] = { ...list.value[idx], ...form }
  else list.value.push({ ...form })
  // 保存失败（如 GitHub 写入出错）时明确报错，并回滚为线上数据
  try {
    await api.saveCustomers(list.value)
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
    await api.saveCustomers(list.value)
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
.amount-debt{color:var(--color-danger);font-weight:600;}
.amount-zero{color:var(--text-placeholder);}
.none{color:var(--text-placeholder);}
.pager{margin-top:12px;justify-content:flex-end;}
.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.filter-label{color:var(--text-regular);font-size:var(--fs-base);}
</style>
