<template>
  <!-- 打印设置：纸张（A4 / A5 / 自定义、横纵向、每页行数）+ 跨页表头开关，全部收在一个弹层里。
       全站只有这一个地方选纸张，页面上只有一个「打印」按钮；列表打印、单张打印、
       批量打印、模板打印都读这一份偏好。
       跨页表头原先占着工具栏一格，但它和纸张一样是「设一次就不动」的偏好，
       所以并进弹层，按钮文字带状态（每页表头 / 单表），不点开也知道当前是什么。 -->
  <div class="print-prefs">
    <el-popover placement="bottom-end" :width="330" trigger="click">
      <template #reference>
        <el-button size="small" class="paper-btn" :title="`打印设置：${paperLabel}，${on ? '每页重复表头' : '整份一张连续大表'}`">
          <span class="pp-gear" aria-hidden="true"></span>{{ paperLabel }} · {{ on ? '每页表头' : '单表' }}
        </el-button>
      </template>
      <div class="pp">
        <div class="pp-row pp-switch-row">
          <span class="pp-label">跨页表头</span>
          <el-switch v-model="on" size="small" />
        </div>
        <div class="pp-desc">{{ tip }}</div>
        <div class="pp-row">
          <span class="pp-label">纸张</span>
          <el-radio-group v-model="paperChoice" size="small">
            <el-radio-button value="A4">A4</el-radio-button>
            <el-radio-button value="A5">A5</el-radio-button>
            <el-radio-button value="custom">自定义</el-radio-button>
          </el-radio-group>
        </div>
        <div v-if="cfg.mode === 'preset'" class="pp-row">
          <span class="pp-label">方向</span>
          <el-radio-group v-model="cfg.orientation" size="small">
            <el-radio-button value="landscape">横向</el-radio-button>
            <el-radio-button value="portrait">纵向</el-radio-button>
          </el-radio-group>
        </div>
        <template v-else>
          <div class="pp-row">
            <span class="pp-label">宽 × 高</span>
            <el-input-number v-model="cfg.width" :min="40" :max="1000" :step="1" :controls="false" size="small" class="pp-num" />
            <span class="pp-x">×</span>
            <el-input-number v-model="cfg.height" :min="40" :max="1000" :step="1" :controls="false" size="small" class="pp-num" />
            <span class="pp-unit">mm</span>
          </div>
        </template>
        <div class="pp-row">
          <span class="pp-label">每页行数</span>
          <el-input-number v-model="cfg.rowsPerPage" :min="0" :max="200" :step="1" :controls="false" size="small" class="pp-num" />
          <span class="pp-unit">0 = 自动</span>
        </div>
        <!-- 自动行数 + 标头/商品拆解：换纸张、方向、自定义宽高都会即时重算，
             数字与真正切片用的 rowsPerPageOf / headRowsOf 同源 -->
        <div class="pp-cap">
          <div class="pp-cap-line">
            每页 <b>{{ rowsInfo.rowsPerPage }}</b> 行
            <span class="pp-cap-tag" :class="{ manual: rowsInfo.manual }">{{ rowsInfo.manual ? '手动' : '自动' }}</span>
            <span v-if="rowsInfo.manual" class="pp-cap-auto">自动 {{ rowsInfo.auto }}</span>
          </div>
          <div class="pp-cap-line">
            首页：标头 {{ headRows }} 行 + 商品 <b>{{ firstRows }}</b> 行
          </div>
          <div v-if="headRows" class="pp-cap-line">后续页：商品 <b>{{ rowsInfo.rowsPerPage }}</b> 行</div>
          <div v-if="!on" class="pp-cap-note">跨页表头已关闭：明细不按纸张分页，表头只印在第一页。</div>
        </div>
        <div class="pp-hint">自定义纸张按填入的宽高出纸（宽 &lt; 高即纵向）。真机打印若某页缺表头或最后一行被挤到下一页，把每页行数调小几行即可。</div>
        <div class="pp-actions">
          <el-button link size="small" class="pp-reset" @click="resetAll">恢复默认（A4 纵向 · 每页表头）</el-button>
        </div>
      </div>
    </el-popover>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { repeatHeaderPref, paperPref, resetPaperPref } from '../utils/printPrefs'
import { paperSpec, paperRowsInfo, headRowsOf } from '../utils/export'

// 当前要打印内容的单头信息（标题/副标题/信息块）：只用来算「标头占几行」，
// 不传就按无标头算（列表打印、模板打印这类没有信息块的场景）
const props = defineProps({
  headTitle: { type: String, default: '' },
  headSubtitle: { type: String, default: '' },
  headFields: { type: Array, default: () => [] }
})

const cfg = paperPref
const on = computed({
  get: () => repeatHeaderPref.value,
  set: (v) => { repeatHeaderPref.value = !!v }
})
const tip = computed(() => on.value
  ? '已开启：每页都重复商品表头（明细按纸张高度自动分页）'
  : '已关闭：整份明细一张连续大表，表头只印在第一页')

// 恢复默认 = 纸张回到 A4 纵向 + 表头重新打开：这两项都是「打印设置」里的偏好，
// 只复位一半会让人以为按钮坏了
function resetAll() {
  resetPaperPref()
  on.value = true
}

// 纸张三选一（A4 / A5 / 自定义）压在一个 radio 上：自定义用 mode 表示，A4/A5 写进 paper，
// 这样界面上不会出现「A4/A5 开关」+「纸张开关」两个容易互相打架的选择
const paperChoice = computed({
  get: () => (cfg.mode === 'custom' ? 'custom' : (cfg.paper || 'A4')),
  set: (v) => {
    if (v === 'custom') { cfg.mode = 'custom'; return }
    cfg.mode = 'preset'
    cfg.paper = v
  }
})

// 按钮上直接写出「会用哪张纸、哪个方向」，打印前不用再点开面板确认
const paperLabel = computed(() => (cfg.mode === 'custom'
  ? `${Math.round(cfg.width)}×${Math.round(cfg.height)}mm`
  : `${cfg.paper || 'A4'} ${cfg.orientation === 'landscape' ? '横向' : '纵向'}`))

// 纸张是否真的生效，以解析结果为准
const spec = computed(() => paperSpec())
// 面板上的行数拆解：自动行数取当前纸张/方向/自定义尺寸，标头行数取当前单据头信息
const rowsInfo = computed(() => paperRowsInfo())
const headRows = computed(() => headRowsOf(spec.value, {
  title: props.headTitle,
  subtitle: props.headSubtitle,
  headerFields: props.headFields
}))
// 首页商品行数：与 packPageSlices 一样至少留 1 行（手动行数填得过小时也不会出现 0/负数）
const firstRows = computed(() => Math.max(1, rowsInfo.value.rowsPerPage - headRows.value))
defineExpose({ spec })
</script>

<style scoped>
.print-prefs { display: inline-flex; align-items: center; gap: 8px; }
/* 按钮左边的小齿轮：一眼看出这是「设置」而不是「打印」，纯 CSS 画，不引图标包 */
.pp-gear {
  display: inline-block; width: 11px; height: 11px; margin-right: 5px;
  border: 1.5px solid currentColor; border-radius: 50%; position: relative;
  opacity: .7; vertical-align: -1px;
}
.pp-gear::after {
  content: ""; position: absolute; left: 3.2px; top: 3.2px;
  width: 3px; height: 3px; border-radius: 50%; background: currentColor;
}
.paper-btn { font-variant-numeric: tabular-nums; }
.pp { display: flex; flex-direction: column; gap: 10px; }
/* 单行不换行：popover 内容区只有 330px，宽×高 的两个输入框一旦换行，297 会掉到下一行 */
.pp-row { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; }
/* 开关行：标签 + 开关 + 一句状态说明，说明用次要色，避免和控件抢注意力 */
.pp-switch-row { justify-content: flex-start; }
.pp-desc { color: var(--text-secondary); font-size: var(--fs-mini); line-height: 1.5; margin: -6px 0 12px 76px; }
.pp-label { width: 68px; color: var(--text-regular); font-size: var(--fs-sub); flex: none; }
.pp-num { width: 84px; }
.pp-x, .pp-unit { color: var(--text-secondary); font-size: var(--fs-sub); }
/* 行数拆解：浅底块，和上面的表单控件区分开 */
.pp-cap { background: var(--el-fill-color-light, #f5f7fa); border-radius: 4px; padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-sub); color: var(--text-regular); }
.pp-cap b { font-variant-numeric: tabular-nums; color: var(--text-primary); }
.pp-cap-tag { margin-left: 4px; padding: 0 5px; border-radius: 3px; font-size: var(--fs-mini); color: var(--text-secondary); background: var(--el-fill-color, #ebeef5); }
.pp-cap-tag.manual { color: var(--el-color-warning-dark-2, #b88230); background: var(--el-color-warning-light-8, #fdf6ec); }
.pp-cap-auto { margin-left: 6px; color: var(--text-secondary); font-size: var(--fs-mini); }
.pp-cap-note { color: var(--text-secondary); font-size: var(--fs-mini); line-height: 1.5; }
.pp-hint { color: var(--text-secondary); font-size: var(--fs-mini); line-height: 1.5; }
.pp-actions { text-align: right; }
/* 全局把文字按钮补成了实心蓝，这里覆盖回「链接」样式，别让一行小链接看着像主按钮 */
.pp-reset {
  background: transparent !important; border-color: transparent !important;
  color: var(--color-primary) !important; padding: 2px 0; height: auto;
}
.pp-reset:hover { text-decoration: underline; }
</style>
