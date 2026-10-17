<template>
  <!-- 轻量单据照片弹窗：给已有单据补原始单据照片，只更新 photos 字段，不动单据其他信息 -->
  <el-dialog
    :model-value="modelValue"
    :title="`单据照片 · ${order?.id || ''}`"
    width="560"
    @update:model-value="v => emit('update:modelValue', v)"
  >
    <template v-if="modelValue">
      <PhotoUpload ref="uploader" v-model="photos" :key="photoKey" />
      <div class="dlg-tip">可上传多张原始单据照片；把鼠标移到已添加的缩略图上点 × 可移除。保存后仅更新本单照片，单号、金额、明细等其他信息不受影响。</div>
    </template>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="save">保存照片</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import PhotoUpload from './PhotoUpload.vue'

const props = defineProps({
  // 弹窗是否打开
  modelValue: { type: Boolean, default: false },
  // 目标单据（取 id 展示、photos 作为初始值）
  order: { type: Object, default: null }
})
const emit = defineEmits(['update:modelValue', 'saved'])

const photos = ref([])
const uploader = ref(null)
// 每次打开都重置上传区：key 变化使 PhotoUpload 重新挂载，避免上一张单据的残留
const photoKey = ref(0)

watch(() => props.modelValue, (v) => {
  if (v) {
    photos.value = [...(props.order?.photos || [])]
    photoKey.value++
  }
})

async function save() {
  if (uploader.value && uploader.value.isUploading()) return ElMessage.warning('照片正在上传中，请等待上传完成后再保存')
  // 兜底等一个 tick，确保上传区对父级的回传已完成
  await nextTick()
  // 由父组件负责合并保存与关闭弹窗（保存失败时保持打开，便于重试）
  emit('saved', [...photos.value])
}
</script>

<style scoped>
.dlg-tip { color:var(--text-secondary); font-size:var(--fs-sub); line-height: 1.6; margin-top: 4px; }
</style>
