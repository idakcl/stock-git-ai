<template>
  <div class="photo-upload">
    <el-upload
      v-model:file-list="fileList"
      action="/api/upload"
      name="file"
      list-type="picture-card"
      accept="image/*"
      :multiple="true"
      :limit="limit"
      :headers="uploadHeaders"
      :on-exceed="onExceed"
      :on-success="onSuccess"
      :on-error="onError"
      :on-remove="onRemove"
      :on-progress="onProgress"
      :on-change="onChange"
      :before-upload="beforeUpload"
    >
      <el-icon><Plus /></el-icon>
    </el-upload>
    <div v-if="!fileList.length" class="tip">可上传多张照片（最多 {{ limit }} 张，单击缩略图可放大）</div>
    <div v-else-if="uploading > 0" class="tip uploading">正在上传 {{ uploading }} 张照片，请稍候…</div>
    <div v-else class="tip">已添加 {{ fileList.length }} 张照片，单击缩略图可放大查看</div>
  </div>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { auth } from '../api'

const props = defineProps({
  // 已保存的照片 URL 数组
  modelValue: { type: Array, default: () => [] },
  limit: { type: Number, default: 9 }
})
const emit = defineEmits(['update:modelValue'])

// 上传接口要求登录态：el-upload 直连 /api/upload，需自带 Bearer 票据
const uploadHeaders = computed(() => {
  const t = auth.get()
  return t ? { Authorization: `Bearer ${t}` } : {}
})

const toList = (urls) => (urls || []).filter(u => u && !u.startsWith('blob:')).map(url => ({ name: url, url }))
// blob: 地址是浏览器本地的临时预览，刷新即失效，绝不允计持久化到单据
const toUrls = (list) => (list || []).map(f => f.url).filter(u => u && !u.startsWith('blob:'))

const fileList = ref(toList(props.modelValue))
// 正在上传中的照片数量（用于父级保存前防呆）
// 小文件可能整个上传过程都不触发 progress 事件，仅靠 status==='uploading' 会漏判，
// 因此把「已选待传(ready)」也视为在途，避免保存过早把未完成的照片漏存/存成空
const uploading = ref(0)

const countUploading = (files) => {
  uploading.value = (files || []).filter(f => f && (f.status === 'uploading' || f.status === 'ready')).length
}

// 外部传入值变化（如切换单据）时同步进来
watch(() => props.modelValue, (v) => {
  if (JSON.stringify(toUrls(fileList.value)) !== JSON.stringify(toList(v).map(f => f.url))) {
    fileList.value = toList(v)
  }
}, { deep: true })

// 列表变化后把 URL 数组回传给父级
watch(fileList, (v) => {
  emit('update:modelValue', toUrls(v))
}, { deep: true })

// 供父级调用：是否还有照片在上传中
defineExpose({ isUploading: () => uploading.value > 0 })

function beforeUpload(file) {
  if (!/^image\//.test(file.type)) {
    ElMessage.warning('只能上传图片文件')
    return false
  }
  if (file.size / 1024 / 1024 > 10) {
    ElMessage.warning('单张图片不能超过 10MB')
    return false
  }
  return true
}

function onSuccess(res, file, files) {
  // 上传成功后同步 el-upload 内部项为最终 URL，便于缩略图预览
  const url = res && res.url
  if (!url) {
    ElMessage.error('上传未返回图片链接')
    const idx = files.findIndex(f => f === file)
    if (idx >= 0) files.splice(idx, 1)
    syncList(files)
    return
  }
  file.url = url
  file.name = file.name || url
  fileList.value = files.map(f => ({ name: f.name, url: f.url }))
  countUploading(files)
}

// 把 el-upload 内部列表同步回我们的 fileList：
// el-upload 用被动 v-model，内部增删在某些时序下不会回传，不同步就会残留脏项
// 这里同步 emit 回传（不等 watch 的异步 flush），避免删除后立刻保存时父级拿到旧值
function syncList(files) {
  fileList.value = (files || []).map(f => ({ name: f.name, url: f.url }))
  emit('update:modelValue', toUrls(fileList.value))
}

// 删除照片：被动 v-model 不回传，且删除只触发 onRemove、不触发 onChange，
// 必须在这里手动对齐，否则已删照片会残留在 fileList 里被再次保存
function onRemove(file, files) {
  syncList(files)
}

function onError(err, file, files) {
  ElMessage.error('上传失败：' + (err?.message || '请重试'))
  // 内部已移除失败项，主动对齐一次，避免残留
  syncList(files)
}

function onExceed() {
  ElMessage.warning(`最多上传 ${props.limit} 张`)
}

function onProgress(evt, file, files) {
  countUploading(files)
}

function onChange(file, files) {
  countUploading(files)
}
</script>

<style scoped>
.photo-upload { width: 100%; }
.tip { color: #909399; font-size: 12px; margin-top: 6px; }
.tip.uploading { color: #e6a23c; }
</style>
