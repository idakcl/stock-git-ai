// 明细表的可见高度：以前写死 320px（约 6 行），行多一点就得在小框里翻。
//
// 现在按视口高度分配：
//   · 普通弹窗    —— 视口的一半多一点（55%），常在 480~600px，能看 10 行上下；
//   · 最大化/整页 —— 扣掉标题与表单占位后几乎占满剩余高度。
// 监听 resize 重新计算，笔记本外接显示器、手机横竖屏切换都能跟上。
import { computed, onMounted, onUnmounted, ref } from 'vue'

export function useLinesMaxHeight(isLarge) {
  const vh = ref(typeof window === 'undefined' ? 900 : window.innerHeight)
  const onResize = () => { vh.value = window.innerHeight }
  onMounted(() => window.addEventListener('resize', onResize))
  onUnmounted(() => window.removeEventListener('resize', onResize))
  return computed(() => (
    isLarge.value
      ? Math.max(480, vh.value - 380)
      : Math.max(320, Math.round(vh.value * 0.55))
  ))
}
