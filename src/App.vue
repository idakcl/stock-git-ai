<template>
  <el-container class="layout">
    <el-header class="header">
      <el-button class="menu-btn" text @click="drawer = true">
        <el-icon :size="22"><Menu /></el-icon>
      </el-button>
      <div class="header-title">进销存</div>
    </el-header>
    <el-container class="body">
      <el-aside width="220px" class="aside desktop-only">
        <div class="logo">进销存</div>
        <el-menu :default-active="$route.path" router class="menu">
          <el-menu-item v-for="item in nav" :key="item.path" :index="item.path">
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
          </el-menu-item>
        </el-menu>
      </el-aside>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
    <el-drawer v-model="drawer" direction="ltr" size="220px" :with-header="false">
      <div class="logo">进销存</div>
      <el-menu :default-active="$route.path" router class="menu" @select="drawer = false">
        <el-menu-item v-for="item in nav" :key="item.path" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </el-menu-item>
      </el-menu>
    </el-drawer>
  </el-container>
</template>

<script setup>
import { ref } from 'vue'
import { Menu, HomeFilled, Goods, OfficeBuilding, User, Download, Sell, Box, DataAnalysis } from '@element-plus/icons-vue'

const drawer = ref(false)
const nav = [
  { path: '/', label: '看板', icon: HomeFilled },
  { path: '/items', label: '商品', icon: Goods },
  { path: '/suppliers', label: '供应商', icon: OfficeBuilding },
  { path: '/customers', label: '客户', icon: User },
  { path: '/purchases', label: '采购', icon: Download },
  { path: '/sales', label: '销售', icon: Sell },
  { path: '/stock', label: '库存', icon: Box },
  { path: '/report', label: '报表', icon: DataAnalysis }
]
</script>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app { height: 100%; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; }
.layout { height: 100%; flex-direction: column; }
.body { flex: 1; min-height: 0; }
.header {
  display: none;
  height: 48px;
  padding: 0 8px;
  align-items: center;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
}
.header-title { font-size: 16px; font-weight: 700; color: #409eff; }
.menu-btn { padding: 8px; }
.aside { background: #fff; border-right: 1px solid #e4e7ed; overflow-y: auto; }
.logo { height: 56px; line-height: 56px; text-align: center; font-size: 18px; font-weight: 700; color: #409eff; }
.menu { border-right: none; }
.main { padding: 16px; overflow-y: auto; min-width: 0; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.stat-item { min-width: 0; }
.stat-item .el-statistic__head,
.stat-item .el-statistic__content { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.table-wrap { overflow-x: auto; }

@media (max-width: 768px) {
  .desktop-only { display: none; }
  .header { display: flex; }
  .main { padding: 12px; }
  .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
