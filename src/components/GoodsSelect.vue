<template>
  <!-- 商品下拉：选项「展开过才渲染」。
       商品库上千条，而明细动辄几十行；若每行都挂全量 el-option，90 行就要渲染 14 万个组件，
       弹窗会卡死一两分钟——用户看到的就是「点编辑没反应」。
       收起时只留一个「当前值」的占位选项（保证显示的是商品名而不是编码），
       展开时才挂完整列表；收起即卸载，长时间开着弹窗也不会越用越慢。 -->
  <el-select
    :model-value="modelValue"
    filterable
    :allow-create="allowCreate"
    :default-first-option="firstOption || allowCreate"
    v-bind="$attrs"
    @update:model-value="v => emit('update:modelValue', v)"
    @change="v => emit('change', v)"
    @visible-change="onVisible"
  >
    <template v-if="opened">
      <el-option v-for="i in items" :key="i.code" :label="`${i.name} (${i.code})`" :value="i.code" />
    </template>
    <el-option v-else-if="modelValue" :label="labelOf(modelValue)" :value="modelValue" />
  </el-select>
</template>

<script setup>
import { ref } from 'vue'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  items: { type: Array, default: () => [] },
  // 允许输入新商品名（销售/采购单可直接建新品）；与 el-select 的 allow-create 同义
  allowCreate: { type: Boolean, default: false },
  // 回车直接选中第一个匹配项
  firstOption: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'change'])

const opened = ref(false)
const onVisible = (v) => { opened.value = v }
const labelOf = (code) => {
  const it = (props.items || []).find(i => i.code === code)
  return it ? `${it.name} (${it.code})` : code
}
</script>
