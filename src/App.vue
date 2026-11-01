<template>
  <!-- 公开页面（外链分享）：不需要登录，也不渲染后台菜单与布局 -->
  <router-view v-if="isPublic" />

  <!-- 未登录：只显示登录页，不渲染业务数据 -->
  <Login v-else-if="!authed" @success="authed = true" />

  <!-- 独立开单标签页（meta.standalone）：新开浏览器标签页只渲染开单表单，不渲染应用外壳。
       必须排在登录检查之后：票据过期时这个标签页也要能落到登录页，
       否则用户只会对着一个提交不出去的空白开单窗。 -->
  <div v-else-if="isStandalone" class="standalone">
    <router-view />
  </div>

  <!-- 已登录：主界面 -->
  <el-container v-else class="layout">
    <el-header class="header">
      <el-button class="menu-btn" text aria-label="打开导航菜单" @click="drawer = true">
        <el-icon :size="22"><Menu /></el-icon>
      </el-button>
      <div class="header-right">
        <!-- 全局开单入口：订单用得最频繁，任何页面都能一步开单；角标是待过账的草稿数 -->
        <el-button class="quick-new" type="primary" aria-label="快速开单" @click="quickNewOrder"
          :title="draftCount ? `${draftCount} 张订单还没过账` : '新建订单'">
          <el-icon><Plus /></el-icon>
          <span class="quick-new-text">开单</span>
          <span v-if="draftCount" class="quick-new-badge">{{ draftCount > 99 ? '99+' : draftCount }}</span>
        </el-button>
        <el-button text class="logout-btn" aria-label="退出登录" @click="onLogout">
          <el-icon><SwitchButton /></el-icon>
          <span class="logout-text">退出</span>
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
          <div class="build-info">构建 {{ buildStamp }}</div>
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
        <div class="build-info">构建 {{ buildStamp }}</div>
      </div>
    </el-drawer>
  </el-container>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { Menu, SwitchButton, Plus } from '@element-plus/icons-vue'
import { useRouter, useRoute } from 'vue-router'
import AppMenu from './components/AppMenu.vue'
import Login from './views/Login.vue'
import { api, auth } from './api'
import { cnDateTime } from './utils/time.js'
import { draftCount, refreshDraftCount } from './utils/draftBadge.js'

const router = useRouter()
const route = useRoute()
// 公开页面（meta.public）：外链分享页不登录也能看，不能渲染后台布局
const isPublic = computed(() => !!route.meta.public)
// 独立开单标签页（meta.standalone）：新开标签页只渲染开单表单，跳过登录检查与应用外壳
const isStandalone = computed(() => !!route.meta.standalone)

const drawer = ref(false)
// 左下角版本标识：由 vite.config.js 注入「短 sha · 提交时间」，同一提交重复构建字节一致
const buildStamp = __BUILD_TIME__
// 侧边栏左下角时钟：固定北京时间（UTC+8），不随设备时区变化
const clock = ref(cnDateTime())
let clockTimer = 0
// 有票据不等于有效：启动时调 /session 自检一次
const authed = ref(false)
// 登录成功后补一次角标：首访时没票不请求，不补的话要等下一次路由跳转才显示草稿数（M22）
watch(authed, v => { if (v) refreshDraftCount(true) })

async function check() {
  // 公开页面不需要会话自检：带着过期票据去调 /session 只会触发一次无意义的「登录已过期」提示
  if (isPublic.value) return
  if (!auth.get()) { authed.value = false; return }
  try {
    const r = await api.verify()
    authed.value = !!r.ok
  } catch (e) {
    authed.value = false
  }
}

// 任何接口返回 401（会话过期）都会广播此事件
function onExpired(e) {
  authed.value = false
  ElMessage.warning((e && e.detail && e.detail.message) || '登录已过期，请重新登录')
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

// 顶部「开单」：统一跳订单页并带 ?new=1，由订单页负责开表单（避免再写一套开单链路）
function quickNewOrder() {
  if (route.path === '/orders') router.replace({ path: '/orders', query: { ...route.query, new: '1' } })
  else router.push({ path: '/orders', query: { new: '1' } })
}

onMounted(() => {
  check()
  refreshDraftCount()
  window.addEventListener('auth:expired', onExpired)
  window.addEventListener('resize', scheduleSync)
  window.addEventListener('orientationchange', scheduleSync)
  router.afterEach(() => { nextTick(scheduleSync); refreshDraftCount() })
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
  /* 次要文字：原 #909399 在白底上只有 3.0:1，达不到 WCAG AA 的 4.5:1；
     加深到 #6b7280（约 4.8:1），提示/说明文字不再发灰看不清 */
  --text-secondary: #6b7280;
  --text-placeholder: #c0c4cc;
  --text-disabled: #a8abb2;
  /* 线条 / 背景 */
  /* 原写法 var(--border-color) 是自引用：CSS 规范下自定义属性引用自己 = 失效，
     全站 23 处 1px 边框因此都退化成 currentColor（深灰黑线）。这里指向 Element 的线条色。 */
  --border-color: var(--el-border-color, #dcdfe6);
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
/* 键盘可达性：只在键盘聚焦（:focus-visible）时画焦点环，鼠标点击不出现；
   颜色用主色，深浅底上都看得见。Element 的按钮/输入框默认焦点样式偏淡，这里统一加强 */
:where(a, button, [tabindex], .el-button, .el-input__wrapper, .el-select__wrapper, .el-textarea__inner):focus-visible {
  outline: 2px solid var(--color-primary) !important;
  outline-offset: 2px;
}
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
/* 独立开单标签页：100% 宽高、无 padding、背景与正常页面一致；只渲染 <router-view> 内容 */
.standalone { width: 100%; height: 100%; padding: 0; margin: 0; background: var(--bg-page); }
.layout { height: 100%; flex-direction: column; }
.body { flex: 1; min-height: 0; }

/* 顶栏：只放操作（开单 / 退出），品牌交给侧栏 */
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
.header-right { display: flex; align-items: center; gap: 10px; margin-left: auto; }
/* 顶部「开单」：角标就是草稿数，不用 el-badge 的绝对定位（在 flex 里会漂），自己画 */
.quick-new { position: relative; }
.quick-new-badge {
  position: absolute;
  top: -7px;
  right: -7px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--color-warning);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}
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

/* ==================== 方块语义：状态=空心，可点=有色 ====================
   方块分三类，一眼能分清「是什么」和「该不该按」：
     ① 状态/类别（不可点）→ 白底 + 同色描边 + 同色字（空心）+ 右上角小圆点
     ② 主按钮（新建/保存/确认）→ 实心填充 + 白字，整页同一屏只留一个
     ③ 次按钮（查看/打印/导出/刷新）→ 白底 + 蓝字蓝边，可点但不抢主按钮
   危险与警示（删除/作废/过账）用 plain 空心，只有真正不可逆的确认框才用实心 danger。
   色相一律沿用已定义的语义色；禁用态按「不可点」归到 ①。 */

/* ① 状态标签：el-tag 全站只做状态与类别展示，一律白底空心。
   空心块再在内部右上角点一颗与文字同色的小圆点：白底描边的块单独看像「没上色」，
   加一颗点之后这块的颜色到底指什么，扫一眼就清楚 */
.el-tag { background-color: #fff !important; position: relative; padding-right: 16px; }
.el-tag::after {
  content: ''; position: absolute; top: 4px; right: 5px;
  width: 5px; height: 5px; border-radius: 50%;
  /* currentColor = 该标签的文字色，状态点多深就是描边/文字多深，不额外引入颜色 */
  background: currentColor;
}
.el-tag--small { padding-right: 14px; }
.el-tag--small::after { top: 3px; right: 4px; width: 4px; height: 4px; }
.el-tag--large { padding-right: 19px; }
.el-tag--large::after { top: 6px; right: 7px; width: 6px; height: 6px; }

/* ② 主按钮：实心。Element 的 primary/success/warning/danger/info 默认就是实心，无需改。
   ③ 次按钮（未指定 type）：白底 + 蓝字蓝边。以前这里是实心蓝，导致「查看/打印/导出」
   和「新建/保存」长得一模一样，一屏十几个蓝块分不出主次；改成空心后主按钮自然凸显，
   同时保留蓝色，不会像灰按钮那样被误认为不可点。 */
.el-button:not(.el-button--primary):not(.el-button--success):not(.el-button--warning):not(.el-button--danger):not(.el-button--info) {
  --el-button-text-color:var(--el-color-primary); --el-button-bg-color:#fff; --el-button-border-color:var(--el-color-primary-light-5);
  --el-button-hover-text-color:var(--el-color-primary-dark-2); --el-button-hover-bg-color:var(--el-color-primary-light-9); --el-button-hover-border-color:var(--el-color-primary-light-3);
  --el-button-active-text-color:var(--el-color-primary-dark-2); --el-button-active-bg-color:var(--el-color-primary-light-8); --el-button-active-border-color:var(--el-color-primary);
}
/* plain 一律空心（删掉以前强制实心的覆盖，恢复 Element 自带的浅底同色字）。
   列表里的删除/作废/过账都用 plain，避免每行挂一排实心色块。 */
/* text / link：真正的小字按钮（透明底、无边框），用于表内「清除 / 改结清」这类三级操作；
   只保留原来的三档尺寸，保证点击区域不缩水 */
.el-button.is-text, .el-button.is-link {
  background-color: transparent; border-width: 1px; border-style: solid; border-color: transparent;
  padding: 8px 15px; height: 32px;
}
.el-button.is-text.el-button--small, .el-button.is-link.el-button--small { padding: 5px 11px; height: 24px; }
.el-button.is-text.el-button--large, .el-button.is-link.el-button--large { padding: 12px 19px; height: 40px; }
.el-button.is-text:hover:not(.is-disabled), .el-button.is-link:hover:not(.is-disabled) {
  background-color: var(--bg-hover); color: var(--el-button-hover-text-color);
}
.el-button.is-text:active:not(.is-disabled), .el-button.is-link:active:not(.is-disabled) {
  background-color: var(--bg-hover); color: var(--el-button-active-text-color);
}
/* plain 的悬停底色：Element 默认是浅-9，和页面底太接近，这里稍加深一档 */
.el-button.is-plain:hover:not(.is-disabled) { background-color: var(--el-button-hover-bg-color); }
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
/* 最大化 / 整页开单：这里必须放开上面那条 94vw，否则「最大化」只到屏宽的 94%、右侧留一条缝 */
.el-dialog.is-fullscreen { max-width: 100vw; width: 100%; }
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
/* 退款单（销售 XT- / 采购 CT-）单号全局红字：列表、详情、来往账、资金单据明细统一生效 */
.return-code { color: var(--color-danger) !important; font-weight: 600; }

@media (max-width: 768px) {
  .desktop-only { display: none; }
  .main { padding: var(--gap-md); }
  /* 统计块在窄/矮屏排两列 */
  .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  /* 手机上头部空间紧张：开单按钮只留图标，退出登录只留图标（原有规则） */
  .quick-new-text { display: none; }
  .quick-new { padding: 8px 10px; }
  /* 手机端表格密度：行高、单元格内边距、字号各收一档，
     让 6~8 列的单据表一屏能多看到两三行；操作列按钮保持 24px 高度，触达区域不缩水 */
  :root { --td-pad: 6px; --fs-table: 12px; }
  .el-table .cell { padding-left: 8px; padding-right: 8px; }
  .el-table .ops-col .cell { padding-left: 6px; padding-right: 6px; }
  .el-table .ops-col .el-button + .el-button { margin-left: 4px; }
  .el-table__empty-text { font-size: var(--fs-sub); }
}
@media (min-width: 769px) {
  .menu-btn { display: none; }
  .header { padding-left: 20px; }
}
</style>
