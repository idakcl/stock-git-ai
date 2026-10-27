<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title"><b>清空数据</b></div>
        </div>
      </template>

      <el-alert type="error" :closable="false" show-icon class="danger-intro">
        清空后数据<b>不可恢复</b>，执行前请务必先到「数据备份」页「导出全部数据」备份。每项清空均需<b>两步确认</b>并验证<b>管理密码</b>。
      </el-alert>

      <!-- 清空所有数据 -->
      <el-card shadow="never" class="panel danger-panel">
        <template #header><b class="danger-title">清空所有数据</b></template>
        <p class="desc">一次性清空全部五类数据（商品 / 客户 / 供应商 / 销售单 / 采购单），执行后将自动刷新页面恢复统计。</p>
        <el-button type="danger" :loading="clearing && clearTarget === 'all'" @click="requestClear('all')">清空所有数据</el-button>
      </el-card>

      <!-- 分项清空 -->
      <el-card shadow="never" class="panel">
        <template #header><b>仅清空某一类</b></template>
        <p class="desc">
          单项清空只影响对应数据：清空客户/供应商时，其名下销售单/采购单会保留并标记为「(已删除…)」，<b>不会连同单据一起删除</b>；清空销售单/采购单不影响客户/供应商档案。
        </p>
        <div class="clear-group">
          <div class="clear-block" v-for="t in typeRows" :key="t.key">
            <div class="clear-label">{{ t.label }}（库内 {{ t.count == null ? '—' : t.count }}）</div>
            <el-button type="danger" plain size="small" :loading="clearing && clearTarget === t.key" @click="requestClear(t.key)">清空{{ t.label }}</el-button>
          </div>
        </div>
      </el-card>
    </el-card>

    <!-- 管理密码确认弹窗（第二步） -->
    <el-dialog v-model="pwdVisible" :title="`清空确认 · ${clearTargetLabel}`" width="420px" top="12vh" @closed="pwdText=''">
      <p class="pwd-warn">{{ clearWarnText }}</p>
      <el-form @submit.prevent="confirmClear">
        <el-form-item :error="pwdError">
          <el-input v-model="pwdText" type="password" show-password placeholder="请输入管理密码" :prefix-icon="Lock" @keyup.enter="confirmClear" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdVisible=false">取消</el-button>
        <el-button type="danger" :loading="clearing" @click="confirmClear">确认清空</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Lock } from '@element-plus/icons-vue'
import { api } from '../api'

// 各类型库内数量（清空面板展示用）
const TYPES = [
  { key: 'items', label: '商品', unit: '条' },
  { key: 'customers', label: '客户', unit: '条' },
  { key: 'suppliers', label: '供应商', unit: '条' },
  { key: 'sales', label: '销售单', unit: '单' },
  { key: 'purchases', label: '采购单', unit: '单' },
  { key: 'receipts', label: '收款单', unit: '单' },
  { key: 'payment-vouchers', label: '付款单', unit: '单' }
]
const typeRows = ref(TYPES.map(t => ({ ...t, count: null })))
const FETCHERS = {
  items: () => api.getItems(),
  customers: () => api.getCustomers(),
  suppliers: () => api.getSuppliers(),
  sales: () => api.getSales(),
  purchases: () => api.getPurchases(),
  receipts: () => api.getReceipts(),
  'payment-vouchers': () => api.getPaymentVouchers()
}
async function loadCounts() {
  await Promise.all(TYPES.map(async t => {
    try {
      const records = await FETCHERS[t.key]()
      const row = typeRows.value.find(r => r.key === t.key)
      if (row) row.count = Array.isArray(records) ? records.length : 0
    } catch { /* 拉取失败显示 —，不阻塞 */ }
  }))
}
onMounted(loadCounts)

// ---------- 两步确认（警告 → 管理密码校验） ----------
const pwdVisible = ref(false)
const pwdText = ref('')
const pwdError = ref('')
const clearing = ref(false)
const clearTarget = ref('')
const clearTargetLabel = ref('')
const clearWarnText = ref('')

const CLEAR_LABELS = { all: '全部数据', items: '商品', customers: '客户', suppliers: '供应商', sales: '销售单', purchases: '采购单', receipts: '收款单', 'payment-vouchers': '付款单' }
const CLEAR_WARN = {
  all: '将清空全部数据（商品、客户、供应商、销售单、采购单、收款单、付款单），此操作不可恢复！',
  items: '将清空全部商品，已建立的库存与历史价关系将丢失。',
  customers: '将清空全部客户档案（含预存款流水）；其名下销售单将标记为「(已删除客户) …」，不再计入客户档案。',
  suppliers: '将清空全部供应商档案（含预付款流水）；其名下采购单将标记为「(已删除供应商) …」，不再计入供应商档案。',
  sales: '将清空全部销售单。',
  purchases: '将清空全部采购单。',
  receipts: '将清空全部收款单（不影响销售单本身的已收记录）。',
  'payment-vouchers': '将清空全部付款单（不影响采购单本身的已付记录）。'
}

// 第一步：警告确认；通过后弹出密码输入框
async function requestClear(key) {
  if (clearing.value) return
  const label = CLEAR_LABELS[key] || key
  try {
    await ElMessageBox.confirm(
      `${CLEAR_WARN[key] || ''}\n\n此操作不可撤销，执行前建议先到「数据备份」导出全部数据。确定要继续吗？`,
      `确认清空${label}`,
      { type: 'warning', confirmButtonText: '下一步：输入密码', cancelButtonText: '取消' }
    )
  } catch { return }
  clearTarget.value = key
  clearTargetLabel.value = label
  clearWarnText.value = CLEAR_WARN[key] || ''
  pwdText.value = ''
  pwdError.value = ''
  pwdVisible.value = true
}

const SAVERS = {
  items: (d) => api.saveItems(d),
  customers: (d) => api.saveCustomers(d),
  suppliers: (d) => api.saveSuppliers(d),
  sales: (d) => api.saveSales(d),
  purchases: (d) => api.savePurchases(d),
  receipts: (d) => api.saveReceipts(d),
  'payment-vouchers': (d) => api.savePaymentVouchers(d)
}
const ALL_KEYS = ['items', 'customers', 'suppliers', 'sales', 'purchases', 'receipts', 'payment-vouchers']

// 第二步：验证管理密码（复用登录接口），通过后整表写入空数组清空
async function confirmClear() {
  if (clearing.value) return
  if (!pwdText.value) { pwdError.value = '请输入管理密码'; return }
  pwdError.value = ''
  clearing.value = true
  const key = clearTarget.value
  try {
    await api.login(pwdText.value, false)
  } catch (e) {
    const msg = (e && e.message) || '登录失败'
    pwdError.value = /密码|password|unauthorized|401|登录/i.test(msg) ? '管理密码错误，请重试' : msg
    clearing.value = false
    return
  }
  try {
    if (key === 'all') {
      await Promise.all(ALL_KEYS.map(k => SAVERS[k]([])))
    } else {
      await SAVERS[key]([])
      // 清空客户/供应商后，把名下孤儿单据的客户/供应商名标记为「(已删除…)」，保持汇总整洁
      if (key === 'customers') await markOrphans('sales', 'customer', '已删除客户')
      if (key === 'suppliers') await markOrphans('purchases', 'supplier', '已删除供应商')
    }
    pwdVisible.value = false
    ElMessage.success(`已清空${clearTargetLabel.value}`)
    if (key === 'all') setTimeout(() => window.location.reload(), 700)
    else loadCounts()
  } catch (e) {
    ElMessage.error(`清空失败：${e.message || '网络异常'}，请重试`)
  } finally {
    clearing.value = false
  }
}

// 把孤儿单据的客户/供应商名加「(已删除…)」前缀（幂等：已加前缀的不重复加）
async function markOrphans(kind, field, tag) {
  const getter = kind === 'sales' ? api.getSales : api.getPurchases
  const saver = kind === 'sales' ? api.saveSales : api.savePurchases
  const list = await getter()
  const prefix = `(${tag}) `
  let changed = false
  for (const o of (list || [])) {
    const name = (o[field] || '').trim()
    if (name && !name.startsWith(prefix)) {
      o[field] = prefix + name
      changed = true
    }
  }
  if (changed) await saver(list)
}
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.title { font-size: var(--fs-h3, 18px); }
.panel { margin-bottom: 16px; background: var(--bg-card, #fff); }
.panel:last-child { margin-bottom: 0; }
.desc { color: var(--text-regular); font-size: var(--fs-base); margin: 0 0 12px; line-height: 1.7; }
.danger-panel { border-color: var(--color-danger, #f56c6c); }
.danger-title { color: var(--color-danger, #f56c6c); }
.danger-intro { margin-bottom: 16px; line-height: 1.7; }
.clear-block { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; background: var(--bg-card, #fff); min-width: 160px; }
.clear-label { font-size: var(--fs-sub); color: var(--text-regular); }
.clear-group { display: flex; align-items: stretch; gap: 14px; flex-wrap: wrap; }
.pwd-warn { color: var(--color-danger, #f56c6c); font-size: var(--fs-base); line-height: 1.7; margin: 0 0 16px; }
</style>
