<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title">
            <b>客户：{{ customer.name }}</b>
            <span class="sub">（{{ customer.code }}）</span>
            <el-tag v-if="customer.category" size="small" :type="categoryTagType(customer.category)" style="margin-left:8px">
              {{ customer.category }}
            </el-tag>
          </div>
          <el-button @click="$router.push('/customers')">返回列表</el-button>
        </div>
      </template>
      <div class="info">
        <span>联系人：{{ customer.contact || '—' }}</span>
        <span>电话：{{ customer.phone || '—' }}</span>
        <span>地址：{{ customer.address || '—' }}</span>
        <span>关联商品：{{ products.length }} 个</span>
        <span class="amount-item">
          应收款：<b :class="receivable ? 'amount-debt' : 'amount-zero'">¥ {{ receivable.toFixed(2) }}</b>
        </span>
        <span class="amount-item">
          预存款：<b class="amount-deposit">¥ {{ depositBalance.toFixed(2) }}</b>
        </span>
        <el-button size="small" type="primary" plain @click="openDeposit">预存款充值</el-button>
        <span v-if="customer.remark">备注：{{ customer.remark }}</span>
      </div>

      <div class="filter-row">
        <span class="filter-label">时间段</span>
        <el-date-picker v-model="dateStart" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" style="width:150px" />
        <span class="filter-sep">至</span>
        <el-date-picker v-model="dateEnd" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" style="width:150px" />
        <el-button v-if="dateStart || dateEnd" text type="primary" @click="dateStart=''; dateEnd=''">清除</el-button>
      </div>

      <el-tabs v-model="tab">
        <el-tab-pane label="产品列表" name="products">
          <ProductTable :items="products" search-placeholder="搜索该客户商品" :show-cost="false" :price-columns="customerPriceColumns" :page-size="60" />
        </el-tab-pane>
        <el-tab-pane :label="`销售单 (${filteredSales.length})`" name="sales">
          <div class="table-wrap">
          <el-table :data="filteredSales" stripe show-summary :summary-method="summaryAmount">
            <el-table-column label="单号" width="180">
              <template #default="{ row }"><router-link :to="`/sale/${row.id}`" class="link" :class="{ 'return-code': isReturn(row) }">{{ row.id }}</router-link></template>
            </el-table-column>
            <el-table-column label="时间" width="170"><template #default="{ row }">{{ orderTimeOf(row) }}</template></el-table-column>
            <el-table-column label="商品数量" width="100" align="right">
              <template #default="{ row }">{{ orderKindCount(row) }}</template>
            </el-table-column>
            <el-table-column label="金额" width="110" align="right">
              <template #default="{ row }">{{ grossOf(row).toFixed(2) }}</template>
            </el-table-column>
            <el-table-column label="实收" width="110" align="right">
              <template #default="{ row }">{{ receivedSumOf(row).toFixed(2) }}</template>
            </el-table-column>
            <el-table-column label="优惠" width="100" align="right">
              <template #default="{ row }">
                <span v-if="Number(row.discount || 0) > 0" class="discount" title="抹零优惠，未实际收款">-{{ Number(row.discount).toFixed(2) }}</span>
                <span v-else class="none">—</span>
              </template>
            </el-table-column>
            <el-table-column label="结算状态" width="100">
              <template #default="{ row }">
                <el-tag :type="settleLabelOf(row) === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
                  {{ settleLabelOf(row) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="remark" label="备注" width="160" show-overflow-tooltip />
          </el-table>
          </div>
          <div v-if="!filteredSales.length" class="empty">该时间段暂无销售单</div>
        </el-tab-pane>
        <el-tab-pane :label="`来往账 (${ledgerRows.length})`" name="ledger">
          <div class="balance-bar">
            <span>期初欠款：<b :class="openingBalance > 0 ? 'amount-debt' : 'amount-zero'">¥ {{ openingBalance.toFixed(2) }}</b></span>
            <span>本期应收：<b>¥ {{ ledgerRows.reduce((s, r) => s + r.amount, 0).toFixed(2) }}</b></span>
            <span>本期已收：<b class="amount-received">¥ {{ ledgerRows.reduce((s, r) => s + r.received, 0).toFixed(2) }}</b></span>
            <span>本期优惠：<b class="amount-deposit">¥ {{ ledgerRows.reduce((s, r) => s + r.discount, 0).toFixed(2) }}</b></span>
            <span>期末欠款：<b :class="closingBalance > 0 ? 'amount-debt' : 'amount-zero'">¥ {{ closingBalance.toFixed(2) }}</b></span>
          </div>
          <div class="table-wrap">
          <el-table :data="ledgerRows" stripe show-summary :summary-method="ledgerSummary">
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column prop="id" label="单号" width="180">
              <template #default="{ row }"><router-link :to="`/sale/${row.id}`" class="link" :class="{ 'return-code': isReturnId(row.id) }">{{ row.id }}</router-link></template>
            </el-table-column>
            <el-table-column prop="summary" label="摘要" width="120" />
            <el-table-column prop="amount" label="应收金额" width="120" align="right">
              <template #default="{ row }">{{ row.amount.toFixed(2) }}</template>
            </el-table-column>
            <el-table-column prop="received" label="实收金额" width="120" align="right">
              <template #default="{ row }">{{ row.received.toFixed(2) }}</template>
            </el-table-column>
            <el-table-column prop="discount" label="优惠" width="100" align="right">
              <template #default="{ row }">
                <span v-if="row.discount > 0" class="discount">-{{ row.discount.toFixed(2) }}</span>
                <span v-else class="none">—</span>
              </template>
            </el-table-column>
            <el-table-column prop="deposit" label="预存款抵扣" width="110" align="right">
              <template #default="{ row }">
                <span v-if="row.deposit > 0" class="discount">-{{ row.deposit.toFixed(2) }}</span>
                <span v-else class="none">—</span>
              </template>
            </el-table-column>
            <el-table-column prop="unpaid" label="未结金额" width="120" align="right">
              <template #default="{ row }">
                <span :class="row.unpaid > 0 ? 'amount-debt' : 'none'">{{ row.unpaid.toFixed(2) }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="balance" label="累计欠款" width="130" align="right">
              <template #default="{ row }">
                <b :class="row.balance > 0 ? 'amount-debt' : 'amount-zero'">{{ row.balance.toFixed(2) }}</b>
              </template>
            </el-table-column>
            <el-table-column prop="settle" label="结算状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.settle === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
                  {{ row.settle || '挂账' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
          </div>
          <div v-if="!ledgerRows.length" class="empty">该时间段暂无往来记录</div>
        </el-tab-pane>
        <el-tab-pane :label="`预存款 (${(customer.deposits || []).length})`" name="deposits">
          <div class="balance-bar">
            <span>预存款余额：<b class="amount-deposit">¥ {{ depositBalance.toFixed(2) }}</b></span>
            <el-button size="small" type="primary" plain @click="openDeposit">充值一笔</el-button>
          </div>
          <div class="table-wrap">
          <el-table :data="customer.deposits || []" stripe>
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column label="类型" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="Number(row.amount) >= 0 ? 'success' : 'danger'" disable-transitions>
                  {{ Number(row.amount) >= 0 ? '增加' : '减少' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="金额" width="120" align="right">
              <template #default="{ row }">
                <b :class="Number(row.amount) >= 0 ? 'amount-deposit' : 'amount-debt'">
                  {{ Number(row.amount) >= 0 ? '+' : '' }}{{ Number(row.amount || 0).toFixed(2) }}
                </b>
              </template>
            </el-table-column>
            <el-table-column label="关联销售单" width="180">
              <template #default="{ $index }">
                <router-link v-if="depositOrders[$index]" :to="`/sale/${depositOrders[$index]}`" class="link" :class="{ 'return-code': isReturnId(depositOrders[$index]) }">{{ depositOrders[$index] }}</router-link>
                <span v-else class="none">—</span>
              </template>
            </el-table-column>
            <el-table-column label="关联收付款单据" width="180">
              <template #default="{ $index }">
                <router-link v-if="depositVouchers[$index]" :to="{ path: '/vouchers', query: { code: depositVouchers[$index] } }" class="link">{{ depositVouchers[$index] }}</router-link>
                <span v-else class="none">—</span>
              </template>
            </el-table-column>
            <el-table-column prop="remark" label="备注" width="140" show-overflow-tooltip />
            <el-table-column label="操作" width="130" class-name="ops-col">
              <template #default="{ row, $index }">
                <el-button size="small" type="primary" link @click="openDepositEdit(row, $index)">编辑</el-button>
                <el-button size="small" type="danger" link @click="removeDeposit($index)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          </div>
          <div v-if="!(customer.deposits || []).length" class="empty">暂无预存款记录；收款时超额部分会自动转入预存款</div>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 预存款充值：写入客户档案 deposits 流水 -->
    <el-dialog v-model="depositDialog" title="预存款充值" width="420">
      <el-form label-width="80px">
        <el-form-item label="日期"><el-date-picker v-model="depDraft.date" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="金额"><el-input-number v-model="depDraft.amount" :min="0" :precision="2" :controls="false" style="width:100%" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="depDraft.remark" placeholder="付款方式等，可空" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="depositDialog = false">取消</el-button>
        <el-button type="primary" :loading="depSaving" @click="saveDeposit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 编辑预存款记录：改日期/金额/备注；金额正数＝增加，负数＝减少（抵扣） -->
    <el-dialog v-model="depositEditDialog" title="编辑预存款记录" width="420">
      <el-form label-width="80px">
        <el-form-item label="日期"><el-date-picker v-model="depEditDraft.date" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item>
        <el-form-item label="金额">
          <el-input-number v-model="depEditDraft.amount" :precision="2" :controls="false" style="width:100%" />
          <div style="margin-top:4px;color:var(--text-secondary);font-size:var(--fs-sub)">正数＝增加，负数＝减少（抵扣）</div>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="depEditDraft.remark" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="depositEditDialog = false">取消</el-button>
        <el-button type="primary" :loading="depSaving" @click="saveDepositEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import ProductTable from '../components/ProductTable.vue'
import { receivableOf, grossOf, receivedSumOf, depositSumOf, isSettledOf } from '../utils/account'
import { orderKindCount } from '../utils/catalog'
import { isReturn, isReturnId } from '../utils/refunds.js'
import { appendVouchers, mapDepositVouchers } from '../utils/voucherFlow'
import { todayCN, orderTimeOf } from '../utils/time.js'

const route = useRoute()
const customers = ref([])
const items = ref([])
const sales = ref([])
const receipts = ref([])
const tab = ref('products')
const dateStart = ref('')
const dateEnd = ref('')

const categoryTagType = (c) => ({ '批发': 'warning', '零售': 'success', '安装师傅': 'primary' }[c] || 'info')

const customer = computed(() => customers.value.find(c => c.code === route.params.code) || { code: route.params.code, name: '未知', contact: '', phone: '', address: '', remark: '', category: '' })

// ---- 预存款：余额 = 客户档案 deposits 流水合计；支持单独充值/删除 ----
const depositBalance = computed(() => depositSumOf(customer.value.deposits))
// 每条预存款流水对应的收款单编号（新充值优先用流水上回写的 voucher，历史流水按单位/日期/金额/订单兜底匹配）
const depositVouchers = computed(() => mapDepositVouchers(customer.value.deposits || [], receipts.value, customer.value.name))
// 预存款流水关联的销售单：抵扣货款/超收转预存都会带 order（订单 id）；批量收款的 batch: 标记不是真实单据，不展示
const saleIdSet = computed(() => new Set((sales.value || []).map(s => s.id)))
const depositOrders = computed(() => (customer.value.deposits || []).map(f => (f.order && saleIdSet.value.has(f.order) ? f.order : '')))
const depositDialog = ref(false)
const depSaving = ref(false)
const depDraft = ref({ date: '', amount: null, remark: '' })

function openDeposit() {
  depDraft.value = { date: todayCN(), amount: null, remark: '' }
  depositDialog.value = true
}

async function saveDeposit() {
  const amount = Number(depDraft.value.amount || 0)
  if (!amount || amount <= 0) return ElMessage.warning('请输入充值金额')
  depSaving.value = true
  try {
    const list = customers.value.map(c => ({ ...c }))
    const c = list.find(x => x.code === customer.value.code)
    if (!c) return ElMessage.error('客户档案未找到，请刷新页面重试')
    const date = depDraft.value.date || todayCN()
    const flow = {
      date,
      amount,
      remark: depDraft.value.remark || '',
      time: new Date().toISOString()
    }
    c.deposits = [...(c.deposits || []), flow]
    await api.saveCustomers(list)
    customers.value = list
    depositDialog.value = false
    ElMessage.success('已存入预存款')
    // 与「往来账 · 存预存/预付」同一口径：充值即资金变动，生成一张无关联单号的收款单
    const note = '存入客户预存款'
    try {
      const { all, created } = await appendVouchers(api, 'receivable', [{
        category: 'deposit-recharge',
        party: customer.value.name,
        date,
        remark: depDraft.value.remark || note,
        items: [{ orderId: '', orderType: '', amount, note }]
      }])
      if (Array.isArray(all)) receipts.value = all
      const code = created[0]?.code
      if (code) {
        // 编号回写到流水，详情页「关联收付款单据」列直接按流水精确展示
        flow.voucher = code
        try { await api.saveCustomers(customers.value) } catch { /* 展示层仍会按单位/日期/金额兜底匹配 */ }
        ElMessage.success(`已生成收款单：${code}`)
      }
    } catch (e) {
      ElMessage.error(`资金单据生成失败：${e.message || '网络异常'}`)
    }
  } catch (e) {
    ElMessage.error(`保存失败：${e.message || e}`)
  } finally { depSaving.value = false }
}

async function removeDeposit(idx) {
  try { await ElMessageBox.confirm('确定删除该笔预存款记录？删除后不可恢复。', '提示', { type: 'warning' }) } catch { return }
  try {
    const list = customers.value.map(c => ({ ...c }))
    const c = list.find(x => x.code === customer.value.code)
    if (!c) return
    c.deposits = (c.deposits || []).filter((_, i) => i !== idx)
    await api.saveCustomers(list)
    customers.value = list
    ElMessage.success('已删除该笔预存款记录')
  } catch (e) {
    ElMessage.error(`删除失败：${e.message || e}`)
  }
}

// 编辑预存款流水：改日期/金额/备注；金额正数＝增加，负数＝减少（抵扣）
const depositEditDialog = ref(false)
const depositEditIndex = ref(-1)
const depEditDraft = ref({ date: '', amount: 0, remark: '' })

function openDepositEdit(row, index) {
  depositEditIndex.value = index
  depEditDraft.value = {
    date: row.date || '',
    amount: Number(row.amount || 0),
    remark: row.remark || ''
  }
  depositEditDialog.value = true
}

async function saveDepositEdit() {
  const idx = depositEditIndex.value
  if (idx < 0) return
  depSaving.value = true
  try {
    const list = customers.value.map(c => ({ ...c }))
    const c = list.find(x => x.code === customer.value.code)
    if (!c) return ElMessage.error('客户档案未找到，请刷新页面重试')
    // 保留 order/fromDeposit 等标记字段，仅改日期/金额/备注
    c.deposits = (c.deposits || []).map((d, i) => i === idx
      ? { ...d, date: depEditDraft.value.date || d.date, amount: Number(depEditDraft.value.amount || 0), remark: depEditDraft.value.remark || '' }
      : d)
    await api.saveCustomers(list)
    customers.value = list
    depositEditDialog.value = false
    ElMessage.success('已保存修改')
  } catch (e) {
    ElMessage.error(`保存失败：${e.message || e}`)
  } finally { depSaving.value = false }
}
const saleList = computed(() => (sales.value || []).filter(s => s.customer === customer.value.name))
const products = computed(() => {
  const codes = new Set()
  saleList.value.forEach(s => (s.items || []).forEach(l => l.code && codes.add(l.code)))
  const map = Object.fromEntries((items.value || []).map(i => [i.code, i]))
  return [...codes].map(code => map[code]).filter(Boolean)
})
// 客户下商品的价格列：按客户类型取对应一档价格；未分配类型时默认显示「售价」
const customerPriceColumns = computed(() => {
  const map = {
    '批发': { prop: 'priceWholesale', label: '批发价' },
    '零售': { prop: 'price', label: '售价' },
    '安装师傅': { prop: 'priceInstaller', label: '安装师傅价' }
  }
  return [map[customer.value.category] || { prop: 'price', label: '售价' }]
})
const filteredSales = computed(() => saleList.value.filter(s => {
  if (dateStart.value && (s.date || '') < dateStart.value) return false
  if (dateEnd.value && (s.date || '') > dateEnd.value) return false
  return true
}).sort((a, b) => String(orderTimeOf(b)).localeCompare(String(orderTimeOf(a))) || String(b.id || '').localeCompare(String(a.id || ''))))

// 展示层结算口径：未收金额为 0 即显示结清（无需打开编辑弹窗，旧单也生效）
const settleLabelOf = (row) => isSettledOf(receivableOf(row), row.settle) ? '结清' : '挂账'

// 应收款：该客户全部销售单未结金额合计（欠款按金额计算，与结算状态无关）
const receivable = computed(() => saleList.value.reduce((sum, s) => sum + receivableOf(s), 0))

// 按单据日期排序（与筛选无关，用于计算期初）
const sortedSales = computed(() => saleList.value
  .slice()
  .sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id))))

// 期初欠款：筛选起点之前所有单据的未结金额合计（避免时间筛选丢失历史欠款）
const openingBalance = computed(() => {
  if (!dateStart.value) return 0
  return sortedSales.value
    .filter(s => (s.date || '') < dateStart.value)
    .reduce((sum, s) => sum + receivableOf(s), 0)
})

// 来往账：期初余额 + 期间逐单滚动累计 → 期末余额
const ledgerRows = computed(() => {
  let balance = openingBalance.value
  return filteredSales.value
    .slice()
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id)))
    .map(s => {
      const amount = grossOf(s)   // 应收金额 = 合计×整单折扣 − 整单优惠（与 grossOf 口径一致）
      const discount = Number(s.discount || 0)
      const received = receivedSumOf(s)
      // 该单从客户预存款抵扣的金额（来源为预存款的收款流水）
      const deposit = (s.payments || []).filter(p => p.fromDeposit).reduce((a, p) => a + Number(p.amount || 0), 0)
      const unpaid = Math.max(0, amount - received)
      balance += unpaid
      return { date: s.date, id: s.id, summary: '销售出库', amount, discount, received, deposit, unpaid, balance, settle: isSettledOf(unpaid, s.settle) ? '结清' : '挂账' }
    })
})

// 期末欠款 = 期初 + 本期未结
const closingBalance = computed(() => openingBalance.value + ledgerRows.value.reduce((s, r) => s + r.unpaid, 0))

// 表格底部汇总：合计金额
const summaryAmount = ({ columns, data }) => {
  const total = (data || []).reduce((sum, r) => sum + grossOf(r), 0)
  return columns.map((c, idx) => {
    if (idx === 0) return '合计'
    if (c.label === '金额') return total.toFixed(2)
    return ''
  })
}

// 来往账合计行（按列的 property 匹配）：本金期为「本期发生额」，累计欠款列显示期末余额
const ledgerSummary = ({ columns, data }) => {
  const sum = (key) => (data || []).reduce((s, r) => s + (Number(r[key]) || 0), 0)
  const values = {
    amount: sum('amount').toFixed(2),
    discount: sum('discount').toFixed(2),
    received: sum('received').toFixed(2),
    deposit: sum('deposit').toFixed(2),
    unpaid: sum('unpaid').toFixed(2),
    balance: closingBalance.value.toFixed(2)
  }
  return columns.map((c, idx) => {
    if (idx === 0) return '合计（期初 ' + openingBalance.value.toFixed(2) + '）'
    return values[c.property] ?? ''
  })
}

onMounted(async () => {
  try {
    const [cu, it, sa, rc] = await Promise.all([api.getCustomers(), api.getItems(), api.getSales(), api.getReceipts().catch(() => [])])
    customers.value = cu
    items.value = it
    sales.value = sa
    receipts.value = rc || []
  } catch (e) { customers.value = []; items.value = []; sales.value = [] }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.sub { color:var(--text-secondary); font-weight: 400; }
.info { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px; color:var(--text-regular); font-size:var(--fs-base); }
.filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.filter-label { color:var(--text-regular); font-size:var(--fs-base); }
.filter-sep { color:var(--text-secondary); }
.amount-item { display: inline-flex; align-items: center; gap: 4px; }
.amount-debt { color:var(--color-danger); font-weight: 700; }
.amount-zero { color:var(--text-placeholder); }
.amount-deposit { color:var(--color-success); font-weight: 700; }
.amount-received { color:var(--color-primary); font-weight: 700; }
.none { color:var(--text-placeholder); }
.discount { color:var(--color-success); }
.balance-bar { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 10px; color:var(--text-regular); font-size:var(--fs-base); }
</style>
