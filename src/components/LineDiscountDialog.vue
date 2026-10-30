<template>
  <!-- 批量行折扣弹窗：为勾选的多行明细统一设置多级折扣链，或逐行单独设置。
       两种模式共用一个弹窗，切换时不丢已填数据。确认后把结果 emit 给父组件，
       父组件负责写回 form.lines 并触发既有 computed 重算（不在此处另算金额）。 -->
  <el-dialog v-model="visible" title="批量设置折扣" width="680" :close-on-click-modal="false" destroy-on-close>
    <div class="mode-switch">
      <el-radio-group v-model="mode" size="small">
        <el-radio-button value="unified">统一折扣链</el-radio-button>
        <el-radio-button value="perLine">逐行单独设置</el-radio-button>
      </el-radio-group>
      <span class="calc-hint">已选 {{ lines.length }} 行</span>
    </div>

    <!-- 统一折扣链模式：填一组级联折扣率，套用到所有勾选行 -->
    <div v-if="mode === 'unified'" class="unified-section">
      <div class="rate-chain">
        <div v-for="(r, i) in chainRates" :key="i" class="rate-row">
          <span class="rate-idx">第 {{ i + 1 }} 级</span>
          <el-input-number v-model="chainRates[i]" :min="0.01" :max="1" :step="0.01" :precision="2" :controls="false" style="width:120px" />
          <el-button link type="danger" size="small" @click="chainRates.splice(i, 1)">删除</el-button>
        </div>
        <el-button size="small" type="primary" plain @click="chainRates.push(0.9)">+ 添加一级折扣</el-button>
      </div>
      <div class="calc-hint" style="margin-top:6px">
        每级 0~1（1＝不打折，0.9＝九折），各级连乘。例如 0.9 → 0.9 → 0.8 等效 ×0.648。
        将套用到所有 {{ lines.length }} 行。
      </div>
      <div v-if="chainRates.length" class="rate-eff">
        累计等效折扣：×{{ chainEffective.toFixed(4) }}
      </div>
      <!-- 预览：展示每行折后小计 -->
      <div class="preview-table">
        <div class="preview-row preview-header">
          <span class="col-name">商品</span>
          <span class="col-num">原价</span>
          <span class="col-num">折后小计</span>
        </div>
        <div v-for="(l, idx) in lines" :key="idx" class="preview-row">
          <span class="col-name">{{ l.name || l.code || '(未选商品)' }}</span>
          <span class="col-num">¥{{ lineGrossOf(l).toFixed(2) }}</span>
          <span class="col-num">¥{{ lineNetWithChain(l).toFixed(2) }}</span>
        </div>
        <div class="preview-row preview-total">
          <span class="col-name">合计</span>
          <span class="col-num">¥{{ totalGross.toFixed(2) }}</span>
          <span class="col-num">¥{{ totalWithChain.toFixed(2) }}</span>
        </div>
      </div>
    </div>

    <!-- 逐行模式：每行可展开成多级链 -->
    <div v-else class="perline-section">
      <div v-for="(l, idx) in lines" :key="idx" class="perline-row">
        <div class="perline-header">
          <span class="perline-name">{{ l.name || l.code || '(未选商品)' }}</span>
          <span class="perline-info">数量 {{ l.qty }} · 单价 ¥{{ Number(l.price || 0).toFixed(2) }} · 原价 ¥{{ lineGrossOf(l).toFixed(2) }}</span>
          <el-button link type="primary" size="small" @click="toggleExpand(idx)">
            {{ expanded.has(idx) ? '收起' : '展开多级' }}
          </el-button>
        </div>
        <!-- 单级模式：直接一个折扣率输入 -->
        <div v-if="!expanded.has(idx)" class="perline-input">
          <span>折扣率：</span>
          <!-- min 0.01：填 0 会被 applyLineRates 当「非法折扣率」剔除＝不打折，
               用户看到「折后 0」结果却是原价，所以输入端直接禁掉 0 -->
          <el-input-number v-model="perLineRates[idx][0]" :min="0.01" :max="1" :step="0.05" :precision="2" :controls="false" style="width:100px" />
          <span class="perline-net">折后 ¥{{ lineNetPerLine(idx).toFixed(2) }}</span>
        </div>
        <!-- 多级模式：链式输入 -->
        <div v-else class="perline-chain">
          <div v-for="(r, ri) in perLineRates[idx]" :key="ri" class="rate-row">
            <span class="rate-idx">第 {{ ri + 1 }} 级</span>
            <el-input-number v-model="perLineRates[idx][ri]" :min="0.01" :max="1" :step="0.01" :precision="2" :controls="false" style="width:100px" />
            <el-button link type="danger" size="small" @click="perLineRates[idx].splice(ri, 1)">删除</el-button>
          </div>
          <el-button size="small" plain @click="perLineRates[idx].push(0.9)">+ 添加一级</el-button>
          <span class="perline-net" style="margin-left:12px">折后 ¥{{ lineNetPerLine(idx).toFixed(2) }}</span>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="confirm">确认应用</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
// 批量行折扣弹窗：支持「统一折扣链」与「逐行单独设置」两种模式。
// 确认后 emit('confirm', results)：results 是数组，每项对应一条勾选行，
// 包含 { discountRate, discountRates, discount, total }，父组件据此写回 form.lines。
// 金额计算纯函数（来自 catalog.js 的 applyLineRates / lineEffectiveRate），
// 弹窗本身不持有 form.lines 引用，避免绕过既有 computed。
import { ref, computed, watch, reactive } from 'vue'
import { round2 } from '../utils/account.js'
import { applyLineRates, lineEffectiveRate } from '../utils/catalog.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 被勾选的行（只读快照，弹窗内不修改原数组）
  lines: { type: Array, default: () => [] }
})
const emit = defineEmits(['update:modelValue', 'confirm'])

const visible = computed({ get: () => props.modelValue, set: (v) => emit('update:modelValue', v) })

const mode = ref('unified')
// 统一折扣链：初始给一级 0.9（最常见的批量折扣场景）
const chainRates = ref([0.9])
// 逐行折扣链：每行一个数组，初始单级 1（不打折）
const perLineRates = ref([])
// 展开状态：记录哪些行展开了多级链
const expanded = reactive(new Set())

// 行原价（数量 × 单价），与 OrderEditDialog / OrderFormDialog 的 lineGross 同一口径
const lineGrossOf = (l) => round2(Number(l.qty || 0) * Number(l.price || 0))

// 统一链模式下的等效折扣率
const chainEffective = computed(() => {
  const valid = chainRates.value.map(Number).filter(r => Number.isFinite(r) && r > 0 && r <= 1)
  return valid.length ? valid.reduce((a, b) => a * b, 1) : 1
})

// 统一链模式下某行的折后小计。
// 必须走 applyLineRates：预览与「确认应用」写回的口径完全一致（先 round2 折扣额、再减），
// 直接 g×rate 取整会和实际落库值差 1 分钱，用户会看到「预览对不上结果」。
const lineNetWithChain = (l) => applyLineRates(l, chainRates.value, lineGrossOf(l)).total

// 统一链模式下所有行原价合计与折后合计
const totalGross = computed(() => round2(props.lines.reduce((s, l) => s + lineGrossOf(l), 0)))
const totalWithChain = computed(() => round2(props.lines.reduce((s, l) => s + lineNetWithChain(l), 0)))

// 逐行模式下某行的折后小计
const lineNetPerLine = (idx) => {
  const l = props.lines[idx]
  if (!l) return 0
  const g = lineGrossOf(l)
  const rates = perLineRates.value[idx] || [1]
  const result = applyLineRates(l, rates, g)
  return result.total
}

// 打开弹窗时：根据传入的行初始化数据
// 统一模式：给一个默认链 [0.9]；逐行模式：每行取当前折扣率作为初始值
watch(() => props.modelValue, (open) => {
  if (!open) return
  mode.value = 'unified'
  chainRates.value = [0.9]
  expanded.clear()
  // 逐行模式初始化：每行取当前等效折扣率
  perLineRates.value = props.lines.map(l => {
    const eff = lineEffectiveRate(l)
    return [eff]
  })
})

function toggleExpand(idx) {
  if (expanded.has(idx)) {
    expanded.delete(idx)
    // 收起时把多级链折叠回单级（保留等效值）
    const rates = perLineRates.value[idx] || [1]
    const eff = rates.filter(r => Number.isFinite(r) && r > 0 && r <= 1).reduce((a, b) => a * b, 1) || 1
    perLineRates.value[idx] = [eff]
  } else {
    expanded.add(idx)
    // 展开时如果当前是单级 1（不打折），补一级 0.9 让用户有东西改
    if (!perLineRates.value[idx] || perLineRates.value[idx].length === 0) {
      perLineRates.value[idx] = [1]
    }
  }
}

function confirm() {
  const results = props.lines.map((l, idx) => {
    const g = lineGrossOf(l)
    if (mode.value === 'unified') {
      return applyLineRates(l, chainRates.value, g)
    } else {
      return applyLineRates(l, perLineRates.value[idx] || [1], g)
    }
  })
  emit('confirm', results)
  visible.value = false
}
</script>

<style scoped>
.mode-switch{display:flex;align-items:center;gap:12px;margin-bottom:12px;}
.calc-hint{color:var(--text-secondary);font-size:var(--fs-sub);}
.rate-chain{display:flex;flex-direction:column;gap:6px;}
.rate-row{display:flex;align-items:center;gap:8px;}
.rate-idx{color:var(--text-secondary);font-size:var(--fs-sub);min-width:44px;}
.rate-eff{margin-top:4px;color:var(--color-success);font-weight:600;font-size:var(--fs-sub);}
.preview-table{margin-top:12px;border:1px solid var(--el-border-color-lighter, #ebeef5);border-radius:4px;overflow:hidden;max-height:200px;overflow-y:auto;}
.preview-row{display:flex;padding:6px 10px;border-bottom:1px solid var(--el-border-color-lighter, #ebeef5);align-items:center;}
.preview-row:last-child{border-bottom:none;}
.preview-header{background:var(--el-fill-color-lighter, #fafafa);font-weight:600;font-size:var(--fs-sub);}
.preview-total{background:var(--el-fill-color-lighter, #fafafa);font-weight:600;}
.col-name{flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.col-num{width:100px;text-align:right;font-variant-numeric:tabular-nums;}
.perline-section{display:flex;flex-direction:column;gap:10px;max-height:360px;overflow-y:auto;}
.perline-row{border:1px solid var(--el-border-color-lighter, #ebeef5);border-radius:4px;padding:8px 10px;}
.perline-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.perline-name{font-weight:600;min-width:100px;}
.perline-info{color:var(--text-secondary);font-size:var(--fs-sub);flex:1;}
.perline-input{display:flex;align-items:center;gap:8px;margin-top:6px;}
.perline-chain{margin-top:6px;display:flex;flex-direction:column;gap:4px;}
.perline-net{color:var(--color-success);font-weight:600;font-variant-numeric:tabular-nums;}
.unified-section, .perline-section{margin-top:4px;}
</style>
