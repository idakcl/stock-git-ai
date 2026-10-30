<template>
  <!-- 打印设置：跨页表头开关 + 纸张（A4/A5 横纵向、自定义 mm、每页行数）。
       一处设置，全站打印共用：列表打印、单张打印、批量打印都读同一份偏好。 -->
  <div class="print-prefs">
    <el-tooltip :content="tip" placement="top">
      <el-checkbox v-model="on" size="small" class="hdr-toggle">跨页表头</el-checkbox>
    </el-tooltip>
    <el-popover placement="bottom-end" :width="286" trigger="click">
      <template #reference>
        <el-button size="small" class="paper-btn" :title="`打印纸张：${paperLabel}`">{{ paperLabel }}</el-button>
      </template>
      <div class="pp">
        <div class="pp-row">
          <span class="pp-label">纸张</span>
          <el-radio-group v-model="cfg.mode" size="small">
            <el-radio-button value="preset">A4 / A5</el-radio-button>
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
        <div class="pp-hint">自定义纸张按填入的宽高出纸（宽 &lt; 高即纵向）。真机打印若某页缺表头或最后一行被挤到下一页，把每页行数调小几行即可。</div>
        <div class="pp-actions">
          <el-button link size="small" @click="resetPaperPref()">恢复默认（A4 横向）</el-button>
        </div>
      </div>
    </el-popover>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { repeatHeaderPref, paperPref, resetPaperPref } from '../utils/printPrefs'
import { paperSpec } from '../utils/export'

const cfg = paperPref
const on = computed({
  get: () => repeatHeaderPref.value,
  set: (v) => { repeatHeaderPref.value = !!v }
})
const tip = computed(() => on.value
  ? '已开启：每页都重复商品表头（明细按纸张高度自动分页）'
  : '已关闭：整份明细一张连续大表，表头只印在第一页')

const paperLabel = computed(() => {
  if (cfg.mode === 'custom') return `${Math.round(cfg.width)}×${Math.round(cfg.height)}mm`
  return cfg.orientation === 'portrait' ? 'A4/A5 纵向' : 'A4/A5 横向'
})

// 纸张是否真的生效，以解析结果为准（自定义/纵向时按钮上的 A4、A5 都用这张纸）
const spec = computed(() => paperSpec('A4'))
defineExpose({ spec })
</script>

<style scoped>
.print-prefs { display: inline-flex; align-items: center; gap: 8px; }
/* 与其它 small 按钮同高，避免在工具栏里把行高撑开 */
.hdr-toggle { height: 24px; line-height: 24px; margin-right: 0; }
.paper-btn { font-variant-numeric: tabular-nums; }
.pp { display: flex; flex-direction: column; gap: 10px; }
.pp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pp-label { width: 68px; color: var(--text-regular); font-size: var(--fs-sub); flex: none; }
.pp-num { width: 92px; }
.pp-x, .pp-unit { color: var(--text-secondary); font-size: var(--fs-sub); }
.pp-hint { color: var(--text-secondary); font-size: var(--fs-mini); line-height: 1.5; }
.pp-actions { text-align: right; }
</style>
