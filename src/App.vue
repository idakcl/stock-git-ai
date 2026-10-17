<template>
  <!-- 未登录：只显示登录页，不渲染业务数据 -->
  <Login v-if="!authed" @success="authed = true" />

  <!-- 已登录：主界面 -->
  <el-container v-else class="layout">
    <el-header class="header">
      <el-button class="menu-btn" text @click="drawer = true">
        <el-icon :size="22"><Menu /></el-icon>
      </el-button>
      <div class="header-title">
        <span class="logo-dot">进</span>进销存
      </div>
      <div class="header-right">
        <span class="build-tag">构建 {{ buildTime }}</span>
        <el-button text class="logout-btn" @click="onLogout">
          <el-icon><SwitchButton /></el-icon>
          <span class="logout-text">退出登录</span>
        </el-button>
      </div>
    </el-header>
    <el-container class="body">
      <el-aside width="224px" class="aside desktop-only">
        <div class="logo">
          <span class="logo-mark">进</span>
          <div class="logo-text">
            <div class="logo-title">进销存</div>
            <div class="logo-sub">管理系统</div>
          </div>
        </div>
        <AppMenu />
        <div class="build-info">构建 {{ buildTime }}</div>
      </el-aside>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
    <el-drawer v-model="drawer" direction="ltr" size="224px" :with-header="false">
      <div class="logo">
        <span class="logo-mark">进</span>
        <div class="logo-text">
          <div class="logo-title">进销存</div>
          <div class="logo-sub">管理系统</div>
        </div>
      </div>
      <AppMenu @select="drawer = false" />
      <div class="build-info">构建 {{ buildTime }}</div>
    </el-drawer>
  </el-container>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { Menu, SwitchButton } from '@element-plus/icons-vue'
import AppMenu from './components/AppMenu.vue'
import Login from './views/Login.vue'
import { api, auth } from './api'

const drawer = ref(false)
const buildTime = __BUILD_TIME__
// 有票据不等于有效：启动时调 /session 自检一次
const authed = ref(false)

async function check() {
  if (!auth.get()) { authed.value = false; return }
  try {
    const r = await api.verify()
    authed.value = !!r.ok
  } catch (e) {
    authed.value = false
  }
}

// 任何接口返回 401（会话过期）都会广播此事件
function onExpired() {
  authed.value = false
  ElMessage.warning('登录已过期，请重新登录')
}
onMounted(() => {
  check()
  window.addEventListener('auth:expired', onExpired)
})
onUnmounted(() => window.removeEventListener('auth:expired', onExpired))

async function onLogout() {
  try {
    await ElMessageBox.confirm('确定退出登录？', '提示', { type: 'warning', confirmButtonText: '退出', cancelButtonText: '取消' })
  } catch { return }
  auth.clear()
  authed.value = false
}
</script>

<style>
/* ---------- 设计变量：全站字体/间距/配色的唯一来源 ---------- */
:root {
  /* 字号四档：正文 14 / 表格 13 / 次要 12 / 辅助 11（不再出现零散数值） */
  --fs-base: 14px;
  --fs-table: 13px;
  --fs-sub: 12px;
  --fs-mini: 11px;
  /* 间距：4px 栅格 */
  --gap-xs: 4px;
  --gap-sm: 8px;
  --gap-md: 12px;
  --gap-lg: 16px;
  --gap-xl: 24px;
  /* 文字 / 线条 / 背景 */
  --text-primary: #303133;
  --text-regular: #606266;
  --text-secondary: #909399;
  --text-placeholder: #c0c4cc;
  --border-color: #ebeef5;
  --bg-page: #f5f7fa;
  --bg-soft: #fafbfc;
}

/* ---------- 全局基础 ---------- */
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app { height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', Roboto, sans-serif;
  background: var(--bg-page);
  color: var(--text-primary);
  font-size: var(--fs-base);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* ---------- 布局 ---------- */
.layout { height: 100%; flex-direction: column; }
.body { flex: 1; min-height: 0; }

/* 顶栏：桌面/移动统一显示，承载系统名与退出登录 */
.header {
  height: 56px;
  padding: 0 12px 0 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid #ebeef5;
  flex: none;
}
.header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 700;
  color: #303133;
}
.logo-dot {
  width: 26px; height: 26px;
  border-radius: 8px;
  background: linear-gradient(135deg, #409eff, #2f7fe0);
  color: #fff;
  font-size: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.header-right { display: flex; align-items: center; gap: 10px; }
.build-tag { color: #c0c4cc; font-size: 12px; }
.logout-btn { color: #606266; }
.logout-btn:hover { color: #f56c6c; }

/* 侧边栏 */
.aside {
  background: #fff;
  border-right: 1px solid #ebeef5;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.logo {
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex: none;
  border-bottom: 1px solid #f5f7fa;
}
.logo-mark {
  width: 32px; height: 32px;
  border-radius: 9px;
  background: linear-gradient(135deg, #409eff, #2f7fe0);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 700;
}
.logo-text { line-height: 1.2; }
.logo-title { font-size: 16px; font-weight: 700; color: #303133; }
.logo-sub { font-size: 11px; color: #a8abb2; }
.aside .menu { flex: 1; }
.build-info { padding: 10px 16px; color: #c0c4cc; font-size: 12px; border-top: 1px solid #f5f7fa; flex: none; }
.main { padding: 16px; overflow-y: auto; min-width: 0; }
.menu-btn { padding: 8px; }

/* ---------- 统一风格：卡片 / 统计块 / 表格 / 链接 ---------- */
.el-card {
  border-radius: 10px !important;
  border: 1px solid #ebeef5 !important;
  box-shadow: 0 1px 3px rgba(31, 45, 61, 0.04) !important;
  /* 卡片默认是 overflow:hidden，会把内部表格的 sticky 表头「困」在卡片里而永不吸顶 */
  overflow: visible !important;
}
/* 卡片主体默认 overflow:auto 同理，必须一并解除；卡片内宽表改由 .main 横向滚动承接 */
.el-card__body { overflow: visible !important; }
.el-card + .el-card { margin-top: var(--gap-lg); }
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }

.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat-item { padding: 12px 16px; background: #f8f9fb; border-radius: 8px; min-width: 0; }
.stat-item .el-statistic__head,
.stat-item .el-statistic__content { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-sub { margin-top: 4px; color: #909399; font-size: 12px; }

/* ---------- 表格列标题吸顶（整页滚动时固定在内容区顶部，即顶栏正下方）---------- */
/* 前提：必须解除 EP 自带的 .el-table / .el-table__body-wrapper 的 overflow:hidden 与 .el-table 的
   max-width:100% 限制——否则 sticky 会被「困」在 .el-table 这个自身不滚动的盒子里而永不触发。
   解法已实测：滚动 400px / 1200px 后，表头相对滚动容器顶部恒为 0，稳定吸顶。 */
.table-wrap { overflow: visible; }
.table-wrap > .el-table { overflow: visible; max-width: none; width: max-content; min-width: 100%; }
.table-wrap .el-table__inner-wrapper,
.table-wrap .el-table__body-wrapper { overflow: visible; }
/* top 取负值抵消 .main 的 padding，使表头正好停在顶栏下沿而不露出缝隙 */
.table-wrap .el-table__header-wrapper { position: sticky; top: -16px; z-index: 4; box-shadow: 0 1px 0 var(--border-color); }
/* 表格统一：无论各页是否单独写了 size="small"，行高与字号都收敛到同一档 */
.el-table { font-size: var(--fs-table); }
.el-table td.el-table__cell { padding: 10px 0; }
.el-table th.el-table__cell { background: var(--bg-soft) !important; color: var(--text-regular); font-weight: 600; font-size: var(--fs-table); }
.el-table .cell { line-height: 1.5; }

.link { color: #409eff; cursor: pointer; text-decoration: none; }
.link:hover { text-decoration: underline; }

@media (max-width: 768px) {
  .desktop-only { display: none; }
  .main { padding: 12px; }
  .table-wrap .el-table__header-wrapper { top: -12px; }
  .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .build-tag { display: none; }
}
@media (min-width: 769px) {
  .menu-btn { display: none; }
  .header { padding-left: 20px; }
}
</style>
