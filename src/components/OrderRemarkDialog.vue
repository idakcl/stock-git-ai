<template>
  <!-- 轻量备注弹窗：只改本单 remark 一个字段，单号/金额/明细/收付款一律不碰 -->
  <el-dialog
    :model-value="modelValue"
    :title="`备注 · ${order?.id || ''}`"
    width="520"
    @update:model-value="v => emit('update:modelValue', v)"
  >
    <template v-if="modelValue">
      <el-input v-model="text" type="textarea" :rows="4"
        :placeholder="placeholder" @keyup.ctrl.enter="save" />
      <div class="dlg-tip">仅更新本单备注，保存后单号、金额、明细、收付款记录均不受影响；清空内容再保存即删除备注。按 Ctrl+Enter 可直接保存。</div>
    </template>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="save">保存备注</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  // 弹窗是否打开
  modelValue: { type: Boolean, default: false },
  // 目标单据（取 id 展示标题、remark 作初始值）
  order: { type: Object, default: null },
  placeholder: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'saved'])

const text = ref('')
// 每次打开都重新取当前单据的备注：不能留着上一张单的文本被误存到本单
watch(() => props.modelValue, (v) => { if (v) text.value = props.order?.remark || '' })

function save() { emit('saved', text.value.trim()) }
</script>

<style scoped>
.dlg-tip { color:var(--text-secondary); font-size:var(--fs-sub); line-height: 1.6; margin-top: 4px; }
</style>
