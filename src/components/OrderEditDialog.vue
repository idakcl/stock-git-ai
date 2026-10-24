<template>
  <!-- 采购/销售单据新增编辑弹窗：两侧仅 6 处差异（单号前缀、主体字段、文案、单价策略、
       resolveLine 传参、结清补流水方向），统一由 kind 派生，逻辑只维护一份。
       落库由父组件完成：本组件只组装 entry 并 emit('saved')，失败时弹窗保持打开便于重试 -->
  <el-dialog v-model="visible" :title="title" width="620">
    <el-form :model="form" label-width="80px">
      <el-form-item :label="partyLabel">
        <!-- 采购：供应商纯输入；销售：客户下拉（可选已有档案，也可直接新建） -->
        <el-input v-if="isPurchase" v-model="form.party" />
        <el-select
          v-else
          v-model="form.party"
          filterable
          allow-create
          default-first-option
          :placeholder="`选择或输入${partyLabel}`"
          style="width:100%"
          @change="onPartyChange"
        >
          <el-option v-for="c in customers" :key="c.code" :label="`${c.name} (${c.code})`" :value="c.name" />
        </el-select>
      </el-form-item>
      <el-form-item label="日期"><el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="结算">
        <el-radio-group v-model="form.settle">
          <el-radio-button label="挂账" />
          <el-radio-button label="结清" />
        </el-radio-group>
        <div v-if="form.settle === '结清' && unpaidAmount > 0" class="settle-hint">
          结清后未{{ payWord }}的 <b>¥{{ unpaidAmount.toFixed(2) }}</b> 将自动计入整单优惠（核销尾款，不虚增已{{ payWord }}）
        </div>
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
      <el-form-item label="单据照片">
        <!-- :key 让每次打开都重建上传区，避免上一单的照片残留 -->
        <PhotoUpload ref="photoUpload" :key="photoKey" v-model="form.photos" />
      </el-form-item>
      <el-form-item label="整单优惠">
        <el-input-number v-model="form.discount" :min="0" :precision="2" :controls="false" style="width:100%" />
      </el-form-item>
      <!-- 实付/实收为只读：不在表单里改，统一走「付款/收款」流水 -->
      <el-form-item :label="`实${payWord}金额`">
        <div class="paid-summary">
          <span>累计实{{ payWord }}：<b>{{ sumPaid.toFixed(2) }}</b></span>
          <span v-if="payCount > 0">（{{ payCount }} 笔，见「{{ payWord }}款」流水）</span>
          <span v-else class="hint">未{{ payWord }}款，可在列表点「{{ payWord }}款」分多笔记录</span>
        </div>
      </el-form-item>
      <el-form-item label=" ">
        <div class="calc-line">
          <span>{{ dueWord }}：<b>{{ dueTotal.toFixed(2) }}</b></span>
          <span>未{{ payWord }}：<b :class="unpaidAmount > 0 ? 'debt' : 'none'">{{ unpaidAmount.toFixed(2) }}</b></span>
        </div>
      </el-form-item>
    </el-form>
    <div class="lines-scroll">
      <el-table :data="form.lines" stripe max-height="320">
        <el-table-column label="商品" min-width="180">
          <template #default="{ row }">
            <el-select
              v-model="row.code"
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入商品"
              style="width:100%"
              @change="onItemChange(row)"
            >
              <el-option v-for="i in items" :key="i.code" :label="`${i.name} (${i.code})`" :value="i.code" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="数量" width="100" align="right">
          <template #default="{ row }"><el-input-number v-model="row.qty" :min="1" size="small" /></template>
        </el-table-column>
        <el-table-column label="单价" width="100" align="right">
          <template #default="{ row }"><el-input-number v-model="row.price" :min="0" :precision="2" size="small" /></template>
        </el-table-column>
        <el-table-column label="折扣" width="100" align="right">
          <template #default="{ row }"><el-input-number v-model="row.discountRate" :min="0" :max="1" :step="0.05" :controls="false" size="small" /></template>
        </el-table-column>
        <el-table-column label="小计" width="100" align="right">
          <template #default="{ row }">
            <span class="line-net" :title="lineRate(row) < 1 ? `原价 ¥${lineGross(row).toFixed(2)}` : ''">{{ lineNet(row).toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="" width="60">
          <template #default="{ $index }"><el-button size="small" type="danger" @click="form.lines.splice($index,1)">×</el-button></template>
        </el-table-column>
      </el-table>
    </div>
    <div style="margin-top:8px">
      <el-button size="small" @click="form.lines.push({code:'',name:'',qty:1,price:0,discountRate:1})">添加行</el-button>
      <span class="calc-hint" style="margin-left:12px">折扣＝折扣率：1＝原价，0.9＝九折；整单优惠请填表单上方「整单优惠」</span>
    </div>
    <div style="margin-top:12px;text-align:right">
      <b>合计：¥ {{ totalAmount.toFixed(2) }}</b>
      <span class="calc-hint" style="margin-left:12px">{{ dueWord }} {{ dueTotal.toFixed(2) }} · 未{{ payWord }} {{ unpaidAmount.toFixed(2) }}</span>
      <div v-if="lineDiscountSum > 0 || Number(form.discount) > 0" class="calc-detail">
        <span>原价合计 ¥ {{ grossAmount.toFixed(2) }}</span>
        <span v-if="lineDiscountSum > 0" class="discount">单项折扣 -¥ {{ lineDiscountSum.toFixed(2) }}</span>
        <span v-if="Number(form.discount) > 0" class="discount">整单优惠 -¥ {{ Number(form.discount).toFixed(2) }}</span>
      </div>
    </div>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving || emitting" @click="save">{{ saveLabel }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { resolveLine, normalizeRate } from '../utils/catalog'
import { genOrderId } from '../utils/code'
import { payableOf, receivableOf, paidSumOf, receivedSumOf, ensurePayments } from '../utils/account'
import PhotoUpload from './PhotoUpload.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 编辑时的原单；null 表示新增
  order: { type: Object, default: null },
  // 同类型全部单据（只读）：新增时据此生成单号、编辑时据此取原单累计实付/实收
  list: { type: Array, default: () => [] },
  items: { type: Array, default: () => [] },
  // 客户档案（仅销售侧用）：定客户类别 → 分级售价、最近成交价
  customers: { type: Array, default: () => [] },
  // payable=采购单 / receivable=销售单
  kind: { type: String, default: 'payable' },
  // 父级保存锁：配合按钮 loading，防止双击重复提交（会生成两张同内容单据、库存翻倍）
  saving: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'saved'])

// ---- 由 kind 派生的差异配置 ----
const isPurchase = computed(() => props.kind === 'payable')
const partyLabel = computed(() => (isPurchase.value ? '供应商' : '客户'))
const partyField = computed(() => (isPurchase.value ? 'supplier' : 'customer'))
const payWord = computed(() => (isPurchase.value ? '付' : '收'))
const dueWord = computed(() => (isPurchase.value ? '应付' : '应收'))
const prefix = computed(() => (isPurchase.value ? 'B' : 'X'))
const sumField = computed(() => (isPurchase.value ? 'paid' : 'received'))
const title = computed(() => (editingId.value ? `编辑${isPurchase.value ? '采购单' : '销售单'}` : (isPurchase.value ? '采购入库' : '销售出库')))
const saveLabel = computed(() => (isPurchase.value ? '保存入库' : '保存出库'))
const bizWord = computed(() => (isPurchase.value ? '采购' : '销售'))

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const photoUpload = ref(null)
// 每次打开自增：强制重建上传区，避免残留上一单的照片
const photoKey = ref(0)
const editingId = ref('')
// 组件内防重入（父级 saving 之外的第二道锁）
const emitting = ref(false)
const form = reactive({ party:'', date:'', remark:'', settle:'挂账', photos:[], discount:0, lines:[] })

// 打开时整体重建表单：编辑回填原单（行折扣走 normalizeRate，兼容早期金额口径的旧数据）
watch(() => props.modelValue, (open) => {
  if (!open) return
  photoKey.value += 1
  const row = props.order
  if (row && row.id) {
    editingId.value = row.id
    form.party = isPurchase.value ? (row.supplier || '') : (row.customer || '')
    form.date = row.date || ''
    form.remark = row.remark || ''
    form.settle = row.settle || '挂账'
    form.photos = [...(row.photos || [])]
    form.discount = Number(row.discount || 0)
    form.lines = (row.items || []).map(i => ({ code: i.code, name: i.name, qty: i.qty, price: i.price, discountRate: normalizeRate(i, (i.qty || 0) * (i.price || 0)) }))
  } else {
    editingId.value = ''
    form.party = ''
    form.date = new Date().toISOString().slice(0, 10)
    form.remark = ''
    form.settle = '挂账'
    form.photos = []
    form.discount = 0
    form.lines = [{ code:'', name:'', qty:1, price:0, discountRate:1 }]
  }
})

// 编辑中的原始单据（用于展示累计实付/实收，实收实付不在表单里改，统一走流水）
const editOrder = computed(() => (editingId.value ? (props.list || []).find(o => o.id === editingId.value) : null) || {})
const payCount = computed(() => ensurePayments(editOrder.value, sumField.value).length)
const sumPaid = computed(() => (isPurchase.value ? paidSumOf(editOrder.value) : receivedSumOf(editOrder.value)))

// 账务规则（与 src/utils/account.js 一致）：欠款按金额计算，与结算状态无关
//   应付/应收 = 合计 − 整单优惠 ；未付/未收 = max(0, 应付 − 累计实付[流水])
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
// 行折扣率（默认1＝原价）/ 行原价（数量×单价）/ 行减免额 / 折后小计；折扣只减钱、不改单价
const lineRate = (l) => normalizeRate(l, lineGross(l))
const lineGross = (l) => round2((l.qty || 0) * (l.price || 0))
const lineDiscount = (l) => round2(lineGross(l) * (1 - lineRate(l)))
const lineNet = (l) => Math.max(0, round2(lineGross(l) - lineDiscount(l)))
const grossAmount = computed(() => form.lines.reduce((s, l) => s + lineGross(l), 0))
const lineDiscountSum = computed(() => form.lines.reduce((s, l) => s + lineDiscount(l), 0))
// 合计＝折后小计之和（已含单项折扣）；应付/应收再减整单优惠
const totalAmount = computed(() => form.lines.reduce((s, l) => s + lineNet(l), 0))
const dueTotal = computed(() => Math.max(0, totalAmount.value - Number(form.discount || 0)))
const unpaidAmount = computed(() => Math.max(0, dueTotal.value - sumPaid.value))

// ---- 销售侧单价策略：客户类别 → 商品分级售价字段 ----
// 客户类别 → 商品上的对应分级售价字段
const CATEGORY_PRICE_FIELD = { '批发': 'priceWholesale', '零售': 'price', '安装师傅': 'priceInstaller' }
const customerCategory = computed(() => {
  const c = (props.customers || []).find(c => c.name === form.party)
  return c && c.category ? c.category : ''
})
// 按客户类别取对应分级售价（批发→批发价 / 零售→售价 / 安装师傅→安装师傅价）
function tierPriceFor(item) {
  const field = CATEGORY_PRICE_FIELD[customerCategory.value]
  if (!field) return null
  const v = item?.[field]
  return (v !== '' && v != null && Number(v) > 0) ? Number(v) : null
}
// 按「某客户最近一次销售价」带出单价；没历史则用商品当前售价
function customerPriceFor(code) {
  if (!form.party || !code) return null
  const item = (props.items || []).find(i => i.code === code)
  if (!item) return null
  const hist = (item.saleHistory || []).filter(h => h.customer === form.party)
  if (!hist.length) return null
  const latest = hist.reduce((a, b) => ((a.date || '') > (b.date || '') ? a : b))
  return latest.price
}
// 单价优先级：该客户最近成交价(历史成交价最优先) → 客户类别对应分级售价 → 商品当前售价
function autoPriceFor(item) {
  const recent = customerPriceFor(item.code)
  if (recent != null) return recent
  const tier = tierPriceFor(item)
  if (tier != null) return tier
  return item.price || 0
}
// 采购取进价；销售走上面的分级/历史价策略
const priceFor = (found) => (isPurchase.value ? (found.cost || found.price || 0) : autoPriceFor(found))

function onItemChange(row) {
  const found = (props.items || []).find(i => i.code === row.code || i.name === row.code)
  if (!found) { row.name = row.code; return }
  row.code = found.code
  row.name = found.name
  // 采购：原单价为空才用进价兜底；销售：始终按客户策略刷新（换客户也会整体刷新）
  if (isPurchase.value) { if (!row.price) row.price = priceFor(found) }
  else row.price = priceFor(found)
}

// 更换客户后，按新客户的类别价/最近售价刷新已填行的单价（仍可手动改）
function onPartyChange() {
  if (isPurchase.value) return
  form.lines.forEach(l => {
    if (!l.code) return
    const item = (props.items || []).find(i => i.code === l.code)
    if (item) l.price = autoPriceFor(item)
  })
}

async function doSave() {
  if (photoUpload.value && photoUpload.value.isUploading()) return ElMessage.warning('照片正在上传中，请等待上传完成后再保存')
  if (!form.party) return ElMessage.warning(`请填写${partyLabel.value}`)
  if (!form.lines.length || form.lines.some(l => !l.code && !l.name)) return ElMessage.warning(`请完整填写${bizWord.value}明细`)
  let catalog = [...(props.items || [])]
  const resolved = []
  form.lines.forEach((l, idx) => {
    // 采购行要带 cost（影响商品建档成本），销售行直接用成交价
    const result = isPurchase.value ? resolveLine(catalog, { ...l, cost: l.price }, idx) : resolveLine(catalog, l, idx)
    if (result.line) {
      catalog = result.items
      resolved.push(result.line)
    }
  })
  if (!resolved.length) return ElMessage.warning(`请完整填写${bizWord.value}明细`)
  const amount = resolved.reduce((s, l) => s + l.total, 0)
  const discountVal = Number(form.discount || 0)
  const isEdit = !!editingId.value
  const origin = isEdit ? (props.list || []).find(o => o.id === editingId.value) : null
  // 收付款统一走 payments 流水（编辑时保留原流水）；标记结清时自动补一笔差额收/付款，保证状态与金额一致
  let entry = {
    ...(origin || {}),
    [partyField.value]: form.party,
    date: form.date,
    remark: form.remark || '',
    settle: form.settle || '挂账',
    photos: [...(form.photos || [])],
    discount: discountVal,
    items: resolved,
    total: amount
  }
  if (!isEdit) {
    entry = { id: genOrderId(prefix.value, props.list, form.date), ...entry, payments: [], [sumField.value]: 0 }
  }
  if (form.settle === '结清') {
    // 结清时把未收差额计入整单优惠（核销尾款），而不是补记一笔收款——
    // 避免账面「已收」虚高；应收也相应减少，账户自然平账
    const unpaid = isPurchase.value
      ? payableOf({ total: amount, discount: discountVal, paid: paidSumOf(entry) })
      : receivableOf({ total: amount, discount: discountVal, received: receivedSumOf(entry) })
    if (unpaid > 0) entry.discount = (Number(entry.discount) || 0) + unpaid
  }
  entry[sumField.value] = isPurchase.value ? paidSumOf(entry) : receivedSumOf(entry)
  // 只组装、不落库：交给父组件保存（失败时弹窗保持打开可重试）
  emit('saved', { entry, isEdit, id: entry.id })
}

// 保存入口：组件锁 + 父级锁双保险，双击只会执行一次
async function save() {
  if (emitting.value || props.saving) return
  emitting.value = true
  try {
    await doSave()
  } finally {
    emitting.value = false
  }
}
</script>

<style scoped>
.calc-line{display:flex;gap:20px;flex-wrap:wrap;color:var(--text-regular);font-size:var(--fs-table);}
.calc-hint{color:var(--text-secondary);font-weight:400;}
.lines-scroll{overflow-x:auto;}
/* 明细行输入框撑满所在列：el-input-number 默认 150px，在 100px 的列里会溢出错位 */
.lines-scroll :deep(.el-input-number){width:100%;}
/* 手机端压缩单元格留白与字体，尽量让 商品/数量/单价/折扣 一屏放下；
   仍放不下的部分由表格自身横向滚动兜底 */
@media (max-width: 768px){
  .lines-scroll :deep(.el-table .cell){padding-left:5px;padding-right:5px;}
  .lines-scroll :deep(.el-table .el-input__wrapper),
  .lines-scroll :deep(.el-table .el-select__wrapper){padding-left:6px;padding-right:6px;}
}
.calc-detail{display:flex;justify-content:flex-end;gap:16px;flex-wrap:wrap;margin-top:2px;color:var(--text-secondary);font-size:var(--fs-sub);}
.line-net{font-variant-numeric:tabular-nums;}
.settle-hint{margin-top:6px;color:var(--text-secondary);font-size:var(--fs-sub);line-height:1.5;}
.paid-summary{display:flex;gap:8px;flex-wrap:wrap;color:var(--text-regular);font-size:var(--fs-table);align-items:baseline;}
.paid-summary .hint{color:var(--text-placeholder);}
.discount{color:var(--color-success);}
.none{color:var(--text-placeholder);}
.debt{color:var(--color-danger);font-weight:600;}
</style>
