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
      <!-- 订单排在最前：它是业务链的起点（先谈单、再收订金、过账后才生成采购/销售单） -->
      <el-menu-item index="/orders">
        <el-icon><Tickets /></el-icon>
        <span>订单</span>
        <span v-if="draftOrders" class="menu-badge warn">{{ badgeText(draftOrders) }}</span>
      </el-menu-item>
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
      <!-- 应付在前、应收在后：与「先付供应商、后收客户」的实际经营节奏一致（用户按用眼习惯要求对调） -->
      <el-menu-item index="/payables">
        <el-icon><CreditCard /></el-icon>
        <span>应付款管理</span>
        <span v-if="payableOpen" class="menu-badge">{{ badgeText(payableOpen) }}</span>
      </el-menu-item>
      <el-menu-item index="/receivables">
        <el-icon><Wallet /></el-icon>
        <span>应收款管理</span>
        <span v-if="receivableOpen" class="menu-badge">{{ badgeText(receivableOpen) }}</span>
      </el-menu-item>
      <el-menu-item index="/current">
        <el-icon><Postcard /></el-icon>
        <span>来往账</span>
      </el-menu-item>
      <el-menu-item index="/returns"><el-icon><Tickets /></el-icon><span>退货 / 退款</span></el-menu-item>
      <el-menu-item index="/vouchers">
        <el-icon><Tickets /></el-icon>
        <span>收付款单</span>
      </el-menu-item>
    </el-sub-menu>

    <el-menu-item-group title="系统">
      <el-menu-item index="/data">
        <el-icon><FolderOpened /></el-icon>
        <span>数据备份</span>
      </el-menu-item>
      <el-menu-item index="/clear">
        <el-icon><Delete /></el-icon>
        <span>清空数据</span>
      </el-menu-item>
    </el-menu-item-group>
  </el-menu>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import {
  HomeFilled, Goods, OfficeBuilding, User, Download, Sell, Box, DataAnalysis,
  Money, Wallet, CreditCard, FolderOpened, Delete, Postcard, Tickets
} from '@element-plus/icons-vue'
import { api } from '../api'
import { receivableOf, payableOf } from '../utils/account'
import { isUnposted } from '../utils/orders.js'

defineEmits(['select'])

// 资金菜单角标：未收清 / 未付清的单据数（加载失败不影响菜单使用）
const receivableOpen = ref(0)
const payableOpen = ref(0)
// 订单菜单角标：还没过账的草稿数（过账前不占库存、不进往来账，容易忘）
const draftOrders = ref(0)
// 角标文案：超过 99 显示 99+，与 el-badge 的 :max="99" 同一口径
const badgeText = n => (Number(n) > 99 ? '99+' : String(n))

onMounted(async () => {
  try {
    const [sales, purchases, orders] = await Promise.all([api.getSales(), api.getPurchases(), api.getOrders()])
    receivableOpen.value = (sales || []).filter(s => receivableOf(s) > 0).length
    payableOpen.value = (purchases || []).filter(p => payableOf(p) > 0).length
    draftOrders.value = (orders || []).filter(o => isUnposted(o.status)).length
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
/* 资金子项：左边缩进留给图标、右边收紧内边距——「应付款管理」这种五字标签加上角标后
   几乎占满抽屉菜单的可用宽度，右边留 20px 会把文字和角标挤到一起（间距 0px）。
   左边 30 + 右边 12 后，手机抽屉里还有 ~9px 空隙，图标也比上一级略深、层级看得出来。 */
.menu :deep(.el-sub-menu .el-menu-item) { padding-left: 30px !important; padding-right: 12px !important; }
/* 菜单角标：原先用 el-badge，但它是「默认插槽 + 绝对定位的 sup」结构——这里没有插槽内容，
   el-badge 本体就是个零高度盒子，sup 相对它 top:0 + translateY(-50%) 定位，在 flex 菜单项里
   会掉到文字下沿（手机上 3 颗像素的偏移就被看成一整行）。改成自己画一颗胶囊：
   垂直居中由 flex 的 align-items:center 保证，靠右由 margin-left:auto 保证。 */
.menu-badge {
  margin-left: auto;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--color-danger);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}
.menu-badge.warn { background: var(--color-warning); }

</style>
