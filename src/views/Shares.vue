<template>
  <el-card v-loading="loading">
    <template #header>
      <div class="card-header">
        <div class="title">
          <b>外链分享</b>
          <span class="hint">所有对外分享统一在这里管理：只读查看、可设置时效、可随时取消</span>
        </div>
        <div class="actions">
          <el-button :loading="loading" @click="load">刷新</el-button>
        </div>
      </div>
    </template>

    <el-table :data="rows" stripe empty-text="暂无外链分享。在销售单 / 采购单 / 订单详情页点「分享」即可生成。">
      <el-table-column label="类型" width="110">
        <template #default="{ row }">{{ row.docLabel }}</template>
      </el-table-column>
      <el-table-column label="单据号" min-width="180">
        <template #default="{ row }">
          <router-link v-if="!row.missing && detailPath(row)" :to="detailPath(row)" class="link">{{ row.docId }}</router-link>
          <span v-else>{{ row.docId }}</span>
        </template>
      </el-table-column>
      <el-table-column label="往来单位" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">{{ row.party || '—' }}</template>
      </el-table-column>
      <el-table-column label="日期" width="110">
        <template #default="{ row }">{{ row.date || '—' }}</template>
      </el-table-column>
      <el-table-column label="金额" width="120" align="right">
        <template #default="{ row }">{{ Number(row.amount || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="创建时间" width="170">
        <template #default="{ row }">{{ fmtCNTime(row.createdAt) || row.createdAt || '—' }}</template>
      </el-table-column>
      <el-table-column label="有效期" width="180">
        <template #default="{ row }">
          <span :class="{ expired: row.expired }">{{ row.expiresAt ? `至 ${fmtCNTime(row.expiresAt) || row.expiresAt}` : '长期有效' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="statusOf(row).type" size="small" disable-transitions>{{ statusOf(row).text }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="280" class-name="ops-col">
        <template #default="{ row }">
          <el-button size="small" @click="copy(row)">复制链接</el-button>
          <el-button size="small" @click="openQr(row)">二维码</el-button>
          <el-button size="small" @click="openExpiry(row)">时效</el-button>
          <el-button size="small" type="danger" plain @click="cancel(row)">取消</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <ShareQr v-model="qr.visible" :url="qr.url" :title="qr.title" />

  <el-dialog v-model="expiry.visible" title="修改分享时效" width="360">
    <div class="expiry-row">
      <span class="expiry-label">新的有效期</span>
      <el-radio-group v-model="expiry.days" size="small">
        <el-radio-button :value="1">1 天</el-radio-button>
        <el-radio-button :value="7">7 天</el-radio-button>
        <el-radio-button :value="30">30 天</el-radio-button>
        <el-radio-button :value="0">长期有效</el-radio-button>
      </el-radio-group>
    </div>
    <p class="expiry-tip">按「现在」重新计算；保存后已过期或已取消的链接不会复活（取消的链接需要重新生成）。</p>
    <template #footer>
      <el-button @click="expiry.visible = false">取消</el-button>
      <el-button type="primary" :loading="expiry.saving" @click="saveExpiry">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { copyText, shareLinkOf } from '../utils/clipboard'
import { fmtCNTime } from '../utils/time.js'
import ShareQr from '../components/ShareQr.vue'

const loading = ref(false)
const rows = ref([])
const qr = ref({ visible: false, url: '', title: '' })
const expiry = ref({ visible: false, token: '', days: 7, saving: false })

const statusOf = (row) => {
  if (row.missing) return { text: '单据已删除', type: 'info' }
  if (row.voided) return { text: '单据已作废', type: 'info' }
  if (row.expired) return { text: '已过期', type: 'info' }
  return { text: '有效', type: 'success' }
}

const detailPath = (row) => {
  if (row.kind === 'sale') return `/sale/${row.docId}`
  if (row.kind === 'purchase') return `/purchase/${row.docId}`
  if (row.kind === 'order') return `/order/${row.docId}`
  return ''
}

async function load() {
  loading.value = true
  try {
    const r = await api.getShares()
    rows.value = r.shares || []
  } catch (e) {
    ElMessage.error(`加载失败：${e.message || '网络异常'}`)
  } finally {
    loading.value = false
  }
}

async function copy(row) {
  try {
    await copyText(shareLinkOf(row.token))
    ElMessage.success(row.expired ? '链接已复制（已过期，需重新生成后才能查看）' : '链接已复制')
  } catch {
    ElMessage.error('复制失败，请长按链接手动复制')
  }
}

function openQr(row) {
  qr.value = { visible: true, url: shareLinkOf(row.token), title: `${row.docLabel} ${row.docId}` }
}

function openExpiry(row) {
  expiry.value = { visible: true, token: row.token, days: 7, saving: false }
}

async function saveExpiry() {
  expiry.value.saving = true
  try {
    await api.shareOperation({ action: 'update', token: expiry.value.token, days: expiry.value.days })
    expiry.value.visible = false
    ElMessage.success('已更新有效期')
    await load()
  } catch (e) {
    ElMessage.error(e.message || '更新失败')
  } finally {
    expiry.value.saving = false
  }
}

async function cancel(row) {
  try {
    await ElMessageBox.confirm(
      `确定取消 ${row.docLabel} ${row.docId} 的分享链接？\n取消后别人将无法继续查看，单据本身不受影响。`,
      '取消分享', { type: 'warning', confirmButtonText: '取消分享', cancelButtonText: '保留' })
  } catch { return }
  try {
    await api.shareOperation({ action: 'cancel', token: row.token })
    ElMessage.success('已取消分享')
    await load()
  } catch (e) {
    ElMessage.error(e.message || '取消失败')
  }
}

onMounted(load)
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hint { color: var(--text-secondary); font-size: var(--fs-sub); }
.actions { display: flex; gap: 8px; }
.expired { color: var(--text-secondary); }
.expiry-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.expiry-label { color: var(--text-regular); font-size: var(--fs-sub); }
.expiry-tip { margin: 12px 0 0; color: var(--text-secondary); font-size: var(--fs-mini); line-height: 1.7; }
</style>
