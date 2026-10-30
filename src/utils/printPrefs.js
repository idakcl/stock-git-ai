// 打印偏好：跨页表头开关。
//
// 为什么放全局而不是各页面各自的 ref：打印是重复动作，这一单选了「不要跨页表头」，
// 下一单大概率还是同样的偏好；而且同一个页面里可能有多个打印入口（列表打印、
// 单张打印、批量详情打印），它们必须印出同一种版面，不能各说各话。
// 用 localStorage 记住，换页面、重开浏览器都还在。
import { ref, watch } from 'vue'

const KEY = 'stock.print.repeatHeader'
// 读不到（隐私模式 / 首次使用）一律按默认值 true：跨页重复表头是更安全的默认
const read = () => {
  try { return localStorage.getItem(KEY) !== '0' } catch { return true }
}

export const repeatHeaderPref = ref(read())

watch(repeatHeaderPref, (v) => {
  try { localStorage.setItem(KEY, v ? '1' : '0') } catch { /* 写不进去只影响记忆，不影响本次打印 */ }
})
