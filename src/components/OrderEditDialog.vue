<template>
  <!-- 采购/销售单据新增编辑弹窗：两侧仅 6 处差异（单号前缀、主体字段、文案、单价策略、
       resolveLine 传参、结清补流水方向），统一由 kind 派生，逻辑只维护一份。
       落库由父组件完成：本组件只组装 entry 并 emit('saved')，失败时弹窗保持打开便于重试 -->
  <!-- 保存中禁止误关：点遮罩/按 ESC 不会中断保存（关闭由保存结果驱动） -->
  <el-dialog v-model="visible" :title="title" width="620" :close-on-click-modal="false" :close-on-press-escape="!(saving || emitting)">
    <!-- label-width 110px：容纳「整单优惠金额」6 个字不换行（80px 会折成两行与下行挤压） -->
    <el-form :model="form" label-width="110px">
      <el-form-item :label="partyLabel">
        <!-- 采购：供应商下拉（可选已有档案，也可直接新建）；销售：客户下拉（同上）。
             options 走 partyOptions：档案列表 + 回显兜底合成项，编辑老单名称对不上档案时也能显示原值 -->
        <el-select
          v-if="isPurchase"
          v-model="form.party"
          filterable
          allow-create
          default-first-option
          :placeholder="`选择或输入${partyLabel}`"
          style="width:100%"
          @change="onPartyChange"
        >
          <el-option v-for="s in partyOptions" :key="s.code || s.name" :label="optionLabel(s)" :value="s.name" />
        </el-select>
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
          <el-option v-for="c in partyOptions" :key="c.code || c.name" :label="optionLabel(c)" :value="c.name" />
        </el-select>
      </el-form-item>
      <el-form-item label="日期"><el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="结算">
        <el-radio-group v-model="form.settle">
          <el-radio-button label="挂账" />
          <el-radio-button label="结清" />
        </el-radio-group>
        <div v-if="form.settle === '结清' && !editingId" class="settle-hint">
          已选「结清」：「实{{ payWord }}金额」与「整单优惠金额」实时联动，未{{ payWord }}的差额自动计入优惠，保存后本单标记结清（不虚增已{{ payWord }}）
        </div>
        <div v-else-if="!editingId && dueTotal > 0" class="settle-hint">
          实{{ payWord }}金额（含{{ depositLabel }}抵扣）填满本单金额、未{{ payWord }}为 0 时，结算将自动标记为「结清」
        </div>
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
      <el-form-item label="单据照片">
        <!-- :key 让每次打开都重建上传区，避免上一单的照片残留 -->
        <PhotoUpload ref="photoUpload" :key="photoKey" v-model="form.photos" />
      </el-form-item>
      <el-form-item label="整单优惠金额">
        <el-input-number v-model="form.discount" :min="0" :precision="2" :controls="false" style="width:100%" />
      </el-form-item>
      <el-form-item label="整单折扣">
        <el-input-number v-model="form.discountRate" :min="0" :max="1" :step="0.01" :precision="2" :controls="false" style="width:100%" />
        <div class="calc-hint" style="margin-top:4px">折扣率：1＝不打折，0.9＝九折；按比例作用于单据合计（在「整单优惠金额」之前）</div>
      </el-form-item>
      <!-- 新增单：直接填本次实付/实收金额，并可用预付款/预收款支付；编辑单：只读汇总，改流水走「付款/收款」弹窗 -->
      <el-form-item :label="`实${payWord}金额`">
        <template v-if="editingId">
          <div class="paid-summary">
            <span>累计实{{ payWord }}：<b>{{ sumPaid.toFixed(2) }}</b></span>
            <span v-if="payCount > 0">（{{ payCount }} 笔，见「{{ payWord }}款」流水）</span>
            <span v-else class="hint">未{{ payWord }}款，可在列表点「{{ payWord }}款」分多笔记录</span>
          </div>
        </template>
        <template v-else>
          <div class="pay-now-row">
            <el-input-number v-model="form.paidNow" :min="0" :precision="2" :controls="false" style="width:150px" :placeholder="`本次实${payWord}金额（现金）`" />
            <span class="pay-now-hint">现金{{ payWord }}款</span>
          </div>
          <div class="pay-now-row" style="margin-top:6px">
            <el-input-number v-model="form.depositPay" :min="0" :max="deductMax" :precision="2" :controls="false" style="width:150px" :placeholder="`${depositLabel}抵扣金额`" />
            <el-button type="info" plain size="small" :disabled="deductMax <= 0" @click="fullDeduct">全额抵扣</el-button>
            <span class="deposit-avail">可用 {{ depositLabel }} ¥{{ depositAvailable.toFixed(2) }}</span>
          </div>
          <div v-if="Number(form.depositPay) > 0" class="deposit-used" style="margin-top:4px">
            已用{{ depositLabel }}抵扣 <b>¥{{ Number(form.depositPay).toFixed(2) }}</b>
            <el-button link type="primary" size="small" @click="form.depositPay = 0">清除</el-button>
          </div>
          <div class="calc-hint" style="margin-top:4px">
            填「实{{ payWord }}金额」保存即记一笔{{ payWord }}款；{{ depositLabel }}可全额或手动填部分抵扣（不超过本单未{{ payWord }}金额）；选「结清」时「实{{ payWord }}金额」与「整单优惠金额」自动联动补差。
          </div>
        </template>
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
      <div v-if="lineDiscountSum > 0 || Number(form.discount) > 0 || effRate !== 1" class="calc-detail">
        <span>原价合计 ¥ {{ grossAmount.toFixed(2) }}</span>
        <span v-if="effRate !== 1" class="discount">整单折扣 ×{{ effRate.toFixed(2) }}</span>
        <span v-if="lineDiscountSum > 0" class="discount">单项折扣 -¥ {{ lineDiscountSum.toFixed(2) }}</span>
        <span v-if="Number(form.discount) > 0" class="discount">整单优惠金额 -¥ {{ Number(form.discount).toFixed(2) }}</span>
      </div>
    </div>
    <template #footer>
      <span v-if="saving || emitting" class="saving-hint">保存中，请稍候…</span>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving || emitting" @click="save">{{ saveLabel }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { resolveLine, normalizeRate } from '../utils/catalog'
import { genOrderId } from '../utils/code'
import { payableOf, receivableOf, paidSumOf, receivedSumOf, ensurePayments, depositSumOf } from '../utils/account'
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
  // 供应商档案（仅采购侧用）：下拉选已有供应商，也可直接新建
  suppliers: { type: Array, default: () => [] },
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
const form = reactive({ party:'', date:'', remark:'', settle:'挂账', photos:[], discount:0, discountRate:1, paidNow:0, depositPay:0, lines:[] })

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
    form.discountRate = Number(row.discountRate || 1)
    form.paidNow = 0
    form.depositPay = 0
    form.lines = (row.items || []).map(i => ({ code: i.code, name: i.name, qty: i.qty, price: i.price, discountRate: normalizeRate(i, (i.qty || 0) * (i.price || 0)) }))
  } else {
    editingId.value = ''
    form.party = ''
    form.date = new Date().toISOString().slice(0, 10)
    form.remark = ''
    form.settle = '挂账'
    form.photos = []
    form.discount = 0
    form.discountRate = 1
    form.paidNow = 0
    form.depositPay = 0
    form.lines = [{ code:'', name:'', qty:1, price:0, discountRate:1 }]
  }
  // 打开弹窗后主动检查一次自动结清：unpaidAmount 可能「回填前后都是 0」
  // （首次打开就是全付旧单、或上一张处理过的单也未付为 0），值没变化 watch 不会触发，
  // 旧订单就会漏掉自动结清。nextTick 等 computed 重算完再判定
  nextTick(checkAutoSettle)
})

// 编辑中的原始单据（用于展示累计实付/实收，实收实付不在表单里改，统一走流水）
const editOrder = computed(() => (editingId.value ? (props.list || []).find(o => o.id === editingId.value) : null) || {})
const payCount = computed(() => ensurePayments(editOrder.value, sumField.value).length)
// 累计实付/实收：编辑单取原流水；新增单取本次填的「现金实付 + 预付款/预收款抵扣」
const sumPaid = computed(() => editingId.value
  ? (isPurchase.value ? paidSumOf(editOrder.value) : receivedSumOf(editOrder.value))
  : round2(Number(form.paidNow || 0) + Number(form.depositPay || 0)))

// 预付款（采购）/ 预收款（销售）：当前所选往来单位的可用余额
const depositLabel = computed(() => (isPurchase.value ? '预付款' : '预收款'))
const depositAvailable = computed(() => {
  const name = form.party
  if (!name) return 0
  const list = isPurchase.value ? props.suppliers : props.customers
  const p = (list || []).find(x => x.name === name)
  return depositSumOf(p && (isPurchase.value ? p.advances : p.deposits))
})

// 往来单位下拉选项：档案列表 + 回显兜底合成项。
// 编辑历史单据时，单据上的名称可能与档案对不上（档案被改名、大小写/空格差异、早期脏数据），
// 没有对应选项时 el-select 显示为空，用户会误以为「供应商/客户没链接上」；
// 合成一项同名选项，保证原值可见、可手动改，保存后仍按名称匹配档案
const partyOptions = computed(() => {
  const list = (isPurchase.value ? props.suppliers : props.customers) || []
  const cur = (form.party || '').trim()
  if (!cur || list.some(x => (x.name || '').trim() === cur)) return list
  return [...list, { code: '', name: form.party, label: `${form.party}（档案中无同名，保存后按名称重新匹配）` }]
})
const optionLabel = (p) => p.label || `${p.name}${p.code ? ` (${p.code})` : ''}`

// 全额抵扣：一键把抵扣额拉到「本单最大可抵」＝ min(本单未收 − 已填现金, 可用余额)。
// 注意：预存款多于本单金额时也只抵本单未付部分，不会把客户余额清零
function fullDeduct() {
  if (editingId.value) return ElMessage.warning('编辑已有单据请用「付款/收款」弹窗操作抵扣')
  const max = deductMax.value
  if (max <= 0) {
    return ElMessage.warning(depositAvailable.value <= 0
      ? `可用${depositLabel.value}不足`
      : `本单已无未${payWord.value}金额`)
  }
  form.depositPay = max
  ElMessage.success(`已用${depositLabel.value}全额抵扣 ¥${max.toFixed(2)}（点「保存」生效）`)
}

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
// 合计＝折后小计之和（已含单项折扣）；应付/应收 = 合计 × 整单折扣率 − 整单优惠金额
const totalAmount = computed(() => form.lines.reduce((s, l) => s + lineNet(l), 0))
const effRate = computed(() => { const r = Number(form.discountRate); return Number.isFinite(r) && r > 0 ? r : 1 })
const dueTotal = computed(() => Math.max(0, round2(totalAmount.value * effRate.value) - Number(form.discount || 0)))
const unpaidAmount = computed(() => Math.max(0, dueTotal.value - sumPaid.value))

// 未付/未收为 0（且本单有金额）时自动标记「结清」：状态与实付金额保持一致，
// 避免「钱已全收/全付却还挂着挂账标签」。仅单向自动（不自动改回挂账，用户可手动选）
function checkAutoSettle() {
  if (unpaidAmount.value <= 0 && dueTotal.value > 0 && form.settle !== '结清') {
    form.settle = '结清'
  }
}
// 值变化时持续检查（新增单填实付、编辑单改金额/折扣等）
watch(unpaidAmount, checkAutoSettle)

// 本单最大可抵扣额 = min(本单未收 − 已填现金实付, 可用预存款/预付款)。
// 预存款余额大于本单金额时，最多只抵本单未付部分，不会超额扣成负数
const deductMax = computed(() => Math.max(0, round2(Math.min(
  dueTotal.value - round2(Number(form.paidNow || 0)),
  depositAvailable.value
))))

// 手动填的抵扣额不允许超过上限（el-input-number 的 :max 之外再兜底一道）
watch(() => form.depositPay, (v) => {
  const max = deductMax.value
  if (Number(v || 0) > max) form.depositPay = max
})

// 结清时「实付金额 ↔ 优惠金额」实时联动（仅新增单；编辑单改流水走付款/收款弹窗）：
//   改实付/抵扣 → 优惠自动补差 = 毛应收 − 实付合计
//   改优惠      → 实付自动补差 = 毛应收 − 优惠 − 抵扣
// 毛应收 = 合计×整单折扣率（不含优惠金额）。两个 watch 互相收敛：一方补到目标值后另一方不再触发
watch([() => form.settle, () => form.paidNow, () => form.depositPay, () => form.discountRate, totalAmount], () => {
  if (editingId.value || form.settle !== '结清') return
  const gross = round2(totalAmount.value * effRate.value)
  const paid = round2(Number(form.paidNow || 0) + Number(form.depositPay || 0))
  const disc = Math.max(0, round2(gross - paid))
  if (disc !== Number(form.discount || 0)) form.discount = disc
})
watch(() => form.discount, () => {
  if (editingId.value || form.settle !== '结清') return
  const gross = round2(totalAmount.value * effRate.value)
  const targetPaid = Math.max(0, round2(gross - Number(form.discount || 0) - Number(form.depositPay || 0)))
  if (targetPaid !== Number(form.paidNow || 0)) form.paidNow = targetPaid
})

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
  // 输入了名单中没有的${partyLabel}：保存后由后端自动建档，先提示用户确认，避免误建档案
  const partyList = isPurchase.value ? props.suppliers : props.customers
  const partyExists = (partyList || []).some(x => x.name === form.party)
  if (!partyExists) {
    try {
      await ElMessageBox.confirm(
        `「${form.party}」不在${partyLabel.value}名单中，保存后将自动新建该${partyLabel.value}档案，是否继续？`,
        `新建${partyLabel.value}`,
        { type: 'warning', confirmButtonText: '继续新建', cancelButtonText: '取消' }
      )
    } catch { return }
  }
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
    discountRate: effRate.value,
    items: resolved,
    total: amount
  }
  if (!isEdit) {
    // 新增单：把「现金实付」与「预付款/预收款抵扣」直接落成收款/付款流水
    const payments = []
    const paidNow = round2(Number(form.paidNow || 0))
    const depositPay = round2(Number(form.depositPay || 0))
    const now = new Date().toISOString()
    if (paidNow > 0) payments.push({ date: form.date, amount: paidNow, remark: `实${payWord.value}`, time: now })
    if (depositPay > 0) payments.push({ date: form.date, amount: depositPay, remark: `用${depositLabel.value}抵扣`, fromDeposit: true, time: now })
    entry = { id: genOrderId(prefix.value, props.list, form.date), ...entry, payments, [sumField.value]: round2(paidNow + depositPay) }
  }
  if (form.settle === '结清') {
    // 结清时把未收差额计入整单优惠（核销尾款），而不是补记一笔收款——
    // 避免账面「已收」虚高；应收也相应减少，账户自然平账
    const unpaid = isPurchase.value
      ? payableOf({ total: amount, discount: discountVal, discountRate: effRate.value, paid: paidSumOf(entry) })
      : receivableOf({ total: amount, discount: discountVal, discountRate: effRate.value, received: receivedSumOf(entry) })
    if (unpaid > 0) entry.discount = (Number(entry.discount) || 0) + unpaid
  }
  entry[sumField.value] = isPurchase.value ? paidSumOf(entry) : receivedSumOf(entry)
  // 用预付款/预收款抵扣的部分：随保存一并交父组件从对应档案余额扣减（幂等，按订单 id 标记）
  const depositDeduct = (!isEdit && round2(Number(form.depositPay || 0)) > 0)
    ? { amount: round2(Number(form.depositPay || 0)) }
    : null
  // 只组装、不落库：交给父组件保存（失败时弹窗保持打开可重试）
  emit('saved', { entry, isEdit, id: entry.id, depositDeduct })
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
/* label 不换行：110px 下「整单优惠金额」6 字单行显示，两个字段各自独立一行 */
:deep(.el-form-item__label){white-space:nowrap;}
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
.saving-hint{margin-right:12px;color:var(--color-primary);font-size:var(--fs-sub);}
.paid-summary{display:flex;gap:8px;flex-wrap:wrap;color:var(--text-regular);font-size:var(--fs-table);align-items:baseline;}
.paid-summary .hint{color:var(--text-placeholder);}
.pay-now-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.pay-now-hint{color:var(--text-placeholder);font-size:var(--fs-sub);}
.deposit-avail{color:var(--text-regular);font-size:var(--fs-sub);}
.deposit-used{color:var(--text-regular);font-size:var(--fs-table);}
.deposit-used b{color:var(--color-success);}
.discount{color:var(--color-success);}
.none{color:var(--text-placeholder);}
.debt{color:var(--color-danger);font-weight:600;}
</style>
