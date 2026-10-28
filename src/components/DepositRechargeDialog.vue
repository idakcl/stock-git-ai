<template>
  <el-dialog v-model="visible" title="存预存 / 预付" width="560" @open="onOpen">
    <el-form label-width="96px" class="recharge-form">
      <el-form-item label="类型" required>
        <el-radio-group v-model="type">
          <el-radio-button value="receivable">客户预存款</el-radio-button>
          <el-radio-button value="payable">供应商预付款</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="type === 'payable' ? '供应商' : '客户'" required>
        <el-select v-model="name" filterable :placeholder="`选择${type === 'payable' ? '供应商' : '客户'}`" style="width:100%">
          <el-option v-for="p in partyOptions" :key="p" :label="p" :value="p" />
        </el-select>
      </el-form-item>
      <el-form-item label="金额" required>
        <el-input-number v-model="amount" :min="0" :max="99999999" :precision="2" :controls="false" style="width:100%" />
        <span class="recharge-hint">当前余额：<b class="recharge-bal">¥ {{ currentBalance.toFixed(2) }}</b></span>
      </el-form-item>
      <el-form-item label="日期">
        <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" placeholder="日期" style="width:100%" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="remark" placeholder="如：预存货款 / 预付订金（可空）" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!canSave" @click="confirm">确认存入</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { depositSumOf } from '../utils/account'
import { todayCN } from '../utils/time.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  customers: { type: Array, default: () => [] },
  suppliers: { type: Array, default: () => [] }
})
const emit = defineEmits(['update:modelValue', 'saved'])

const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v)
})

const type = ref('receivable') // 'receivable'=客户预存款 -> customer.deposits；'payable'=供应商预付款 -> supplier.advances
const name = ref('')
const amount = ref(null)
const date = ref(todayCN())
const remark = ref('')

const onOpen = () => {
  type.value = 'receivable'
  name.value = ''
  amount.value = null
  date.value = todayCN()
  remark.value = ''
}

const partyOptions = computed(() => {
  const list = type.value === 'payable' ? props.suppliers : props.customers
  return (list || []).map(p => p.name).filter(Boolean)
})

// 当前选中单位的可用余额（充值前），便于用户核对
const currentBalance = computed(() => {
  const list = type.value === 'payable' ? props.suppliers : props.customers
  const p = (list || []).find(x => x.name === name.value)
  if (!p) return 0
  return depositSumOf(type.value === 'payable' ? p.advances : p.deposits)
})

const canSave = computed(() => !!name.value && Number(amount || 0) > 0)

function confirm() {
  if (!name.value) return ElMessage.warning('请选择往来单位')
  if (!(Number(amount || 0) > 0)) return ElMessage.warning('请输入大于 0 的金额')
  emit('saved', {
    kind: type.value,
    name: name.value,
    amount: Number(amount),
    date: date.value || todayCN(),
    remark: remark.value || ''
  })
  visible.value = false
}
</script>

<style scoped>
.recharge-form { margin-top: 8px; }
.recharge-hint { display: inline-block; margin-left: 12px; color: var(--text-secondary); font-size: var(--fs-sub); }
.recharge-bal { color: var(--color-success); }
</style>
