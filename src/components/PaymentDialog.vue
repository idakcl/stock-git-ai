<template>
  <el-dialog v-model="visible" :title="`${kindLabel}流水 - ${order.id || ''}`" width="660" @closed="onClosed">
    <div class="pay-summary">
      <span>{{ kind === 'payable' ? '应付' : '应收' }}：<b>¥ {{ due.toFixed(2) }}</b></span>
      <span>累计{{ kind === 'payable' ? '实付' : '实收' }}：<b>¥ {{ paidSum.toFixed(2) }}</b>（{{ rows.length }} 笔）</span>
      <span v-if="Number(order.discount || 0) > 0">抹零优惠：<b class="discount">¥ {{ Number(order.discount).toFixed(2) }}</b>（未实际{{ kind === 'payable' ? '付款' : '收款' }}）</span>
      <span>{{ kind === 'payable' ? '未付' : '未收' }}：<b :class="unpaid > 0 ? 'debt' : 'zero'">¥ {{ unpaid.toFixed(2) }}</b></span>
      <span v-if="depositAvailable > 0">可用{{ depositLabel }}：<b class="deposit">¥ {{ depositAvailable.toFixed(2) }}</b></span>
    </div>

    <el-table :data="rows" stripe max-height="280" empty-text="暂无收付款记录">
      <el-table-column type="index" label="#" width="46" />
      <el-table-column prop="date" label="日期" width="130" />
      <el-table-column prop="amount" label="金额" width="120" align="right">
        <template #default="{ row }">{{ Number(row.amount || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="来源" width="92">
        <template #default="{ row }">
          <el-tag v-if="row.fromDeposit" size="small" type="warning" disable-transitions>{{ depositLabel }}</el-tag>
          <span v-else class="none">现金</span>
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" width="130" show-overflow-tooltip />
      <el-table-column label="操作" width="120" class-name="ops-col">
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
        :max="editingIndex >= 0 ? draftMax : 99999999"
        :precision="2"
        :controls="false"
        placeholder="金额"
        style="width:120px"
      />
      <el-input v-model="draft.remark" placeholder="备注（付款方式等，可空）" style="flex:1;min-width:140px" />
      <template v-if="editingIndex < 0">
        <el-button type="primary" @click="addOne">记一笔</el-button>
        <!-- 结清：自动把剩余未收/未付金额记为一笔流水并保存（保存后按金额自动判定结清） -->
        <el-button type="success" @click="settleFull">结清</el-button>
        <!-- 抹零结清：按填写金额记一笔，不足应收/应付的差额自动计入优惠并结清 -->
        <el-button type="warning" @click="settleRound">抹零结清</el-button>
        <!-- 用预存款/预付款支付：从对应档案余额中扣减货款，记一笔来源为预存款的流水 -->
        <el-button type="info" plain :disabled="depositAvailable <= 0" @click="payFromDeposit">用{{ depositLabel }}支付</el-button>
      </template>
      <template v-else>
        <el-button type="primary" @click="saveEdit">保存修改</el-button>
        <el-button @click="cancelEdit">取消编辑</el-button>
      </template>
    </div>
    <div v-if="pendingDeposit" class="pay-hint deposit-tip">
      本单已记满未{{ kind === 'payable' ? '付' : '收' }}金额，超出部分 <b>¥ {{ pendingDeposit.amount.toFixed(2) }}</b> 将存入{{ kind === 'payable' ? '供应商预付款' : '客户预存款' }}（点「保存」生效）
    </div>
    <div class="pay-hint">提示：记一笔后先入列表，点「保存」统一生效；点「结清」自动记一笔剩余全部金额并标记结清；填好实际金额点「抹零结清」，不足部分自动转为优惠并结清；超额收付时本单记满未收金额、超出部分转入预存款；点「用{{ depositLabel }}支付」可从{{ depositLabel }}余额中抵扣货款（余额不足时按可用额扣减）。<span v-if="editingIndex >= 0" class="editing-tip">正在编辑第 {{ editingIndex + 1 }} 笔，金额上限为「应收 − 其他各笔合计」。</span></div>

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
  kind: { type: String, default: 'receivable' }, // 'receivable' 销售单收款 | 'payable' 采购单付款
  depositBalance: { type: Number, default: 0 } // 客户预存款/供应商预付款可用余额，用于「用预存款支付」抵扣
})
const emit = defineEmits(['update:modelValue', 'saved'])

const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v)
})

const kindLabel = computed(() => props.kind === 'payable' ? '付款' : '收款')
// 预存款（客户）/预付款（供应商）文案与可用余额
const depositLabel = computed(() => props.kind === 'payable' ? '预付款' : '预存款')
const depositAvailable = computed(() => Math.max(0, Number(props.depositBalance) || 0))
const rows = ref([])
const dirty = ref(false)
const draft = ref({ date: '', amount: null, remark: '' })
// 正在编辑的流水下标，-1 表示未进入编辑（此时表单用于「记一笔」）
const editingIndex = ref(-1)
// 超额收付时待转入预存款/预付款的流水：{ date, amount, remark, time }，保存时交由父组件写入对应档案
const pendingDeposit = ref(null)

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
    pendingDeposit.value = null
    dirty.value = false
  }
})

function addOne() {
  const amount = Number(draft.value.amount || 0)
  if (!amount || amount <= 0) return ElMessage.warning('请输入收款/付款金额')
  const remain = round2(unpaid.value)
  if (amount > remain + 1e-6) {
    // 超额收付：本单记满未收/未付金额，超出部分转预存款/预付款（保存时写入对应档案）
    if (remain <= 0) return ElMessage.warning(`本单已无未${kindLabel.value === '付款' ? '付' : '收'}金额，无需再记`)
    const date = draft.value.date || new Date().toISOString().slice(0, 10)
    rows.value.push({ date, amount: remain, remark: draft.value.remark || '', time: new Date().toISOString(), _new: true })
    pendingDeposit.value = {
      date,
      amount: round2(amount - remain),
      remark: draft.value.remark || `超${kindLabel.value === '付款' ? '付' : '收'}转${props.kind === 'payable' ? '预付款' : '预存款'}`,
      time: new Date().toISOString()
    }
    dirty.value = true
    draft.value.amount = null
    draft.value.remark = ''
    ElMessage.success(`本单已记满未${kindLabel.value === '付款' ? '付' : '收'}金额，超出 ¥${round2(amount - remain).toFixed(2)} 将存入${props.kind === 'payable' ? '供应商预付款' : '客户预存款'}`)
    return
  }
  rows.value.push({
    date: draft.value.date || new Date().toISOString().slice(0, 10),
    amount,
    remark: draft.value.remark || '',
    time: new Date().toISOString(),
    _new: true
  })
  dirty.value = true
  // 默认带入剩余未收，方便连续录入
  draft.value.amount = Math.max(0, unpaid.value - amount) || null
  draft.value.remark = ''
}

// 用预存款/预付款抵扣货款：从对应档案余额扣减，记一笔「来源=预存款」的流水（金额计入实收/实付）
// 保存时父组件据此从客户预存款/供应商预付款余额中扣减对应金额，并在往来账/预存款页体现
function payFromDeposit() {
  if (editingIndex.value >= 0) return ElMessage.warning('正在编辑流水，请先取消编辑')
  if (depositAvailable.value <= 0) return ElMessage.warning(`该${props.kind === 'payable' ? '供应商' : '客户'}暂无可用${depositLabel.value}`)
  const remain = round2(unpaid.value)
  if (remain <= 0) return ElMessage.warning(`本单已无未${kindLabel.value === '付款' ? '付' : '收'}金额`)
  const entered = Number(draft.value.amount || 0)
  // 填了金额用填写值，否则默认抵扣「剩余未收」与「可用余额」中的较小值；最终不超过两者
  let amount = entered > 0 ? entered : Math.min(remain, depositAvailable.value)
  amount = round2(Math.min(amount, remain, depositAvailable.value))
  if (amount <= 0) return ElMessage.warning('抵扣金额无效')
  const date = draft.value.date || new Date().toISOString().slice(0, 10)
  rows.value.push({
    date,
    amount,
    remark: draft.value.remark || `用${depositLabel.value}抵扣`,
    time: new Date().toISOString(),
    fromDeposit: true,
    _new: true
  })
  dirty.value = true
  draft.value.amount = null
  draft.value.remark = ''
  ElMessage.success(`已用${depositLabel.value}抵扣 ¥${amount.toFixed(2)}（点「保存」生效）`)
}

// 一键结清：把剩余未收/未付金额记为一笔流水并保存（syncPayments 按金额自动判定结清）
async function settleFull() {
  if (editingIndex.value >= 0) return ElMessage.warning('正在编辑流水，请先取消编辑')
  const remain = round2(unpaid.value)
  if (remain <= 0) return ElMessage.warning(`本单已无未${kindLabel.value === '付款' ? '付' : '收'}金额`)
  rows.value.push({
    date: draft.value.date || new Date().toISOString().slice(0, 10),
    amount: remain,
    remark: draft.value.remark || `结清${kindLabel.value}`,
    time: new Date().toISOString(),
    _new: true
  })
  dirty.value = true
  draft.value.amount = null
  draft.value.remark = ''
  await saveAll()
}

// 抹零结清：按填写的金额记一笔；不足应收/应付的差额自动计入整单优惠并标记结清
function settleRound() {
  if (editingIndex.value >= 0) return ElMessage.warning('正在编辑流水，请先取消编辑')
  const amount = Number(draft.value.amount || 0)
  if (!amount || amount <= 0) return ElMessage.warning('请先填写实际收/付金额，再点「抹零结清」')
  const paidTotal = round2(paidSum.value + amount)
  if (paidTotal > due.value + 1e-6) {
    return ElMessage.warning(`金额超过${kindLabel.value === '付款' ? '应付' : '应收'}金额；如需多收请用「记一笔」，超出部分会转入预存款`)
  }
  rows.value.push({
    date: draft.value.date || new Date().toISOString().slice(0, 10),
    amount,
    remark: draft.value.remark || `抹零${kindLabel.value}`,
    time: new Date().toISOString(),
    _new: true
  })
  dirty.value = true
  const gap = round2(due.value - paidTotal)
  const order = { ...props.order, payments: rows.value.map(p => ({ ...p })) }
  // 不足部分直接计入整单优惠（核销尾款），syncPayments 按金额自动判定结清
  if (gap > 0) order.discount = round2(Number(order.discount || 0) + gap)
  draft.value.amount = null
  draft.value.remark = ''
  const dep = pendingDeposit.value
  pendingDeposit.value = null
  emit('saved', syncPayments(order, props.kind), {
    add: dep && Number(dep.amount) > 0 ? dep : null,
    deduct: null,
    newRows: collectNewRows()
  })
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

// 收集本次保存会话新增的流水（标记 _new），用于父组件逐笔生成资金单据；收集后清标记
function collectNewRows() {
  const out = rows.value
    .filter(r => r._new)
    .map(r => ({ date: r.date || '', amount: Number(r.amount || 0), remark: r.remark || '', fromDeposit: !!r.fromDeposit }))
  rows.value.forEach(r => { if (r._new) delete r._new })
  return out
}

function removeRow(idx) {
  // 删除后同步修正编辑下标：删的是正在编辑行则退出编辑，删在前方则前移
  if (editingIndex.value === idx) cancelEdit()
  else if (editingIndex.value > idx) editingIndex.value -= 1
  rows.value.splice(idx, 1)
  // 待转预存款与已记满的流水是配套的：删了流水就一并取消，避免出现「没有对应收款却入账预存款」
  if (pendingDeposit.value) {
    pendingDeposit.value = null
    ElMessage.info('已同时取消转入预存款的超额部分')
  }
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
  // 超额收付的预存款流水随保存一并交给父组件写入对应档案（客户预存款/供应商预付款）
  const dep = pendingDeposit.value
  pendingDeposit.value = null
  // 用预存款/预付款抵扣的部分：按标记来源的行汇总，保存时从对应档案余额扣减
  const deductTotal = round2(rows.value.filter(r => r.fromDeposit).reduce((s, r) => s + Number(r.amount || 0), 0))
  emit('saved', updated, {
    add: dep && Number(dep.amount) > 0 ? dep : null,
    deduct: deductTotal > 0 ? {
      date: props.order.date || new Date().toISOString().slice(0, 10),
      amount: deductTotal,
      remark: `抵扣 ${props.order.id || ''} 货款`,
      time: new Date().toISOString()
    } : null,
    newRows: collectNewRows()
  })
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
.deposit-tip { color:var(--color-success); }
.editing-tip { margin-left: 6px; color:var(--color-warning); }
.discount { color:var(--color-success); }
.deposit { color:var(--color-success); }
.is-editing { font-weight: 600; }
.debt { color:var(--color-danger); }
.zero { color:var(--color-success); }
</style>
