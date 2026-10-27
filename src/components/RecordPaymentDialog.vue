<template>
  <el-dialog v-model="visible" title="记一笔（收/付款）" width="640" @open="onOpen">
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
      <el-form-item label="金额" required>
        <el-input-number v-model="amount" :min="0" :max="99999999" :precision="2" :controls="false" style="width:100%" />
        <span class="rec-hint">未结合计：<b class="rec-due">¥ {{ due.toFixed(2) }}</b><template v-if="excess > 0.005"> · 超出 ¥ {{ excess.toFixed(2) }} 转{{ type === 'receivable' ? '客户预存款' : '供应商预付款' }}</template></span>
      </el-form-item>
      <el-form-item label="日期">
        <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" placeholder="日期" style="width:100%" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="remark" placeholder="如：转账 / 现金（可空）" />
      </el-form-item>
    </el-form>
    <div class="rec-orders" v-if="partyOrders.length">
      <div class="rec-orders-title">该单位未结单据（{{ partyOrders.length }} 张，按日期升序分摊）</div>
      <el-table :data="partyOrders" stripe size="small" max-height="220">
        <el-table-column prop="id" label="单号" width="180" />
        <el-table-column prop="date" label="日期" width="120" />
        <el-table-column label="未收/未付" width="120" align="right">
          <template #default="{ row }">{{ netOf(row, type).toFixed(2) }}</template>
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
const date = ref(new Date().toISOString().slice(0, 10))
const remark = ref('')

const onOpen = () => {
  type.value = 'receivable'
  name.value = ''
  amount.value = null
  date.value = new Date().toISOString().slice(0, 10)
  remark.value = ''
}
const onPartyChange = () => { amount.value = null }

const partyOptions = computed(() => {
  const list = type.value === 'payable' ? props.suppliers : props.customers
  return (list || []).map(p => p.name).filter(Boolean)
})

// 选中单位的未结单据（netOf>0），记一笔时按日期升序分摊到这些单据
const partyOrders = computed(() => {
  if (!name.value) return []
  const src = type.value === 'receivable' ? props.salesList : props.purchasesList
  const partyKey = type.value === 'receivable' ? 'customer' : 'supplier'
  return (src || []).filter(o => o[partyKey] === name.value && netOf(o, type.value) > 1e-6)
})
const due = computed(() => round2(partyOrders.value.reduce((s, o) => s + netOf(o, type.value), 0)))
const excess = computed(() => round2(Math.max(0, (Number(amount || 0)) - due.value)))
const canSave = computed(() => !!name.value && Number(amount || 0) > 0)

function confirm() {
  if (!name.value) return ElMessage.warning('请选择往来单位')
  if (!(Number(amount || 0) > 0)) return ElMessage.warning('请输入大于 0 的金额')
  // 产出与 BatchPayDialog 同构的单组 payload，交由父组件统一写回（复用 onBatchApplied）
  emit('applied', [{
    party: name.value,
    kind: type.value,
    amount: Number(amount),
    date: date.value || new Date().toISOString().slice(0, 10),
    remark: remark.value || '',
    orderIds: partyOrders.value.map(o => o.id)
  }])
  visible.value = false
}
</script>

<style scoped>
.rec-form { margin-top: 8px; }
.rec-hint { display: inline-block; margin-left: 12px; color: var(--text-secondary); font-size: var(--fs-sub); }
.rec-due { color: var(--color-danger); }
.rec-orders { margin-top: 8px; }
.rec-orders-title { font-size: var(--fs-sub); color: var(--text-secondary); margin-bottom: 6px; }
.rec-empty { color: var(--text-placeholder); font-size: var(--fs-sub); padding: 8px 0; }
</style>
