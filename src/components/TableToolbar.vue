<template>
  <div class="export-bar">
    <slot />
    <el-button size="small" :disabled="!rows.length" @click="doExport">导出CSV</el-button>
    <!-- 只有一个打印按钮：纸张统一在右边的「打印设置」里选（A4 / A5 / 自定义 + 横纵向） -->
    <el-button size="small" :disabled="!rows.length" @click="doPrint()">打印</el-button>
    <PrintHeaderToggle />
  </div>
</template>

<script setup>
import { ElMessage } from 'element-plus'
import { downloadCSV, printA4 } from '../utils/export'
import { repeatHeaderPref } from '../utils/printPrefs'
import PrintHeaderToggle from './PrintHeaderToggle.vue'

const props = defineProps({
  // 导出文件名（不含扩展名）
  filename: { type: String, default: '导出' },
  // 打印标题
  title: { type: String, default: '导出' },
  // 副标题（一般放筛选条件）
  subtitle: { type: String, default: '' },
  // 列定义：[{ label:'名称', prop:'name' | value: row => xxx }]
  columns: { type: Array, default: () => [] },
  // 数据行（一般为当前筛选后的全部数据）
  rows: { type: Array, default: () => [] },
  // 打印专用列（可选）：不传就与 CSV 共用 columns；用于「打印时截断商品名」这类场景
  printColumns: { type: Array, default: null }
})

function doExport() {
  if (!props.columns.length) return ElMessage.warning('未定义导出列')
  downloadCSV(props.filename + '.csv', props.columns, props.rows)
  ElMessage.success(`已导出 ${props.rows.length} 行`)
}

function doPrint() {
  const cols = props.printColumns || props.columns
  if (!cols.length) return ElMessage.warning('未定义导出列')
  printA4(props.title, cols, props.rows, props.subtitle, [], [], '', repeatHeaderPref.value)
}
</script>

<style scoped>
.export-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
</style>
