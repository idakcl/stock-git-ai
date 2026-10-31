<template>
  <!-- 菜单分组口径：经营=看结果，业务=做单据，资金=对钱，资料=基础档案，对外=给出去的出口，系统=自己的配置。
       层级最多两层：手机抽屉只有 224px 宽，再深就点不动了。 -->
  <el-menu ref="menuRef" :default-active="$route.path" router class="menu" @select="$emit('select')">
    <el-menu-item-group title="经营">
      <el-menu-item index="/">
        <el-icon><HomeFilled /></el-icon>
        <span>看板</span>
      </el-menu-item>
      <el-menu-item index="/report">
        <el-icon><DataAnalysis /></el-icon>
        <span>报表</span>
      </el-menu-item>
      <!-- 库存是只读查询，和报表一样属于「看结果」，不放业务组里跟开单混排 -->
      <el-menu-item index="/stock">
        <el-icon><Box /></el-icon>
        <span>库存</span>
      </el-menu-item>
    </el-menu-item-group>

    <el-menu-item-group title="业务">
      <!-- 订单是业务链起点（先谈单、再收订金、过账后才生成采购/销售单）；模板是它的下属配置，
           所以收进子菜单而不是和订单平级。父级 index 用非路由值，避免和子项路径撞车。 -->
      <el-sub-menu index="/biz-orders">
        <template #title>
          <el-icon><Tickets /></el-icon>
          <span>订单</span>
          <span v-if="draftOrders" class="menu-badge warn">{{ badgeText(draftOrders) }}</span>
        </template>
        <el-menu-item index="/orders">全部订单</el-menu-item>
        <el-menu-item index="/templates">订单模板</el-menu-item>
      </el-sub-menu>
      <el-menu-item index="/purchases">
        <el-icon><Download /></el-icon>
        <span>采购</span>
      </el-menu-item>
      <el-menu-item index="/sales">
        <el-icon><Sell /></el-icon>
        <span>销售</span>
      </el-menu-item>
      <!-- 退货退款是逆向单据（默认退现金、可冲欠款），跟着正向单据走比塞进资金组更好理解 -->
      <el-menu-item index="/returns">
        <el-icon><RefreshLeft /></el-icon>
        <span>退货 / 退款</span>
      </el-menu-item>
    </el-menu-item-group>

    <el-menu-item-group title="资金">
      <!-- 应付在前、应收在后：与「先付供应商、后收客户」的实际经营节奏一致 -->
      <el-menu-item index="/payables">
        <el-icon><CreditCard /></el-icon>
        <span>应付款</span>
        <span v-if="payableOpen" class="menu-badge">{{ badgeText(payableOpen) }}</span>
      </el-menu-item>
      <el-menu-item index="/receivables">
        <el-icon><Wallet /></el-icon>
        <span>应收款</span>
        <span v-if="receivableOpen" class="menu-badge">{{ badgeText(receivableOpen) }}</span>
      </el-menu-item>
      <el-menu-item index="/current">
        <el-icon><Postcard /></el-icon>
        <span>来往账</span>
      </el-menu-item>
      <el-menu-item index="/vouchers">
        <el-icon><Money /></el-icon>
        <span>收付款单</span>
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

    <el-menu-item-group title="对外">
      <!-- 分享和密钥都是「把数据给出去」的出口，日后加 Webhook / 开放平台也落这一组 -->
      <el-menu-item index="/shares">
        <el-icon><Link /></el-icon>
        <span>外链分享</span>
      </el-menu-item>
      <el-menu-item index="/ai-api">
        <el-icon><Key /></el-icon>
        <span>AI-API</span>
      </el-menu-item>
    </el-menu-item-group>

    <el-menu-item-group title="系统">
      <el-menu-item index="/profile">
        <el-icon><UserFilled /></el-icon>
        <span>用户信息</span>
      </el-menu-item>
      <el-menu-item index="/data">
        <el-icon><FolderOpened /></el-icon>
        <span>数据备份</span>
      </el-menu-item>
      <!-- 破坏性操作必须一眼可辨：和「数据备份」挨着放（保险 vs 自毁），但用红色区分 -->
      <el-menu-item index="/clear" class="danger">
        <el-icon><Delete /></el-icon>
        <span>清空数据</span>
      </el-menu-item>
    </el-menu-item-group>
  </el-menu>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import {
  HomeFilled, Goods, OfficeBuilding, User, Download, Sell, Box, DataAnalysis,
  Money, Wallet, CreditCard, FolderOpened, Delete, Postcard, Tickets, UserFilled, Link, Key, RefreshLeft
} from '@element-plus/icons-vue'
import { api } from '../api'
import { receivableOf, payableOf } from '../utils/account'
import { isUnposted } from '../utils/orders.js'

defineEmits(['select'])

const route = useRoute()
const menuRef = ref(null)
// 订单子菜单的父级 index（不是路由路径，纯用作分组开关）
const ORDERS_MENU = '/biz-orders'

// 命中订单/模板路由时自动展开订单子菜单：default-active 只负责高亮，
// 从分享链接或刷新直接落到 /templates 时，折叠的父级会让子项「看不见」。
function syncOrdersMenu(path) {
  if (!menuRef.value || !path) return
  if (path === '/orders' || path.startsWith('/orders/') || path === '/templates') {
    menuRef.value.open(ORDERS_MENU)
  }
}
onMounted(() => syncOrdersMenu(route.path))
watch(() => route.path, p => syncOrdersMenu(p))

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
/* 订单子菜单：子项缩进一档，层级看得出来，右侧内边距收紧给角标和文字留空间 */
.menu :deep(.el-sub-menu .el-menu-item) { padding-left: 32px !important; padding-right: 14px !important; }
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
/* 清空数据：破坏性操作，红色文字 + 红色悬停，和相邻的「数据备份」拉开距离 */
.menu :deep(.el-menu-item.danger) { color: var(--color-danger); }
.menu :deep(.el-menu-item.danger .el-icon) { color: var(--color-danger); }
.menu :deep(.el-menu-item.danger:hover) { background: var(--bg-danger-weak, rgba(245, 108, 108, 0.1)); }
.menu :deep(.el-menu-item.danger.is-active) { color: var(--color-danger); background: rgba(245, 108, 108, 0.12); }
</style>
