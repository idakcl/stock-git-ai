import { createRouter, createWebHistory } from 'vue-router'
import Dashboard from './views/Dashboard.vue'
import Items from './views/Items.vue'
import Suppliers from './views/Suppliers.vue'
import Customers from './views/Customers.vue'
import Purchases from './views/Purchases.vue'
import Sales from './views/Sales.vue'
import Orders from './views/Orders.vue'
import OrderDetail from './views/OrderDetail.vue'
import Stock from './views/Stock.vue'
import Report from './views/Report.vue'
import Receivables from './views/Receivables.vue'
import Payables from './views/Payables.vue'
import SupplierDetail from './views/SupplierDetail.vue'
import CustomerDetail from './views/CustomerDetail.vue'
import PurchaseDetail from './views/PurchaseDetail.vue'
import SalesDetail from './views/SalesDetail.vue'
import DataManager from './views/DataManager.vue'
import ClearData from './views/ClearData.vue'
import CurrentAccounts from './views/CurrentAccounts.vue'
import Vouchers from './views/Vouchers.vue'
import Returns from './views/Returns.vue'
import Profile from './views/Profile.vue'
import Shares from './views/Shares.vue'
import ShareView from './views/ShareView.vue'
import OrderTemplates from './views/OrderTemplates.vue'

const routes = [
  { path: '/', component: Dashboard },
  { path: '/items', component: Items },
  { path: '/suppliers', component: Suppliers },
  { path: '/supplier/:code', component: SupplierDetail },
  { path: '/customers', component: Customers },
  { path: '/customer/:code', component: CustomerDetail },
  { path: '/purchases', component: Purchases },
  // 新页面开单（meta.entry）：复用列表页组件，靠 meta 把列表隐藏、开单表单整页显示。
  // 复用而不是新写页面：开单要用的整表数据、单号生成、整表覆盖红线、资金单据联动都在列表页里，
  // 再写一套就是两份保存链路，金额口径漂移就是错账。
  { path: '/purchases/new', component: Purchases, meta: { entry: true } },
  { path: '/purchase/:id', component: PurchaseDetail },
  { path: '/sales', component: Sales },
  { path: '/sales/new', component: Sales, meta: { entry: true } },
  { path: '/sale/:id', component: SalesDetail },
  { path: '/orders', component: Orders },
  { path: '/orders/new', component: Orders, meta: { entry: true } },
  { path: '/order/:id', component: OrderDetail },
  { path: '/templates', component: OrderTemplates },
  { path: '/stock', component: Stock },
  { path: '/report', component: Report },
  { path: '/receivables', component: Receivables },
  { path: '/payables', component: Payables },
  { path: '/data', component: DataManager },
  { path: '/clear', component: ClearData },
  { path: '/current', component: CurrentAccounts },
  { path: '/vouchers', component: Vouchers },
  { path: '/returns', component: Returns },
  { path: '/profile', component: Profile },
  { path: '/shares', component: Shares },
  // 外链分享页：公开访问，不经过登录与后台布局（meta.public 由 App.vue 识别）
  { path: '/share/:token', component: ShareView, meta: { public: true } }
]

export default createRouter({
  history: createWebHistory(),
  routes
})
