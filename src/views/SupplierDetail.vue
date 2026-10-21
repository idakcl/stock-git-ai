<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title">
            <b>供应商：{{ supplier.name }}</b>
            <span class="sub">（{{ supplier.code }}）</span>
          </div>
          <el-button @click="$router.push('/suppliers')">返回列表</el-button>
        </div>
      </template>
      <div class="info">
        <span>联系人：{{ supplier.contact || '—' }}</span>
        <span>电话：{{ supplier.phone || '—' }}</span>
        <span>关联商品：{{ products.length }} 个</span>
        <span class="amount-item">
          应付款：<b :class="payable ? 'amount-debt' : 'amount-zero'">¥ {{ payable.toFixed(2) }}</b>
        </span>
        <span v-if="supplier.remark">备注：{{ supplier.remark }}</span>
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
          <ProductTable :items="products" search-placeholder="搜索该供应商商品" :show-cost="true" :show-supplier="false" :price-columns="supplierPriceColumns" :page-size="60">
            <template #actions="{ row }">
              <el-button size="small" @click="openDialog(row)">编辑</el-button>
              <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
            </template>
          </ProductTable>
        </el-tab-pane>
        <el-tab-pane :label="`采购单 (${filteredPurchases.length})`" name="purchases">
          <div class="table-wrap">
          <el-table :data="filteredPurchases" stripe show-summary :summary-method="summaryAmount">
            <el-table-column label="单号" width="180">
              <template #default="{ row }"><router-link :to="`/purchase/${row.id}`" class="link">{{ row.id }}</router-link></template>
            </el-table-column>
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column prop="total" label="金额" width="110" align="right">
              <template #default="{ row }">{{ Number(row.total || 0).toFixed(2) }}</template>
            </el-table-column>
            <el-table-column label="实付" width="110" align="right">
              <template #default="{ row }">{{ row.paid != null ? Number(row.paid).toFixed(2) : '—' }}</template>
            </el-table-column>
            <el-table-column label="优惠" width="100" align="right">
              <template #default="{ row }">
                <span v-if="Number(row.discount || 0) > 0" class="discount" title="抹零优惠，未实际付款">-{{ Number(row.discount).toFixed(2) }}</span>
                <span v-else class="none">—</span>
              </template>
            </el-table-column>
            <el-table-column label="结算" width="100">
              <template #default="{ row }">
                <el-tag :type="row.settle === '结清' ? 'success' : 'danger'" size="small" disable-transitions>
                  {{ row.settle || '挂账' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
          </el-table>
          </div>
          <div v-if="!filteredPurchases.length" class="empty">该时间段暂无采购单</div>
        </el-tab-pane>
        <el-tab-pane :label="`来往账 (${ledgerRows.length})`" name="ledger">
          <div class="balance-bar">
            <span>期初欠款：<b :class="openingBalance > 0 ? 'amount-debt' : 'amount-zero'">¥ {{ openingBalance.toFixed(2) }}</b></span>
            <span>本期应付：<b>¥ {{ ledgerRows.reduce((s, r) => s + r.amount, 0).toFixed(2) }}</b></span>
            <span>期末欠款：<b :class="closingBalance > 0 ? 'amount-debt' : 'amount-zero'">¥ {{ closingBalance.toFixed(2) }}</b></span>
          </div>
          <div class="table-wrap">
          <el-table :data="ledgerRows" stripe show-summary :summary-method="ledgerSummary">
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column prop="id" label="单号" width="180">
              <template #default="{ row }"><router-link :to="`/purchase/${row.id}`" class="link">{{ row.id }}</router-link></template>
            </el-table-column>
            <el-table-column prop="summary" label="摘要" width="120" />
            <el-table-column prop="amount" label="应付金额" width="120" align="right">
              <template #default="{ row }">{{ row.amount.toFixed(2) }}</template>
            </el-table-column>
            <el-table-column prop="paid" label="实付金额" width="120" align="right">
              <template #default="{ row }">{{ row.paid.toFixed(2) }}</template>
            </el-table-column>
            <el-table-column prop="discount" label="优惠" width="100" align="right">
              <template #default="{ row }">
                <span v-if="row.discount > 0" class="discount">-{{ row.discount.toFixed(2) }}</span>
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
            <el-table-column prop="settle" label="结算" width="100">
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
      </el-tabs>
    </el-card>

    <el-dialog v-model="dialog" title="商品" width="520">
      <el-form :model="form" label-width="80px">
        <el-form-item label="编码"><el-input v-model="form.code" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="单位"><el-input v-model="form.unit" /></el-form-item>
        <el-form-item label="供应商">
          <el-select
            v-model="form.suppliers"
            multiple filterable clearable
            placeholder="可多选，留空表示暂未指定"
            style="width:100%"
          >
            <el-option v-for="s in supplierOptions" :key="s.code" :label="s.label" :value="s.code" />
          </el-select>
          <div class="field-hint">更换供应商后，商品行的供应商列会同步更新；下次录入该商品的采购单时仍会自动补充新供应商</div>
        </el-form-item>
        <el-form-item label="进价"><el-input-number v-model="form.cost" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="售价"><el-input-number v-model="form.price" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="批发价"><el-input-number v-model="form.priceWholesale" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="安装师傅价"><el-input-number v-model="form.priceInstaller" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="预警值"><el-input-number v-model="form.warning" :min="0" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="商品照片"><PhotoUpload v-model="form.photos" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog=false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import ProductTable from '../components/ProductTable.vue'
import PhotoUpload from '../components/PhotoUpload.vue'
import { payableOf, paidSumOf } from '../utils/account'

const route = useRoute()
const suppliers = ref([])
const items = ref([])
const purchases = ref([])
const tab = ref('products')
const dateStart = ref('')
const dateEnd = ref('')

const supplier = computed(() => suppliers.value.find(s => s.code === route.params.code) || { code: route.params.code, name: '未知', contact: '', phone: '', remark: '' })
const products = computed(() => {
  const codes = new Set(supplier.value.products || [])
  return items.value.filter(i => codes.has(i.code))
})
// 供应商下商品的价格列：与商品库一致，售价、批发价、安装师傅价（不展示进价）
const supplierPriceColumns = [
  { prop: 'price', label: '售价' },
  { prop: 'priceWholesale', label: '批发价' },
  { prop: 'priceInstaller', label: '安装师傅价' }
]

// ---------- 商品编辑 / 删除 ----------
const dialog = ref(false)
// 正在编辑的商品原始编码：用于拦截「改成他人编码」导致覆盖对方商品
const editingCode = ref('')
const form = reactive({
  code:'', name:'', unit:'', photos:[], suppliers:[],
  cost:0, price:0, priceWholesale:0, priceInstaller:0,
  warning:0, remark:''
})

// 供应商选项：存在同名不同码的重复档案（如 S00001/S00039 都叫湖南利接管件），
// 同名的在选项里补上编码后缀，避免选错
const supplierOptions = computed(() => {
  const nameCount = {}
  ;(suppliers.value || []).forEach(s => { nameCount[s.name] = (nameCount[s.name] || 0) + 1 })
  return (suppliers.value || []).map(s => ({
    code: s.code,
    label: nameCount[s.name] > 1 ? `${s.name}（${s.code}）` : s.name
  }))
})

function openDialog(row) {
  editingCode.value = row ? row.code : ''
  // 先重置为默认值再覆盖，避免上次编辑残留；品牌字段已废弃，读入时剥离
  const { brand, ...rest } = row || {}
  Object.assign(form, {
    code:'', name:'', unit:'', photos:[], suppliers:[],
    cost:0, price:0, priceWholesale:0, priceInstaller:0, warning:0, remark:'',
    ...rest
  })
  // 供应商始终是数组，避免历史脏数据（字符串/null）导致多选组件异常
  form.suppliers = Array.isArray(form.suppliers) ? [...form.suppliers] : []
  dialog.value = true
}

async function save() {
  // 把编码改成别人的编码会把对方商品整条覆盖掉，先拦下来
  if (form.code && form.code !== editingCode.value && items.value.some(i => i.code === form.code)) {
    return ElMessage.error(`编码 ${form.code} 已被其他商品使用，请换一个编码`)
  }
  const idx = items.value.findIndex(i => i.code === form.code)
  // 品牌字段已废弃、零售价已并入售价：保存时剥离，数据中不再写入
  const { brand, priceRetail, ...rest } = form
  const payload = { ...rest, suppliers: Array.isArray(rest.suppliers) ? [...rest.suppliers] : [] }
  if (idx >= 0) items.value[idx] = { ...items.value[idx], ...payload, brand: undefined }
  else items.value.push({ ...payload, brand: undefined })
  // 保存失败（如 GitHub 写入出错）时明确报错，并回滚为线上数据，避免本地与线上不一致
  try {
    await api.saveItems(items.value)
  } catch (e) {
    ElMessage.error(`保存失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    await load()
    return
  }
  dialog.value = false
  ElMessage.success('已保存')
  load()
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除 ${row.name}?`, '提示', { type: 'warning' })
  } catch { return }
  items.value = items.value.filter(i => i.code !== row.code)
  try {
    await api.saveItems(items.value)
  } catch (e) {
    ElMessage.error(`删除失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    await load()
    return
  }
  ElMessage.success('已删除')
  load()
}
const purchaseList = computed(() => (purchases.value || []).filter(p => p.supplier === supplier.value.name))
const filteredPurchases = computed(() => purchaseList.value.filter(p => {
  if (dateStart.value && (p.date || '') < dateStart.value) return false
  if (dateEnd.value && (p.date || '') > dateEnd.value) return false
  return true
}))

// 应付款：该供应商全部采购单未结金额合计（欠款按金额计算，与结算状态无关）
const payable = computed(() => purchaseList.value.reduce((sum, p) => sum + payableOf(p), 0))

// 按单据日期排序（与筛选无关，用于计算期初）
const sortedPurchases = computed(() => purchaseList.value
  .slice()
  .sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id))))

// 期初欠款：筛选起点之前所有单据的未结金额合计（避免时间筛选丢失历史欠款）
const openingBalance = computed(() => {
  if (!dateStart.value) return 0
  return sortedPurchases.value
    .filter(p => (p.date || '') < dateStart.value)
    .reduce((sum, p) => sum + payableOf(p), 0)
})

// 来往账：期初余额 + 期间逐单滚动累计 → 期末余额
const ledgerRows = computed(() => {
  let balance = openingBalance.value
  return filteredPurchases.value
    .slice()
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id)))
    .map(p => {
      const amount = Number(p.total || 0)
      const discount = Number(p.discount || 0)
      const paid = paidSumOf(p)
      const unpaid = Math.max(0, amount - discount - paid)
      balance += unpaid
      return { date: p.date, id: p.id, summary: '采购入库', amount, discount, paid, unpaid, balance, settle: p.settle || '挂账' }
    })
})

// 期末欠款 = 期初 + 本期未结
const closingBalance = computed(() => openingBalance.value + ledgerRows.value.reduce((s, r) => s + r.unpaid, 0))

// 表格底部汇总：合计金额
const summaryAmount = ({ columns, data }) => {
  const total = (data || []).reduce((sum, r) => sum + Number(r.total || 0), 0)
  return columns.map((c, idx) => {
    if (idx === 0) return '合计'
    if (c.property === 'total') return total.toFixed(2)
    return ''
  })
}

// 来往账合计行（按列的 property 匹配）：本金期为「本期发生额」，累计欠款列显示期末余额
const ledgerSummary = ({ columns, data }) => {
  const sum = (key) => (data || []).reduce((s, r) => s + (Number(r[key]) || 0), 0)
  const values = {
    amount: sum('amount').toFixed(2),
    discount: sum('discount').toFixed(2),
    paid: sum('paid').toFixed(2),
    unpaid: sum('unpaid').toFixed(2),
    balance: closingBalance.value.toFixed(2)
  }
  return columns.map((c, idx) => {
    if (idx === 0) return '合计（期初 ' + openingBalance.value.toFixed(2) + '）'
    return values[c.property] ?? ''
  })
}

onMounted(load)
async function load() {
  try {
    const [sp, it, pu] = await Promise.all([api.getSuppliers(), api.getItems(), api.getPurchases()])
    suppliers.value = sp
    items.value = it
    purchases.value = pu
  } catch (e) { suppliers.value = []; items.value = []; purchases.value = [] }
}
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
.none { color:var(--text-placeholder); }
.discount { color:var(--color-success); }
.balance-bar { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 10px; color:var(--text-regular); font-size:var(--fs-base); }
.field-hint { margin-top: var(--gap-xs); color: var(--text-secondary); font-size: var(--fs-sub); line-height: 1.5; }
</style>
