<template>
  <!-- 过账方式选择：结清＝钱已当场收/付；挂账＝先欠着，之后再收款/付款。
       单张过账、勾选批量过账、录入页「保存并过账」共用同一个弹窗，口径只写一遍。 -->
  <el-dialog :model-value="modelValue" title="选择过账方式" width="min(480px, 94vw)"
    :close-on-click-modal="false" @update:model-value="v => emit('update:modelValue', v)">
    <div class="ps-summary">
      <div class="ps-line">
        <span>待过账</span>
        <b>{{ orders.length }} 张{{ kindText }}</b>
      </div>
      <div class="ps-line">
        <span>订单金额合计</span>
        <b>¥ {{ amount.toFixed(2) }}</b>
      </div>
      <div v-if="deposit > 0" class="ps-line">
        <span>已收 / 已付订金</span>
        <b>¥ {{ deposit.toFixed(2) }}</b>
      </div>
      <div v-if="amount - deposit > 0" class="ps-line">
        <span>{{ isPurchase ? '过账后应付' : '过账后应收' }}</span>
        <b class="ps-due">¥ {{ (amount - deposit).toFixed(2) }}</b>
      </div>
    </div>
    <div class="ps-choice">
      <button type="button" class="ps-card" :disabled="saving" @click="choose('settle')">
        <span class="ps-card-title">过账为结清</span>
        <span class="ps-card-desc">
          生成正式{{ isPurchase ? '采购' : '销售' }}单，同时把未{{ isPurchase ? '付' : '收' }}的 ¥{{ Math.max(0, amount - deposit).toFixed(2) }}
          记为本次实际{{ isPurchase ? '付款' : '收款' }}并自动开{{ isPurchase ? '付款单 FK-' : '收款单 SK-' }}，
          {{ isPurchase ? '应付' : '应收' }}归零。
        </span>
      </button>
      <button type="button" class="ps-card" :disabled="saving" @click="choose('credit')">
        <span class="ps-card-title">过账为挂账</span>
        <span class="ps-card-desc">
          只生成正式{{ isPurchase ? '采购' : '销售' }}单，{{ isPurchase ? '应付' : '应收' }}保留为 ¥{{ Math.max(0, amount - deposit).toFixed(2) }}，
          稍后可到单据里记录{{ isPurchase ? '付款' : '收款' }}。
        </span>
      </button>
    </div>
    <div class="ps-note">
      两种方式的库存、单据金额完全一致，只差「这笔钱现在算不算收/付过」。
      过账后要改，可在单据页撤销（未动钱时）或走变更明细。
    </div>
    <template #footer>
      <el-button :disabled="saving" @click="emit('update:modelValue', false)">取消</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed } from 'vue'
import { orderAmount, orderDepositSum } from '../utils/orders.js'
import { round2 } from '../utils/account.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 待过账订单（新建表单里传的是「保存后将要落的草稿」，字段形状与订单一致）
  orders: { type: Array, default: () => [] },
  saving: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'confirm'])

const amount = computed(() => round2((props.orders || []).reduce((s, o) => s + orderAmount(o), 0)))
const deposit = computed(() => round2((props.orders || []).reduce((s, o) => s + orderDepositSum(o), 0)))
// 批量里可能混着销售与采购：只要有一张采购就按「采购」措辞提示，逐张单据仍各按自己的类型生成
const isPurchase = computed(() => (props.orders || []).some(o => o.kind === 'purchase'))
const kindText = computed(() => {
  const kinds = new Set((props.orders || []).map(o => (o.kind === 'purchase' ? 'purchase' : 'sale')))
  if (kinds.size > 1) return '（销售 + 采购）'
  return isPurchase.value ? '采购单' : '销售单'
})

function choose(mode) {
  if (props.saving) return
  emit('confirm', mode)
}
</script>

<style scoped>
.ps-summary { background: var(--bg-page); border-radius: 6px; padding: 10px 12px; margin-bottom: 12px; }
.ps-line { display: flex; justify-content: space-between; gap: 12px; line-height: 1.9; font-size: var(--fs-base); color: var(--text-regular); }
.ps-line b { color: var(--text-primary); }
.ps-due { color: var(--color-danger); }
.ps-choice { display: flex; flex-direction: column; gap: 10px; }
/* 两个选项做成整块可点的大卡片：手机上比小按钮好点，也不会一点就误提交 */
.ps-card {
  display: flex; flex-direction: column; gap: 4px; width: 100%; text-align: left;
  padding: 12px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--border-color); background: #fff; font-family: inherit;
}
.ps-card:hover { border-color: var(--color-primary); background: rgba(64, 158, 255, 0.04); }
.ps-card:disabled { cursor: not-allowed; opacity: 0.6; }
.ps-card-title { font-size: var(--fs-base); font-weight: 700; color: var(--color-primary); }
.ps-card-desc { font-size: var(--fs-sub); color: var(--text-secondary); line-height: 1.6; }
.ps-note { margin-top: 12px; color: var(--text-secondary); font-size: var(--fs-sub); line-height: 1.6; }
</style>
