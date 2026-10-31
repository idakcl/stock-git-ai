<template>
  <!-- 采购/销售单据新增编辑弹窗：两侧仅 6 处差异（单号前缀、主体字段、文案、单价策略、
       resolveLine 传参、结清补流水方向），统一由 kind 派生，逻辑只维护一份。
       落库由父组件完成：本组件只组装 entry 并 emit('saved')，失败时弹窗保持打开便于重试 -->
  <!-- 保存中禁止误关：点遮罩/按 ESC 不会中断保存（关闭由保存结果驱动） -->
  <!-- standalone＝整页开单（路由 /sales/new、/purchases/new）：同一份表单铺满屏幕，
       明细表能拿到近两倍高度。关掉即由父组件回列表，所以不显示右上角 ×，避免「×」和「返回」两个出口 -->
  <el-dialog v-model="visible" :title="title" width="620" :fullscreen="standalone || maximized" :show-close="!standalone" :close-on-click-modal="false" :close-on-press-escape="!(saving || emitting)">
    <!-- 左上角最大化角标：整页铺满屏幕看长明细；再点一次还原。整页开单模式本身就是全屏，不显示该角标 -->
    <template v-if="!standalone" #header="{ titleId, titleClass }">
      <div class="dlg-header">
        <el-button class="dlg-max" text :title="maximized ? '还原窗口' : '最大化窗口'" :aria-label="maximized ? '还原窗口' : '最大化窗口'" @click="maximized = !maximized">
          <MaxIcon :restore="maximized" />
        </el-button>
        <span :id="titleId" :class="titleClass">{{ title }}</span>
      </div>
    </template>
    <!-- 已动过钱的单：明细/折扣/优惠/结算状态全部锁定（表单级 disabled 会连按钮一起禁用，
         所以这块放在 el-form 外面），要增减商品改走「变更明细」生成退货单/补差单 -->
    <div v-if="moneyLocked" class="lock-bar">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        :title="lockTitle"
      />
      <div class="lock-actions">
        <el-button type="primary" size="small" @click="amendVisible = true">变更明细（增减商品）</el-button>
        <span class="calc-hint">减少的商品开退货单、新增的商品开补差单，原单保持不动并可追溯。</span>
      </div>
    </div>
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
      <el-form-item label="结算状态">
        <el-radio-group v-model="form.settle" :disabled="moneyLocked">
          <el-radio-button label="挂账" />
          <el-radio-button label="结清" />
        </el-radio-group>
        <div v-if="form.settle === '结清'" class="settle-hint">
          已选「结清」：未{{ payWord }}必须为 0。你手填的「实{{ payWord }}金额」「整单优惠金额」优先，另一项自动补差；保存时会校验未{{ payWord }}是否为 0。
        </div>
        <div v-else-if="!editingId && dueTotal > 0" class="settle-hint">
          实{{ payWord }}金额（含{{ depositLabel }}抵扣）填满本单金额、未{{ payWord }}为 0 时，结算状态将自动标记为「结清」
        </div>
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
      <el-form-item label="单据照片">
        <!-- :key 让每次打开都重建上传区，避免上一单的照片残留 -->
        <PhotoUpload ref="photoUpload" :key="photoKey" v-model="form.photos" />
      </el-form-item>
      <el-form-item label="快速添加">
        <!-- 顶部快捷加商品：选已有商品或输入新名回车即加入下方明细，免去滚动到表格底部操作 -->
        <GoodsSelect v-if="!moneyLocked" v-model="quickItem" :items="items" allow-create placeholder="选择或输入商品后回车添加" class="quick-add-select" @change="addQuickItem" />
        <el-input v-else model-value="明细已锁定，请点上方「变更明细」增减商品" disabled class="quick-add-select" />
        <div v-if="!moneyLocked" class="calc-hint">选择已有商品或输入新商品名后回车，即加入下方明细</div>
      </el-form-item>
      <!-- 所选按钮区：批量折扣与批量删除，只在非锁定态显示。
           勾选行后按钮可用，未勾选时禁用（避免空操作）。 -->
      <div v-if="!moneyLocked" class="batch-actions">
        <el-button size="small" type="primary" plain :disabled="!selectedIndices.size" @click="lineDiscountVisible = true">
          批量设置折扣（已选 {{ selectedIndices.size }} 项）
        </el-button>
        <el-button size="small" type="danger" plain :disabled="!selectedIndices.size" @click="batchDelete">
          批量删除（已选 {{ selectedIndices.size }} 项）
        </el-button>
      </div>
      <!-- 商品明细表：紧跟「快速添加」下方，新增商品即可在下方明细继续改数量/单价。
           锁定态（原单已动过钱）整表改为纯文本展示：明细改动只能走「变更明细」生成关联单 -->
      <div class="lines-scroll">
        <!-- 整页模式给明细表近两倍高度：商品几十行的单子不用在小窗里来回滚 -->
        <el-table ref="linesTable" :data="form.lines" stripe :max-height="standalone ? 480 : 320" @selection-change="onSelectionChange">
          <!-- 勾选框列：非锁定态才显示，锁定态不显示（已动过钱的单不允许批量操作） -->
          <el-table-column v-if="!moneyLocked" type="selection" width="42" />
          <!-- 序号列：按行号实时生成，历史单据打开即自动带上，无需迁移数据 -->
          <el-table-column type="index" label="序号" width="58" align="center" />
          <el-table-column label="商品" min-width="180">
            <template #default="{ row }">
              <GoodsSelect
                v-if="!moneyLocked"
                v-model="row.code"
                :items="items"
                allow-create
                placeholder="选择或输入商品"
                style="width:100%"
                @change="onItemChange(row)"
              />
              <span v-else>{{ row.name || row.code }}</span>
            </template>
          </el-table-column>
          <el-table-column label="数量" width="100" align="right">
            <template #default="{ row }">
              <el-input-number v-if="!moneyLocked" v-model="row.qty" :min="1" size="small" v-select-on-focus />
              <span v-else>{{ row.qty }}</span>
            </template>
          </el-table-column>
          <el-table-column label="单价" width="100" align="right">
            <template #default="{ row }">
              <el-input-number v-if="!moneyLocked" v-model="row.price" :min="0" :precision="2" size="small" v-select-on-focus />
              <span v-else>{{ Number(row.price || 0).toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="折扣" width="100" align="right">
            <template #default="{ row }">
              <el-input-number v-if="!moneyLocked" v-model="row.discountRate" :min="0" :max="1" :step="0.05" :controls="false" size="small" v-select-on-focus />
              <span v-else>{{ lineRate(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="小计" width="100" align="right">
            <template #default="{ row }">
              <span class="line-net" :title="lineRate(row) < 1 ? `原价 ¥${lineGross(row).toFixed(2)}` : ''">{{ lineNet(row).toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="!moneyLocked" label="" width="60">
            <template #default="{ $index }"><el-button size="small" type="danger" @click="form.lines.splice($index,1)">×</el-button></template>
          </el-table-column>
        </el-table>
      </div>
      <div style="margin-top:8px">
        <el-button v-if="!moneyLocked" size="small" @click="form.lines.push({code:'',name:'',qty:1,price:0,discountRate:1,discountRates:[]})">添加行</el-button>
        <span class="calc-hint" style="margin-left:12px">折扣＝折扣率：1＝原价，0.9＝九折；整单优惠请填表单下方「整单优惠」</span>
      </div>
      <div style="margin-top:12px;text-align:right">
        <b>合计：¥ {{ totalAmount.toFixed(2) }}</b>
        <span class="calc-hint" style="margin-left:12px">{{ dueWord }} {{ dueTotal.toFixed(2) }} · 未{{ payWord }} {{ unpaidAmount.toFixed(2) }}</span>
        <div v-if="lineDiscountSum > 0 || Number(form.discount) > 0 || orderRateText" class="calc-detail">
          <span>原价合计 ¥ {{ grossAmount.toFixed(2) }}</span>
          <span v-if="orderRateText" class="discount">整单折扣 {{ orderRateText }}（减 ¥{{ discountAmount.toFixed(2) }}）</span>
          <span v-if="lineDiscountSum > 0" class="discount">单项折扣 -¥ {{ lineDiscountSum.toFixed(2) }}</span>
          <span v-if="hasDiscount" class="discount discounted">折后金额 ¥{{ discountedTotal.toFixed(2) }}</span>
          <span v-if="Number(form.discount) > 0" class="discount">整单优惠金额 -¥ {{ Number(form.discount).toFixed(2) }}</span>
        </div>
      </div>
      <el-form-item label="整单折扣">
        <!-- 锁定态只展示等效折扣率，改折扣会改应收/应付，与已开凭证冲突 -->
        <span v-if="moneyLocked" class="locked-value">{{ orderRateText || '不打折' }}（已锁定）</span>
        <!-- 多级折扣链：每级一个折扣率(0~1) 连乘生效，支持「打完9折再打9折、再打8折」这类逐级叠加 -->
        <template v-else>
          <div class="rate-chain">
            <div v-for="(r, i) in form.discountRates" :key="i" class="rate-row">
              <span class="rate-idx">第 {{ i + 1 }} 级</span>
              <el-input-number v-model="form.discountRates[i]" :min="0" :max="1" :step="0.01" :precision="2" :controls="false" style="width:120px" v-select-on-focus />
              <el-button link type="danger" size="small" @click="removeRate(i)">删除</el-button>
            </div>
            <el-button size="small" type="primary" plain @click="addRate">+ 添加一级折扣</el-button>
          </div>
          <div class="calc-hint" style="margin-top:4px">
            支持多级折扣：每级 0~1（1＝不打折，0.9＝九折），各级连乘。例如 0.9 → 0.9 → 0.8 等效 6.5 折；按比例作用于单据合计（在「整单优惠金额」之前）。全部删空即不打折。
          </div>
          <div v-if="orderRateText" class="rate-eff">累计等效折扣：{{ orderRateText }}</div>
        </template>
      </el-form-item>
      <el-form-item label="整单优惠金额">
        <el-input-number v-model="form.discount" :min="0" :precision="2" :controls="false" style="width:200px" v-select-on-focus :disabled="moneyLocked" @input="markAnchor('discount')" />
        <span v-if="moneyLocked" class="locked-value" style="margin-left:10px">（已锁定）</span>
      </el-form-item>
      <!-- 新增单：直接填本次实付/实收金额，并可用预付款/预收款支付；编辑单：只能持平或调高（下限＝已记现金流水，调高即补一笔），要减少走「记录付款/收款」弹窗逐笔改 -->
      <el-form-item :label="`实${payWord}金额`">
        <template v-if="editingId">
          <el-input-number v-model="form.paidNow" :min="cashFloor" :max="cashCeil" :precision="2" :controls="false" style="width:150px" v-select-on-focus :placeholder="`现金实${payWord}金额`" @input="markAnchor('paid')" />
          <span class="pay-now-hint">现金{{ payWord }}款（原 {{ payCount }} 笔流水）</span>
          <div v-if="Number(form.depositPay) > 0" class="pay-now-row" style="margin-top:6px">
            <el-input-number :model-value="Number(form.depositPay)" :min="0" :precision="2" :controls="false" style="width:150px" disabled />
            <span class="pay-now-hint">已用{{ depositLabel }}抵扣 ¥{{ Number(form.depositPay).toFixed(2) }}（改抵扣请走「{{ payWord }}款」弹窗）</span>
          </div>
          <div class="calc-hint" style="margin-top:4px">
            已记{{ payWord }}款流水 ¥{{ cashFloor.toFixed(2) }} 是这一栏的<b>下限</b>：这里只能持平或调高（调高即补一笔{{ payWord }}款），
            要减少请到详情页「记录{{ payWord }}款」里逐笔删改——历史流水各自对应已开的资金凭证，编辑弹窗不会替你改。
            选「结清」时与优惠金额联动，未付款必须为 0。
          </div>
        </template>
        <template v-else>
          <el-input-number v-model="form.paidNow" :min="0" :max="cashCeil" :precision="2" :controls="false" style="width:150px" v-select-on-focus :placeholder="`本次实${payWord}金额（现金）`" @input="markAnchor('paid')" />
          <span class="pay-now-hint">现金{{ payWord }}款</span>
          <div class="calc-hint" style="margin-top:4px">
            填「实{{ payWord }}金额」保存即记一笔{{ payWord }}款；选「结清」时与优惠金额联动，未付款必须为 0。
          </div>
        </template>
      </el-form-item>
      <el-form-item v-if="!editingId" :label="`${depositLabel}抵扣`">
        <el-input-number v-model="form.depositPay" :min="0" :max="deductMax" :precision="2" :controls="false" style="width:150px" v-select-on-focus :placeholder="`${depositLabel}抵扣金额`" @input="markAnchor('deposit')" />
        <el-button type="info" plain size="small" :disabled="deductMax <= 0" @click="fullDeduct">全额抵扣</el-button>
        <span class="deposit-avail">可用 {{ depositLabel }} ¥{{ depositAvailable.toFixed(2) }}</span>
        <div v-if="Number(form.depositPay) > 0" class="deposit-used" style="margin-top:4px">
          已用{{ depositLabel }}抵扣 <b>¥{{ Number(form.depositPay).toFixed(2) }}</b>
          <el-button link type="primary" size="small" @click="form.depositPay = 0">清除</el-button>
        </div>
        <div class="calc-hint" style="margin-top:4px">
          {{ depositLabel }}可全额或手动填部分抵扣（不超过本单未{{ payWord }}金额）；选「结清」时「实{{ payWord }}金额」「整单优惠金额」实时联动（你填的金额优先，其余自动补差），保存时校验未付款必须为 0。
        </div>
      </el-form-item>
      <el-form-item label=" ">
        <div class="calc-line">
          <span>{{ dueWord }}：<b>{{ dueTotal.toFixed(2) }}</b></span>
          <span>未{{ payWord }}：<b :class="unpaidAmount > 0 ? 'debt' : 'none'">{{ unpaidAmount.toFixed(2) }}</b></span>
        </div>
      </el-form-item>
    </el-form>
    <template #footer>
      <span v-if="saving || emitting" class="saving-hint">保存中，请稍候…</span>
      <!-- 整页模式下这个按钮就是唯一的「回列表」出口，文案用返回而不是取消，避免用户以为会丢已填内容 -->
      <el-button @click="visible = false">{{ standalone ? '返回' : '取消' }}</el-button>
      <el-button type="primary" :loading="saving || emitting" @click="save">{{ saveLabel }}</el-button>
    </template>
    <!-- 变更明细：嵌在这里，销售/采购两个列表页与两个详情页四处调用点自动全部继承 -->
    <OrderAmendDialog
      v-model="amendVisible"
      :order="editOrder"
      :list="list"
      :items="items"
      :kind="amendKind"
      @amended="onAmended"
    />
    <!-- 批量行折扣弹窗：为勾选行统一设置多级折扣链或逐行单独设置 -->
    <LineDiscountDialog
      v-model="lineDiscountVisible"
      :lines="selectedLinesSnapshot"
      @confirm="onLineDiscountConfirm"
    />
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { resolveLine, normalizeRate, lineEffectiveRate } from '../utils/catalog'
import { genOrderId } from '../utils/code'
import { payableOf, receivableOf, grossOf, overpaidOf, paidSumOf, receivedSumOf, ensurePayments, depositSumOf, discountRatesTextOf, settleBalance } from '../utils/account'
import PhotoUpload from './PhotoUpload.vue'
import GoodsSelect from './GoodsSelect.vue'
import OrderAmendDialog from './OrderAmendDialog.vue'
import LineDiscountDialog from './LineDiscountDialog.vue'
import MaxIcon from './MaxIcon.vue'
import { moneyTouched } from '../utils/amend.js'
import { api } from '../api'
import { todayCN } from '../utils/time.js'
import { askDuplicateItem, flashTableRow } from '../utils/duplicateItem.js'

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
  // 整页模式（/sales/new、/purchases/new）：弹窗铺满屏幕，父组件负责关掉后回列表
  standalone: { type: Boolean, default: false },
  // 父级保存锁：配合按钮 loading，防止双击重复提交（会生成两张同内容单据、库存翻倍）
  saving: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'saved', 'amended'])

// ---- 由 kind 派生的差异配置 ----
const isPurchase = computed(() => props.kind === 'payable')
const partyLabel = computed(() => (isPurchase.value ? '供应商' : '客户'))
const partyField = computed(() => (isPurchase.value ? 'supplier' : 'customer'))
const payWord = computed(() => (isPurchase.value ? '付' : '收'))
const dueWord = computed(() => (isPurchase.value ? '应付' : '应收'))
const prefix = computed(() => (isPurchase.value ? 'C' : 'X'))
const sumField = computed(() => (isPurchase.value ? 'paid' : 'received'))
const title = computed(() => (editingId.value ? `编辑${isPurchase.value ? '采购单' : '销售单'}` : (isPurchase.value ? '采购入库' : '销售出库')))
const saveLabel = computed(() => (isPurchase.value ? '保存入库' : '保存出库'))
const bizWord = computed(() => (isPurchase.value ? '采购' : '销售'))
// 变更/退款链路口径是 sale|purchase（本组件的 kind 是 receivable|payable），这里做一次映射
const amendKind = computed(() => (isPurchase.value ? 'purchase' : 'sale'))

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const photoUpload = ref(null)
// 顶部快速添加：当前选中的商品（编码或新输名称），回车/选择即加入明细
const quickItem = ref('')
const linesTable = ref(null)
// 每次打开自增：强制重建上传区，避免残留上一单的照片
const photoKey = ref(0)
const editingId = ref('')
// 弹窗最大化（左上角角标切换）；整页开单模式不用它
const maximized = ref(false)
// 组件内防重入（父级 saving 之外的第二道锁）
const emitting = ref(false)
// 变更明细弹窗：原单已动过钱时，明细只能走它生成退货单/补差单
const amendVisible = ref(false)
// ---- 批量操作：勾选行 → 批量折扣 / 批量删除 ----
// 选中态：Set<行索引>，由 el-table 的 selection-change 事件同步。
// 用 Set 而非数组：批量删除时需要按索引倒序移除，Set 便于 O(1) 判定与遍历。
const selectedIndices = reactive(new Set())
// 批量折扣弹窗可见态
const lineDiscountVisible = ref(false)
// 传给批量折扣弹窗的行快照：取选中行的引用，弹窗内只读不写
const selectedLinesSnapshot = computed(() => {
  const indices = [...selectedIndices].sort((a, b) => a - b)
  return indices.map(i => form.lines[i]).filter(Boolean)
})
// 变更成功后两层都关掉：原单本身没被改，但它所在的「单族」金额已经变了
// （净成交、未收/未付都会带上新的退货单/补差单），留着旧表单容易基于过期数字点保存。
function onAmended(result) {
  amendVisible.value = false
  visible.value = false
  emit('amended', result)
}

// ---- 批量操作处理函数 ----
// el-table selection-change：同步选中态到 selectedIndices（Set<行索引>）。
// el-table 的 selection 参数是当前勾选行的数组，需要反查它们在 form.lines 中的索引。
function onSelectionChange(selection) {
  selectedIndices.clear()
  selection.forEach(row => {
    const idx = form.lines.indexOf(row)
    if (idx >= 0) selectedIndices.add(idx)
  })
}

// 批量删除：二次确认后按索引倒序移除（倒序避免正序删除时索引错位）。
// 删除后清空选中态，避免残留的索引指向已不存在的行。
async function batchDelete() {
  if (!selectedIndices.size) return
  try {
    await ElMessageBox.confirm(
      `确定删除已勾选的 ${selectedIndices.size} 行商品明细？删除后不可恢复。`,
      '批量删除确认',
      { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' }
    )
  } catch { return }
  const indices = [...selectedIndices].sort((a, b) => b - a)
  for (const idx of indices) {
    form.lines.splice(idx, 1)
  }
  selectedIndices.clear()
  // 清 table 的勾选态：el-table 的 clearSelection 方法
  nextTick(() => linesTable.value?.clearSelection())
}

// 批量折扣确认回调：LineDiscountDialog emit 的 results 数组，
// 按选中顺序一一对应，逐项写回 form.lines 的折扣字段。
// 写完后既有 computed（lineGross/lineDiscount/lineNet/totalAmount 等）自动重算，
// 不在此处另算金额——保证口径与单行编辑完全一致。
function onLineDiscountConfirm(results) {
  const indices = [...selectedIndices].sort((a, b) => a - b)
  results.forEach((r, i) => {
    const lineIdx = indices[i]
    if (lineIdx == null || !form.lines[lineIdx]) return
    const line = form.lines[lineIdx]
    line.discountRate = r.discountRate
    line.discountRates = r.discountRates
    line.discount = r.discount
    line.total = r.total
  })
  selectedIndices.clear()
  nextTick(() => linesTable.value?.clearSelection())
  ElMessage.success(`已为 ${results.length} 行设置折扣`)
}
const form = reactive({ party:'', date:'', remark:'', settle:'挂账', photos:[], discount:0, discountRates:[], paidNow:0, depositPay:0, lines:[] })
// 历史销售价改为按需接口，不再随 items.json 下发；打开弹窗时取一次，
// 用于「该客户最近一次成交价」带出单价（未取到则退回分级售价/当前售价）
const saleHistoryMap = ref(null)
// 每次打开都取一次：接口层有 15 秒内存缓存，连续开单开销很小；
// 保存单据后缓存会失效，必须重新取，否则「该客户最近成交价」会一直用旧数据。
async function loadSaleHistory() {
  try { saleHistoryMap.value = (await api.getSaleHistory()) || {} }
  catch { if (!saleHistoryMap.value) saleHistoryMap.value = {} }
}

// 打开时整体重建表单：编辑回填原单（行折扣走 normalizeRate，兼容早期金额口径的旧数据）
watch(() => props.modelValue, async (open) => {
  // 每次关闭都还原窗口大小，下次打开按普通弹窗呈现
  if (!open) { maximized.value = false; return }
  await loadSaleHistory()
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
    // 多级折扣回填：优先 discountRates 数组；旧单只有标量 discountRate 时转为单级链；都没有则不打折
    const r = row
    if (Array.isArray(r.discountRates) && r.discountRates.length) form.discountRates = r.discountRates.map(Number)
    else if (Number(r.discountRate) > 0) form.discountRates = [Number(r.discountRate)]
    else form.discountRates = []
    // 编辑单：现金实收/实付（paidNow）与已用抵扣（depositPay）分别回填；抵扣部分来自原单 fromDeposit 流水，改写时沿用、不重复扣减档案余额
    const originPayments = ensurePayments(row, sumField.value)
    const depositFromTotal = round2(originPayments.filter(p => p.fromDeposit).reduce((s, p) => s + Number(p.amount || 0), 0))
    form.paidNow = Math.max(0, round2((isPurchase.value ? paidSumOf(row) : receivedSumOf(row)) - depositFromTotal))
    form.depositPay = depositFromTotal
    // 编辑回填：保留 discountRates 数组（多级折扣链），同时用 normalizeRate 兼容旧数据
    form.lines = (row.items || []).map(i => ({
      code: i.code, name: i.name, qty: i.qty, price: i.price,
      discountRate: normalizeRate(i, (i.qty || 0) * (i.price || 0)),
      // 多级折扣链：如果原行有 discountRates 数组，保留它；否则留空（由 discountRate 标量生效）
      discountRates: Array.isArray(i.discountRates) && i.discountRates.length ? i.discountRates.map(Number) : []
    }))
  } else {
    editingId.value = ''
    form.party = ''
    form.date = todayCN()
    form.remark = ''
    form.settle = '挂账'
    form.photos = []
    form.discount = 0
    form.discountRates = []
    form.paidNow = 0
    form.depositPay = 0
    form.lines = [{ code:'', name:'', qty:1, price:0, discountRate:1, discountRates:[] }]
  }
  // 打开弹窗后主动检查一次自动结清：unpaidAmount 可能「回填前后都是 0」
  // （首次打开就是全付旧单、或上一张处理过的单也未付为 0），值没变化 watch 不会触发，
  // 旧订单就会漏掉自动结清。nextTick 等 computed 重算完再判定
  nextTick(checkAutoSettle)
})

// 编辑中的原始单据（用于展示累计实付/实收，实收实付不在表单里改，统一走流水）
const editOrder = computed(() => (editingId.value ? (props.list || []).find(o => o.id === editingId.value) : null) || {})
// 原单是否已动过钱：动过就不能再原地改明细/折扣/优惠/结算状态——每一笔已记收付款流水都对应
// 一张已开的资金凭证，把金额改小等于凭空抹掉一笔真实进账。此时明细交给「变更明细」：
// 减少的商品生成退货单、新增的商品开补差单，原单不动。判据与服务端共用 utils/amend.js。
// 另一种锁定原因是本单已经有下级单（退货/补差按「原单行索引」定位商品行，明细一改索引就错位）。
const hasChildren = computed(() => !!editingId.value && (props.list || []).some(o => o.sourceOrderId === editingId.value))
const moneyLocked = computed(() => !!editingId.value && (hasChildren.value || moneyTouched(editOrder.value, props.kind)))
const lockTitle = computed(() => (hasChildren.value
  ? '这张单已经生成过退货单 / 补差单，明细与金额不能原地修改，否则下级单会指向错误的商品行。'
  : '这张单已记收付款流水：明细、折扣、优惠与结算状态已锁定，否则金额会与已开的收付款凭证对不上账。'))
const payCount = computed(() => ensurePayments(editOrder.value, sumField.value).length)
// 累计实付/实收（实时跟随表单）：编辑单取表单当前现金实付+抵扣（用户可直接改），新增单取本次填的「现金+抵扣」
const sumPaid = computed(() => round2(Number(form.paidNow || 0) + Number(form.depositPay || 0)))

// 编辑单「实付/实收金额」的下限 = 已记的现金流水合计（不含 fromDeposit 抵扣笔）。
// 调低这个框并不会改写历史流水（每笔流水各自对应已开的资金凭证，保存时只会发一条
// 「未生效」的 warning），所以与其让用户填完被弹回，不如直接把下限钉在已记金额上：
// 这里只能持平或调高（调高＝补一笔），要减少请到「记录收款/付款」里逐笔删改。
const cashFloor = computed(() => round2(
  ensurePayments(editOrder.value, sumField.value)
    .filter(p => !p.fromDeposit)
    .reduce((s, p) => s + Number(p.amount || 0), 0)
))

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
// 本次会话新增流水的一次性定位标记：父组件靠它把资金单据（SK-/FK-）编号精确回写到对应流水上。
// 仅存在于内存——attachPaymentVouchers 回写完即删除，后端 normalizeOrderPayments 再兜一道，绝不落库。
let midSeq = 0
const newMid = () => `o${Date.now().toString(36)}${(midSeq++).toString(36)}`
// 行折扣率（默认1＝原价）/ 行原价（数量×单价）/ 行减免额 / 折后小计；折扣只减钱、不改单价
// 行折扣率支持多级折扣链（discountRates 数组），与 normalizeRate 向后兼容旧单级 discountRate
const lineRate = (l) => lineEffectiveRate(l) || normalizeRate(l, lineGross(l))
const lineGross = (l) => round2((l.qty || 0) * (l.price || 0))
const lineDiscount = (l) => round2(lineGross(l) * (1 - lineRate(l)))
const lineNet = (l) => Math.max(0, round2(lineGross(l) - lineDiscount(l)))
const grossAmount = computed(() => form.lines.reduce((s, l) => s + lineGross(l), 0))
const lineDiscountSum = computed(() => form.lines.reduce((s, l) => s + lineDiscount(l), 0))
// 合计＝折后小计之和（已含单项折扣）；应付/应收 = 合计 × 整单折扣率 − 整单优惠金额
const totalAmount = computed(() => form.lines.reduce((s, l) => s + lineNet(l), 0))
// 整单等效折扣率：discountRates 连乘；无折扣返回 1（与 account.effectiveRateOf 口径一致）
const effRate = computed(() => {
  const rates = (form.discountRates || []).map(Number).filter(r => Number.isFinite(r) && r > 0)
  if (!rates.length) return 1
  return rates.reduce((a, b) => a * b, 1)
})
// 折扣链展示文本（单级 ×0.90 / 多级 ×0.90 ×0.90 ×0.80 = ×0.65 / 无折扣空串）
const orderRateText = computed(() => discountRatesTextOf({ discountRates: form.discountRates }))
// 整单折扣金额（人民币绝对值）：折扣链连乘后从合计里减掉的钱 = 合计 × (1 − 等效折扣率)。
// 与「整单优惠金额」共同构成应收/应付的减项——改折扣率时二者随折扣金额同步联动（折扣金额与优惠金额联动）。
// 与 account.discountAmountOf 口径一致；此处直接由 form 派生，避免组装临时 order 对象
const discountAmount = computed(() => Math.max(0, round2(totalAmount.value * (1 - effRate.value))))
// 多级折扣：添加 / 删除一级（可删到空＝不打折）
function addRate() { form.discountRates.push(1) }
function removeRate(i) { form.discountRates.splice(i, 1) }
const dueTotal = computed(() => Math.max(0, round2(totalAmount.value * effRate.value) - Number(form.discount || 0)))
// 折后金额＝应用全部折扣后、未扣优惠前的金额（合计 × 整单等效折扣率）；与应收/应付(再扣优惠)区分展示
const discountedTotal = computed(() => round2(totalAmount.value * effRate.value))
// 是否有折扣（整单折扣链或单项折扣），用于控制「折后金额」展示
const hasDiscount = computed(() => (form.discountRates || []).filter(r => Number(r) > 0).length > 0 || lineDiscountSum.value > 0)
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

// 手动填的抵扣额不允许超过上限（el-input-number 的 :max 之外再兜底一道）。编辑单的抵扣为只读（沿用原单已用预付款），不动它
watch(() => form.depositPay, (v) => {
  if (editingId.value) return
  const max = deductMax.value
  if (Number(v || 0) > max) form.depositPay = max
})

// 结清模式联动：用户手填的金额优先，另一项自动补差，保持「未付款=0」（红线）。
// 锚点 anchor：'paid'（实收为基准→优惠补差）/ 'deposit'（抵扣为基准→优惠补差）/ 'discount'（优惠为基准→实收补差）。
// 仅结清模式生效；挂账模式三项独立、互不联动。计算入口统一走 account.settleBalance，便于单测。
const settleAnchor = ref('paid')
// el-input-number 的 input 事件比 v-model 先跑一步（Element Plus 里 handleInput 先 emit('input')
// 再 emit('update:modelValue')），在 @input 里直接算补差读到的是**上一个值**：
// 例如实收框里 7 → 点结清（优惠补成 68）→ 把 7 改成 75，联动仍按 7 算，优惠停在 68，
// 于是出现「实收 75 / 应收 7 / 未收 0」这种自相矛盾，保存还会撞红线①。
// 所以这里只记锚点，等一个 tick 让 v-model 落地后再补差。
function markAnchor(anchor) {
  settleAnchor.value = anchor
  nextTick(() => reconcile())
}
// 结清模式下实收/实付的上限 = 折后金额 − 已用抵扣：结清单据多收的部分只能变成优惠，
// 收不进钱却把金额填大，保存必被红线①拦下，不如把输入框直接封顶。
// 挂账模式不封顶（多收可转预存，由红线提示）；上限低于下限时也不封顶（历史超付单据不能被夹死）。
const cashCeil = computed(() => {
  if (form.settle !== '结清') return undefined
  const ceil = round2(discountedTotal.value - Number(form.depositPay || 0))
  return ceil >= cashFloor.value ? ceil : undefined
})
function reconcile(anchor) {
  if (anchor) settleAnchor.value = anchor
  if (form.settle !== '结清') return
  const gross = round2(totalAmount.value * effRate.value)
  let { discount: d, paidNow: p } = settleBalance({
    gross,
    paidNow: form.paidNow,
    depositPay: form.depositPay,
    discount: form.discount,
    anchor: settleAnchor.value
  })
  const floor = cashFloor.value
  if (p < floor) {
    // 已记流水不能凭空减掉：实付钉在下限上，优惠按剩余量重算，仍保持「未付款 = 0」
    p = floor
    d = Math.max(0, round2(gross - floor - Number(form.depositPay || 0)))
  }
  if (Number(form.discount || 0) !== d) form.discount = d
  if (Number(form.paidNow || 0) !== p) form.paidNow = p
}
// 切换为结清：以当前实收为基准，优惠自动补差（未付款归 0）
watch(() => form.settle, (v) => { if (v === '结清') { settleAnchor.value = 'paid'; reconcile() } })
// 改合计 / 整单折扣率（毛额变化）时按当前锚点重新平衡（不切换基准）
watch([totalAmount, () => form.discountRates.join('|')], () => reconcile())

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
  const hist = ((saleHistoryMap.value && saleHistoryMap.value[code]) || []).filter(h => h.customer === form.party)
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

// 明细行判定：code 与 name 都为空＝空白行。
// 「添加行」和新增单的首行都是空白行，用户往往不会去填它，因此空白行不该拦下整单；
// 但「填了数量/单价却没选商品」的空白行是漏填，必须指名道姓报出来，不能静默丢弃。
const isBlankLine = (l) => !l || (!l.code && !l.name)
const isUntouchedBlankLine = (l) => isBlankLine(l)
  && !(Number(l?.price || 0) > 0) && !(Number(l?.qty || 0) > 1) && !(Number(l?.discountRate ?? 1) < 1)

// 校验类提示统一停留 5 秒：手机端弹窗长、注意力在下半屏，3 秒自动消失的 toast
// 会让一次被拦截的保存看起来「点了没反应」
const warn = (message) => ElMessage.warning({ message, duration: 5000 })

// 顶部快速添加：选择已有商品或输入新商品名后回车，直接把一行加入明细（下方表格可继续改数量/单价）。
// 新商品（库内无同名）以 name 占位、code 留空，保存时由 resolveLine 分配正式 P 编码，不会产生乱码
async function addQuickItem(val) {
  const code = val != null ? val : quickItem.value
  if (!code) return
  const found = (props.items || []).find(i => i.code === code || i.name === code)
  // 同一商品已在本单明细里：弹「本商品已录入」，让用户选定位或再次添加。
  // 库内商品按 code 认；手输的新商品名（code 为空）按 name 认，避免同名两行。
  const dup = found
    ? form.lines.findIndex(l => l.code === found.code || (!l.code && l.name === found.name))
    : form.lines.findIndex(l => !l.code && l.name === String(code))
  if (dup >= 0) {
    const choice = await askDuplicateItem({ name: found ? found.name : String(code), index: dup })
    quickItem.value = ''
    if (choice === 'locate') return flashTableRow(linesTable, dup)
    if (choice !== 'add') return
  }
  const line = found
    ? { code: found.code, name: found.name, qty: 1, price: priceFor(found), discountRate: 1, discountRates: [] }
    : { code: '', name: String(code), qty: 1, price: 0, discountRate: 1, discountRates: [] }
  // 优先填入第一个未触碰的空白行：直接 push 会在明细里留下一行空白，
  // 过去这行空白会让「保存出库」静默失败（点了没反应的直接原因）
  const blank = form.lines.findIndex(isUntouchedBlankLine)
  if (blank >= 0) form.lines.splice(blank, 1, line)
  else form.lines.push(line)
  quickItem.value = ''
  ElMessage.success(`已添加：${found ? found.name : code}`)
}

async function doSave() {
  if (photoUpload.value && photoUpload.value.isUploading()) return warn('照片正在上传中，请等待上传完成后再保存')
  if (!form.party) return warn(`请填写${partyLabel.value}`)
  // 空白行不再拦下整单：未触碰的空行忽略，填了数量/单价却没选商品的行明确指出第几行
  const pending = form.lines.map((l, idx) => ({ l, idx })).filter(o => !isUntouchedBlankLine(o.l))
  if (!pending.length) return warn(`请先添加至少一行${bizWord.value}商品`)
  const missed = pending.find(o => isBlankLine(o.l))
  if (missed) return warn(`第 ${missed.idx + 1} 行没选商品（已填数量/单价）：请补选商品或删除该行`)
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
  // 新增商品时分配正式 P 编码（P + 5 位，从当前商品库最大序号 +1 递增），避免写入乱码 N… 临时编码
  let pMax = 0
  for (const x of catalog) { const m = /^P(\d{5})$/.exec(x.code || ''); if (m) pMax = Math.max(pMax, parseInt(m[1], 10)) }
  const nextCodeFn = () => { pMax += 1; return 'P' + String(pMax).padStart(5, '0') }
  const resolved = []
  pending.forEach(({ l, idx }) => {
    // 采购行要带 cost（影响商品建档成本），销售行直接用成交价
    const result = isPurchase.value ? resolveLine(catalog, { ...l, cost: l.price }, idx, nextCodeFn) : resolveLine(catalog, l, idx, nextCodeFn)
    if (result.line) {
      catalog = result.items
      // 保留行级多级折扣链（discountRates 数组）：resolveLine 只返回 discountRate 标量，
      // 但过账时需要把链本身也带上，确保「过账后金额不变数」
      const resolvedLine = { ...result.line }
      if (Array.isArray(l.discountRates) && l.discountRates.length) {
        resolvedLine.discountRates = l.discountRates.map(Number)
      }
      resolved.push(resolvedLine)
    }
  })
  if (!resolved.length) return warn(`请完整填写${bizWord.value}明细`)
  const amount = resolved.reduce((s, l) => s + l.total, 0)
  const discountVal = Number(form.discount || 0)
  const isEdit = !!editingId.value
  const origin = isEdit ? (props.list || []).find(o => o.id === editingId.value) : null
  // 收付款统一走 payments 流水。新增单：现金实付 + 预付款/预收款抵扣直接落成流水；
  // 编辑单：现金实收/实付由表单 paidNow 决定，抵扣部分沿用原单已用预付款（fromDeposit 流水原样保留，避免重复扣减档案余额）。
  // 结清时的「未付款=0」由录入时的实时联动（settleBalance）保证，保存前再做一次红线校验。
  // 本次会话新增的收付款流水（新增单的全部实收/抵扣、编辑单的补收差额）：
  // 交父组件逐笔生成资金单据，编号回写后再整表落库
  let payRows = []
  let entry = {
    ...(origin || {}),
    [partyField.value]: form.party,
    date: form.date,
    remark: form.remark || '',
    settle: form.settle || '挂账',
    photos: [...(form.photos || [])],
    discount: discountVal,
    discountRates: (form.discountRates || []).map(Number).filter(r => Number.isFinite(r) && r > 0),
    discountRate: round2(effRate.value),
    items: resolved,
    total: amount
  }
  if (!isEdit) {
    // 新增单：把「现金实付」与「预付款/预收款抵扣」直接落成流水
    const payments = []
    const paidNow = round2(Number(form.paidNow || 0))
    const depositPay = round2(Number(form.depositPay || 0))
    const now = new Date().toISOString()
    // mid：本次会话的一次性定位标记，父组件据此把资金单据编号精确回写到对应流水上，落库前删除
    if (paidNow > 0) payments.push({ date: form.date, amount: paidNow, remark: `现${payWord.value}`, time: now, mid: newMid() })
    if (depositPay > 0) payments.push({ date: form.date, amount: depositPay, remark: `用${depositLabel.value}抵扣`, fromDeposit: true, time: now, mid: newMid() })
    entry = { id: genOrderId(prefix.value, props.list, form.date), ...entry, payments, [sumField.value]: round2(paidNow + depositPay) }
    payRows = payments.map(p => ({ ...p }))
  } else {
    // 编辑单：原有收付款流水一律原样保留（现金笔 + 预存款抵扣笔）——它们已经各自对应一张资金单据，
    // 重写成一笔会把编号对应关系抹掉，也会让「用预存款抵扣」的档案扣减失去依据（重复扣减风险）。
    // 「实收金额」只用于算差额：调高 → 追加一笔补收（父组件据此开一张新收款单）；
    // 调低 → 不改历史流水，请到「收款流水」弹窗逐笔修改，保证单据与凭证一一对应。
    const originPayments = ensurePayments(origin, sumField.value)
    const depositFrom = originPayments.filter(p => p.fromDeposit)
    const cashOld = originPayments.filter(p => !p.fromDeposit)
    const depositFromTotal = round2(depositFrom.reduce((s, p) => s + Number(p.amount || 0), 0))
    const cashOldTotal = round2(cashOld.reduce((s, p) => s + Number(p.amount || 0), 0))
    const cashNew = Math.max(0, round2(Number(form.paidNow || 0)))
    const rebuilt = [...cashOld.map(p => ({ ...p })), ...depositFrom.map(p => ({ ...p }))]
    const delta = round2(cashNew - cashOldTotal)
    if (delta > 0.005) {
      const row = { date: form.date, amount: delta, remark: `补${payWord.value}`, time: new Date().toISOString(), mid: newMid() }
      rebuilt.push(row)
      payRows = [{ ...row }]
    } else if (delta < -0.005) {
      ElMessage.warning(`实${payWord.value}金额调低 ¥${Math.abs(delta).toFixed(2)} 未生效：已收付的流水对应着已开的资金单据，请到「${payWord.value}款」弹窗逐笔修改`)
    }
    entry.payments = rebuilt
    entry[sumField.value] = round2(cashOldTotal + Math.max(0, delta) + depositFromTotal)
    form.depositPay = depositFromTotal
  }
  // 红线校验①：实付/实收合计不得超过本单应付/应收总额（合计 × 折扣链 − 整单优惠）。
  // 上限必须用 grossOf（应付/应收总额），不能用 payableOf / receivableOf ——
  // 那两个是「未付/未收余额」：已结清的单据余额恒为 0，拿余额当上限会把
  // 实付＝应付的正常单据全部拦下（编辑任何一张已付满的单都存不了，
  // 新增时选「结清」并填实付同样被拦）。该错误自 1f3fc72 引入起就存在。
  const paidAtSave = isPurchase.value ? paidSumOf(entry) : receivedSumOf(entry)
  const dueTotalAtSave = grossOf(entry)
  const over = overpaidOf(entry, isPurchase.value ? 'payable' : 'receivable')
  if (over > 0.005) {
    // 编辑单里把「实付金额」调小并不会改写历史流水（每笔流水各自对应已开的资金单据），
    // 所以提示必须指向真正能改的地方；否则用户照着提示调小实付、再点保存还是被拦。
    return ElMessage.error(isEdit
      ? `本单已记${payWord.value}款流水合计 ¥${paidAtSave.toFixed(2)}，超过${dueWord.value}总额 ¥${dueTotalAtSave.toFixed(2)}（超出 ¥${over.toFixed(2)}）。\n` +
        `编辑弹窗不会改动历史${payWord.value}款流水，请到详情页「记录${payWord.value}款」里逐笔修改，或把${dueWord.value}（合计／折扣／优惠）调回不低于已${payWord.value}金额；多${payWord.value}的部分也可转为${depositLabel.value}。`
      : `实${payWord.value}金额不能超过${dueWord.value}总额 ¥${dueTotalAtSave.toFixed(2)}（当前实${payWord.value} ¥${paidAtSave.toFixed(2)}，超出 ¥${over.toFixed(2)}）。请调低「实${payWord.value}金额」或减少抵扣。`)
  }
  // 红线校验②：结清状态下未付/未收必须为 0（按金额判定，与结算状态标签无关；容忍半分钱以内的浮点尘）
  const debtAtSave = isPurchase.value ? payableOf(entry) : receivableOf(entry)
  if (form.settle === '结清' && debtAtSave > 0.005) {
    return ElMessage.error(`「结清」状态下未付款必须为 0，但当前仍有未付款 ¥${debtAtSave.toFixed(2)}。请调高「实${payWord.value}金额」或「整单优惠金额」后再保存。`)
  }
  entry[sumField.value] = isPurchase.value ? paidSumOf(entry) : receivedSumOf(entry)
  // 用预付款/预收款抵扣的部分：随保存一并交父组件从对应档案余额扣减（幂等，按订单 id 标记）
  const depositDeduct = (!isEdit && round2(Number(form.depositPay || 0)) > 0)
    ? { amount: round2(Number(form.depositPay || 0)) }
    : null
  // 只组装、不落库：交给父组件保存（失败时弹窗保持打开可重试）。
  // items：含本次可能新增商品的完整商品库（新商品已带正式 P 编码），交由父组件落库，保证单据行 code 与主数据一致
  emit('saved', { entry, isEdit, id: entry.id, depositDeduct, payRows, items: catalog })
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
/* 资金锁定提示条：置于 el-form 之外，否则表单级禁用会连带「变更明细」按钮一起灰掉 */
.lock-bar{margin:-8px 0 14px;}
/* 弹窗标题栏：最大化角标在最左侧，标题紧随其后 */
.dlg-header{display:flex;align-items:center;gap:6px;min-width:0;}
/* 标题左侧的最大化角标：一处纯图标按钮。
   全局把 .el-button.is-text 补成了实心蓝（见 App.vue），这里必须整块覆盖掉，
   否则角标是个蓝色方块，跟标题挤在一起像个徽章 */
.dlg-max{
  padding:0; width:26px; height:26px; min-height:0; margin-right:2px;
  background:transparent !important; border-color:transparent !important;
  color:var(--text-regular) !important;
}
.dlg-max:hover{ color:var(--color-primary) !important; background:var(--bg-hover) !important; }
.lock-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px;}
.locked-value{color:var(--text-regular);font-size:var(--fs-table);}
.calc-line{display:flex;gap:20px;flex-wrap:wrap;color:var(--text-regular);font-size:var(--fs-table);}
/* 快速添加选择框撑满表单内容区，避免 300px 硬宽在窄弹窗下右侧溢出 */
.quick-add-select{width:100%;max-width:100%;}
/* 预存款抵扣框左侧文案：与输入框之间留出间距，避免贴在一起看不清 */
.field-label{color:var(--text-regular);font-size:var(--fs-base);min-width:64px;flex:none;}
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
.rate-chain{display:flex;flex-direction:column;gap:6px;}
.rate-row{display:flex;align-items:center;gap:8px;}
.rate-idx{color:var(--text-secondary);font-size:var(--fs-sub);min-width:44px;}
.rate-eff{margin-top:2px;color:var(--color-success);font-size:var(--fs-sub);font-weight:600;}
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
/* 定位重复商品：蓝色外框闪两下（只作用于该行单元格，不改变表格布局） */
:deep(tr.locate-flash > td){animation:locate-flash 1.6s ease-in-out 1;}
@keyframes locate-flash{
  0%,20%,40%,60%,80%,100%{box-shadow:inset 0 0 0 0 rgba(64,158,255,0);background:transparent;}
  10%,30%,50%,70%{box-shadow:inset 0 0 0 2px #409eff;background:rgba(64,158,255,.14);}
}
.discount{color:var(--color-success);}
.none{color:var(--text-placeholder);}
.debt{color:var(--color-danger);font-weight:600;}
/* 批量操作按钮区：紧贴明细表上方，与「添加行」按钮同行对齐 */
.batch-actions{display:flex;gap:8px;margin-top:8px;align-items:center;}
</style>
