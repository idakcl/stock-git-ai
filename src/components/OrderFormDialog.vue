<template>
  <!-- 订单（草稿）编辑弹窗：只写 orders.json，不进库存、不进应收、不开凭证。
       金额口径与单据完全一致（合计 × 折扣链 − 整单优惠），过账后两张数字必须一样，
       所以这里直接复用 utils/orders.js 的 orderAmount，绝不在弹窗里另算一套。 -->
  <el-dialog v-model="visible" :title="title" width="620" :close-on-click-modal="false" :close-on-press-escape="!(saving || emitting)">
    <el-alert class="draft-alert" type="info" :closable="false" show-icon
      title="订单是未过账单据：不占库存、不计应收/应付，可以随便改、随便删。点「过账」才会生成正式单据。" />
    <el-form :model="form" label-width="110px">
      <el-form-item label="订单类型">
        <!-- 已过账的订单不能改类型（要改请先撤销过账）；新建与草稿可自由切换 -->
        <el-radio-group v-model="form.kind" :disabled="posted">
          <el-radio-button value="sale">销售订单</el-radio-button>
          <el-radio-button value="purchase">采购订单</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="partyLabel">
        <el-select v-model="form.party" filterable allow-create default-first-option :placeholder="`选择或输入${partyLabel}`" style="width:100%">
          <el-option v-for="p in partyOptions" :key="p.code || p.name" :label="optionLabel(p)" :value="p.name" />
        </el-select>
      </el-form-item>
      <el-form-item label="日期"><el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="业务单号">
        <el-input v-model="form.no" maxlength="40" placeholder="选填：客户/供应商那边的单号，过账后会带到单据上" />
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
      <el-form-item label="单据照片"><PhotoUpload ref="photoUpload" :key="photoKey" v-model="form.photos" /></el-form-item>
      <el-form-item v-if="deposits.length" label="已收订金">
        <div class="deposit-list">
          <div v-for="(d, i) in deposits" :key="i" class="deposit-row">
            <span>{{ d.date }}</span>
            <b>¥ {{ Number(d.amount || 0).toFixed(2) }}</b>
            <span class="calc-hint">{{ d.remark || '订金' }}</span>
            <router-link v-if="d.voucher" :to="{ path: '/vouchers', query: { code: d.voucher } }" class="link">{{ d.voucher }}</router-link>
          </div>
          <div class="deposit-total">订金合计 ¥ {{ depositSum.toFixed(2) }} · 过账时自动转成第一笔{{ payWord }}款</div>
        </div>
      </el-form-item>

      <el-form-item label="快速添加">
        <el-select v-model="quickItem" filterable default-first-option placeholder="选择商品后回车添加" class="quick-add-select" @change="addQuickItem">
          <el-option v-for="i in items" :key="i.code" :label="`${i.name} (${i.code})`" :value="i.code" />
        </el-select>
        <div class="calc-hint">订单只能选商品库里已有的商品；新品请先到商品档案新增</div>
      </el-form-item>
      <div class="lines-scroll">
        <el-table :data="form.lines" stripe max-height="320">
          <el-table-column label="商品" min-width="180">
            <template #default="{ row }">
              <el-select v-model="row.code" filterable placeholder="选择商品" style="width:100%" @change="onItemChange(row)">
                <el-option v-for="i in items" :key="i.code" :label="`${i.name} (${i.code})`" :value="i.code" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="数量" width="100" align="right">
            <template #default="{ row }"><el-input-number v-model="row.qty" :min="1" size="small" v-select-on-focus /></template>
          </el-table-column>
          <el-table-column label="单价" width="110" align="right">
            <template #default="{ row }"><el-input-number v-model="row.price" :min="0" :precision="2" size="small" v-select-on-focus /></template>
          </el-table-column>
          <!-- 行折扣与正式单据同一字段（discountRate）与同一口径（只减钱、不改单价），
               过账时原样搬进单据，订单金额与单据金额才不会在过账后变数 -->
          <el-table-column label="折扣" width="100" align="right">
            <template #default="{ row }">
              <el-input-number v-model="row.discountRate" :min="0" :max="1" :step="0.05" :precision="2" :controls="false" size="small" v-select-on-focus />
            </template>
          </el-table-column>
          <el-table-column label="小计" width="100" align="right">
            <template #default="{ row }">
              <span class="line-net" :title="lineRate(row) < 1 ? `原价 ¥${lineGross(row).toFixed(2)}` : ''">{{ lineTotal(row).toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="" width="60">
            <template #default="{ $index }"><el-button size="small" type="danger" @click="form.lines.splice($index,1)">×</el-button></template>
          </el-table-column>
        </el-table>
      </div>
      <div style="margin-top:8px">
        <el-button size="small" @click="form.lines.push({ code:'', name:'', qty:1, price:0, discountRate:1 })">添加行</el-button>
        <span class="calc-hint" style="margin-left:12px">折扣＝折扣率：1＝原价，0.9＝九折；整单优惠请填下方「整单优惠金额」</span>
      </div>
      <div style="margin-top:12px;text-align:right">
        <b>合计：¥ {{ totalAmount.toFixed(2) }}</b>
        <div v-if="lineDiscountSum > 0 || orderRateText || Number(form.discount) > 0" class="calc-detail">
          <span v-if="lineDiscountSum > 0">原价合计 ¥ {{ grossAmount.toFixed(2) }}</span>
          <span v-if="lineDiscountSum > 0" class="discount">单项折扣 -¥ {{ lineDiscountSum.toFixed(2) }}</span>
          <span v-if="orderRateText" class="discount">整单折扣 {{ orderRateText }}（减 ¥{{ discountAmount.toFixed(2) }}）</span>
          <span v-if="Number(form.discount) > 0" class="discount">整单优惠金额 -¥ {{ Number(form.discount).toFixed(2) }}</span>
        </div>
      </div>
      <el-form-item label="整单折扣">
        <div class="rate-chain">
          <div v-for="(r, i) in form.discountRates" :key="i" class="rate-row">
            <span class="rate-idx">第 {{ i + 1 }} 级</span>
            <el-input-number v-model="form.discountRates[i]" :min="0.01" :max="1" :step="0.01" :precision="2" :controls="false" style="width:120px" v-select-on-focus />
            <el-button link type="danger" size="small" @click="form.discountRates.splice(i,1)">删除</el-button>
          </div>
          <el-button size="small" type="primary" plain @click="form.discountRates.push(1)">+ 添加一级折扣</el-button>
        </div>
        <div class="calc-hint" style="margin-top:4px">每级 0~1（1＝不打折，0.9＝九折），各级连乘；与单据口径完全一致，过账后不会变数。</div>
      </el-form-item>
      <el-form-item label="整单优惠金额">
        <el-input-number v-model="form.discount" :min="0" :precision="2" :controls="false" style="width:200px" v-select-on-focus />
      </el-form-item>
      <el-form-item label=" ">
        <div class="calc-line">
          <span>订单金额：<b>{{ orderAmountValue.toFixed(2) }}</b></span>
          <span v-if="deposits.length">尚差：{{ owed.toFixed(2) }}</span>
        </div>
      </el-form-item>
    </el-form>
    <template #footer>
      <span v-if="saving || emitting" class="saving-hint">保存中，请稍候…</span>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving || emitting" @click="save">保存订单</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import PhotoUpload from './PhotoUpload.vue'
import { round2, discountRatesTextOf } from '../utils/account.js'
import { normalizeRate } from '../utils/catalog.js'
import { orderAmount, orderDepositSum, validateOrder, DRAFT } from '../utils/orders.js'
import { todayCN } from '../utils/time.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 编辑中的订单（null＝新建）
  order: { type: Object, default: null },
  items: { type: Array, default: () => [] },
  customers: { type: Array, default: () => [] },
  suppliers: { type: Array, default: () => [] },
  saving: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'saved'])

const visible = computed({ get: () => props.modelValue, set: (v) => emit('update:modelValue', v) })
const photoUpload = ref(null)
const photoKey = ref(0)
const quickItem = ref('')
const emitting = ref(false)
const editingId = ref('')
const posted = ref(false)
const form = reactive({ kind:'sale', party:'', date:'', no:'', remark:'', photos:[], discount:0, discountRates:[], lines:[] })

const isPurchase = computed(() => form.kind === 'purchase')
const partyLabel = computed(() => (isPurchase.value ? '供应商' : '客户'))
const payWord = computed(() => (isPurchase.value ? '付' : '收'))
const title = computed(() => (editingId.value ? `编辑订单 · ${editingId.value}` : '新建订单'))
const partyOptions = computed(() => (isPurchase.value ? props.suppliers : props.customers) || [])
const optionLabel = (p) => p.label || `${p.name}${p.code ? ` (${p.code})` : ''}`
const deposits = computed(() => props.order?.deposits || [])
const depositSum = computed(() => orderDepositSum(props.order))

// 打开时整表重建：草稿回填，新建给一行空明细
watch(() => props.modelValue, (open) => {
  if (!open) return
  photoKey.value += 1
  quickItem.value = ''
  const row = props.order
  if (row && row.id) {
    editingId.value = row.id
    posted.value = row.status !== DRAFT
    form.kind = row.kind === 'purchase' ? 'purchase' : 'sale'
    form.party = row.kind === 'purchase' ? (row.supplier || '') : (row.customer || '')
    form.date = row.date || todayCN()
    form.no = row.no || ''
    form.remark = row.remark || ''
    form.photos = [...(row.photos || [])]
    form.discount = Number(row.discount || 0)
    form.discountRates = (row.discountRates || []).map(Number)
    form.lines = (row.items || []).map(l => ({
      code: l.code, name: l.name, qty: l.qty, price: l.price,
      // 行折扣按正式单据同一套归一化回填（兼容早期「折扣是金额」的旧数据）
      discountRate: normalizeRate(l, Number(l.qty || 0) * Number(l.price || 0))
    }))
  } else {
    editingId.value = ''
    posted.value = false
    form.kind = 'sale'
    form.party = ''
    form.date = todayCN()
    form.no = ''
    form.remark = ''
    form.photos = []
    form.discount = 0
    form.discountRates = []
    form.lines = [{ code:'', name:'', qty:1, price:0, discountRate:1 }]
  }
})

// 行金额三件套（与 OrderEditDialog / utils/catalog.resolveLine 同一口径）：
// 原价＝数量×单价，折后小计＝原价×(1−折扣率)，折扣只减钱、不改单价
const lineGross = (l) => round2(Number(l.qty || 0) * Number(l.price || 0))
const lineRate = (l) => normalizeRate(l, lineGross(l))
const lineDiscount = (l) => round2(lineGross(l) * (1 - lineRate(l)))
const lineTotal = (l) => Math.max(0, round2(lineGross(l) - lineDiscount(l)))
const grossAmount = computed(() => round2(form.lines.reduce((s, l) => s + lineGross(l), 0)))
const lineDiscountSum = computed(() => round2(form.lines.reduce((s, l) => s + lineDiscount(l), 0)))
// 合计＝折后小计之和（已含单项折扣），整单折扣链与整单优惠在此之上再作用
const totalAmount = computed(() => round2(form.lines.reduce((s, l) => s + lineTotal(l), 0)))
const effRate = computed(() => {
  const rates = (form.discountRates || []).map(Number).filter(r => Number.isFinite(r) && r > 0)
  return rates.length ? rates.reduce((a, b) => a * b, 1) : 1
})
const orderRateText = computed(() => discountRatesTextOf({ discountRates: form.discountRates }))
const discountAmount = computed(() => Math.max(0, round2(totalAmount.value * (1 - effRate.value))))
// 订单金额与 utils/orders.js、服务端三处同一口径（orderAmount 内部走 grossOf）
const draft = computed(() => ({
  id: editingId.value || undefined,
  kind: form.kind,
  [isPurchase.value ? 'supplier' : 'customer']: form.party,
  date: form.date,
  no: form.no,
  remark: form.remark,
  photos: form.photos,
  discount: Number(form.discount || 0),
  discountRates: (form.discountRates || []).map(Number),
  items: form.lines.map(l => ({
    code: l.code, name: l.name, qty: Number(l.qty || 0), price: Number(l.price || 0),
    discountRate: lineRate(l), discount: lineDiscount(l), total: lineTotal(l)
  })),
  status: DRAFT
}))
const orderAmountValue = computed(() => orderAmount(draft.value))
const owed = computed(() => Math.max(0, round2(orderAmountValue.value - depositSum.value)))

function onItemChange(row) {
  const found = (props.items || []).find(i => i.code === row.code)
  if (!found) return
  row.name = found.name
  // 采购带进价、销售带售价（订单价格仍可手改）；换商品不动行折扣，用户自己改过的折扣不丢
  row.price = Number(isPurchase.value ? (found.cost || found.price || 0) : (found.price || 0))
}
function addQuickItem(val) {
  if (!val) return
  const found = (props.items || []).find(i => i.code === val)
  if (!found) return ElMessage.warning('订单只能选商品库里已有的商品')
  const line = { code: found.code, name: found.name, qty: 1, discountRate: 1, price: Number(isPurchase.value ? (found.cost || found.price || 0) : (found.price || 0)) }
  const blank = form.lines.findIndex(l => !l.code && !l.name && !(Number(l.qty) > 1) && !(Number(l.price) > 0))
  if (blank >= 0) form.lines.splice(blank, 1, line)
  else form.lines.push(line)
  quickItem.value = ''
  ElMessage.success(`已添加：${found.name}`)
}

async function save() {
  if (emitting.value || props.saving) return
  if (photoUpload.value && photoUpload.value.isUploading()) return ElMessage.warning('照片正在上传中，请等待上传完成后再保存')
  // 校验交给与服务端同一份 validateOrder：界面能提交、服务端必能落库
  const errors = validateOrder(draft.value, { items: props.items })
  if (errors.length) return ElMessage.error({ message: errors[0], duration: 5000 })
  emitting.value = true
  try {
    emit('saved', { draft: draft.value, isEdit: !!editingId.value, id: editingId.value || undefined })
  } finally { emitting.value = false }
}
</script>

<style scoped>
:deep(.el-form-item__label){white-space:nowrap;}
/* 顶部灰底提示条与下方表单之间留出呼吸：紧贴「订单类型」那一行时，整块看起来像被压扁了 */
.draft-alert{margin-bottom:14px;}
.quick-add-select{width:100%;max-width:100%;}
.calc-hint{color:var(--text-secondary);font-weight:400;font-size:var(--fs-sub);line-height:1.5;}
.lines-scroll{overflow-x:auto;}
.lines-scroll :deep(.el-input-number){width:100%;}
.rate-chain{display:flex;flex-direction:column;gap:6px;}
.rate-row{display:flex;align-items:center;gap:8px;}
.rate-idx{color:var(--text-secondary);font-size:var(--fs-sub);min-width:44px;}
.calc-detail{display:flex;justify-content:flex-end;gap:16px;flex-wrap:wrap;margin-top:2px;color:var(--text-secondary);font-size:var(--fs-sub);}
.calc-line{display:flex;gap:20px;flex-wrap:wrap;color:var(--text-regular);font-size:var(--fs-table);}
.line-net{font-variant-numeric:tabular-nums;}
.discount{color:var(--color-success);}
.saving-hint{margin-right:12px;color:var(--color-primary);font-size:var(--fs-sub);}
.deposit-list{width:100%;color:var(--text-regular);font-size:var(--fs-table);}
.deposit-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;}
.deposit-total{margin-top:4px;color:var(--text-secondary);font-size:var(--fs-sub);}
@media (max-width: 768px){
  .lines-scroll :deep(.el-table .cell){padding-left:5px;padding-right:5px;}
}
</style>
