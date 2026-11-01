<template>
  <div class="page">
    <el-card shadow="never">
      <template #header>
        <div class="card-head">
          <div class="head-title">
            <b>对账检查</b>
            <span class="hint">{{ checkedText }}</span>
          </div>
          <div class="head-actions">
            <el-radio-group v-model="level" size="small">
              <el-radio-button value="">全部</el-radio-button>
              <el-radio-button value="error">错误 {{ counts.error || 0 }}</el-radio-button>
              <el-radio-button value="warn">警告 {{ counts.warn || 0 }}</el-radio-button>
              <el-radio-button value="info">提示 {{ counts.info || 0 }}</el-radio-button>
            </el-radio-group>
            <el-button size="small" :loading="loading" @click="load">重新检查</el-button>
          </div>
        </div>
      </template>

      <el-alert class="intro" type="info" :closable="false" show-icon
        title="只检查、不改数据。发现的问题需要你确认后手动修：重新保存单据、改结清，或补录流水。" />

      <el-table v-if="filtered.length" :data="filtered" size="small" class="check-table">
        <el-table-column label="级别" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="tagType(row.level)" disable-transitions>{{ levelText(row.level) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="问题" width="190">
          <template #default="{ row }">{{ row.title }}</template>
        </el-table-column>
        <el-table-column label="单据 / 凭证" width="180">
          <template #default="{ row }">
            <router-link v-if="linkOf(row)" :to="linkOf(row)" class="link">{{ row.id || row.code }}</router-link>
            <span v-else-if="row.id || row.code">{{ row.id || row.code }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="说明" min-width="360">
          <template #default="{ row }">{{ row.detail }}</template>
        </el-table-column>
      </el-table>

      <div v-else class="empty">
        {{ loading ? '检查中…' : (items.length ? '当前筛选下没有问题' : '没有发现问题：单头/明细、实收/流水、结算状态、凭证引用与退货额度全部一致') }}
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { fmtCNTime } from '../utils/time.js'

const items = ref([])
const counts = ref({ error: 0, warn: 0, info: 0 })
const checkedAt = ref('')
const loading = ref(false)
const level = ref('')

const LEVEL_TEXT = { error: '错误', warn: '警告', info: '提示' }
const LEVEL_TAG = { error: 'danger', warn: 'warning', info: 'info' }
const levelText = (l) => LEVEL_TEXT[l] || l
const tagType = (l) => LEVEL_TAG[l] || 'info'

const checkedText = computed(() => (checkedAt.value ? `检查时间 ${fmtCNTime(checkedAt.value)}` : '只读检查，不会改动任何数据'))
const filtered = computed(() => (level.value ? items.value.filter(i => i.level === level.value) : items.value))

// 能定位到具体页面就给链接：单据 → 详情页；凭证 → 收付款单页并高亮该编号
function linkOf(row) {
  if (row.kind === 'sale' && row.id) return `/sale/${encodeURIComponent(row.id)}`
  if (row.kind === 'purchase' && row.id) return `/purchase/${encodeURIComponent(row.id)}`
  if (['receipt', 'payment-voucher', 'refund'].includes(row.kind) && row.code) return { path: '/vouchers', query: { code: row.code } }
  return ''
}

async function load() {
  loading.value = true
  try {
    const r = await api.getAudit()
    items.value = Array.isArray(r && r.items) ? r.items : []
    counts.value = (r && r.counts) || { error: 0, warn: 0, info: 0 }
    checkedAt.value = (r && r.checkedAt) || ''
  } catch (e) {
    ElMessage.error('检查失败：' + (e.message || e))
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
.intro { margin-bottom: var(--gap-md); }
.muted { color: var(--text-secondary); }
/* 说明列较长：允许换行，手机上不撑破卡片 */
.check-table :deep(.cell) { line-height: 1.5; }
@media (max-width: 768px) {
  .head-actions { width: 100%; }
}
</style>
