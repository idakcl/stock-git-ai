// 新页面开单（列表页 → 独立开单页）
//
// 为什么复用列表页组件而不是新写三个开单页面：
// 开单需要的整表数据、下一张单号的生成、「本地不是线上全量就不许提交整表」这条红线，
// 以及保存后的资金单据联动与预付款抵扣，全都长在列表页里。另写一份就是两套保存链路，
// 金额口径一旦漂移就是真金白银的错账。所以这里只做一件事：用路由 meta 标记「这是开单页」，
// 由列表页自己隐藏列表、把开单弹窗改成整页（standalone）显示。
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

// listPath：对应的列表路由（回到列表用 replace，避免「后退」又退回到一张已经保存过的开单页）
export function useEntryMode(listPath) {
  const route = useRoute()
  const router = useRouter()
  const entry = computed(() => !!route.meta.entry)

  // 列表页上的「新页面开单」按钮：同一个组件切到整页模式，地址栏是真实 URL，可以收藏/新标签打开
  function openEntryPage() {
    if (entry.value) return
    router.push(`${listPath}/new`)
  }

  // 整页模式下关掉表单（取消 / 保存成功）就回列表；普通弹窗模式不做任何事
  function backToList() {
    if (entry.value) router.replace(listPath)
  }

  return { entry, openEntryPage, backToList }
}
