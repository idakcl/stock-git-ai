<template>
  <!-- 模板新增/编辑弹窗：只存商品明细（商品+数量+单价+行折扣率），不存客户/日期/单号。
       金额口径与订单完全一致（合计 × 折扣链 − 整单优惠），生成订单时按 orderAmount 重算。 -->
  <el-dialog v-model="visible" :title="title" width="min(620px, 94vw)" :fullscreen="maximized" :close-on-click-modal="false" :close-on-press-escape="!saving">
    <!-- 左上角最大化角标：行多的时候铺满屏幕，明细表能拿到更多高度；再点一次还原（与订单/单据弹窗同一交互） -->
    <template #header="{ titleId, titleClass }">
      <div class="dlg-header">
        <el-button class="dlg-max" text :title="maximized ? '还原窗口' : '最大化窗口'" :aria-label="maximized ? '还原窗口' : '最大化窗口'" @click="toggleMax">
          <MaxIcon :restore="maximized" />
        </el-button>
        <span :id="titleId" :class="titleClass">{{ title }}</span>
      </div>
    </template>
    <el-form :model="form" label-width="100px">
      <el-form-item label="模板名称">
        <el-input v-model="form.name" maxlength="60" placeholder="例如：常用管件组合、标准配件包" />
      </el-form-item>
      <el-form-item label="模板类型">
        <el-radio-group v-model="form.kind">
          <el-radio-button value="sale">销售模板</el-radio-button>
          <el-radio-button value="purchase">采购模板</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-form-item label="快速添加">
        <GoodsSelect v-model="quickItem" :items="items" first-option placeholder="选择商品后回车添加" class="quick-add-select" @change="addQuickItem" />
        <div class="calc-hint">只能选商品库里已有的商品；新品请先到商品档案新增</div>
      </el-form-item>

      <div class="scroll-hint">手机上表格可左右滑动，查看单价 / 折扣 / 小计</div>
      <div class="lines-scroll">
        <el-table ref="linesTable" :data="form.lines" stripe :max-height="linesMaxHeight">
          <el-table-column label="商品" min-width="150">
            <template #default="{ row }">
              <GoodsSelect v-model="row.code" :items="items" placeholder="选择商品" style="width:100%" @change="onItemChange(row)" />
            </template>
          </el-table-column>
          <el-table-column label="数量" width="100" align="right">
            <template #default="{ row }"><el-input-number v-model="row.qty" :min="1" size="small" /></template>
          </el-table-column>
          <el-table-column label="单价" width="110" align="right">
            <template #default="{ row }"><el-input-number v-model="row.price" :min="0" :precision="2" size="small" /></template>
          </el-table-column>
          <!-- 行折扣率与订单/单据同一字段（discountRate）与同一口径（只减钱、不改单价） -->
          <el-table-column label="折扣" width="100" align="right">
            <template #default="{ row }">
              <el-input-number v-model="row.discountRate" :min="0" :max="1" :step="0.05" :precision="2" :controls="false" size="small" />
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
        <span class="calc-hint" style="margin-left:12px">折扣＝折扣率：1＝原价，0.9＝九折</span>
      </div>

      <div style="margin-top:12px;text-align:right">
        <b>合计：¥ {{ totalAmount.toFixed(2) }}</b>
        <div v-if="lineDiscountSum > 0" class="calc-detail">
          <span>原价合计 ¥ {{ grossAmount.toFixed(2) }}</span>
          <span class="discount">单项折扣 -¥ {{ lineDiscountSum.toFixed(2) }}</span>
        </div>
      </div>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { round2 } from '../utils/account'
import GoodsSelect from './GoodsSelect.vue'
import MaxIcon from './MaxIcon.vue'
import { normalizeRate } from '../utils/catalog'

const props = defineProps({
  modelValue: Boolean,
  template: Object, // 编辑时传入；新增时为 null
  items: { type: Array, default: () => [] }, // 商品库
  saving: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'saved'])

const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v)
})

const title = computed(() => props.template ? '编辑模板' : '新建模板')

const defaultForm = () => ({
  name: '',
  kind: 'sale',
  lines: []
})

const form = ref(defaultForm())
const quickItem = ref('')
// 弹窗最大化（左上角角标切换）：明细多时铺满屏幕，退出时保持记忆，下次打开仍是上次的大小。
// 明细表高度跟着走——不然窗口铺满了，表格还锁在 320px，多出来的空间白白浪费。
const maximized = ref(false)
const linesMaxHeight = ref(320)
function toggleMax() {
  maximized.value = !maximized.value
  linesMaxHeight.value = maximized.value ? Math.max(320, window.innerHeight - 300) : 320
}

// 弹窗打开时初始化表单
watch(() => props.modelValue, (v) => {
  if (v) {
    if (props.template) {
      form.value = {
        name: props.template.name || '',
        kind: props.template.kind || 'sale',
        lines: (props.template.items || []).map(it => ({
          code: it.code || '',
          name: it.name || '',
          qty: Number(it.qty || 1),
          price: Number(it.price || 0),
          discountRate: Number(it.discountRate ?? 1)
        }))
      }
    } else {
      form.value = defaultForm()
    }
    quickItem.value = ''
  }
})

const lineGross = (row) => round2(Number(row.qty || 0) * Number(row.price || 0))
const lineRate = (row) => {
  const gross = lineGross(row)
  return normalizeRate(row, gross)
}
const lineDiscount = (row) => {
  const gross = lineGross(row)
  const rate = lineRate(row)
  return round2(gross * (1 - rate))
}
const lineTotal = (row) => {
  const gross = lineGross(row)
  const discount = lineDiscount(row)
  return Math.max(0, round2(gross - discount))
}

const grossAmount = computed(() => round2(form.value.lines.reduce((s, l) => s + lineGross(l), 0)))
const lineDiscountSum = computed(() => round2(form.value.lines.reduce((s, l) => s + lineDiscount(l), 0)))
const totalAmount = computed(() => round2(form.value.lines.reduce((s, l) => s + lineTotal(l), 0)))

function onItemChange(row) {
  const it = props.items.find(i => i.code === row.code)
  if (it) {
    row.name = it.name || ''
    if (!row.price) row.price = Number(it.price || 0)
  }
}

function addQuickItem() {
  if (!quickItem.value) return
  const it = props.items.find(i => i.code === quickItem.value)
  if (!it) return
  form.value.lines.push({
    code: it.code,
    name: it.name || '',
    qty: 1,
    price: Number(it.price || 0),
    discountRate: 1
  })
  quickItem.value = ''
}

function save() {
  if (!form.value.name.trim()) {
    ElMessage.warning('请填写模板名称')
    return
  }
  if (!form.value.lines.length) {
    ElMessage.warning('至少添加一行商品明细')
    return
  }
  // 校验每行
  for (let i = 0; i < form.value.lines.length; i++) {
    const l = form.value.lines[i]
    if (!l.code) {
      ElMessage.warning(`第 ${i + 1} 行未选商品`)
      return
    }
    if (!(Number(l.qty) > 0)) {
      ElMessage.warning(`第 ${i + 1} 行数量必须大于 0`)
      return
    }
    if (!(Number(l.price) >= 0)) {
      ElMessage.warning(`第 ${i + 1} 行单价不能为负`)
      return
    }
  }
  const template = {
    name: form.value.name.trim(),
    kind: form.value.kind,
    items: form.value.lines.map(l => ({
      code: l.code,
      name: l.name,
      unit: props.items.find(i => i.code === l.code)?.unit || '',
      qty: Number(l.qty),
      price: Number(l.price),
      discountRate: Number(l.discountRate ?? 1)
    }))
  }
  // 事件名必须是 saved：父组件 OrderTemplates.vue 监听的是 @saved。
  // 以前这里叫 'save'，父组件的监听器永远不触发，POST 根本没发出去 ——
  // 表现就是「订单模板保存不了」：点保存看似没反应，弹窗也停在原地。
  emit('saved', { id: props.template?.id, template })
}
</script>

<style scoped>
/* 弹窗标题栏：最大化角标在最左侧，标题紧随其后（与订单/单据弹窗同一套样式） */
.dlg-header { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dlg-max {
  padding: 0; width: 26px; height: 26px; min-height: 0; margin-right: 2px;
  background: transparent !important; border-color: transparent !important;
  color: var(--text-regular) !important;
}
.dlg-max:hover { color: var(--color-primary) !important; background: var(--bg-hover) !important; }
.quick-add-select { width: 100%; }
/* 窄屏放不下 6 列：横向滚动是唯一出路，但滚动条在不滑动时不显眼，给一句提示 */
.scroll-hint { display: none; margin-top: 8px; color: var(--text-secondary); font-size: var(--fs-mini); }
@media (max-width: 768px) { .scroll-hint { display: block; } }
.lines-scroll { max-height: 360px; overflow-y: auto; overflow-x: auto; margin-top: 8px; }
/* 明细行输入框撑满所在列：el-input-number 默认 150px，在 100px 的列里会溢出错位（数量和单价被裁掉一半） */
.lines-scroll :deep(.el-input-number) { width: 100%; }
.calc-hint { color: var(--text-secondary); font-size: var(--fs-mini); }
.calc-detail { margin-top: 4px; color: var(--text-secondary); font-size: var(--fs-sub); }
.calc-detail .discount { color: var(--color-danger); margin-left: 12px; }
.line-net { font-weight: 600; }
</style>
