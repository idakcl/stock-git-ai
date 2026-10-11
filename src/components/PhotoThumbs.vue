<template>
  <div v-if="photos.length" class="photos">
    <el-image
      v-for="(u, i) in photos"
      :key="u + i"
      :src="u"
      :preview-src-list="photos"
      :initial-index="i"
      fit="cover"
      class="thumb"
      preview-teleported
    />
  </div>
  <span v-else class="none">—</span>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  value: { type: Array, default: () => [] }
})
// 兼容两种写法：value 数组直接是 URL，或是 {url} 对象
const photos = computed(() => (props.value || [])
  .map(v => (typeof v === 'string' ? v : (v && v.url)))
  .filter(Boolean))
</script>

<style scoped>
.photos { display: flex; gap: 8px; flex-wrap: wrap; }
.thumb {
  width: 64px;
  height: 64px;
  border-radius: 6px;
  border: 1px solid #e4e7ed;
  background: #f5f7fa;
  cursor: pointer;
}
.none { color: #c0c4cc; }
</style>
