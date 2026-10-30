<template>
  <el-card v-loading="loading">
    <template #header><b>退货 / 退款</b></template>
    <el-alert title="默认退现金；冲欠款、转余额不计现金流。退款记录不可直接修改或删除。" type="info" :closable="false" />
    <div class="toolbar">
      <el-radio-group v-model="kind" @change="resetSelection"><el-radio-button value="sale">销售退货 / 退给客户</el-radio-button><el-radio-button value="purchase">采购退货 / 收供应商退款</el-radio-button></el-radio-group>
      <el-button type="primary" :disabled="!ready" @click="openCreate">新增退货</el-button>
      <el-button :disabled="!ready || !returns.length" @click="toggleSelectAll">{{ allSelected ? '取消全选' : '全选' }}</el-button>
      <el-button :disabled="!ready || !selected.length" @click="openSettle">所选退货单退款</el-button>
      <el-button @click="$router.push('/vouchers')">查看退款凭证</el-button>
      <el-button :disabled="loading" @click="load">刷新</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-table :data="returns" row-key="id" @selection-change="selected = $event" ref="table">
      <el-table-column type="selection" width="45" />
      <el-table-column label="退货单号" min-width="190"><template #default="{ row }"><router-link :to="`${kind === 'sale' ? '/sale/' : '/purchase/'}${row.id}`" :class="{ 'return-code': isReturnId(row.id) }">{{ row.id }}</router-link></template></el-table-column>
      <el-table-column :prop="partyKey" label="往来单位" min-width="160" />
      <el-table-column prop="date" label="日期" width="110" />
      <el-table-column label="退货金额" width="110"><template #default="{ row }">{{ Math.abs(grossOf(row)).toFixed(2) }}</template></el-table-column>
      <el-table-column label="待退 / 待抵扣" width="120"><template #default="{ row }">{{ Math.max(0, -netOf(row, accountKind)).toFixed(2) }}</template></el-table-column>
      <el-table-column label="原单号" min-width="180">
        <template #default="{ row }"><router-link v-if="row.sourceOrderId" :to="`${kind === 'sale' ? '/sale/' : '/purchase/'}${row.sourceOrderId}`">{{ row.sourceOrderId }}</router-link><span v-else>—</span></template>
      </el-table-column>
      <el-table-column prop="returnReason" label="原因" min-width="120" />
    </el-table>
    <el-empty v-if="ready && !returns.length" description="暂无退货单" />
  </el-card>
  <el-dialog v-model="dialog" :title="action === 'create' ? '新增退货' : '登记退款 / 核销'" width="min(900px, 96vw)" :close-on-click-modal="false" :close-on-press-escape="false" :show-close="!saving && !retryLocked">
    <el-form label-width="100px" :disabled="saving || retryLocked">
      <template v-if="action === 'create'">
        <el-form-item label="原单" required><el-select v-model="sourceId" filterable style="width:100%" @change="chooseSource"><el-option v-for="o in sources" :key="o.id" :value="o.id" :label="`${o.id} · ${o[partyKey]} · ${o.date}`" /></el-select></el-form-item>
        <div class="lines-head">
          <span>退货明细</span>
          <el-button size="small" :disabled="!lines.length" @click="fillFullReturn">本单全退</el-button>
        </div>
        <el-table :data="lines" max-height="320">
          <el-table-column prop="name" label="商品" min-width="160" /><el-table-column prop="available" label="可退数量" width="100" />
          <el-table-column label="本次退货数量" width="160"><template #default="{ row }"><el-input-number v-model="row.returnQty" :min="0" :max="row.available" :controls="false" style="width:135px" /></template></el-table-column>
          <el-table-column label="折后可退金额" width="130"><template #default="{ row }">{{ row.remainingMoney.toFixed(2) }}</template></el-table-column>
        </el-table>
        <el-form-item label="退货原因" required><el-input v-model="reason" maxlength="500" /></el-form-item>
        <el-form-item label="本次退货额">¥ {{ previewAmount.toFixed(2) }}（按原单折后净额计算）</el-form-item>
      </template>
      <template v-else><p>所选 {{ selected.length }} 张，待退合计 ¥ {{ selectedDue.toFixed(2) }}</p><el-form-item label="本次金额" required><el-input-number v-model="amount" :min="0.01" :max="selectedDue" :precision="2" :controls="false" /><el-button link type="primary" style="margin-left:8px" @click="amount = selectedDue">全额退款</el-button></el-form-item></template>
      <el-form-item label="处理方式"><el-select v-model="mode"><el-option label="退现金（实际收付）" value="cash" /><el-option label="冲抵同单位欠款（先旧单）" value="offset" /><el-option label="转预存款 / 预付款" value="deposit" /><el-option v-if="action === 'create'" label="先退货，暂不退款" value="pending" /></el-select></el-form-item>
      <el-form-item label="日期" required><el-date-picker v-model="date" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="备注"><el-input v-model="remark" maxlength="1000" /></el-form-item>
      <el-alert v-if="mode === 'cash'" :title="kind === 'sale' ? '确认已将现金退给客户后再保存；不会自动执行银行转账。' : '确认已收到供应商退款后再保存；不会自动执行银行转账。'" type="warning" :closable="false" />
    </el-form>
    <template #footer><el-button :disabled="saving || retryLocked" @click="dialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">确认保存</el-button></template>
  </el-dialog>
</template>
<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { isReturn, isReturnId, returnableLines } from '../utils/refunds.js'
import { grossOf, netOf, round2, isVoided } from '../utils/account.js'
import { todayCN } from '../utils/time.js'
const route = useRoute()
const kind = ref(route.query.kind === 'purchase' ? 'purchase' : 'sale')
const sales = ref([]), purchases = ref([]), loading = ref(false), ready = ref(false), error = ref('')
const selected = ref([]), table = ref(null), dialog = ref(false), saving = ref(false), retryLocked = ref(false)
const action = ref('create'), sourceId = ref(''), lines = ref([]), reason = ref('无'), mode = ref('cash'), amount = ref(0), date = ref(''), remark = ref('')
const pendingKey = 'stock.refund.pending'
let requestId = '', pendingInput = null
// 作废单不能退货：金额与库存都已回滚，再退一次等于重复冲销
const orders = computed(() => (kind.value === 'sale' ? sales.value : purchases.value || []).filter(o => !isVoided(o)))
const partyKey = computed(() => kind.value === 'sale' ? 'customer' : 'supplier')
const accountKind = computed(() => kind.value === 'sale' ? 'receivable' : 'payable')
const returns = computed(() => orders.value.filter(isReturn))
const sources = computed(() => orders.value.filter(o => !isReturn(o)))
const selectedDue = computed(() => round2(selected.value.reduce((s, o) => s + Math.max(0, -netOf(o, accountKind.value)), 0)))
const allSelected = computed(() => returns.value.length > 0 && selected.value.length === returns.value.length)
const previewAmount = computed(() => round2(lines.value.reduce((s, l) => s + (Number(l.returnQty) > 0 ? (Math.abs(l.returnQty - l.available) < 1e-8 ? l.remainingMoney : round2(l.lineNet * l.returnQty / l.qty)) : 0), 0)))
async function load() {
  loading.value = true; ready.value = false; error.value = ''
  try { [sales.value, purchases.value] = await Promise.all([api.getSales(), api.getPurchases()]); ready.value = true; resetSelection() }
  catch (e) { error.value = `读取失败：${e.message}` }
  finally { loading.value = false }
}
function resetSelection() { selected.value = []; table.value?.clearSelection() }
// 全选/取消全选当前类型的退货单；只作用于表格里实际展示的退货单，避免误选正常销售/采购单
function toggleSelectAll() {
  if (!table.value) return
  if (allSelected.value) { table.value.clearSelection(); return }
  returns.value.forEach(row => table.value.toggleRowSelection(row, true))
}
// 本单全退：把原单每一行的剩余可退数量一次填满，金额仍按原单折后净额计算
function fillFullReturn() {
  lines.value = lines.value.map(l => ({ ...l, returnQty: Number(l.available) > 0 ? l.available : 0 }))
}
function resetForm() { requestId = crypto.randomUUID(); pendingInput = null; retryLocked.value = false; mode.value = 'cash'; date.value = todayCN(); remark.value = ''; reason.value = '无' }
function chooseSource() { const o = orders.value.find(o => o.id === sourceId.value); lines.value = o ? returnableLines(o, orders.value).map(l => ({ ...l, returnQty: 0 })) : [] }
function openCreate() { resetForm(); action.value = 'create'; sourceId.value = ''; lines.value = []; dialog.value = true }
function openSettle() {
  if (new Set(selected.value.map(o => o[partyKey.value])).size !== 1) return ElMessage.warning('请选择同一往来单位的退货单')
  if (selectedDue.value <= 0) return ElMessage.warning('所选单据已结清')
  resetForm(); action.value = 'settle'; amount.value = selectedDue.value; dialog.value = true
}
async function save() {
  if (saving.value) return
  if (!pendingInput) {
    if (action.value === 'create' && (!sourceId.value || !reason.value.trim() || !lines.value.some(l => l.returnQty > 0))) return ElMessage.warning('请选择原单、退货数量并填写原因')
    pendingInput = { action: action.value, kind: kind.value, requestId, date: date.value, mode: mode.value, remark: remark.value,
      sourceOrderId: sourceId.value, reason: reason.value, lines: lines.value.filter(l => l.returnQty > 0).map(l => ({ index: l.index, qty: l.returnQty })),
      orderIds: selected.value.map(o => o.id), amount: amount.value }
  }
  saving.value = true
  try {
    await ElMessageBox.confirm('确认登记本次退货/退款？保存后不可直接修改或删除。', '确认', { type: 'warning' })
    sessionStorage.setItem(pendingKey, JSON.stringify(pendingInput))
    const result = await api.saveRefundOperation(pendingInput)
    sessionStorage.removeItem(pendingKey)
    dialog.value = false; pendingInput = null; retryLocked.value = false
    ElMessage.success(`已保存：${result.code}`)
    await load()
  } catch (e) {
    if (e === 'cancel' || e === 'close') { if (!retryLocked.value) pendingInput = null }
    else if (e.status && e.status < 500) { sessionStorage.removeItem(pendingKey); pendingInput = null; retryLocked.value = false; ElMessage.error(e.status === 409 ? '数据已被其他操作更新，请取消并刷新后重试' : e.message) }
    else { retryLocked.value = true; ElMessage.error(`${e.message}；结果不明，表单已锁定。请用同一请求重试，勿重新录入。`) }
  } finally { saving.value = false }
}
onMounted(async () => {
  await load()
  const stored = sessionStorage.getItem(pendingKey)
  if (stored) {
    try { pendingInput = JSON.parse(stored) }
    catch { error.value = '待确认退款请求损坏，请核实凭证后处理，勿重复录入'; ready.value = false; return }
    kind.value = pendingInput.kind; action.value = pendingInput.action; requestId = pendingInput.requestId
    sourceId.value = pendingInput.sourceOrderId; mode.value = pendingInput.mode; date.value = pendingInput.date
    reason.value = pendingInput.reason; remark.value = pendingInput.remark; amount.value = pendingInput.amount
    chooseSource()
    lines.value.forEach(l => { l.returnQty = pendingInput.lines?.find(p => p.index === l.index)?.qty || 0 })
    selected.value = orders.value.filter(o => pendingInput.orderIds?.includes(o.id))
    retryLocked.value = true; dialog.value = true
    ElMessage.warning('发现上次结果待确认的退款，已恢复原请求。请确认保存以安全重试。')
  } else if (ready.value && route.query.source) { openCreate(); sourceId.value = String(route.query.source); chooseSource() }
})
</script>
<style scoped>.toolbar { display:flex; flex-wrap:wrap; gap:12px; margin:18px 0; } .el-form-item { margin-top:16px; } .lines-head { display:flex; align-items:center; justify-content:space-between; margin:-4px 0 8px; font-size:13px; color:var(--text-regular); }</style>
