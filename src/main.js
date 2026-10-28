import { createApp } from 'vue'
import ElementPlus from 'element-plus'
// 组件内置文案（确认框按钮、分页、日期选择器等）统一为中文，避免界面中英混排
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import App from './App.vue'
import router from './router'

const app = createApp(App)

// 金额/数量输入框聚焦即全选：点击后直接输入，无需先删除原值（采购单/销售单共用）
const selectOnFocus = {
  mounted(el) {
    const handler = (e) => {
      const t = e.target
      if (t && t.tagName === 'INPUT' && typeof t.select === 'function') {
        // 延迟到浏览器完成默认聚焦行为后再全选，避免被光标定位覆盖
        setTimeout(() => t.select(), 0)
      }
    }
    // 捕获阶段监听：el-input-number / el-input 的内部 <input> 聚焦时，事件在冒泡到容器前被捕获
    el.addEventListener('focus', handler, true)
    el._selectOnFocusHandler = handler
  },
  unmounted(el) {
    if (el._selectOnFocusHandler) el.removeEventListener('focus', el._selectOnFocusHandler, true)
  }
}
app.directive('select-on-focus', selectOnFocus)

app.use(router).use(ElementPlus, { locale: zhCn }).mount('#app')
