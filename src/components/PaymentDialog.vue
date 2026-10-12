<template>
  <el-dialog v-model="visible" :title="`${kindLabel}流水 - ${order.id || ''}`" width="660" @closed="onClosed">
    <div class="pay-summary">
      <span>{{ kind === 'payable' ? '应付' : '应收' }}：<b>¥ {{ due.toFixed(2) }}</b></span>
      <span>累计{{ kind === 'payable' ? '实付' : '实收' }}：<b>¥ {{ paidSum.toFixed(2) }}</b>（{{ rows.length }} 笔）</span>
      <span>{{ kind === 'payable' ? '未付' : '未收' }}：<b :class="unpaid > 0 ? 'debt' : 'zero'">¥ {{ unpaid.toFixed(2) }}</b></span>
    </div>

    <el-table :data="rows" stripe size="small" empty-text="暂无收付款记录">
      <el-table-column type="index" label="#" width="46" />
      <el-table-column prop="date" label="日期" width="130" />
      <el-table-column prop="amount" label="金额" width="120">
        <template #default="{ row }">{{ Number(row.amount || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
      <el-table-column label="操作" width="70">
        <template #default="{ $index }">
          <el-button size="small" type="danger" link @click="rows.splice($index, 1)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="pay-add">
      <el-date-picker v-model="draft.date" type="date" value-format="YYYY-MM-DD" placeholder="日期" style="width:140px" />
      <el-input-number
        v-model="draft.amount"
        :min="0"
        :max="draftMax"
        :precision="2"
        :controls="false"
        placeholder="金额"
        style="width:120px"
      />
      <el-input v-model="draft.remark" placeholder="备注（付款方式等，可空）" style="flex:1;min-width:140px" />
      <el-button type="primary" @click="addOne">记一笔</el-button>
    </div>
    <div class="pay-hint">提示：记一笔后先入列表，点「保存」统一生效；超额收付会被拒绝，少收/少付保存时会提示是否按优惠结清。</div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!dirty" @click="saveAll">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, h } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ensurePayments, grossOf, syncPayments } from '../utils/account'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  order: { type: Object, required: true },
  kind: { type: String, default: 'receivable' } // 'receivable' 销售单收款 | 'payable' 采购单付款
})
const emit = defineEmits(['update:modelValue', 'saved'])

const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v)
})

const kindLabel = computed(() => props.kind === 'payable' ? '付款' : '收款')
const rows = ref([])
const dirty = ref(false)
const draft = ref({ date: '', amount: null, remark: '' })

const due = computed(() => grossOf(props.order))
const paidSum = computed(() => rows.value.reduce((s, r) => s + Number(r.amount || 0), 0))
const unpaid = computed(() => Math.max(0, due.value - paidSum.value))
const draftMax = computed(() => Math.max(0, unpaid.value))

watch(() => props.modelValue, v => {
  if (v) {
    const field = props.kind === 'payable' ? 'paid' : 'received'
    rows.value = ensurePayments(props.order, field)
    draft.value = { date: new Date().toISOString().slice(0, 10), amount: null, remark: '' }
    dirty.value = false
  }
})

function addOne() {
  const amount = Number(draft.value.amount || 0)
  if (!amount || amount <= 0) return ElMessage.warning('请输入收款/付款金额')
  if (amount > unpaid.value + 1e-6) return ElMessage.warning(`金额超过未${kindLabel.value === '付款' ? '付' : '收'}金额`)
  rows.value.push({
    date: draft.value.date || new Date().toISOString().slice(0, 10),
    amount,
    remark: draft.value.remark || '',
    time: new Date().toISOString()
  })
  dirty.value = true
  // 默认带入剩余未收，方便连续录入
  draft.value.amount = Math.max(0, unpaid.value - amount) || null
  draft.value.remark = ''
}

// 两位小数四舍五入，避免浮点误差导致「差额入优惠后仍差一分钱」
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

async function saveAll() {
  // 以当前行覆盖原单 payments，并同步汇总字段(received/paid)与结算状态
  const due = round2(grossOf(props.order))
  const paidSum = round2(rows.value.reduce((s, r) => s + Number(r.amount || 0), 0))
  const gap = round2(due - paidSum)
  const isPay = props.kind === 'payable'
  const action = isPay ? '付款' : '收款'
  const order = { ...props.order, payments: rows.value.map(p => ({ ...p })) }
  if (gap > 0.005) {
    // 少收/少付：提示确认是否把差额作为优惠并结清（VNode 分行展示，金额确认更清晰）
    try {
      await ElMessageBox.confirm(
        // ElMessageBox 挂载到 body，scoped 样式不生效，故用内联样式分行展示
        h('div', null, [
          h('p', { style: 'margin:0 0 6px;line-height:1.6' }, `本单${isPay ? '应付' : '应收'} ¥${due.toFixed(2)}，本次${action}合计 ¥${paidSum.toFixed(2)}，差额 ¥${gap.toFixed(2)}。`),
          h('p', { style: 'margin:0 0 6px;line-height:1.6' }, `确认后差额作为优惠入账，本单按 ¥${paidSum.toFixed(2)} 结清。`),
          h('p', { style: 'margin:0;color:#909399;font-size:12px;line-height:1.6' }, `取消则仅记部分${action}，账单保持挂账。`)
        ]),
        '优惠结清确认',
        { type: 'warning', confirmButtonText: '确认优惠结清', cancelButtonText: `仅记部分${action}`, distinguishCancelAndClose: true }
      )
      // 用户确认：差额计入优惠字段，syncPayments 会按金额自动判定为结清（全站口径一致）
      order.discount = round2(Number(props.order.discount || 0) + gap)
    } catch {
      // 用户取消：按部分收付保存，账单保持挂账
    }
  }
  const updated = syncPayments(order, props.kind)
  // 不在此处关闭弹窗：由父组件保存成功后关闭，失败时弹窗保持打开便于重试
  emit('saved', updated)
}

function onClosed() {
  rows.value = []
  dirty.value = false
}
</script>

<style scoped>
.pay-summary { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 10px; color: #606266; font-size: 14px; }
.pay-add { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
.pay-hint { margin-top: 6px; color: #909399; font-size: 12px; }
.debt { color: #f56c6c; }
.zero { color: #67c23a; }
</style>
