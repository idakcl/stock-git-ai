<template>
  <el-dialog v-model="visible" :title="`分享${title || '单据'}`" width="540" :close-on-click-modal="false" append-to-body>
    <div v-loading="loading" class="share-body">
      <!-- 还没有分享：选有效期后生成 -->
      <template v-if="!share">
        <p class="share-hint">生成一个只读链接，别人打开只能查看，不能编辑或删除单据。</p>
        <div class="share-row">
          <span class="share-label">有效期</span>
          <el-radio-group v-model="days" size="small">
            <el-radio-button :value="1">1 天</el-radio-button>
            <el-radio-button :value="7">7 天</el-radio-button>
            <el-radio-button :value="30">30 天</el-radio-button>
            <el-radio-button :value="0">长期有效</el-radio-button>
          </el-radio-group>
        </div>
        <el-button type="primary" class="share-create" :loading="saving" @click="create">生成分享链接</el-button>
      </template>

      <!-- 已有分享（含已过期）：显示链接与操作 -->
      <template v-else>
        <div class="share-row">
          <span class="share-label">链接</span>
          <el-input :model-value="link" readonly>
            <template #append><el-button @click="copy">复制</el-button></template>
          </el-input>
        </div>
        <div class="share-row">
          <span class="share-label">状态</span>
          <el-tag :type="share.expired ? 'info' : 'success'" size="small" disable-transitions>{{ share.expired ? '已过期' : '有效' }}</el-tag>
          <span class="share-exp">{{ share.expiresAt ? `至 ${fmtCNTime(share.expiresAt) || share.expiresAt}` : '长期有效' }}</span>
        </div>
        <div v-if="share.expired" class="share-row">
          <span class="share-label">重新生成</span>
          <el-radio-group v-model="days" size="small">
            <el-radio-button :value="1">1 天</el-radio-button>
            <el-radio-button :value="7">7 天</el-radio-button>
            <el-radio-button :value="30">30 天</el-radio-button>
            <el-radio-button :value="0">长期有效</el-radio-button>
          </el-radio-group>
          <el-button size="small" type="primary" :loading="saving" @click="create">重新生成</el-button>
        </div>
        <div class="share-actions">
          <el-button @click="qrVisible = true">二维码</el-button>
          <el-button type="danger" plain :loading="saving" @click="cancel">取消分享</el-button>
        </div>
        <p class="share-tip">取消后链接立即失效；单据本身不受影响。</p>
      </template>
    </div>
    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>

  <ShareQr v-model="qrVisible" :url="link" :title="`${title || '单据'}分享二维码`" />
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { copyText, shareLinkOf } from '../utils/clipboard'
import { fmtCNTime } from '../utils/time.js'
import ShareQr from './ShareQr.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  kind: { type: String, default: 'sale' },
  docId: { type: String, default: '' },
  title: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])
const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v)
})

const loading = ref(false)
const saving = ref(false)
const share = ref(null)
const days = ref(7)
const qrVisible = ref(false)
const link = computed(() => (share.value ? shareLinkOf(share.value.token) : ''))

// 同一张单在分享列表里可能有一条过期记录：优先展示仍有效的，没有效的才展示过期的那条
async function loadShare() {
  if (!props.docId) return
  loading.value = true
  try {
    const r = await api.getShares()
    const list = (r.shares || []).filter(s => s.kind === props.kind && s.docId === props.docId)
    share.value = list.find(s => !s.expired) || list[0] || null
    if (share.value && share.value.expiresAt) {
      const left = Date.parse(share.value.expiresAt) - Date.now()
      days.value = left > 30 * 86400000 ? 30 : left > 7 * 86400000 ? 7 : 1
    }
  } catch (e) {
    ElMessage.error(`分享状态加载失败：${e.message || '网络异常'}`)
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, v => {
  if (v) { share.value = null; days.value = 7; loadShare() }
})
watch(() => props.docId, () => { if (props.modelValue) { share.value = null; loadShare() } })

async function create() {
  saving.value = true
  try {
    const r = await api.shareOperation({ action: 'create', kind: props.kind, docId: props.docId, days: days.value })
    share.value = r.share
    if (r.reused) ElMessage.info('该单据已有有效分享，已为你打开原链接')
    else ElMessage.success('分享链接已生成')
  } catch (e) {
    ElMessage.error(e.message || '生成分享链接失败')
  } finally {
    saving.value = false
  }
}

async function cancel() {
  if (!share.value) return
  try {
    await ElMessageBox.confirm('确定取消这个分享链接？取消后别人将无法继续查看。', '取消分享', {
      type: 'warning', confirmButtonText: '取消分享', cancelButtonText: '保留'
    })
  } catch { return }
  saving.value = true
  try {
    await api.shareOperation({ action: 'cancel', token: share.value.token })
    share.value = null
    ElMessage.success('已取消分享')
  } catch (e) {
    ElMessage.error(e.message || '取消失败')
  } finally {
    saving.value = false
  }
}

async function copy() {
  try {
    await copyText(link.value)
    ElMessage.success('链接已复制')
  } catch {
    ElMessage.error('复制失败，请长按链接手动复制')
  }
}
</script>

<style scoped>
.share-body { min-height: 120px; }
.share-hint { margin: 0 0 12px; color: var(--text-regular); font-size: var(--fs-sub); line-height: 1.7; }
.share-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.share-label { width: 64px; flex: none; color: var(--text-regular); font-size: var(--fs-sub); }
.share-row :deep(.el-input) { flex: 1; min-width: 220px; }
.share-exp { color: var(--text-secondary); font-size: var(--fs-sub); }
.share-actions { display: flex; gap: 8px; margin-top: 4px; }
.share-tip { margin: 10px 0 0; color: var(--text-secondary); font-size: var(--fs-mini); }
.share-create { margin-top: 4px; }
</style>
