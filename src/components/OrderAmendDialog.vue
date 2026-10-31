<template>
  <!-- 单据变更：已动过钱的单不能原地改明细（金额、库存、已开收付款凭证会同时错位），
       改成「原单不动 + 生成关联单」：减少的商品开退货单（XT-/CT-，走退款四档处理），
       新增的商品开补差单（XA-/CA-，正常挂账）。原单与两张新单都靠 sourceOrderId 串起来。 -->
  <el-dialog
    v-model="visible"
    append-to-body
    :title="`变更明细 · ${source?.id || ''}`"
    width="min(920px, 96vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="!(saving || retryLocked)"
    :show-close="!(saving || retryLocked)"
  >
    <el-alert
      type="info"
      :closable="false"
      title="变更不会改动原单：减少的商品生成退货单、新增的商品生成补差单，两张单都关联本单，库存与应收/应付自动跟上。变更不允许改价，要改价请另开新单。"
    />
    <el-alert v-if="!source" type="error" :closable="false" title="原单不存在，请刷新后重试" />

    <el-form v-else label-width="110px" :disabled="saving || retryLocked">
      <el-form-item :label="partyLabel">
        <el-input :model-value="party" disabled />
      </el-form-item>
      <el-form-item label="日期"><el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" /></el-form-item>

      <div class="section-head">
        <span>① 要减少的商品（退货）</span>
        <el-button size="small" :disabled="!returnable.length" @click="fillAllReturn">本单全退</el-button>
      </div>
      <div class="lines-scroll">
        <el-table :data="returnable" max-height="260">
          <el-table-column prop="name" label="商品" min-width="150" />
          <el-table-column label="原数量" width="90" align="right"><template #default="{ row }">{{ row.qty }}</template></el-table-column>
          <el-table-column label="已退" width="80" align="right"><template #default="{ row }">{{ row.returnedQty || 0 }}</template></el-table-column>
          <el-table-column label="可退" width="80" align="right"><template #default="{ row }">{{ row.available }}</template></el-table-column>
          <el-table-column label="本次退货" width="120" align="right">
            <template #default="{ row }">
              <el-input-number v-model="row.returnQty" :min="0" :max="row.available" :controls="false" size="small" style="width:100%" />
            </template>
          </el-table-column>
          <el-table-column label="折后可退金额" width="120" align="right">
            <template #default="{ row }">{{ row.remainingMoney.toFixed(2) }}</template>
          </el-table-column>
        </el-table>
      </div>

      <div class="section-head">
        <span>② 要新增的商品（补差）</span>
        <el-button size="small" @click="addLine">添加行</el-button>
      </div>
      <div class="lines-scroll">
        <el-table :data="extra" max-height="240">
          <el-table-column label="商品" min-width="180">
            <template #default="{ row }">
              <GoodsSelect v-model="row.code" :items="items" placeholder="选择商品" style="width:100%" @change="onItemChange(row)" />
            </template>
          </el-table-column>
          <el-table-column label="数量" width="110" align="right">
            <template #default="{ row }"><el-input-number v-model="row.qty" :min="1" size="small" style="width:100%" v-select-on-focus /></template>
          </el-table-column>
          <el-table-column label="单价" width="130" align="right">
            <template #default="{ row }">
              <el-input-number v-model="row.price" :min="0" :precision="2" size="small" style="width:100%" :disabled="lockedPrice(row.code) !== null" v-select-on-focus />
            </template>
          </el-table-column>
          <el-table-column label="金额" width="100" align="right">
            <template #default="{ row }">{{ (Number(row.qty || 0) * Number(row.price || 0)).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="" width="60">
            <template #default="{ $index }"><el-button size="small" type="danger" @click="extra.splice($index, 1)">×</el-button></template>
          </el-table-column>
        </el-table>
      </div>
      <div v-if="lockedRows.length" class="calc-hint" style="margin-top:6px">
        以下商品原单已有，单价锁定为原价：{{ lockedRows.join('、') }}（沿用原单价，避免同一商品两个价）
      </div>

      <el-form-item label="处理方式" class="amend-mode">
        <!-- 只有真的要退钱时才问处理方式；纯新增商品（补差）直接挂账，不涉及退款 -->
        <el-select v-model="mode" :disabled="refundAmount <= 0" style="width:260px">
          <el-option label="退现金（实际收付）" value="cash" />
          <el-option label="冲抵同单位欠款（先旧单）" value="offset" />
          <el-option label="转预存款 / 预付款" value="deposit" />
          <el-option label="先退货，暂不退款" value="pending" />
        </el-select>
        <div class="calc-hint" style="margin-top:4px">
          {{ refundAmount > 0
            ? '退货金额按原单折后净额计算；「先退货，暂不退款」会留在待退里，之后在退货页统一核销。'
            : '本次没有需要退还的金额，处理方式暂不适用（只新增商品时直接挂账）。' }}
        </div>
      </el-form-item>
      <el-form-item v-if="mode === 'cash'" label=" ">
        <el-alert :title="kind === 'sale' ? '确认已将现金退给客户后再保存；不会自动执行银行转账。' : '确认已收到供应商退款后再保存；不会自动执行银行转账。'" type="warning" :closable="false" />
      </el-form-item>
      <el-form-item label="变更原因" required><el-input v-model="reason" maxlength="500" /></el-form-item>
      <el-form-item label="备注"><el-input v-model="remark" type="textarea" :rows="2" maxlength="1000" /></el-form-item>

      <div class="preview">
        <div class="pv-row"><span>原单{{ dueWord }}金额</span><b>¥ {{ sourceGross.toFixed(2) }}</b></div>
        <div class="pv-row"><span>本次退货（{{ refundQty || 0 }} 件）</span><b class="minus">− ¥ {{ refundAmount.toFixed(2) }}</b></div>
        <div class="pv-row"><span>本次补差（按原价，不含折扣）</span><b class="plus">+ ¥ {{ amendTotal.toFixed(2) }}</b></div>
        <div class="pv-row total"><span>变更后净成交金额</span><b>¥ {{ netAmount.toFixed(2) }}</b></div>
        <div v-if="mode !== 'pending' && refundAmount > 0" class="pv-note">
          退货部分 ¥{{ refundAmount.toFixed(2) }} 按所选方式单独记账（退现金／冲欠款／转预存），不影响上面的净成交金额。
        </div>
      </div>
      <el-alert v-if="!diff.ok" :title="diff.error" type="error" :closable="false" class="pv-error" />
      <el-alert v-else-if="diff.untouched" title="明细没有变化：填了退货数量或新增了商品行才会生成单据。" type="warning" :closable="false" class="pv-error" />
    </el-form>

    <template #footer>
      <span v-if="retryLocked" class="retry-hint">上次提交结果不明，表单已锁定——请核对下方信息后点「重试提交」（同一请求号，不会重复生成单据）。</span>
      <el-button :disabled="saving" @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!canSubmit" @click="submit">{{ retryLocked ? '重试提交' : '确认变更' }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { round2, grossOf } from '../utils/account.js'
import { returnableLines } from '../utils/refunds.js'
import { diffOrderLines, refundPreview } from '../utils/amend.js'
import { todayCN } from '../utils/time.js'
import GoodsSelect from './GoodsSelect.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 要变更的原单（正常销售/采购单，退货单与补差单不走这里）
  order: { type: Object, default: null },
  // 同类型全部单据：算剩余可退、生成关联单号都要看全量
  list: { type: Array, default: () => [] },
  items: { type: Array, default: () => [] },
  // sale=销售 / purchase=采购
  kind: { type: String, default: 'sale' }
})
const emit = defineEmits(['update:modelValue', 'amended'])

const visible = computed({ get: () => props.modelValue, set: (v) => emit('update:modelValue', v) })

const isPurchase = computed(() => props.kind === 'purchase')
const partyLabel = computed(() => (isPurchase.value ? '供应商' : '客户'))
const partyKey = computed(() => (isPurchase.value ? 'supplier' : 'customer'))
const dueWord = computed(() => (isPurchase.value ? '应付' : '应收'))

// 父组件在「没有编辑中的单」时也会渲染本组件，props.order 可能是空对象——按 id 判定才算有原单
const source = computed(() => (props.order && props.order.id ? props.order : null))
const party = computed(() => source.value?.[partyKey.value] || '')

const returnable = ref([])
const extra = ref([])
const date = ref(todayCN())
const reason = ref('')
const remark = ref('')
const mode = ref('cash')
const saving = ref(false)
const retryLocked = ref(false)
// 请求号一次打开只生成一次：重试、页面刷新后恢复都沿用同一个，服务端按它幂等
let requestId = ''
let pendingInput = null
const pendingKey = 'stock.amend.pending'

const sourceGross = computed(() => (source.value ? grossOf(source.value) : 0))
// 退货行按「原单行索引」定位，编辑时只存一个数量，其余交给 diffOrderLines 复用服务端同一口径
function lineQty(index) {
  const row = returnable.value.find(l => l.index === index)
  return row ? Number(row.returnQty || 0) : 0
}

// 改后明细 = 原单各行减去退货量（减到 0 的行删掉）+ 新增行
const editedItems = computed(() => {
  if (!source.value) return []
  const kept = (source.value.items || [])
    .map((l, index) => ({ l, index }))
    .map(({ l, index }) => {
      const qty = round2(Number(l.qty || 0) - lineQty(index))
      return qty > 0 ? { ...l, qty, total: round2(qty * Number(l.price || 0)) } : null
    })
    .filter(Boolean)
  const added = extra.value
    .filter(l => l.code && Number(l.qty || 0) > 0)
    .map(l => ({ code: l.code, name: l.name, unit: l.unit || '', qty: Number(l.qty), price: Number(l.price || 0), total: round2(Number(l.qty || 0) * Number(l.price || 0)) }))
  return [...kept, ...added]
})

const diff = computed(() => {
  if (!source.value) return { ok: false, error: '原单不存在', refundLines: [], amendLines: [], refundQty: 0, amendTotal: 0, untouched: true }
  return diffOrderLines(source.value, editedItems.value, props.list || [])
})
const refundAmount = computed(() => (diff.value.ok && source.value ? refundPreview(source.value, diff.value.refundLines, props.list || []) : 0))
const refundQty = computed(() => diff.value.refundQty || 0)
const amendTotal = computed(() => diff.value.amendTotal || 0)
const netAmount = computed(() => round2(sourceGross.value - refundAmount.value + amendTotal.value))

// 原单已有的编码：单价锁定为原单价（diffOrderLines 同样按这个规则校验）
function lockedPrice(code) {
  if (!code) return null
  const prior = (source.value?.items || []).find(l => String(l.code) === String(code))
  return prior ? Number(prior.price || 0) : null
}
const lockedRows = computed(() => extra.value
  .filter(l => l.code && lockedPrice(l.code) !== null)
  .map(l => `${l.name || l.code} ¥${lockedPrice(l.code).toFixed(2)}`))

function onItemChange(row) {
  const found = (props.items || []).find(i => i.code === row.code)
  if (!found) return
  row.name = found.name
  row.unit = found.unit || ''
  // 原单已有这个编码 → 只能沿用原单价；纯新增商品才按档案价带出
  const locked = lockedPrice(row.code)
  row.price = locked !== null ? locked : Number(isPurchase.value ? (found.cost || found.price || 0) : (found.price || 0))
}
function addLine() { extra.value.push({ code: '', name: '', unit: '', qty: 1, price: 0 }) }
function fillAllReturn() { returnable.value = returnable.value.map(l => ({ ...l, returnQty: l.available })) }

const canSubmit = computed(() => {
  if (!source.value || !diff.value.ok || diff.value.untouched) return false
  if (!reason.value.trim()) return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.value || '')) return false
  return true
})

function buildInput() {
  return {
    kind: props.kind,
    requestId,
    sourceOrderId: source.value.id,
    party: party.value,
    date: date.value,
    reason: reason.value.trim(),
    remark: remark.value,
    mode: mode.value,
    // 只传行索引/数量与商品编码，金额一律由服务端按原单与商品档案重算
    refundLines: diff.value.refundLines,
    amendLines: diff.value.amendLines.map(l => ({ code: l.code, name: l.name, unit: l.unit, qty: l.qty, price: l.price }))
  }
}

function resetForm() {
  requestId = crypto.randomUUID()
  pendingInput = null
  retryLocked.value = false
  mode.value = 'cash'
  date.value = todayCN()
  reason.value = ''
  remark.value = ''
  extra.value = []
  returnable.value = source.value
    ? returnableLines(source.value, props.list || []).map(l => ({ ...l, returnQty: 0 }))
    : []
}

// 打开时优先恢复「上次结果不明」的请求，其余情况整表重建
watch(() => props.modelValue, (open) => {
  if (!open) return
  resetForm()
  const stored = sessionStorage.getItem(pendingKey)
  if (!stored || !source.value) return
  let saved = null
  try { saved = JSON.parse(stored) } catch { sessionStorage.removeItem(pendingKey); return }
  if (saved.sourceOrderId !== source.value.id) return
  pendingInput = saved
  requestId = saved.requestId
  date.value = saved.date
  reason.value = saved.reason
  remark.value = saved.remark
  mode.value = saved.mode
  extra.value = saved.amendLines.map(l => ({ ...l }))
  returnable.value = returnable.value.map(l => ({ ...l, returnQty: saved.refundLines.find(p => p.index === l.index)?.qty || 0 }))
  retryLocked.value = true
  ElMessage.warning('发现上次结果待确认的变更请求，已恢复原内容，请核对后重试提交。')
})

async function submit() {
  if (saving.value) return
  if (!pendingInput) {
    if (!canSubmit.value) return ElMessage.warning('请检查变更明细与变更原因')
    pendingInput = buildInput()
  }
  saving.value = true
  try {
    await ElMessageBox.confirm(
      `确认变更？将生成${pendingInput.refundLines.length ? ' 退货单' : ''}${pendingInput.amendLines.length ? ' 补差单' : ''}，退货单与退款记录不可直接修改或删除。`,
      '确认变更',
      { type: 'warning' }
    )
    sessionStorage.setItem(pendingKey, JSON.stringify(pendingInput))
    const result = await api.amendOrder(pendingInput)
    sessionStorage.removeItem(pendingKey)
    pendingInput = null
    retryLocked.value = false
    visible.value = false
    ElMessage.success(`已变更：${result.code || ''}`)
    emit('amended', result)
  } catch (e) {
    if (e === 'cancel' || e === 'close') { if (!retryLocked.value) pendingInput = null }
    else if (e.status && e.status < 500) { sessionStorage.removeItem(pendingKey); pendingInput = null; retryLocked.value = false; ElMessage.error(e.status === 409 ? '数据已被其他操作更新，请取消并刷新后重新发起变更' : e.message) }
    else { retryLocked.value = true; ElMessage.error(`${e.message}；结果不明，表单已锁定。请用同一请求重试，勿重新录入。`) }
  } finally { saving.value = false }
}
</script>

<style scoped>
.section-head{display:flex;align-items:center;justify-content:space-between;margin:14px 0 8px;color:var(--text-regular);font-weight:600;}
.lines-scroll{overflow-x:auto;}
.lines-scroll :deep(.el-input-number){width:100%;}
.calc-hint{color:var(--text-secondary);font-size:var(--fs-sub);line-height:1.5;}
.preview{margin-top:14px;padding:12px 14px;border:1px solid var(--border-color);border-radius:6px;}
.pv-row{display:flex;justify-content:space-between;gap:12px;color:var(--text-regular);font-size:var(--fs-table);line-height:1.9;}
.pv-row .minus{color:var(--color-danger);}
.pv-row .plus{color:var(--color-success);}
.pv-row.total{border-top:1px dashed var(--border-color);margin-top:6px;padding-top:6px;font-weight:700;}
.pv-note{margin-top:6px;color:var(--text-secondary);font-size:var(--fs-sub);line-height:1.5;}
.pv-error{margin-top:12px;}
.retry-hint{margin-right:12px;color:var(--color-danger);font-size:var(--fs-sub);}
@media (max-width: 768px){
  .lines-scroll :deep(.el-table .cell){padding-left:5px;padding-right:5px;}
}
</style>
