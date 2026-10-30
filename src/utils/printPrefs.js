// 打印偏好：跨页表头开关 + 纸张设置（A4/A5 横纵向、自定义纸张、每页行数）。
//
// 为什么放全局而不是各页面各自的 ref：打印是重复动作，这一单选了「不要跨页表头」，
// 下一单大概率还是同样的偏好；而且同一个页面里可能有多个打印入口（列表打印、
// 单张打印、批量详情打印），它们必须印出同一种版面，不能各说各话。
// 用 localStorage 记住，换页面、重开浏览器都还在。
import { reactive, ref, watch } from 'vue'

const KEY = 'stock.print.repeatHeader'
const PAPER_KEY = 'stock.print.paper'
// 读不到（隐私模式 / 首次使用）一律按默认值：跨页重复表头是更安全的默认，纸张跟随按钮（A4/A5）
const read = () => {
  try { return localStorage.getItem(KEY) !== '0' } catch { return true }
}

export const repeatHeaderPref = ref(read())

watch(repeatHeaderPref, (v) => {
  try { localStorage.setItem(KEY, v ? '1' : '0') } catch { /* 写不进去只影响记忆，不影响本次打印 */ }
})

// 纸张设置：
//   mode='preset'      跟随页面上的「打印(A4) / 打印(A5)」按钮，orientation 决定横/纵向
//   mode='custom'      自定义纸张（宽高单位 mm），按钮上的 A4/A5 不再区分，统一按自定义纸张出纸
//   rowsPerPage=0      每页行数按纸张高度自动推算；手动填 >0 时强制按该行数分片
//                       （遇到明细文字特别长、真机仍溢出时，把它调小即可，每页必定带表头）
const defaultPaper = () => ({ mode: 'preset', orientation: 'landscape', width: 210, height: 297, rowsPerPage: 0 })
const readPaper = () => {
  try {
    const raw = localStorage.getItem(PAPER_KEY)
    return raw ? { ...defaultPaper(), ...JSON.parse(raw) } : defaultPaper()
  } catch { return defaultPaper() }
}

export const paperPref = reactive(readPaper())

watch(paperPref, (v) => {
  try { localStorage.setItem(PAPER_KEY, JSON.stringify(v)) } catch { /* 同上，只影响记忆 */ }
}, { deep: true })

export function resetPaperPref() {
  Object.assign(paperPref, defaultPaper())
}
