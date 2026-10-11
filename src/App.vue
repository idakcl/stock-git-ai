<template>
  <el-container class="layout">
    <el-aside width="220px" class="aside">
      <div class="logo">进销存</div>
      <el-menu :default-active="$route.path" router class="menu">
        <el-menu-item index="/"><el-icon><HomeFilled /></el-icon><span>看板</span></el-menu-item>
        <el-menu-item index="/items"><el-icon><Goods /></el-icon><span>商品</span></el-menu-item>
        <el-menu-item index="/suppliers"><el-icon><OfficeBuilding /></el-icon><span>供应商</span></el-menu-item>
        <el-menu-item index="/customers"><el-icon><User /></el-icon><span>客户</span></el-menu-item>
        <el-menu-item index="/purchases"><el-icon><Download /></el-icon><span>采购</span></el-menu-item>
        <el-menu-item index="/sales"><el-icon><Sell /></el-icon><span>销售</span></el-menu-item>
        <el-menu-item index="/stock"><el-icon><Box /></el-icon><span>库存</span></el-menu-item>
        <el-menu-item index="/report"><el-icon><DataAnalysis /></el-icon><span>报表</span></el-menu-item>
      </el-menu>
    </el-aside>
    <el-main class="main">
      <router-view />
    </el-main>
  </el-container>
</template>

<script setup>
import { HomeFilled, Goods, OfficeBuilding, User, Download, Sell, Box, DataAnalysis } from '@element-plus/icons-vue'
</script>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; }
.layout { height: 100vh; }
.aside { background: #fff; border-right: 1px solid #e4e7ed; }
.logo { height: 56px; line-height: 56px; text-align: center; font-size: 18px; font-weight: 700; color: #409eff; }
.menu { border-right: none; }
.main { padding: 20px; overflow-y: auto; }
</style>
