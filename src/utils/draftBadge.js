// 草稿订单角标：侧边栏「订单」和顶部「开单」按钮共用一个计数。
//
// 两处都显示同一个数字，如果各自拉一次 /api/orders，每打开一页就多一次请求；
// 这里做一层缓存 + 并发去重：3 秒内的重复调用直接复用上一次的结果。
import { ref } from 'vue'
import { api } from '../api'
import { isUnposted } from './orders.js'

export const draftCount = ref(0)

let inflight = null
let at = 0

// force=true 用于写操作之后（过账、删除、开单保存），需要立刻刷新计数
export function refreshDraftCount(force = false) {
  if (!force && Date.now() - at < 3000) return inflight || Promise.resolve()
  at = Date.now()
  inflight = api.getOrders()
    .then(list => { draftCount.value = (list || []).filter(o => isUnposted(o.status)).length })
    .catch(() => { /* 角标失败不影响页面 */ })
    .finally(() => { inflight = null })
  return inflight
}
