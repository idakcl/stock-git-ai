<template>
  <el-dialog v-model="visible" :title="title || '分享二维码'" width="360" append-to-body>
    <div class="qr-wrap">
      <img v-if="dataUrl" :src="dataUrl" alt="分享二维码" class="qr-img" />
      <div v-else class="qr-loading">二维码生成中…</div>
      <div class="qr-tip">用手机扫码即可查看（只读）</div>
      <el-input :model-value="url" readonly class="qr-url" />
    </div>
    <template #footer>
      <el-button @click="doCopy">复制链接</el-button>
      <el-button type="primary" @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import QRCode from 'qrcode'
import { ElMessage } from 'element-plus'
import { copyText } from '../utils/clipboard'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  url: { type: String, default: '' },
  title: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])
const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v)
})

const dataUrl = ref('')
let renderSeq = 0

async function render() {
  const seq = ++renderSeq
  if (!props.url) { dataUrl.value = ''; return }
  try {
    const url = await QRCode.toDataURL(props.url, { margin: 1, width: 240, errorCorrectionLevel: 'M' })
    if (seq === renderSeq) dataUrl.value = url
  } catch {
    if (seq === renderSeq) dataUrl.value = ''
  }
}

watch(() => props.modelValue, v => { if (v) render() })
watch(() => props.url, () => { if (props.modelValue) render() })

async function doCopy() {
  try {
    await copyText(props.url)
    ElMessage.success('链接已复制')
  } catch {
    ElMessage.error('复制失败，请长按链接手动复制')
  }
}
</script>

<style scoped>
.qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.qr-img { width: 240px; height: 240px; image-rendering: pixelated; border: 1px solid var(--border-color); border-radius: var(--radius-sm); }
.qr-loading { width: 240px; height: 240px; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); font-size: var(--fs-sub); border: 1px dashed var(--border-color); border-radius: var(--radius-sm); }
.qr-tip { color: var(--text-secondary); font-size: var(--fs-sub); }
.qr-url { width: 100%; }
</style>
