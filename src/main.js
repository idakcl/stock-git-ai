import { createApp } from 'vue'
import ElementPlus from 'element-plus'
// 组件内置文案（确认框按钮、分页、日期选择器等）统一为中文，避免界面中英混排
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import App from './App.vue'
import router from './router'

createApp(App).use(router).use(ElementPlus, { locale: zhCn }).mount('#app')
