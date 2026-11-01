<template>
  <div class="page">
    <el-card shadow="never">
      <template #header>
        <div class="card-head">
          <div class="head-title">
            <b>操作日志</b>
            <span class="hint">最近 {{ rows.length }} 条（数据仓只保留最近 200 条）</span>
          </div>
          <div class="head-actions">
            <el-select v-model="source" size="small" clearable placeholder="全部来源" class="src-select">
              <el-option v-for="s in sources" :key="s" :label="LABELS[s] || s" :value="s" />
            </el-select>
            <el-input v-model="keyword" size="small" clearable placeholder="搜索单号 / 名称 / 密钥" class="kw" />
            <el-button size="small" :loading="loading" @click="load">刷新</el-button>
          </div>
        </div>
      </template>

      <el-table :data="filtered" size="small" row-key="__key" class="log-table">
        <el-table-column type="expand">
          <template #default="{ row }">
            <pre class="raw">{{ pretty(row) }}</pre>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ timeText(row.time) }}</template>
        </el-table-column>
        <el-table-column label="来源" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="tagType(row.source)" disable-transitions>{{ LABELS[row.source] || row.source || '其他' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="内容" min-width="380">
          <template #default="{ row }">{{ summary(row) }}</template>
        </el-table-column>
      </el-table>

      <div v-if="!filtered.length" class="empty">{{ loading ? '加载中…' : (rows.length ? '没有匹配的日志' : '暂无日志') }}</div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { fmtCNTime } from '../utils/time.js'

// 来源到中文名的映射；没有列到的类型直接显示原值（不吞信息）
const LABELS = {
  refund: '退款', order: '订单', void: '作废', restore: '恢复', ai: 'AI-API',
  clear: '清空', merge: '合并导入', amend: '变更', derive: '编码修正', login: '登录',
  save: '字段修改', share: '外链分享'
}
const TAG_TYPES = {
  refund: 'danger', void: 'warning', clear: 'danger', restore: 'info',
  ai: 'success', derive: 'warning', amend: 'info', save: 'primary', share: 'info'
}
const ACTION_LABELS = {
  create: '新建', delete: '删除', post: '过账', unpost: '撤销过账', save: '保存',
  remark: '备注', restore: '恢复', clear: '清空', deposit: '订金', view: '打开'
}
const KIND_LABELS = { sale: '销售单', purchase: '采购单', order: '订单' }
const MONEY = new Set(['total', 'discount', 'received', 'paid'])
const moneyText = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })

// 一条 docs 摘要 → 「金额 1,000 → 900、客户 甲 → 乙」
function fieldsText(doc) {
  return Object.entries((doc && doc.fields) || {}).map(([k, v]) => {
    if (k === '_new') return '新建'
    if (k === '_deleted') return '移除'
    if (!v || !v.label) return k
    if (MONEY.has(k)) return `${v.label} ${moneyText(v.from)} → ${moneyText(v.to)}`
    return `${v.label} ${v.from || '空'} → ${v.to || '空'}`
  }).join('、') || '无字段变化'
}

const rows = ref([])
const loading = ref(false)
const source = ref('')
const keyword = ref('')

const sources = computed(() => [...new Set(rows.value.map(r => r.source).filter(Boolean))])

const textOf = (r) => JSON.stringify(r)
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return rows.value.filter(r => {
    if (source.value && r.source !== source.value) return false
    if (!kw) return true
    return textOf(r).toLowerCase().includes(kw)
  })
})

const timeText = (t) => fmtCNTime(t) || '—'
const pretty = ({ __key, ...rest }) => JSON.stringify(rest, null, 2)
const tagType = (s) => TAG_TYPES[s] || 'info'

function summary(row) {
  const parts = []
  if (row.action) parts.push(ACTION_LABELS[row.action] || row.action)
  if (row.target) parts.push(String(row.target))
  if (row.kind) parts.push(KIND_LABELS[row.kind] || String(row.kind))
  if (row.code) parts.push(String(row.code))
  if (row.orderId && row.orderId !== row.code) parts.push(`订单 ${row.orderId}`)
  if (row.party) parts.push(String(row.party))
  if (row.voucher) parts.push(`凭证 ${row.voucher}`)
  if (row.amount != null && Number.isFinite(Number(row.amount))) parts.push(`¥${Number(row.amount).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`)
  if (row.count != null) parts.push(`${row.count} 条`)
  if (row.counts && typeof row.counts === 'object') {
    const detail = Object.entries(row.counts).filter(([, v]) => Number(v)).map(([k, v]) => `${k} ${v}`).join('、')
    if (detail) parts.push(detail)
  }
  if (row.fixed != null) parts.push(`修正编码 ${row.fixed} 处`)
  if (Array.isArray(row.results)) parts.push(row.results.map(x => `${x.key} ${x.count}`).join('、'))
  if (row.key) parts.push(`密钥 ${row.key}`)
  if (row.token) parts.push(`链接 ${row.token}…`)
  if (row.changed != null) parts.push(`改 ${row.changed} 张`)
  if (Array.isArray(row.docs) && row.docs.length) {
    const shown = row.docs.slice(0, 3).map(d => `${d.id}（${fieldsText(d)}）`).join('；')
    parts.push(row.docs.length > 3 ? `${shown} 等` : shown)
  }
  return parts.filter(Boolean).join(' · ') || '—'
}

async function load() {
  loading.value = true
  try {
    const list = await api.getLogs()
    // 新的在前；同一条日志的展开键固定下来，避免筛选后重复渲染
    rows.value = (Array.isArray(list) ? list : []).slice().reverse().map((r, i) => ({ ...r, __key: i }))
  } catch (e) {
    ElMessage.error('日志加载失败：' + (e.message || e))
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--gap-md); flex-wrap: wrap; }
.head-title { display: flex; align-items: baseline; gap: var(--gap-sm); flex-wrap: wrap; }
.hint { color: var(--text-secondary); font-size: var(--fs-sub); }
.head-actions { display: flex; align-items: center; gap: var(--gap-sm); flex-wrap: wrap; }
.src-select { width: 130px; }
.kw { width: 200px; }
.raw { margin: 0; padding: var(--gap-sm) var(--gap-md); background: var(--bg-soft); border-radius: var(--radius-sm); font-size: var(--fs-sub); line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
@media (max-width: 768px) {
  .head-actions { width: 100%; }
  .kw { flex: 1; min-width: 120px; }
  .src-select { width: 110px; }
}
</style>
