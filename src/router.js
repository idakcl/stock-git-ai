import { createRouter, createWebHistory } from 'vue-router'
import Dashboard from './views/Dashboard.vue'
import Items from './views/Items.vue'
import Suppliers from './views/Suppliers.vue'
import Customers from './views/Customers.vue'
import Purchases from './views/Purchases.vue'
import Sales from './views/Sales.vue'
import Stock from './views/Stock.vue'
import Report from './views/Report.vue'

const routes = [
  { path: '/', component: Dashboard },
  { path: '/items', component: Items },
  { path: '/suppliers', component: Suppliers },
  { path: '/customers', component: Customers },
  { path: '/purchases', component: Purchases },
  { path: '/sales', component: Sales },
  { path: '/stock', component: Stock },
  { path: '/report', component: Report }
]

export default createRouter({
  history: createWebHistory(),
  routes
})
