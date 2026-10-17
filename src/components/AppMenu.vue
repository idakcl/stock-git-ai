<template>
  <el-menu :default-active="$route.path" router class="menu" @select="$emit('select')">
    <el-menu-item-group title="经营">
      <el-menu-item index="/">
        <el-icon><HomeFilled /></el-icon>
        <span>看板</span>
      </el-menu-item>
      <el-menu-item index="/report">
        <el-icon><DataAnalysis /></el-icon>
        <span>报表</span>
      </el-menu-item>
    </el-menu-item-group>

    <el-menu-item-group title="资料">
      <el-menu-item index="/items">
        <el-icon><Goods /></el-icon>
        <span>商品</span>
      </el-menu-item>
      <el-menu-item index="/suppliers">
        <el-icon><OfficeBuilding /></el-icon>
        <span>供应商</span>
      </el-menu-item>
      <el-menu-item index="/customers">
        <el-icon><User /></el-icon>
        <span>客户</span>
      </el-menu-item>
    </el-menu-item-group>

    <el-menu-item-group title="业务">
      <el-menu-item index="/purchases">
        <el-icon><Download /></el-icon>
        <span>采购</span>
      </el-menu-item>
      <el-menu-item index="/sales">
        <el-icon><Sell /></el-icon>
        <span>销售</span>
      </el-menu-item>
      <el-menu-item index="/stock">
        <el-icon><Box /></el-icon>
        <span>库存</span>
      </el-menu-item>
    </el-menu-item-group>

    <el-sub-menu index="/funds">
      <template #title>
        <el-icon><Money /></el-icon>
        <span>资金</span>
      </template>
      <el-menu-item index="/receivables">
        <el-icon><Wallet /></el-icon>
        <span>应收款管理</span>
        <el-badge v-if="receivableOpen" :value="receivableOpen" type="danger" :max="99" class="menu-badge" />
      </el-menu-item>
      <el-menu-item index="/payables">
        <el-icon><CreditCard /></el-icon>
        <span>应付款管理</span>
        <el-badge v-if="payableOpen" :value="payableOpen" type="danger" :max="99" class="menu-badge" />
      </el-menu-item>
    </el-sub-menu>
  </el-menu>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import {
  HomeFilled, Goods, OfficeBuilding, User, Download, Sell, Box, DataAnalysis,
  Money, Wallet, CreditCard
} from '@element-plus/icons-vue'
import { api } from '../api'
import { receivableOf, payableOf } from '../utils/account'

defineEmits(['select'])

// 资金菜单角标：未收清 / 未付清的单据数（加载失败不影响菜单使用）
const receivableOpen = ref(0)
const payableOpen = ref(0)

onMounted(async () => {
  try {
    const [sales, purchases] = await Promise.all([api.getSales(), api.getPurchases()])
    receivableOpen.value = (sales || []).filter(s => receivableOf(s) > 0).length
    payableOpen.value = (purchases || []).filter(p => payableOf(p) > 0).length
  } catch (e) { /* 忽略：角标仅为提示 */ }
})
</script>

<style scoped>
.menu { border-right: none; }
.menu :deep(.el-menu-item-group__title) {
  font-size:var(--fs-sub);
  color:var(--text-disabled);
  padding: 10px 20px 4px;
  letter-spacing: 1px;
}
.menu :deep(.el-menu-item) {
  height: 44px;
  line-height: 44px;
  margin: 2px 8px;
  border-radius: 6px;
}
.menu :deep(.el-menu-item.is-active) {
  background:var(--bg-menu-active);
  color:var(--color-primary);
  font-weight: 600;
}
.menu :deep(.el-sub-menu__title) {
  height: 44px;
  line-height: 44px;
  margin: 2px 8px;
  border-radius: 6px;
}
.menu :deep(.el-sub-menu .el-menu-item) { padding-left: 44px !important; }
.menu-badge { margin-left: auto; }
</style>
