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
        <AppMenu />
        <div class="build-info">构建 {{ buildTime }}</div>
      </el-aside>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
    <el-drawer v-model="drawer" direction="ltr" size="220px" :with-header="false">
      <div class="logo">进销存</div>
      <AppMenu @select="drawer = false" />
      <div class="build-info">构建 {{ buildTime }}</div>
    </el-drawer>
  </el-container>
</template>

<script setup>
import { ref } from 'vue'
import { Menu } from '@element-plus/icons-vue'
import AppMenu from './components/AppMenu.vue'

const drawer = ref(false)
const buildTime = __BUILD_TIME__
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
.aside { background: #fff; border-right: 1px solid #e4e7ed; overflow-y: auto; display: flex; flex-direction: column; }
.logo { height: 56px; line-height: 56px; text-align: center; font-size: 18px; font-weight: 700; color: #409eff; flex: none; }
.aside .menu { flex: 1; }
.build-info { padding: 10px 16px; color: #c0c4cc; font-size: 12px; border-top: 1px solid #f0f2f5; flex: none; }
.main { padding: 16px; overflow-y: auto; min-width: 0; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.stat-item { min-width: 0; }
.stat-item .el-statistic__head,
.stat-item .el-statistic__content { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.table-wrap { overflow-x: auto; }
.link { color: #409eff; cursor: pointer; text-decoration: none; }
.link:hover { text-decoration: underline; }

@media (max-width: 768px) {
  .desktop-only { display: none; }
  .header { display: flex; }
  .main { padding: 12px; }
  .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
