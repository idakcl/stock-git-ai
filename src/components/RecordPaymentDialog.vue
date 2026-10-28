<template>
  <el-dialog v-model="visible" title="记一笔（收/付款）" width="900" @open="onOpen">
    <el-form label-width="96px" class="rec-form">
      <el-form-item label="类型" required>
        <el-radio-group v-model="type">
          <el-radio-button value="receivable">客户收款</el-radio-button>
          <el-radio-button value="payable">供应商付款</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="type === 'payable' ? '供应商' : '客户'" required>
        <el-select v-model="name" filterable :placeholder="`选择${type === 'payable' ? '供应商' : '客户'}`" style="width:100%" @change="onPartyChange">
          <el-option v-for="p in partyOptions" :key="p" :label="p" :value="p" />
        </el-select>
      </el-form-item>
      <el-form-item label="收付金额" required>
        <div class="rec-amount">
          <el-input-number v-model="amount" :min="0" :max="99999999" :precision="2" :controls="false" class="rec-amount-input" />
          <el-button size="small" :disabled="selectedDue <= 0.005" @click="fillSelected">按所选未结合计填入</el-button>
        </div>
        <!-- 三个数一条链实时联动：所选未结合计（优惠后）→ 本次优惠 → 结清张数 → 收付金额差额 -->
        <span class="rec-hint">
          所选 <b>{{ selectedRows.length }}</b> 张 ·
          未结合计 ¥ <b class="rec-due">{{ dueBeforeDiscount.toFixed(2) }}</b> − 本单优惠 ¥ <b class="rec-disc">{{ discSum.toFixed(2) }}</b> =
          需{{ type === 'payable' ? '付' : '收' }} ¥ <b class="rec-due">{{ selectedDue.toFixed(2) }}</b> ·
          设为结清 <b>{{ settleCount }}</b> 张
        </span>
        <span class="rec-hint">
          <template v-if="excess > 0.005">实{{ type === 'payable' ? '付' : '收' }}超出 ¥ {{ excess.toFixed(2) }}，将转入{{ type === 'receivable' ? '客户预存款' : '供应商预付款' }}；</template>
          <template v-if="short > 0.005">还差 ¥ {{ short.toFixed(2) }}：按单据日期先后分摊，未分摊到的仍挂账（勾选「结清」的单会把差额记为优惠）；</template>
          <template v-else-if="excess <= 0.005 && selectedRows.length">金额与需{{ type === 'payable' ? '付' : '收' }}一致，{{ type === 'payable' ? '付清' : '收清' }}后自动结清；</template>
          成交后每{{ type === 'payable' ? '付' : '收' }}一笔都会生成一张资金单据（{{ type === 'payable' ? 'FK' : 'SK' }}-）
        </span>
      </el-form-item>
      <el-form-item label="日期">
        <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" placeholder="日期" style="width:100%" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="remark" placeholder="如：转账 / 现金（可空）" />
      </el-form-item>
    </el-form>

    <div class="rec-orders" v-if="displayOrders.length">
      <div class="rec-orders-title">
        <span>该单位单据（{{ displayOrders.length }} 张，勾选需处理）</span>
        <span class="bulk">
          批量设置：
          优惠 ¥<el-input-number v-model="bulkDiscount" :min="0" :precision="2" :controls="false" size="small" style="width:104px" />
          <el-button size="small" @click="applyBulkDiscount">应用到所选</el-button>
          结算
          <el-select v-model="bulkSettle" size="small" style="width:104px" @change="applyBulkSettle">
            <el-option label="请选择" value="" />
            <el-option label="结清" value="结清" />
            <el-option label="挂账" value="挂账" />
          </el-select>
          <el-button size="small" text type="primary" @click="selectAll">全选</el-button>
          <el-button size="small" text @click="clearSel">清空</el-button>
        </span>
      </div>
      <el-table ref="orderTable" :data="displayOrders" stripe size="small" max-height="300" row-key="id" :reserve-selection="true" @selection-change="onSelChange">
        <el-table-column type="selection" width="42" />
        <el-table-column prop="id" label="单号" width="170" />
        <el-table-column prop="date" label="日期" width="110" />
        <el-table-column label="未收/未付" width="108" align="right">
          <template #default="{ row }">{{ netOf(row, type).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="优惠金额" width="124">
          <template #default="{ row }">
            <!-- 封顶到「该单未收」：优惠超过欠款没有意义（多出来的既不是收款也不是应收）；
                 铺满未收时自动把该行设为「结清」，三数联动不留半挂状态 -->
            <el-input-number v-model="row._discount" :min="0" :max="netOf(row, type)" :precision="2" :controls="false" size="small" style="width:104px" @change="onDiscountChange(row)" />
          </template>
        </el-table-column>
        <el-table-column label="优惠后未收" width="110" align="right">
          <template #default="{ row }"><span :class="afterDiscountNet(row) > 0.005 ? 'debt' : 'zero'">{{ afterDiscountNet(row).toFixed(2) }}</span></template>
        </el-table-column>
        <el-table-column label="结算状态" width="104">
          <template #default="{ row }">
            <el-select v-model="row._settle" size="small" style="width:84px">
              <el-option label="挂账" value="挂账" />
              <el-option label="结清" value="结清" />
            </el-select>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <div class="rec-empty" v-else>该单位暂无未结单据</div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!canSave" @click="confirm">确认记一笔</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { netOf, round2 } from '../utils/account'
import { todayCN } from '../utils/time.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  customers: { type: Array, default: () => [] },
  suppliers: { type: Array, default: () => [] },
  salesList: { type: Array, default: () => [] },
  purchasesList: { type: Array, default: () => [] }
})
const emit = defineEmits(['update:modelValue', 'applied'])

const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v)
})

const type = ref('receivable') // 'receivable'=客户收款；'payable'=供应商付款
const name = ref('')
const amount = ref(null)
const date = ref(todayCN())
const remark = ref('')

// 批量设置控件
const bulkDiscount = ref(0)
const bulkSettle = ref('')
const orderTable = ref(null)
const selectedRows = ref([])

const onOpen = () => {
  type.value = 'receivable'
  name.value = ''
  amount.value = null
  date.value = todayCN()
  remark.value = ''
  resetBulk()
}
const onPartyChange = () => { amount.value = null; resetBulk(); clearSel() }
const resetBulk = () => { bulkDiscount.value = 0; bulkSettle.value = '' }
function clearSel() { if (orderTable.value) orderTable.value.clearSelection(); selectedRows.value = [] }
function selectAll() { if (orderTable.value) displayOrders.value.forEach(r => orderTable.value.toggleRowSelection(r, true)) }

const onSelChange = (rows) => { selectedRows.value = rows || [] }
function applyBulkDiscount() {
  const v = Number(bulkDiscount.value || 0)
  if (!(v > 0)) return ElMessage.warning('请输入大于 0 的优惠金额')
  if (!selectedRows.value.length) return ElMessage.warning('请先勾选单据')
  selectedRows.value.forEach(r => { r._discount = Math.min(v, netOf(r, type.value)); onDiscountChange(r) })
  ElMessage.success(`已为 ${selectedRows.value.length} 张单据填入优惠（各按本单未收封顶），铺满未收的已自动设为结清`)
}
function applyBulkSettle(val) {
  if (!val) return
  if (!selectedRows.value.length) return ElMessage.warning('请先勾选单据')
  selectedRows.value.forEach(r => { r._settle = val })
  ElMessage.success(`已为 ${selectedRows.value.length} 张单据设为「${val}」`)
}

const partyOptions = computed(() => {
  const list = type.value === 'payable' ? props.suppliers : props.customers
  return (list || []).map(p => p.name).filter(Boolean)
})

// 选中单位的未结单据（netOf>0），展示副本（含可编辑的 _discount / _settle，避免污染源数据）
const partyOrders = computed(() => {
  if (!name.value) return []
  const src = type.value === 'receivable' ? props.salesList : props.purchasesList
  const partyKey = type.value === 'receivable' ? 'customer' : 'supplier'
  return (src || []).filter(o => o[partyKey] === name.value && netOf(o, type.value) > 1e-6)
})
const displayOrders = computed(() => partyOrders.value.map(o => ({ ...o, _discount: 0, _settle: '挂账' })))

// 优惠后未收 = 应用本单新增优惠后的净额（仅展示，保存时才落库）
const afterDiscountNet = (row) => netOf({ ...row, discount: round2(Number(row.discount || 0) + Number(row._discount || 0)) }, type.value)

// 所选未结合计（优惠前）：与「优惠合计」「优惠后需收付」构成同一条联动链，三者始终对得上
const dueBeforeDiscount = computed(() => round2(selectedRows.value.reduce((s, r) => s + netOf(r, type.value), 0)))
const discSum = computed(() => round2(selectedRows.value.reduce((s, r) => s + Math.min(Number(r._discount || 0), netOf(r, type.value)), 0)))
const settleCount = computed(() => selectedRows.value.filter(r => r._settle === '结清').length)
// 所选未结合计（优惠后）：随逐单「优惠金额」「结算状态=结清」实时联动
//   · 结清：差额将抹零，不计入需现金未收（贡献 0）
//   · 否则按 max(0, 未收 − 本单优惠) 计入
const selectedDue = computed(() => round2(selectedRows.value.reduce((s, r) => {
  if (r._settle === '结清') return s
  return s + Math.max(0, netOf(r, type.value) - Number(r._discount || 0))
}, 0)))
const excess = computed(() => round2(Math.max(0, Number(amount.value || 0) - selectedDue.value)))
// 不足额：还差多少没收到（按日期先后分摊，摊不到的继续挂账），与「超出转预存」互为镜像
const short = computed(() => round2(Math.max(0, selectedDue.value - Number(amount.value || 0))))

// 优惠铺满本单未收 → 该行自动设为结清：避免「已全免却还挂着账」这种自相矛盾的状态
function onDiscountChange(row) {
  const d = Math.min(Number(row._discount || 0), netOf(row, type.value))
  row._discount = d
  if (d > 0 && netOf(row, type.value) - d <= 0.005) row._settle = '结清'
}

// 一键把「优惠后需收付合计」填进金额框：结清的单据不贡献现金，填进去正好收清所选
function fillSelected() {
  amount.value = selectedDue.value > 0 ? selectedDue.value : null
}
const hasDiscOrSettle = computed(() => selectedRows.value.some(r => Number(r._discount || 0) > 0 || r._settle === '结清'))
const canSave = computed(() => !!name.value && selectedRows.value.length > 0 && (Number(amount.value || 0) > 0 || hasDiscOrSettle.value))

function confirm() {
  if (!name.value) return ElMessage.warning('请选择往来单位')
  if (!selectedRows.value.length) return ElMessage.warning('请勾选至少一张单据')
  const discounts = {}
  const settleIds = []
  for (const r of selectedRows.value) {
    if (Number(r._discount || 0) > 0) discounts[r.id] = round2(Number(r._discount))
    if (r._settle === '结清') settleIds.push(r.id)
  }
  if (!(Number(amount.value || 0) > 0) && !Object.keys(discounts).length && !settleIds.length) {
    return ElMessage.warning('请输入收/付款金额，或设置优惠 / 结清')
  }
  // 产出与 BatchPayDialog 同构的单组 payload，并附逐单优惠与结清标记，交由父组件统一写回
  emit('applied', [{
    party: name.value,
    kind: type.value,
    amount: Number(amount.value || 0),
    date: date.value || todayCN(),
    remark: remark.value || '',
    orderIds: selectedRows.value.map(r => r.id),
    discounts,
    settleIds
  }])
  visible.value = false
}
</script>

<style scoped>
.rec-form { margin-top: 8px; }
.rec-hint { display: block; margin-left: 12px; color: var(--text-secondary); font-size: var(--fs-sub); line-height: 1.7; }
.rec-amount { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; width: 100%; min-width: 0; }
.rec-amount-input { width: 180px; max-width: 100%; }
.rec-amount .el-button { max-width: 100%; height: auto; padding: 6px 10px; white-space: normal; line-height: 1.5; }
@media (max-width: 600px) {
  .rec-amount { flex-direction: column; align-items: flex-start; }
  .rec-amount-input { width: 100%; }
  .rec-hint { margin-left: 0; }
}
.rec-disc { color: var(--color-success); }
.rec-due { color: var(--color-danger); }
.rec-orders { margin-top: 8px; }
.rec-orders-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: var(--fs-sub); color: var(--text-secondary); margin-bottom: 6px; }
.bulk { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.rec-empty { color: var(--text-placeholder); font-size: var(--fs-sub); padding: 8px 0; }
.debt { color: var(--color-danger); font-weight: 600; }
.zero { color: var(--color-success); font-weight: 600; }
</style>
