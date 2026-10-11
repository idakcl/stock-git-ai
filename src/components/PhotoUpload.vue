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
      :on-exceed="onExceed"
      :on-success="onSuccess"
      :on-error="onError"
      :before-upload="beforeUpload"
    >
      <el-icon><Plus /></el-icon>
    </el-upload>
    <div v-if="!fileList.length" class="tip">可上传多张照片</div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'

const props = defineProps({
  // 已保存的照片 URL 数组
  modelValue: { type: Array, default: () => [] },
  limit: { type: Number, default: 9 }
})
const emit = defineEmits(['update:modelValue'])

const toList = (urls) => (urls || []).filter(Boolean).map(url => ({ name: url, url }))
const toUrls = (list) => (list || []).map(f => f.url).filter(Boolean)

const fileList = ref(toList(props.modelValue))

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
    return
  }
  file.url = url
  file.name = file.name || url
  fileList.value = files.map(f => ({ name: f.name, url: f.url }))
}

function onError(err) {
  ElMessage.error('上传失败：' + (err?.message || '请重试'))
}

function onExceed() {
  ElMessage.warning(`最多上传 ${props.limit} 张`)
}
</script>

<style scoped>
.photo-upload { width: 100%; }
.tip { color: #909399; font-size: 12px; margin-top: 6px; }
</style>
