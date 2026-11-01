// 草稿订单角标：侧边栏「订单」和顶部「开单」按钮共用一个计数。
// 口径固定为「全部未过账订单」（含已收订金的）：角标是提醒「还有单没处理完」，
// 不是「有多少张能删」。订单页「清空未过账订单」按钮数的是其中可直接作废的张数，
// 两个数字本来就不相等，界面上各自写明，避免被当成算错。
// 订单页 load() 成功后会直接把这份计数写成列表的实际张数：写操作（过账/作废/新建）
// 都走 load()，角标因此与列表同源、即时刷新，不需要再单独请求一次。
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
