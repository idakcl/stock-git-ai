<template>
  <!-- 最大化 / 还原：对角线双箭头（向外的四条边各带一个箭头）。
       Element Plus 自带图标里没有这种形状（FullScreen 是四角框、ScaleToOriginal 是缩小符号），
       所以这里用内联 SVG；跟着 currentColor 走，颜色随按钮状态变化 -->
  <svg class="max-icon" viewBox="0 0 24 24" width="15" height="15" fill="none"
    stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="!restore">
      <path d="M9 3H3v6" />
      <path d="M3 3l7 7" />
      <path d="M15 21h6v-6" />
      <path d="M21 21l-7-7" />
    </template>
    <template v-else>
      <path d="M10 20v-6H4" />
      <path d="M3 21l7-7" />
      <path d="M14 4v6h6" />
      <path d="M21 3l-7 7" />
    </template>
  </svg>
</template>

<script setup>
defineProps({ restore: { type: Boolean, default: false } })
</script>

<style scoped>
.max-icon { display: block; }
</style>
