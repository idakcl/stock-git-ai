<template>
  <el-dialog v-model="visible" :title="`${kindLabel}流水 - ${order.id || ''}`" width="660" @closed="onClosed">
    <div class="pay-summary">
      <span>{{ kind === 'payable' ? '应付' : '应收' }}：<b>¥ {{ due.toFixed(2) }}</b></span>
      <span>累计{{ kind === 'payable' ? '实付' : '实收' }}：<b>¥ {{ paidSum.toFixed(2) }}</b>（{{ rows.length }} 笔）</span>
      <span v-if="Number(order.discount || 0) > 0">抹零优惠：<b class="discount">¥ {{ Number(order.discount).toFixed(2) }}</b>（未实际{{ kind === 'payable' ? '付款' : '收款' }}）</span>
      <span>{{ kind === 'payable' ? '未付' : '未收' }}：<b :class="unpaid > 0 ? 'debt' : 'zero'">¥ {{ unpaid.toFixed(2) }}</b></span>
    </div>

    <el-table :data="rows" stripe max-height="280" empty-text="暂无收付款记录">
      <el-table-column type="index" label="#" width="46" />
      <el-table-column prop="date" label="日期" width="130" />
      <el-table-column prop="amount" label="金额" width="120" align="right">
        <template #default="{ row }">{{ Number(row.amount || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
      <el-table-column label="操作" width="120">
        <template #default="{ row, $index }">
          <el-button size="small" type="primary" link :class="{ 'is-editing': editingIndex === $index }" @click="startEdit($index)">编辑</el-button>
          <el-button size="small" type="danger" link @click="removeRow($index)">删除</el-button>
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
      <template v-if="editingIndex < 0">
        <el-button type="primary" @click="addOne">记一笔</el-button>
      </template>
      <template v-else>
        <el-button type="primary" @click="saveEdit">保存修改</el-button>
        <el-button @click="cancelEdit">取消编辑</el-button>
      </template>
    </div>
    <div class="pay-hint">提示：记一笔后先入列表，点「保存」统一生效；点「编辑」可修改已有记录；超额收付会被拒绝，少收/少付保存时会把差额记为抹零优惠（不产生实际收付）并提示确认结清。<span v-if="editingIndex >= 0" class="editing-tip">正在编辑第 {{ editingIndex + 1 }} 笔，金额上限为「应收 − 其他各笔合计」。</span></div>

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
// 正在编辑的流水下标，-1 表示未进入编辑（此时表单用于「记一笔」）
const editingIndex = ref(-1)

const due = computed(() => grossOf(props.order))
const paidSum = computed(() => rows.value.reduce((s, r) => s + Number(r.amount || 0), 0))
const editingRow = computed(() => (editingIndex.value >= 0 ? rows.value[editingIndex.value] : null))
// 编辑已有记录时，「未收/未付」要排除该笔原金额：草稿金额上限 = 应收 − 其他各笔合计
const unpaid = computed(() => Math.max(0, due.value - paidSum.value + (editingRow.value ? Number(editingRow.value.amount || 0) : 0)))
const draftMax = computed(() => unpaid.value)

watch(() => props.modelValue, v => {
  if (v) {
    const field = props.kind === 'payable' ? 'paid' : 'received'
    rows.value = ensurePayments(props.order, field)
    draft.value = { date: new Date().toISOString().slice(0, 10), amount: null, remark: '' }
    editingIndex.value = -1
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

// ---------- 编辑已有流水：把该笔载入表单，改完写回原位置（保留原 time） ----------
function startEdit(idx) {
  const row = rows.value[idx]
  if (!row) return
  editingIndex.value = idx
  draft.value = {
    date: row.date || new Date().toISOString().slice(0, 10),
    amount: Number(row.amount || 0),
    remark: row.remark || ''
  }
}

function saveEdit() {
  const idx = editingIndex.value
  const row = rows.value[idx]
  if (!row) { cancelEdit(); return }
  const amount = Number(draft.value.amount || 0)
  if (!amount || amount <= 0) return ElMessage.warning('请输入收款/付款金额')
  // unpaid 已排除该笔原金额，此处校验的是「其他各笔 + 本次修改」是否超额
  if (amount > unpaid.value + 1e-6) return ElMessage.warning(`金额超过未${kindLabel.value === '付款' ? '付' : '收'}金额`)
  rows.value[idx] = {
    ...row,
    date: draft.value.date || row.date,
    amount,
    remark: draft.value.remark || '',
    time: row.time || new Date().toISOString() // 保留原记录时间，仅更新可改字段
  }
  dirty.value = true
  cancelEdit()
  ElMessage.success('已修改该笔记录，点「保存」后生效')
}

function cancelEdit() {
  editingIndex.value = -1
  draft.value = { date: new Date().toISOString().slice(0, 10), amount: null, remark: '' }
}

function removeRow(idx) {
  // 删除后同步修正编辑下标：删的是正在编辑行则退出编辑，删在前方则前移
  if (editingIndex.value === idx) cancelEdit()
  else if (editingIndex.value > idx) editingIndex.value -= 1
  rows.value.splice(idx, 1)
  dirty.value = true
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
          h('p', { style: 'margin:0;color:var(--text-secondary);font-size:var(--fs-sub);line-height:1.6' }, `取消则仅记部分${action}，账单保持挂账。`)
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
  editingIndex.value = -1
}
</script>

<style scoped>
.pay-summary { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 10px; color:var(--text-regular); font-size:var(--fs-base); }
.pay-add { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
.pay-hint { margin-top: 6px; color:var(--text-secondary); font-size:var(--fs-sub); }
.editing-tip { margin-left: 6px; color:var(--color-warning); }
.discount { color:var(--color-success); }
.is-editing { font-weight: 600; }
.debt { color:var(--color-danger); }
.zero { color:var(--color-success); }
</style>
