<template>
  <!-- 跨页表头开关：勾上＝明细按每页行数切片，每页顶部都重复商品表头；
       不勾＝整份明细一张连续的大表，表头只印在第一页。A4 / A5 都受这个开关控制。 -->
  <el-tooltip :content="tip" placement="top">
    <el-checkbox v-model="on" size="small" class="hdr-toggle">跨页表头</el-checkbox>
  </el-tooltip>
</template>

<script setup>
import { computed } from 'vue'
import { repeatHeaderPref } from '../utils/printPrefs'

const on = computed({
  get: () => repeatHeaderPref.value,
  set: (v) => { repeatHeaderPref.value = !!v }
})
const tip = computed(() => on.value
  ? '已开启：每页都重复商品表头（明细按每页 40 行 / A5 28 行切片）'
  : '已关闭：整份明细一张连续大表，表头只印在第一页')
</script>

<style scoped>
/* 与其它 small 按钮同高，避免在工具栏里把行高撑开 */
.hdr-toggle { height: 24px; line-height: 24px; margin-right: 0; }
</style>
