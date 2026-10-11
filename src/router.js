import { createRouter, createWebHistory } from 'vue-router'
import Dashboard from './views/Dashboard.vue'
import Items from './views/Items.vue'
import Suppliers from './views/Suppliers.vue'
import Customers from './views/Customers.vue'
import Purchases from './views/Purchases.vue'
import Sales from './views/Sales.vue'
import Stock from './views/Stock.vue'
import Report from './views/Report.vue'
import SupplierDetail from './views/SupplierDetail.vue'
import PurchaseDetail from './views/PurchaseDetail.vue'
import SalesDetail from './views/SalesDetail.vue'

const routes = [
  { path: '/', component: Dashboard },
  { path: '/items', component: Items },
  { path: '/suppliers', component: Suppliers },
  { path: '/supplier/:code', component: SupplierDetail },
  { path: '/customers', component: Customers },
  { path: '/purchases', component: Purchases },
  { path: '/purchase/:id', component: PurchaseDetail },
  { path: '/sales', component: Sales },
  { path: '/sale/:id', component: SalesDetail },
  { path: '/stock', component: Stock },
  { path: '/report', component: Report }
]

export default createRouter({
  history: createWebHistory(),
  routes
})
