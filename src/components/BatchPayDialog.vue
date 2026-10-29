<template>
  <el-dialog v-model="visible" title="合并收付款" width="760" @open="onOpen">
    <div class="batch-summary">
      <span>已选 <b>{{ orders.length }}</b> 张单据，涉及 <b>{{ grouped.length }}</b> 个结算分组</span>
      <span class="batch-tip">按往来单位（客户应收 / 供应商应付）分组，每组填一笔金额，逐单按日期升序封顶未收分摊</span>
    </div>

    <div v-for="g in grouped" :key="g.key" class="batch-group">
      <div class="batch-group-head">
        <b class="batch-party">{{ g.party }}</b>
        <el-tag :type="g.kind === 'receivable' ? 'success' : 'warning'" size="small" disable-transitions>
          {{ g.kind === 'receivable' ? '客户应收' : '供应商应付' }}
        </el-tag>
        <span class="batch-group-due">未收/未付合计：<b :class="g.kind === 'receivable' ? 'amount-in' : 'amount-out'">¥ {{ groupDue(g).toFixed(2) }}</b></span>
        <span v-if="groupExcess(g) > 0.005" class="batch-excess">超出 ¥ {{ groupExcess(g).toFixed(2) }} 将存入{{ g.kind === 'receivable' ? '客户预存款' : '供应商预付款' }}</span>
      </div>
      <div class="batch-amount-row">
        <span class="batch-amount-label">{{ g.kind === 'receivable' ? '本次收款' : '本次付款' }}</span>
        <el-input-number v-model="groupAmounts[g.key]" :min="0" :max="99999999" :precision="2" :controls="false" style="width:160px" />
        <el-button text type="primary" @click="fillDue(g)">填充满额</el-button>
        <el-button text @click="groupAmounts[g.key] = 0">清零</el-button>
      </div>
      <el-table :data="g.orders" stripe size="small" max-height="240">
        <el-table-column prop="id" label="单号" width="180" />
        <el-table-column label="时间" width="170"><template #default="{ row }">{{ orderTimeOf(row) }}</template></el-table-column>
        <el-table-column label="未收/未付" width="120" align="right">
          <template #default="{ row }">{{ netOf(row, row._kind).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip />
      </el-table>
    </div>

    <div class="batch-global">
      <span class="batch-global-label">单据日期</span>
      <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" placeholder="日期" style="width:160px" />
      <span class="batch-global-label" style="margin-left:12px">备注</span>
      <el-input v-model="remark" placeholder="如：合并结算 / 转账批次号（可空）" style="flex:1;min-width:160px" />
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!hasAmount" @click="confirm">确认合并收付款</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { netOf, round2 } from '../utils/account'
import { todayCN, orderTimeOf } from '../utils/time.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 已选单据（含 CurrentAccounts ordersAll 结构的 _kind / _party / id / date 等字段）
  orders: { type: Array, default: () => [] }
})
const emit = defineEmits(['update:modelValue', 'applied'])

const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v)
})

const date = ref(todayCN())
const remark = ref('')
// 分组金额：key = `${party}__${kind}`
const groupAmounts = reactive({})

const onOpen = () => {
  date.value = todayCN()
  remark.value = ''
  // 重置分组金额为各组未收合计（默认填满，可改少＝部分收）
  for (const k of Object.keys(groupAmounts)) delete groupAmounts[k]
  for (const g of grouped.value) groupAmounts[g.key] = round2(groupDue(g))
}

// 按 (往来单位 + 类型) 分组：同一单位既为客户又作供应商时拆成两组，避免应收应付混在同一笔金额里
const grouped = computed(() => {
  const map = {}
  for (const o of (props.orders || [])) {
    const key = `${o._party}__${o._kind}`
    if (!map[key]) map[key] = { key, party: o._party, kind: o._kind, orders: [] }
    map[key].orders.push(o)
  }
  return Object.values(map)
})

const groupDue = (g) => round2((g.orders || []).reduce((s, o) => s + netOf(o, o._kind), 0))
const groupExcess = (g) => round2(Math.max(0, (Number(groupAmounts[g.key]) || 0) - groupDue(g)))
const hasAmount = computed(() => grouped.value.some(g => Number(groupAmounts[g.key] || 0) > 0))

function fillDue(g) { groupAmounts[g.key] = round2(groupDue(g)) }

function confirm() {
  const groups = grouped.value
    .map(g => ({
      party: g.party,
      kind: g.kind,
      amount: round2(Number(groupAmounts[g.key]) || 0),
      date: date.value || todayCN(),
      remark: remark.value || '',
      orderIds: g.orders.map(o => o.id)
    }))
    .filter(g => g.amount > 0)
  if (!groups.length) return ElMessage.warning('请至少为一个分组填写金额')
  emit('applied', groups)
  visible.value = false
}
</script>

<style scoped>
.batch-summary { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; color: var(--text-regular); font-size: var(--fs-base); }
.batch-tip { color: var(--text-secondary); font-size: var(--fs-sub); }
.batch-group { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
.batch-group-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.batch-party { font-size: var(--fs-base); }
.batch-group-due { color: var(--text-secondary); font-size: var(--fs-sub); }
.batch-excess { color: var(--color-success); font-size: var(--fs-sub); }
.batch-amount-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.batch-amount-label { color: var(--text-regular); font-size: var(--fs-base); }
.batch-global { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.batch-global-label { color: var(--text-regular); font-size: var(--fs-base); }
.amount-in { color: var(--color-success); font-weight: 600; }
.amount-out { color: var(--el-color-primary); font-weight: 600; }
</style>
