// 新页面开单（列表页 → 独立开单页）
//
// 为什么复用列表页组件而不是新写三个开单页面：
// 开单需要的整表数据、下一张单号的生成、「本地不是线上全量就不许提交整表」这条红线，
// 以及保存后的资金单据联动与预付款抵扣，全都长在列表页里。另写一份就是两套保存链路，
// 金额口径一旦漂移就是真金白银的错账。所以这里只做一件事：用路由 meta 标记「这是开单页」，
// 由列表页自己隐藏列表、把开单弹窗改成整页（standalone）显示。
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

// listPath：对应的列表路由（回到列表用 replace，避免「后退」又退回到一张已经保存过的开单页）
export function useEntryMode(listPath) {
  const route = useRoute()
  const router = useRouter()
  const entry = computed(() => !!route.meta.entry)

  // 列表页上的「新页面开单」按钮：新开浏览器标签页，标签页里只有开单表单（无应用外壳）。
  // 当前标签页留在列表不动；若浏览器拦截弹出窗口，回退为同标签页跳转并提示用户。
  function openEntryPage() {
    if (entry.value) return
    const url = router.resolve(`${listPath}/new`).href
    const win = window.open(url, '_blank')
    if (!win) {
      // 弹出窗口被浏览器拦截，回退为同标签页跳转
      router.push(`${listPath}/new`)
      ElMessage.warning('浏览器拦截了新标签页，请允许弹出窗口')
    }
  }

  // 整页模式下关掉表单（取消 / 保存成功）就关闭当前标签页；
  // 脚本打开的标签页允许脚本关闭，关不掉（用户手动打开的标签页）就退回列表页。
  // 普通弹窗模式不做任何事。
  function backToList() {
    if (!entry.value) return
    try {
      window.close()
      if (!window.closed) {
        router.replace(listPath)
      }
    } catch {
      router.replace(listPath)
    }
  }

  return { entry, openEntryPage, backToList }
}
