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
        <div class="aside-footer">
          <div class="cn-clock" :title="'系统时区：北京时间（UTC+8）'">
            <span class="cn-clock-label">北京时间</span>
            <span class="cn-clock-time">{{ clock }}</span>
          </div>
          <div class="build-info">构建 {{ buildTime }}</div>
        </div>
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
      <div class="aside-footer">
        <div class="cn-clock" :title="'系统时区：北京时间（UTC+8）'">
          <span class="cn-clock-label">北京时间</span>
          <span class="cn-clock-time">{{ clock }}</span>
        </div>
        <div class="build-info">构建 {{ buildTime }}</div>
      </div>
    </el-drawer>
  </el-container>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { Menu, SwitchButton } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import AppMenu from './components/AppMenu.vue'
import Login from './views/Login.vue'
import { api, auth } from './api'
import { cnDateTime } from './utils/time.js'

const router = useRouter()

const drawer = ref(false)
const buildTime = __BUILD_TIME__
// 侧边栏左下角时钟：固定北京时间（UTC+8），不随设备时区变化
const clock = ref(cnDateTime())
let clockTimer = 0
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
// ---- 宽表自适应 ------------------------------------------------------------
// 取舍：
//   窄屏（手机/小平板，≤1024）——优先「页面左右对齐 + 能滑动看全列 + 不在表内上下拖动」：
//     表格在卡片内横滑，且不限高，随整页自然滚动；代价是横滑容器困住 sticky，窄屏表头不吸顶；
//   宽屏（笔记本/桌面）——保持整页滚动，sticky 列标题正常吸顶；
//     但列总宽仍超出容器时，同样启用卡片内横向滚动条查看
//     （否则表格会撑破页面右侧、内容被裁且整页出现横向滚动，笔记本上尤其明显）。
function syncTableScroll() {
  const narrow = window.innerWidth <= 1024
  document.querySelectorAll('.table-wrap').forEach((wrap) => {
    // 溢出检测：表格为 width:max-content，scrollWidth 会包含溢出部分的宽度
    const overflowing = wrap.scrollWidth > wrap.clientWidth + 1
    wrap.classList.toggle('is-scrollable', narrow || overflowing)
  })
}
let rafId = 0
function scheduleSync() {
  cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => setTimeout(syncTableScroll, 80))
}
let mo = null
function observeMain(retry = 0) {
  const main = document.querySelector('.main')
  if (!main) { if (retry < 20) setTimeout(() => observeMain(retry + 1), 100); return }
  // 列表数据渲染后宽度会变，用 MutationObserver 兜底重算（已做节流，不会频繁触发）
  mo = new MutationObserver(scheduleSync)
  mo.observe(main, { childList: true, subtree: true })
}

onMounted(() => {
  check()
  window.addEventListener('auth:expired', onExpired)
  window.addEventListener('resize', scheduleSync)
  window.addEventListener('orientationchange', scheduleSync)
  router.afterEach(() => nextTick(scheduleSync))
  observeMain()
  scheduleSync()
  clockTimer = setInterval(() => { clock.value = cnDateTime() }, 1000)
})
onUnmounted(() => {
  window.removeEventListener('auth:expired', onExpired)
  window.removeEventListener('resize', scheduleSync)
  window.removeEventListener('orientationchange', scheduleSync)
  cancelAnimationFrame(rafId)
  clearInterval(clockTimer)
  if (mo) mo.disconnect()
})

async function onLogout() {
  try {
    await ElMessageBox.confirm('确定退出登录？', '提示', { type: 'warning', confirmButtonText: '退出', cancelButtonText: '取消' })
  } catch { return }
  auth.clear()
  authed.value = false
}
</script>

<style>
/* ==================== 设计变量：全站唯一来源 ==================== */
:root {
  /* 字号五档：正文 14 / 表格 13 / 次要 12 / 辅助 11 / 标题 16 */
  --fs-base: 14px;
  --fs-table: 13px;
  --fs-sub: 12px;
  --fs-mini: 11px;
  --fs-title: 16px;
  --fs-display: 22px;
  /* 间距：4px 栅格 */
  --gap-xs: 4px;
  --gap-sm: 8px;
  --gap-md: 12px;
  --gap-lg: 16px;
  --gap-xl: 24px;
  /* 文字 */
  --text-primary: #303133;
  --text-regular: #606266;
  --text-secondary: #909399;
  --text-placeholder: #c0c4cc;
  --text-disabled: #a8abb2;
  /* 线条 / 背景 */
  --border-color:var(--border-color);
  --border-light: #f5f7fa;
  --bg-page: #f5f7fa;
  --bg-soft: #fafbfc;
  --bg-stat: #f8f9fb;
  --bg-hover: #f5f7fa;
  --bg-menu-active: #ecf5ff;
  /* 语义色 */
  --color-primary: #409eff;
  --color-success: #67c23a;
  --color-warning: #e6a23c;
  --color-danger: #f56c6c;
  --brand-gradient: linear-gradient(135deg, #409eff, #2f7fe0);
  /* 圆角 */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  /* 阴影 */
  --shadow-card: 0 1px 3px rgba(31, 45, 61, 0.04);
  /* 表格行高两档：主表 / 从属内表 */
  --td-pad: 10px;
  --td-pad-sm: 8px;
}

/* ==================== 全局基础 ==================== */
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

/* 滚动条统一（全站，含表格内与内容区） */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background:#dcdfe6;
  border-radius: 6px;
  border: 2px solid transparent;
  background-clip: content-box;
}
::-webkit-scrollbar-thumb:hover { background:var(--text-placeholder); background-clip: content-box; }

/* ==================== 布局 ==================== */
.layout { height: 100%; flex-direction: column; }
.body { flex: 1; min-height: 0; }

/* 顶栏：桌面/移动统一显示，承载系统名与退出登录 */
.header {
  height: 56px;
  padding: 0 var(--gap-md) 0 var(--gap-sm);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid var(--border-color);
  flex: none;
}
.header-title {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  font-size: var(--fs-title);
  font-weight: 700;
  color: var(--text-primary);
}
.logo-dot {
  width: 26px; height: 26px;
  border-radius: var(--radius-md);
  background: var(--brand-gradient);
  color: #fff;
  font-size:15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.header-right { display: flex; align-items: center; gap: 10px; }
.build-tag { color: var(--text-placeholder); font-size: var(--fs-sub); }
.logout-btn { color: var(--text-regular); }
.logout-btn:hover { color: var(--color-danger); }

/* 侧边栏 */
.aside {
  background: #fff;
  border-right: 1px solid var(--border-color);
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
  border-bottom: 1px solid var(--border-light);
}
.logo-mark {
  width: 32px; height: 32px;
  border-radius: 9px;
  background: var(--brand-gradient);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size:18px;
  font-weight: 700;
}
.logo-text { line-height: 1.2; }
.logo-title { font-size: var(--fs-title); font-weight: 700; color: var(--text-primary); }
.logo-sub { font-size: var(--fs-mini); color: var(--text-disabled); }
.aside .menu { flex: 1; }
.aside-footer { flex: none; margin-top: auto; }
.build-info { padding: 10px var(--gap-lg); color: var(--text-placeholder); font-size: var(--fs-sub); border-top: 1px solid var(--border-light); flex: none; }
/* 北京时间时钟：菜单左下角，等宽数字避免秒数跳动时抖动 */
.cn-clock {
  padding: 10px var(--gap-lg) 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  border-top: 1px solid var(--border-light);
  color: var(--text-regular);
  font-size: var(--fs-sub);
}
.cn-clock-label { color: var(--text-secondary); font-size: var(--fs-mini); }
.cn-clock-time { font-variant-numeric: tabular-nums; font-feature-settings: 'tnum'; letter-spacing: 0.2px; }
.el-drawer .aside-footer { margin-top: var(--gap-lg); }
.main { padding: var(--gap-lg); overflow-y: auto; min-width: 0; }
.menu-btn { padding: var(--gap-sm); }

/* ==================== 卡片 ==================== */
.el-card {
  border-radius: var(--radius-lg) !important;
  border: 1px solid var(--border-color) !important;
  box-shadow: var(--shadow-card) !important;
  /* 卡片默认是 overflow:hidden，会把内部表格的 sticky 表头「困」在卡片里而永不吸顶 */
  overflow: visible !important;
}
/* 卡片主体默认 overflow:auto 同理，必须一并解除；卡片内宽表改由 .main 横向滚动承接 */
.el-card__body { overflow: visible !important; padding: var(--gap-lg) !important; }
/* el-tabs 的内容区默认 overflow:hidden，会把卡片内表格的 sticky 表头「困」在 tab 里而永不吸顶 */
.el-tabs__content { overflow: visible !important; }
.el-card__header {
  padding: var(--gap-md) var(--gap-lg) !important;
  border-bottom: 1px solid var(--border-color) !important;
  font-size: var(--fs-title);
  font-weight: 600;
}
.el-card + .el-card { margin-top: var(--gap-lg); }
/* 卡片头部：标题居左、操作居右，全站唯一写法 */
.card-header { display: flex; justify-content: space-between; align-items: center; gap: var(--gap-sm); flex-wrap: wrap; }

/* ==================== 通用工具类 ==================== */
/* 筛选/工具行：同类页面结构统一，避免五套写法 */
.filter-row,
.tool-row { display: flex; align-items: center; gap: var(--gap-sm); flex-wrap: wrap; }
.filter-label { color: var(--text-regular); font-size: var(--fs-base); }
.filter-sep { color: var(--text-secondary); }
.section-title { font-size: var(--fs-title); font-weight: 600; }
.search-input { margin-bottom: var(--gap-md); max-width: 360px; }
.mt-md { margin-top: var(--gap-md); }
/* 空态：列表/卡片内统一的空数据提示，替代各页自造的写法 */
.empty { padding: var(--gap-xl) 0; text-align: center; color: var(--text-secondary); font-size: var(--fs-sub); }

/* 统计块：全站统一栅格与卡片；卡片内已统一间距的页面不再重复声明 */
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--gap-md); }
.stat-item { padding: var(--gap-md) var(--gap-lg); background: var(--bg-stat); border-radius: var(--radius-md); min-width: 0; }
.stat-item .el-statistic__head,
.stat-item .el-statistic__content { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-sub { margin-top: var(--gap-xs); color: var(--text-secondary); font-size: var(--fs-sub); }

/* ==================== Element Plus 组件规格统一 ==================== */
/* 按钮：圆角统一；字号按尺寸档位（字号仍需覆盖，EP 默认按钮偏大） */
.el-button { border-radius: var(--radius-sm) !important; font-size: var(--fs-base); }
.el-button--small { font-size: var(--fs-sub); }
.el-button--large { font-size: var(--fs-base); }

/* ==================== 方块语义：状态=空心，可点=实心 ====================
   全站只有两种「方块」，一眼能分清能不能按：
     ① 只表示状态/类别（不可点）→ 白底 + 同色描边 + 同色字（空心）
     ② 可以点击（按钮、开关）→ 同色实心填充 + 白字（文字像镂空）
   色相一律沿用上面已定义的语义色，不新增颜色；禁用态按「不可点」归到 ①。 */

/* ① 状态标签：el-tag 全站只做状态与类别展示，一律白底空心 */
.el-tag { background-color: #fff !important; }

/* ② 可点按钮：Element 的 plain / text / link 默认是空心，统一改成与实心按钮同一套配色 */
.el-button--primary.is-plain, .el-button--primary.is-text, .el-button--primary.is-link {
  --el-button-text-color:#fff; --el-button-bg-color:var(--el-color-primary); --el-button-border-color:var(--el-color-primary);
  --el-button-hover-text-color:#fff; --el-button-hover-bg-color:var(--el-color-primary-light-3); --el-button-hover-border-color:var(--el-color-primary-light-3);
  --el-button-active-text-color:#fff; --el-button-active-bg-color:var(--el-color-primary-dark-2); --el-button-active-border-color:var(--el-color-primary-dark-2);
}
.el-button--success.is-plain, .el-button--success.is-text, .el-button--success.is-link {
  --el-button-text-color:#fff; --el-button-bg-color:var(--el-color-success); --el-button-border-color:var(--el-color-success);
  --el-button-hover-text-color:#fff; --el-button-hover-bg-color:var(--el-color-success-light-3); --el-button-hover-border-color:var(--el-color-success-light-3);
  --el-button-active-text-color:#fff; --el-button-active-bg-color:var(--el-color-success-dark-2); --el-button-active-border-color:var(--el-color-success-dark-2);
}
.el-button--warning.is-plain, .el-button--warning.is-text, .el-button--warning.is-link {
  --el-button-text-color:#fff; --el-button-bg-color:var(--el-color-warning); --el-button-border-color:var(--el-color-warning);
  --el-button-hover-text-color:#fff; --el-button-hover-bg-color:var(--el-color-warning-light-3); --el-button-hover-border-color:var(--el-color-warning-light-3);
  --el-button-active-text-color:#fff; --el-button-active-bg-color:var(--el-color-warning-dark-2); --el-button-active-border-color:var(--el-color-warning-dark-2);
}
.el-button--danger.is-plain, .el-button--danger.is-text, .el-button--danger.is-link {
  --el-button-text-color:#fff; --el-button-bg-color:var(--el-color-danger); --el-button-border-color:var(--el-color-danger);
  --el-button-hover-text-color:#fff; --el-button-hover-bg-color:var(--el-color-danger-light-3); --el-button-hover-border-color:var(--el-color-danger-light-3);
  --el-button-active-text-color:#fff; --el-button-active-bg-color:var(--el-color-danger-dark-2); --el-button-active-border-color:var(--el-color-danger-dark-2);
}
.el-button--info.is-plain, .el-button--info.is-text, .el-button--info.is-link {
  --el-button-text-color:#fff; --el-button-bg-color:var(--el-color-info); --el-button-border-color:var(--el-color-info);
  --el-button-hover-text-color:#fff; --el-button-hover-bg-color:var(--el-color-info-light-3); --el-button-hover-border-color:var(--el-color-info-light-3);
  --el-button-active-text-color:#fff; --el-button-active-bg-color:var(--el-color-info-dark-2); --el-button-active-border-color:var(--el-color-info-dark-2);
}
/* 未指定 type 的中性按钮：底与字取文字灰阶（#606266 上白字对比度达标），与 info 的浅灰区分主次 */
.el-button:not(.el-button--primary):not(.el-button--success):not(.el-button--warning):not(.el-button--danger):not(.el-button--info) {
  --el-button-text-color:#fff; --el-button-bg-color:var(--text-regular); --el-button-border-color:var(--text-regular);
  --el-button-hover-text-color:#fff; --el-button-hover-bg-color:var(--text-primary); --el-button-hover-border-color:var(--text-primary);
  --el-button-active-text-color:#fff; --el-button-active-bg-color:var(--text-primary); --el-button-active-border-color:var(--text-primary);
}
/* text / link 被 Element 重置成无边框透明底小字，这里显式补上实心底与描边，并恢复三档尺寸 */
.el-button.is-text, .el-button.is-link {
  background-color: var(--el-button-bg-color);
  border-width: 1px; border-style: solid; border-color: var(--el-button-border-color);
  padding: 8px 15px; height: 32px;
}
.el-button.is-text.el-button--small, .el-button.is-link.el-button--small { padding: 5px 11px; height: 24px; }
.el-button.is-text.el-button--large, .el-button.is-link.el-button--large { padding: 12px 19px; height: 40px; }
.el-button.is-text:hover:not(.is-disabled), .el-button.is-link:hover:not(.is-disabled) {
  background-color: var(--el-button-hover-bg-color); border-color: var(--el-button-hover-border-color); color: var(--el-button-hover-text-color);
}
.el-button.is-text:active:not(.is-disabled), .el-button.is-link:active:not(.is-disabled) {
  background-color: var(--el-button-active-bg-color); border-color: var(--el-button-active-border-color); color: var(--el-button-active-text-color);
}
/* 禁用＝不可点：不论原来什么色，一律白底空心灰字 */
.el-button.is-disabled, .el-button:disabled {
  background-color:#fff !important; border-color:var(--border-color) !important; color:var(--text-disabled) !important;
}
/* 输入类控件圆角 */
.el-input__wrapper,
.el-select__wrapper,
.el-textarea__inner { border-radius: var(--radius-sm) !important; }
.el-input__inner, .el-select__placeholder { font-size: var(--fs-base); }
.el-input--small .el-input__inner { font-size: var(--fs-sub); }
/* 标签 */
.el-tag { border-radius: 4px; font-size: var(--fs-sub); border-radius: var(--radius-sm); }
/* 分页 */
.el-pagination { font-size: var(--fs-table); }
/* 弹窗 */
.el-dialog { border-radius: var(--radius-lg) !important; }
/* 弹窗宽度自适应：各弹窗写死的 width（420~660px）在手机上会左右溢出屏幕，
   用 max-width 统一钳制在视口内（max-width 天然优先于 width），桌面端不受影响 */
.el-dialog { max-width: 94vw; }
/* 列表操作列（ops-col）：按钮收紧间距并强制单行，删除与照片同排不换行 */
.el-table .ops-col .cell { white-space: nowrap; }
/* 单据号列（id-col）：退货单号形如 XT-20261028-0001，允许在连字符处折行会把单号拆成两行，
   这里强制单行不折行，编号始终完整显示在一行内 */
.el-table .id-col .cell { white-space: nowrap; word-break: keep-all; }
.el-table .ops-col .el-button + .el-button { margin-left: 6px; }
.el-dialog__title { font-size: var(--fs-title); font-weight: 600; }
.el-dialog__headerbtn { top: 10px; }
/* 下拉/日期面板 */
.el-picker__popper, .el-select-dropdown { border-radius: var(--radius-md) !important; }
/* 消息提示 */
.el-message { border-radius: var(--radius-sm); }

/* ==================== 表格 ==================== */
/* 列标题吸顶：整页滚动时固定在内容区顶部（顶栏正下方）。
   前提：必须解除 EP 自带的 .el-table / .el-table__body-wrapper 的 overflow:hidden 与 .el-table 的
   max-width:100% 限制——否则 sticky 会被「困」在 .el-table 这个自身不滚动的盒子里而永不触发。
   已实测：滚动 400px / 1200px 后，表头相对滚动容器顶部恒为 0，稳定吸顶。 */
.table-wrap { overflow: visible; }
.table-wrap > .el-table { overflow: visible; max-width: none; width: max-content; min-width: 100%; }
.table-wrap .el-table__inner-wrapper,
.table-wrap .el-table__body-wrapper { overflow: visible; }
/* top 取负值抵消 .main 的 padding，使表头正好停在顶栏下沿而不露出缝隙 */
.table-wrap .el-table__header-wrapper { position: sticky; top: -16px; z-index: 4; box-shadow: 0 1px 0 var(--border-color); }
/* 表格放不下时（窄屏或列总宽超出容器时由 JS 自动加上 is-scrollable）：
   在卡片内横向滑动看全列，避免整页被宽表撑出横向滚动区（页面左右被裁、手机上拖不动）。
   不限高：表格随整页自然滚动，不在表格内部制造小滚动区（手机上不用在表内上下拖动）；
   代价是横滑容器会困住 sticky，宽屏表格溢出时表头不吸顶——窄屏同理，桌面不溢出时照常吸顶。 */
.table-wrap.is-scrollable { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: thin; scrollbar-color: var(--border-color) transparent; }
.table-wrap.is-scrollable::-webkit-scrollbar { height: 6px; }
.table-wrap.is-scrollable::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 3px; }
.table-wrap.is-scrollable .el-table__header-wrapper { position: static; box-shadow: none; }

/* 表格统一：无论各页是否单独写了 size="small"，字号与行高都收敛到同一档 */
.el-table { font-size: var(--fs-table); }
.el-table th.el-table__cell {
  padding: var(--td-pad) 0;
  background: var(--bg-soft) !important;
  color: var(--text-regular);
  font-weight: 600;
  font-size: var(--fs-table);
  white-space: nowrap;
}
.el-table td.el-table__cell { padding: var(--td-pad) 0; }
.el-table .cell { line-height: 1.5; }
/* 斑马纹与悬浮态统一到同一色阶 */
.el-table--striped .el-table__body tr.el-table__row--striped td.el-table__cell { background: var(--bg-soft); }
.el-table__body tr:hover > td.el-table__cell { background: var(--bg-hover) !important; }
/* 空态 */
.el-table__empty-text { color: var(--text-secondary); font-size: var(--fs-sub); }
.el-empty__description { font-size: var(--fs-sub); color: var(--text-secondary); }

.link { color: var(--color-primary); cursor: pointer; text-decoration: none; }
.link:hover { text-decoration: underline; }
/* 退款单（销售 XT- / 采购 CT-）单号全局红字：列表、详情、往来账、资金单据明细统一生效 */
.return-code { color: var(--color-danger) !important; font-weight: 600; }

@media (max-width: 768px) {
  .desktop-only { display: none; }
  .main { padding: var(--gap-md); }
  /* 统计块在窄/矮屏排两列 */
  .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .build-tag { display: none; }
}
@media (min-width: 769px) {
  .menu-btn { display: none; }
  .header { padding-left: 20px; }
}
</style>
