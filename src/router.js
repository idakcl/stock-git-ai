import { createRouter, createWebHistory } from 'vue-router'
import Dashboard from './views/Dashboard.vue'
import Items from './views/Items.vue'
import Suppliers from './views/Suppliers.vue'
import Customers from './views/Customers.vue'
import Purchases from './views/Purchases.vue'
import Sales from './views/Sales.vue'
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

const routes = [
  { path: '/', component: Dashboard },
  { path: '/items', component: Items },
  { path: '/suppliers', component: Suppliers },
  { path: '/supplier/:code', component: SupplierDetail },
  { path: '/customers', component: Customers },
  { path: '/customer/:code', component: CustomerDetail },
  { path: '/purchases', component: Purchases },
  { path: '/purchase/:id', component: PurchaseDetail },
  { path: '/sales', component: Sales },
  { path: '/sale/:id', component: SalesDetail },
  { path: '/stock', component: Stock },
  { path: '/report', component: Report },
  { path: '/receivables', component: Receivables },
  { path: '/payables', component: Payables },
  { path: '/data', component: DataManager },
  { path: '/clear', component: ClearData },
  { path: '/current', component: CurrentAccounts },
  { path: '/vouchers', component: Vouchers },
  { path: '/returns', component: () => import('./views/Returns.vue') }
]

export default createRouter({
  history: createWebHistory(),
  routes
})
