<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header"><b>供应商</b><el-button type="primary" @click="openDialog()">新增</el-button></div>
      </template>
      <el-input v-model="keyword" clearable placeholder="搜索编码 / 名称 / 联系人 / 电话" class="search-input" />
      <div class="filter-row">
        <span class="filter-label">时间段</span>
        <el-date-picker
          v-model="period"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          style="width:260px"
        />
        <el-button :type="sortMode==='amount' ? 'primary' : 'default'" @click="sortMode='amount'">按总金额排序</el-button>
        <el-button :type="sortMode==='latest' ? 'primary' : 'default'" @click="sortMode='latest'">按最新成交排序</el-button>
        <el-button v-if="sortMode!=='newest'" plain @click="sortMode='newest'">默认(按编码)</el-button>
      </div>
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
        <el-table-column label="名称" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <router-link :to="`/supplier/${row.code}`" class="link">{{ row.name }}</router-link>
          </template>
        </el-table-column>
        <el-table-column prop="contact" label="联系人" width="130" />
        <el-table-column prop="phone" label="电话" width="130" />
        <el-table-column prop="address" label="地址" min-width="180" show-overflow-tooltip />
        <el-table-column label="应付款" width="130" align="right">
          <template #default="{ row }">
            <span :class="payableMap[row.name] ? 'amount-debt' : 'amount-zero'">
              ¥ {{ Number(payableMap[row.name] || 0).toFixed(2) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="预付款" width="130" align="right">
          <template #default="{ row }">
            <span :class="advanceMap[row.code] ? 'amount-deposit' : 'amount-zero'">
              ¥ {{ Number(advanceMap[row.code] || 0).toFixed(2) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="采购总金额" width="140" align="right">
          <template #default="{ row }">
            <span :class="purchaseTotalMap[row.name] ? 'amount-deposit' : 'amount-zero'">
              ¥ {{ Number(purchaseTotalMap[row.name] || 0).toFixed(2) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="最新成交" width="120">
          <template #default="{ row }">
            <span :class="latestPurchaseMap[row.name] ? '' : 'amount-zero'">{{ latestPurchaseMap[row.name] || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" class-name="ops-col">
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
        <el-form-item label="地址"><el-input v-model="form.address" placeholder="详细地址，可空" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { matchText } from '../utils/search'
import { nextEntityCode } from '../utils/code'
import { payableOf, depositSumOf, grossOf, round2, isVoided } from '../utils/account'
import TableToolbar from '../components/TableToolbar.vue'

const PAGE_SIZE = 60

const list = ref([])
const purchases = ref([])
const keyword = ref('')
const period = ref([])       // 时间段：[开始日期, 结束日期]（YYYY-MM-DD），空数组=全部
const sortMode = ref('newest') // newest=按编码(默认) | amount=按采购总金额 | latest=按最新成交
const page = ref(1)
const dialog = ref(false)
// 保存中锁：配合按钮 loading，防止连点造成并发重复写入
const saving = ref(false)
const form = reactive({ code:'', name:'', contact:'', phone:'', address:'', remark:'' })
// 列表排序：最新添加的排最前面。编码为 S+5 位序号、新增时取最大序号+1，序号越大越新；
// 按编码数字部分倒序（兼容历史非定宽编码），无序号脏数据排最后
const byNewest = (a, b) => {
  const na = parseInt(String(a.code || '').replace(/\D/g, ''), 10) || 0
  const nb = parseInt(String(b.code || '').replace(/\D/g, ''), 10) || 0
  return nb - na
}
// 时间段筛选：未选则视为「全部」，选了则按采购单 date 落在区间内（含端点）
const inPeriod = (date) => {
  if (!period.value || period.value.length !== 2) return true
  const [s, e] = period.value
  return String(date || '') >= s && String(date || '') <= e
}
// 区间内采购单（按时间段过滤）
const periodPurchases = computed(() => (purchases.value || []).filter(p => !isVoided(p) && inPeriod(p.date)))
// 区间内采购总金额（折后成交金额合计）与最新成交日期，按供应商名称归并
const purchaseTotalMap = computed(() => {
  const map = {}
  for (const p of periodPurchases.value) {
    const name = p.supplier || ''
    map[name] = round2((map[name] || 0) + grossOf(p))
  }
  return map
})
const latestPurchaseMap = computed(() => {
  const map = {}
  for (const p of periodPurchases.value) {
    const name = p.supplier || ''
    if (!map[name] || String(p.date || '') > map[name]) map[name] = p.date
  }
  return map
})

const base = computed(() => list.value.filter(i =>
  matchText(keyword.value, i.code, i.name, i.contact, i.phone, i.address, i.remark)))
// 排序：默认按编码(最新添加)，可按区间内采购总金额、或最新成交日期
const filtered = computed(() => {
  const arr = base.value.slice()
  if (sortMode.value === 'amount') {
    arr.sort((a, b) => (purchaseTotalMap.value[b.name] || 0) - (purchaseTotalMap.value[a.name] || 0) || byNewest(a, b))
  } else if (sortMode.value === 'latest') {
    arr.sort((a, b) => String(latestPurchaseMap.value[b.name] || '').localeCompare(String(latestPurchaseMap.value[a.name] || '')) || byNewest(a, b))
  } else {
    arr.sort(byNewest)
  }
  return arr
})
const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
watch([keyword, period, sortMode], () => { page.value = 1 })

// 导出/打印与列表当前页同步：副标题标注输出范围（第 X/Y 页）
const subtitle = computed(() => {
  const parts = [`共 ${filtered.value.length} 条`, `导出当前第 ${page.value}/${pageCount.value} 页`]
  if (period.value && period.value.length === 2) parts.push(`时间段：${period.value[0]} ~ ${period.value[1]}`)
  return parts.join(' · ')
})

const exportColumns = [
  { label: '编码', prop: 'code' },
  { label: '名称', prop: 'name' },
  { label: '联系人', prop: 'contact' },
  { label: '电话', prop: 'phone' },
  { label: '地址', prop: 'address' },
  { label: '应付款', value: r => Number(payableMap.value[r.name] || 0).toFixed(2) },
  { label: '预付款', value: r => Number(advanceMap.value[r.code] || 0).toFixed(2) },
  { label: '采购总金额', value: r => Number(purchaseTotalMap.value[r.name] || 0).toFixed(2) },
  { label: '最新成交', value: r => latestPurchaseMap.value[r.name] || '—' },
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

// 预付款余额：供应商档案 advances 流水合计（充值 + 超付转存 − 抵扣）
const advanceMap = computed(() => {
  const map = {}
  for (const s of list.value || []) {
    if (s && s.code) map[s.code] = depositSumOf(s.advances)
  }
  return map
})

onMounted(load)
// 刷新失败不再清空列表：数据此时多半仍在服务端，清空会让用户误以为「没保存上」而反复点击，
// 保留本地数据等下次进入/刷新自动重拉即可
async function load() {
  try {
    const [sp, pu] = await Promise.all([api.getSuppliers(), api.getPurchases()])
    list.value = sp
    purchases.value = pu
  } catch (e) { /* 刷新失败：保留当前数据 */ }
}
function openDialog(row) { if (row) Object.assign(form, row); else Object.assign(form, { code: nextEntityCode(list.value, 'S'), name:'', contact:'', phone:'', address:'', remark:'' }); dialog.value = true }
// 保存中锁：防止连点造成并发重复写入；按钮同步转 loading 给出明确反馈
async function save() {
  if (saving.value) return
  // 供应商不允许同名：采购单是按「名称」匹配供应商档案的，
  // 重名会让单据挂到错误的档案上（历史上出现过 S00001/S00039 重复建档，商品被拆到两个码下）
  const name = (form.name || '').trim()
  if (!name) return ElMessage.warning('请填写供应商名称')
  const dup = list.value.find(i => i.code !== form.code && (i.name || '').trim() === name)
  if (dup) return ElMessage.error(`已存在同名供应商「${name}」（${dup.code}），请换一个名称，或直接在原档案上修改`)
  saving.value = true
  try {
    const snapshot = [...list.value]
    const idx = list.value.findIndex(i => i.code === form.code)
    if (idx >= 0) list.value[idx] = { ...list.value[idx], ...form }
    else list.value.push({ ...form })
    // 保存失败（如 GitHub 写入出错）时明确报错，并回滚为线上数据
    try {
      await api.saveSuppliers(list.value)
    } catch (e) {
      list.value = snapshot
      ElMessage.error(`保存失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
      await load()
      return
    }
    // 保存已成功：先关窗报成功，再后台刷新（刷新失败不再清空，新记录仍留在列表里）
    dialog.value = false; ElMessage.success('已保存'); load()
  } finally { saving.value = false }
}
async function remove(row) {
  if (saving.value) return
  // 预删除校验：预付款余额 / 未结应付 / 名下采购单
  const adv = round2(advanceMap.value[row.code] || 0)
  const pay = round2(payableMap.value[row.name] || 0)
  const purchaseCount = (purchases.value || []).filter(p => p.supplier === row.name && !isVoided(p)).length
  // 1) 预付款余额 > 0：硬性拦截，避免钱蒸发（必须去详情页清零/提现）
  if (adv > 0.005) {
    ElMessage.error(`该供应商还有预付款余额 ¥${adv.toFixed(2)}，请先到供应商详情页提现/清零后再删除，否则余额将丢失`)
    return
  }
  // 2) 有未结应付或名下有采购单：明确告知后果，二次确认
  let msg = `确定删除供应商「${row.name}」?`
  const tips = []
  if (purchaseCount > 0) tips.push(`名下 ${purchaseCount} 张采购单将标记为「(已删除供应商) ${row.name}」，仍可查询但不再计入该供应商档案`)
  if (pay > 0.005) tips.push(`仍有未结应付 ¥${pay.toFixed(2)}`)
  if (tips.length) msg += ` 注意：${tips.join('；')}。`
  try {
    await ElMessageBox.confirm(msg, '删除供应商', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' })
  } catch { return }
  saving.value = true
  try {
    const snapshotList = [...list.value]
    // 3) 先标记孤儿采购单（改名），仅当有孤儿时写 purchases
    const orphans = (purchases.value || []).filter(p => p.supplier === row.name)
    let snapshotPurchases = null
    if (orphans.length) {
      snapshotPurchases = [...(purchases.value || [])]
      const newPurchases = (purchases.value || []).map(p => p.supplier === row.name ? { ...p, supplier: `(已删除供应商) ${row.name}` } : p)
      try { await api.savePurchases(newPurchases) } catch (e) {
        ElMessage.error(`标记历史采购单失败：${e.message || '网络异常'}，已取消删除`)
        return
      }
      purchases.value = newPurchases
    }
    // 再删除供应商档案（破坏性操作放最后，失败可回滚订单改名）
    list.value = list.value.filter(i => i.code !== row.code)
    try {
      await api.saveSuppliers(list.value)
    } catch (e) {
      if (snapshotPurchases) { await api.savePurchases(snapshotPurchases).catch(() => {}); purchases.value = snapshotPurchases }
      list.value = snapshotList
      ElMessage.error(`删除失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
      return
    }
    ElMessage.success('已删除')
    load()
  } finally { saving.value = false }
}
</script>
<style scoped>
.card-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}
.search-input{margin-bottom:12px;max-width:360px;}
.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.filter-label{color:var(--text-regular);font-size:var(--fs-base);}
.amount-debt{color:var(--color-danger);font-weight:600;}
.amount-deposit{color:var(--color-success);font-weight:600;}
.amount-zero{color:var(--text-placeholder);}
.pager{margin-top:12px;justify-content:flex-end;}
</style>
