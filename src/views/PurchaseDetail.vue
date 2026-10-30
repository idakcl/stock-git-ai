<template>
  <div v-loading="loading">
    <el-card>
      <template #header>
        <div class="card-header">
          <div class="title">
            <b>{{ isReturn(purchase) ? '采购退款单' : '采购单' }}：<span :class="{ 'return-code': isReturn(purchase) }">{{ purchase.id }}</span></b>
          </div>
          <!-- 单据不存在（已删除/链接失效）时禁用写操作，避免把占位空单当成新增保存 -->
          <div class="actions">
            <el-checkbox v-if="!externalView" v-model="hidePrice" class="hide-price-cb">隐藏单价与金额</el-checkbox>
            <el-checkbox v-if="!priceHidden" v-model="showSellPrice" class="opt-cb">显示售价</el-checkbox>
            <el-checkbox v-if="!priceHidden" v-model="showCostCol" class="opt-cb">显示进价</el-checkbox>
            <el-checkbox v-if="!priceHidden" v-model="showHistory" class="opt-cb">展开历史价与商品档案</el-checkbox>
            <el-checkbox v-model="externalView" class="opt-cb">对外查看（隐藏价格·只读）</el-checkbox>
            <el-checkbox v-model="showPartyInfo" class="opt-cb">显示供应商信息详情</el-checkbox>
            <el-checkbox v-model="showProfile" class="opt-cb">显示用户信息</el-checkbox>
            <el-button :disabled="!found" @click="doExport">导出CSV</el-button>
            <el-button :disabled="!found" @click="doPrint('A4')">打印(A4)</el-button>
            <el-button :disabled="!found" @click="doPrint('A5')">打印(A5)</el-button>
            <PrintHeaderToggle />
            <el-button v-if="found && !externalView && !isVoided(purchase)" @click="shareDialog = true">分享</el-button>
            <el-button v-if="!externalView" type="primary" :disabled="!found || isReturn(purchase) || isVoided(purchase)" @click="editDialog = true">编辑</el-button>
            <el-button v-if="!externalView" type="danger" :disabled="!found || isReturn(purchase) || isVoided(purchase) || purchases.some(o => o.sourceOrderId === purchase.id)" @click="removeOrder">删除</el-button>
            <el-button v-if="found && !externalView && !isVoided(purchase)" type="warning" @click="$router.push({ path: '/returns', query: { kind: 'purchase', source: isReturn(purchase) ? undefined : purchase.id } })">退货 / 退款</el-button>
            <el-button @click="$router.push('/purchases')">返回列表</el-button>
          </div>
        </div>
      </template>
      <el-alert v-if="externalView" class="external-banner" type="info" :closable="false" show-icon
        title="对外查看模式：价格与金额已隐藏，页面只读" />
      <el-alert v-if="found && isVoided(purchase)" class="external-banner" type="warning" :closable="false" show-icon
        :title="`这张单已作废${purchase.voidedAt ? `（${fmtCNTime(purchase.voidedAt) || purchase.voidedAt}）` : ''}：库存已回滚、应付归零，关联的付款单同步作废${purchase.voidedReason ? `。原因：${purchase.voidedReason}` : ''}。作废不可恢复。`" />
      <div class="info">
        <span>供应商：
          <router-link v-if="supplierCodeMap[purchase.supplier]" :to="`/supplier/${supplierCodeMap[purchase.supplier]}`" class="link">{{ purchase.supplier }}</router-link>
          <span v-else>{{ purchase.supplier }}</span>
        </span>
        <!-- 勾「显示供应商信息详情」时，页面与打印/导出同步显示联系方式：
             只印不显会造成「纸上有的信息在屏幕上反而看不到」，两处必须同一口径 -->
        <template v-if="showPartyInfo">
          <span>联系人：{{ supplierInfo.contact || '—' }}</span>
          <span>电话：{{ supplierInfo.phone || '—' }}</span>
          <span>地址：{{ supplierInfo.address || '—' }}</span>
        </template>
        <span>记录时间：{{ orderTimeOf(purchase) }}</span>
        <!-- 退款单必须能回到原采购单：以后所有退款单都带 sourceOrderId -->
        <span v-if="isReturn(purchase)">原采购单：
          <router-link v-if="purchase.sourceOrderId" :to="`/purchase/${purchase.sourceOrderId}`" class="link">{{ purchase.sourceOrderId }}</router-link>
          <span v-else>—</span>
        </span>
        <template v-if="!priceHidden">
          <span>合计：¥ {{ Number(purchase.total || 0).toFixed(2) }}<template v-if="lineDiscountSum > 0">（已含单项折扣）</template></span>
          <span v-if="lineDiscountSum > 0">原价合计：¥ {{ grossSum.toFixed(2) }}（单项折扣 -¥ {{ lineDiscountSum.toFixed(2) }}）</span>
          <span v-if="orderRate" class="order-discount">整单折扣：<b>{{ orderRate }}</b>（减 ¥{{ discountAmount.toFixed(2) }}）</span>
          <span v-if="hasDiscount">折后金额：¥ {{ discountedTotal.toFixed(2) }}</span>
          <span>优惠：¥ {{ Number(purchase.discount || 0).toFixed(2) }}<template v-if="Number(purchase.discount || 0) > 0">（抹零优惠，未实际付款）</template></span>
          <span>应付：¥ {{ dueAmount.toFixed(2) }}</span>
          <span>实付：¥ {{ paidSum.toFixed(2) }}<template v-if="payments.length">（{{ payments.length }} 笔）</template></span>
          <span>
            未付：<b :class="unpaid > 0 ? 'debt' : 'zero'">¥ {{ unpaid.toFixed(2) }}</b>
          </span>
        </template>
        <span v-else class="price-hidden-note">（价格与金额已隐藏）</span>
        <span class="settle-cell">
          结算状态：
          <!-- 状态标签与改账按钮取同一高度（标签默认档 24px = small link 按钮 24px）并禁止换行：
               以前标签 small（20px）配按钮（24px）一高一矮，还常被挤成两行 -->
          <el-tag :type="settleLabel === '结清' ? 'success' : 'danger'" disable-transitions>
            {{ settleLabel }}
          </el-tag>
          <!-- 未付 0 且无优惠时不显示；两个改账动作：改结清＝结清未付差额，改挂账＝撤销抹零优惠、恢复未付 -->
          <el-button v-if="!externalView && !isReturn(purchase) && !isVoided(purchase) && settleAction !== 'none'" link size="small" type="primary" class="settle-btn"
            :disabled="!found"
            @click="toggleSettle">
            {{ settleAction === 'settle' ? '改结清' : '改挂账' }}
          </el-button>
        </span>
        <!-- 备注单独一个轻量入口：补一句话不必打开整单编辑弹窗（那要重算金额明细，风险大得多） -->
        <span class="remark-cell">
          备注：<span v-if="purchase.remark">{{ purchase.remark }}</span><span v-else class="none">—</span>
          <el-button v-if="!externalView" link size="small" type="primary" class="settle-btn"
            :disabled="!found" @click="remarkDialog = true">
            {{ purchase.remark ? '编辑备注' : '添加备注' }}
          </el-button>
        </span>
      </div>
      <div class="photos-block">
        <div class="photos-title">
          <span>原始单据照片<template v-if="(purchase.photos || []).length">（{{ (purchase.photos || []).length }} 张）</template></span>
          <el-button v-if="!externalView" size="small" type="primary" @click="photoDialog = true">
            {{ (purchase.photos || []).length ? '添加照片' : '上传原始单据照片' }}
          </el-button>
        </div>
        <PhotoThumbs v-if="(purchase.photos || []).length" :value="purchase.photos" />
      </div>
      <ProductTable :items="detailItems" search-placeholder="搜索本单商品" :price-columns="tablePriceColumns" :show-cost="showCostCol && !priceHidden" :remark-last="true" :show-history="showHistory && !priceHidden">
        <template #extra>
          <el-table-column prop="_qty" label="本次数量" width="100"  align="right"/>
          <el-table-column v-if="!priceHidden" prop="_price" label="本次单价" width="100"  align="right"/>
          <el-table-column v-if="!priceHidden && hasLineDiscount" label="本次折扣" width="100" align="right">
            <template #default="{ row }">
              <span v-if="Number(row._discount || 0) > 0" class="discount" :title="`${row._discountRate != null && row._discountRate < 1 ? `折扣率 ${row._discountRate} · ` : ''}原价 ¥${(Number(row._qty || 0) * Number(row._price || 0)).toFixed(2)}`">-{{ Number(row._discount).toFixed(2) }}</span>
              <span v-else class="none">—</span>
            </template>
          </el-table-column>
          <el-table-column v-if="!priceHidden" prop="_total" label="本次金额" width="100"  align="right"/>
          <el-table-column v-if="!priceHidden && orderRate" label="折后单价（含整单折扣）" width="180" align="right">
            <template #default="{ row }">{{ Number(row._unitNet || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column v-if="!priceHidden && orderRate" label="折后金额（含整单折扣）" width="180" align="right">
            <template #default="{ row }">{{ Number(row._net || 0).toFixed(2) }}</template>
          </el-table-column>
        </template>
      </ProductTable>
      <!-- 用户信息落款：勾选后显示在商品列表底部，打印时跟在同一位置 -->
      <div v-if="showProfile" class="print-foot">
        <template v-if="hasProfile">
          <span v-if="profile.name">联系名称：{{ profile.name }}</span>
          <span v-if="profile.phone">电话：{{ profile.phone }}</span>
          <span v-if="profile.address">地址：{{ profile.address }}</span>
          <span v-if="profile.remark">备注：{{ profile.remark }}</span>
        </template>
        <span v-else class="none">尚未填写用户信息，请到「系统 → 用户信息」补充</span>
      </div>
    </el-card>

    <el-card v-if="!externalView" class="pay-card">
      <template #header>
        <div class="card-header">
          <b v-if="priceHidden">付款记录（{{ payments.length }} 笔 · 金额已隐藏）</b>
          <b v-else>付款记录（{{ payments.length }} 笔 · 累计 ¥ {{ paidSum.toFixed(2) }} / 应付 ¥ {{ dueAmount.toFixed(2) }}<template v-if="Number(purchase.discount || 0) > 0"> · 抹零优惠 ¥ {{ Number(purchase.discount).toFixed(2) }}（未实际付款）</template>）</b>
          <el-button v-if="!isReturn(purchase) && !isVoided(purchase)" type="primary" size="small" @click="payDialog = true">记录付款</el-button>
        </div>
      </template>
      <div class="table-wrap">
      <el-table :data="payments" stripe empty-text="暂无付款记录，可点右上角「记录付款」分多笔登记">
        <el-table-column type="index" label="#" width="46" />
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ fmtCNTime(row.time) || orderTimeOf(purchase) }}</template>
        </el-table-column>
        <el-table-column v-if="!priceHidden" label="金额" width="130" align="right">
          <template #default="{ row }">{{ Number(row.amount || 0).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" width="160" show-overflow-tooltip />
        <el-table-column label="资金单据编号" width="160" show-overflow-tooltip>
          <template #default="{ row }"><router-link v-if="row.voucher" :to="{ path: '/vouchers', query: { code: row.voucher } }" class="link">{{ row.voucher }}</router-link><span v-else>—</span></template>
        </el-table-column>
      </el-table>
      </div>
    </el-card>

    <el-card v-if="!externalView && (purchase.settlements || []).length" class="pay-card">
      <template #header>退货核销（不计现金实付或优惠）</template>
      <el-table :data="purchase.settlements"><el-table-column label="时间" width="170"><template #default="{ row }">{{ fmtCNTime(row.time) || row.date }}</template></el-table-column><el-table-column v-if="!priceHidden" prop="amount" label="核销金额" /><el-table-column prop="voucher" label="核销凭证编号"><template #default="{ row }"><router-link v-if="row.voucher" :to="{ path: '/vouchers', query: { code: row.voucher } }" class="link">{{ row.voucher }}</router-link><span v-else>—</span></template></el-table-column></el-table>
    </el-card>
    <!-- 关联变更单：本单做过的「变更明细」会留下退货单（CT-，负数）与补差单（CA-，正数），
         原单金额保持不动，净额由这几张单一起算出来，故必须在原单页面上看得见 -->
    <el-card v-if="!externalView && relatedDocs.length" class="pay-card">
      <template #header>
        <div class="card-header">
          <b>关联变更单（{{ relatedDocs.length }} 张）</b>
          <span class="related-sum">变更后净成交 ¥ {{ netDeal.toFixed(2) }} · 未付 ¥ {{ netDue.toFixed(2) }}</span>
        </div>
      </template>
      <div class="table-wrap">
        <el-table :data="relatedDocs" stripe>
          <el-table-column label="单号" min-width="190">
            <template #default="{ row }"><router-link :to="`/purchase/${row.id}`" class="link">{{ row.id }}</router-link></template>
          </el-table-column>
          <el-table-column label="类型" width="100">
            <template #default="{ row }">{{ isAmend(row) ? '补差单' : '退货单' }}</template>
          </el-table-column>
          <el-table-column prop="date" label="日期" width="110" />
          <el-table-column v-if="!priceHidden" label="金额" width="120" align="right">
            <template #default="{ row }">{{ grossOf(row).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="原因" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">{{ row.returnReason || row.amendReason || row.remark || '—' }}</template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>
    <PaymentDialog v-model="payDialog" :order="purchase" kind="payable" :deposit-balance="supplierAdvanceBalance" @saved="onPaySaved" />

    <!-- 就地编辑本单：与列表页「编辑」共用同一个弹窗组件（suppliers 必须传，否则供应商下拉无选项、编辑时无法回显） -->
    <OrderEditDialog
      v-model="editDialog"
      :order="purchase"
      :list="purchases"
      :items="items"
      :suppliers="suppliers"
      kind="payable"
      :saving="saving"
      @saved="onOrderSaved"
      @amended="onAmended"
    />

    <!-- 轻量补照片：仅更新本单 photos 字段 -->
    <OrderPhotoDialog v-model="photoDialog" :order="purchase" @saved="onPhotosSaved" />

    <!-- 轻量补备注：仅更新本单 remark 字段 -->
    <OrderRemarkDialog v-model="remarkDialog" :order="purchase" placeholder="例如：货款月结、发票待开、到货分两批…" @saved="onRemarkSaved" />

    <!-- 外链分享：生成只读链接，可设时效、查看二维码、随时取消 -->
    <ShareDialog v-model="shareDialog" kind="purchase" :doc-id="purchase.id" :title="`采购单 ${purchase.id}`" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { isReturn } from '../utils/refunds.js'
import { isAmend } from '../utils/amend.js'
import ProductTable from '../components/ProductTable.vue'
import PhotoThumbs from '../components/PhotoThumbs.vue'
import OrderPhotoDialog from '../components/OrderPhotoDialog.vue'
import OrderRemarkDialog from '../components/OrderRemarkDialog.vue'
import OrderEditDialog from '../components/OrderEditDialog.vue'
import PaymentDialog from '../components/PaymentDialog.vue'
import ShareDialog from '../components/ShareDialog.vue'
import { payableOf, grossOf, netOf, paidSumOf, ensurePayments, depositSumOf, isSettledOf, settleActionOf, syncPayments, round2, discountRatesTextOf, discountAmountOf, discountedTotalOf, effectiveRateOf, allocateUnitOf, isVoided } from '../utils/account'
import { downloadCSV, printA4 } from '../utils/export'
import { repeatHeaderPref } from '../utils/printPrefs'
import PrintHeaderToggle from '../components/PrintHeaderToggle.vue'
import { applyDepositFlows, removeDepositFlows } from '../utils/deposit'
import { lineDisplayName } from '../utils/catalog'
import { savePaymentWithVouchers, voucherNotices } from '../utils/voucherFlow'
import { todayCN, fmtCNTime, orderTimeOf } from '../utils/time.js'

const route = useRoute()
const router = useRouter()
const purchases = ref([])
const items = ref([])
// 供应商档案：付款时「用预付款支付」抵扣需要读取/扣减供应商预付款余额
const suppliers = ref([])
// 数据加载中：全量单据/商品拉取期间显示遮罩，避免白屏被误判为"点了没反应"
const loading = ref(true)
const payDialog = ref(false)
const photoDialog = ref(false)
// 备注弹窗（轻量，只改 remark 字段）
const remarkDialog = ref(false)
const editDialog = ref(false)
// 保存中标记：配合弹窗按钮 loading，防止双击重复提交
const saving = ref(false)
const shareDialog = ref(false)
// 用户信息落款：勾选后显示在商品列表底部，并随打印一起输出
const showProfile = ref(false)
const profile = ref({})
const hasProfile = computed(() => ['name', 'phone', 'address', 'remark'].some(k => String(profile.value[k] || '').trim()))
const profileFields = computed(() => (showProfile.value ? [
  ['联系名称', profile.value.name],
  ['电话', profile.value.phone],
  ['地址', profile.value.address],
  ['备注', profile.value.remark]
] : []))
watch(showProfile, v => {
  if (v && !hasProfile.value) ElMessage.warning('尚未填写用户信息，请到「系统 → 用户信息」补充')
})
// 单据是否真实存在：不存在时禁用编辑/删除，避免把占位空单当新增保存
const found = computed(() => purchases.value.some(p => p.id === route.params.id))
const purchase = computed(() => purchases.value.find(p => p.id === route.params.id) || { id: route.params.id, supplier: '', date: '', total: 0, items: [] })

// 当前采购单对应供应商的预付款可用余额（用于付款时「用预付款支付」抵扣）
const supplierAdvanceBalance = computed(() => {
  const s = suppliers.value.find(x => x.name === purchase.value.supplier)
  return depositSumOf(s && s.advances)
})
// 供应商名 → 编码：详情页点供应商名跳转供应商详情
// 本单供应商的档案（联系人/电话/地址）：页面显示与打印导出的联系方式取同一份数据，
// 避免「勾了显示供应商信息详情，纸上有了、屏幕上还要靠打印预览看」
const supplierInfo = computed(() =>
  (suppliers.value || []).find(x => x.name === purchase.value.supplier) || {})
const supplierCodeMap = computed(() => {
  const m = {}
  ;(suppliers.value || []).forEach(s => { if (s && s.name) m[s.name] = s.code })
  return m
})
// 整单折扣链文本（单级 ×0.90 / 多级 ×0.90 ×0.90 ×0.80 = ×0.65 / 无折扣空串）：与 account 口径一致
const orderRate = computed(() => discountRatesTextOf(purchase.value))
// 整单折扣金额（人民币绝对值）：折扣链连乘后从合计减掉的钱，与「优惠」并列构成应付减项（折扣金额与优惠金额联动）
const discountAmount = computed(() => discountAmountOf(purchase.value))
// 折后金额（应用全部折扣后、未扣优惠前）：合计 × 整单等效折扣率；与应付(再扣优惠)区分
const discountedTotal = computed(() => discountedTotalOf(purchase.value))
const hasDiscount = computed(() => Boolean(orderRate.value) || lineDiscountSum.value > 0)

// 应付(合计−优惠) 与 未付(应付−累计实付)，与全站统一规则一致
const dueAmount = computed(() => grossOf(purchase.value))
const unpaid = computed(() => payableOf(purchase.value))
const paidSum = computed(() => paidSumOf(purchase.value))
const payments = computed(() => ensurePayments(purchase.value, 'paid'))
// 未付金额为 0 即显示结清；结算状态旁的改账按钮由 settleActionOf 统一判定（改结清 / 改挂账 / 不显示）
const settleLabel = computed(() => isSettledOf(unpaid.value, purchase.value.settle) ? '结清' : '挂账')
const settleAction = computed(() => settleActionOf(purchase.value, 'payable'))

// 单据家族：本单 + 它派生的退货/补差单；本单自己若是补差单，再把指回的原单也算进来。
// 变更后「净成交」「未付」都必须按家族合计——原单金额不再代表这单最终成交了多少。
const familyDocs = computed(() => {
  const all = purchases.value || []
  const parent = purchase.value.sourceOrderId ? all.filter(o => o.id === purchase.value.sourceOrderId) : []
  return [...parent, purchase.value, ...all.filter(o => o.sourceOrderId === purchase.value.id)]
})
const relatedDocs = computed(() => familyDocs.value.filter(o => o.id !== purchase.value.id))
const netDeal = computed(() => round2(familyDocs.value.reduce((s, o) => s + grossOf(o), 0)))
const netDue = computed(() => round2(familyDocs.value.reduce((s, o) => s + netOf(o, 'payable'), 0)))

// 结算状态改账按钮三个动作（与列表页同口径）：
//   settle：仍未付 → 付款结清（差额记实付，生成付款单）或差额记优惠（无资金单据）
//   unrest：金额已平但有抹零优惠 → 改挂账＝撤销优惠、未付恢复
//   none：不显示按钮
async function toggleSettle() {
  const action = settleAction.value
  if (action === 'none') return
  if (action === 'unrest') {
    const discount = round2(Number(purchase.value.discount || 0))
    try {
      await ElMessageBox.confirm(
        `本单应付已结清，其中抹零优惠 ¥${discount.toFixed(2)} 未实际付款。\n` +
        `改挂账将撤销这笔优惠，未付恢复为 ¥${discount.toFixed(2)}，结算状态回到「挂账」。\n` +
        `如果钱其实已经付出，请用「记录付款」补登记，而不是改挂账。`,
        '确认改挂账', { type: 'warning', confirmButtonText: '确认改挂账', cancelButtonText: '取消' })
    } catch { return }
    const updated = syncPayments({ ...purchase.value, discount: 0 }, 'payable')
    const idx = purchases.value.findIndex(x => x.id === updated.id)
    if (idx < 0) return
    const origin = purchases.value[idx]
    purchases.value[idx] = updated
    try {
      await api.savePurchases(purchases.value)
    } catch (e) {
      purchases.value[idx] = origin
      ElMessage.error(`操作失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
      const fresh = await api.getPurchases().catch(() => null)
      if (fresh) purchases.value = fresh
      return
    }
    ElMessage.success(`已改回挂账：未付恢复 ¥${discount.toFixed(2)}`)
    return
  }
  // action === 'settle'：未付 > 0
  const due = dueAmount.value
  const paid = paidSum.value
  const gap = unpaid.value
  let mode = 'cash'
  try {
    await ElMessageBox.confirm(
      `该单应付 ¥${due.toFixed(2)}，已实付 ¥${paid.toFixed(2)}，未付 ¥${gap.toFixed(2)}。\n` +
      `· 「付款结清」：把 ¥${gap.toFixed(2)} 记为一笔实际付款，并生成付款单（现金减少）\n` +
      `· 「差额记优惠」：¥${gap.toFixed(2)} 作为抹零优惠核销，钱未付出，因此不生成付款单`,
      '确认改结清', {
        type: 'warning',
        confirmButtonText: '付款结清',
        cancelButtonText: '差额记优惠',
        distinguishCancelAndClose: true
      })
  } catch (e) {
    // close（点 X / ESC）= 放弃操作；cancel = 明确选择「差额记优惠」
    if (e !== 'cancel') return
    mode = 'discount'
  }
  if (mode === 'cash') {
    const payments = ensurePayments(purchase.value, 'paid')
    const row = { date: todayCN(), amount: gap, remark: '结清付款', time: new Date().toISOString(), mid: `n${Date.now().toString(36)}` }
    payments.push(row)
    const updated = syncPayments({ ...purchase.value, payments }, 'payable')
    const r = await savePaymentWithVouchers(api, 'payable', purchases.value, updated, [row], null)
    if (r.stage === 'orders') {
      ElMessage.error(`操作失败：${(r.error && r.error.message) || '网络异常'}，本地改动已回滚，请重试`)
      const fresh = await api.getPurchases().catch(() => null)
      if (fresh) purchases.value = fresh
      return
    }
    purchases.value = r.merged
    ElMessage.success(`已付款结清：¥${gap.toFixed(2)} 已付出`)
    voucherNotices('payable', r).forEach(n => ElMessage[n.type]({ message: n.text, duration: n.duration }))
    return
  }
  const updated = syncPayments({ ...purchase.value, discount: round2(Number(purchase.value.discount || 0) + gap) }, 'payable')
  const idx = purchases.value.findIndex(x => x.id === updated.id)
  if (idx >= 0) purchases.value[idx] = updated
  try {
    await api.savePurchases(purchases.value)
  } catch (e) {
    ElMessage.error(`操作失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
    const fresh = await api.getPurchases().catch(() => null)
    if (fresh) purchases.value = fresh
    return
  }
  ElMessage.success(`已按抹零优惠结清 ¥${gap.toFixed(2)}（无资金变动，未生成付款单）`)
}

// 明细行原价合计与单项折扣合计（合计字段为折后金额）
const grossSum = computed(() => (purchase.value.items || []).reduce((s, l) => s + Number(l.qty || 0) * Number(l.price || 0), 0))
const lineDiscountSum = computed(() => (purchase.value.items || []).reduce((s, l) => s + Number(l.discount || 0), 0))
// 没有行级折扣时不显示「本次折扣」列（打印/导出同样隐藏），避免整列都是 0.00
const hasLineDiscount = computed(() => (purchase.value.items || []).some(l => {
  const r = Number(l.discountRate)
  return Number(l.discount || 0) > 0 || (Number.isFinite(r) && r > 0 && r < 1)
}))

const detailItems = computed(() => {
  const nameMap = Object.fromEntries((items.value || []).map(i => [i.code, i.name || '']))
  const lines = purchase.value.items || []
  // 摊完整单折扣后的行金额：各行合计 = 单头折后金额
  const { nets, units } = allocateUnitOf(lines.map(l => Number(l.total || 0)), lines.map(l => Number(l.qty || 0)), effectiveRateOf(purchase.value))
  return lines.map((line, idx) => {
    const base = (items.value || []).find(i => i.code === line.code) || {}
    return {
      ...base,
      code: line.code,
      name: lineDisplayName(line, nameMap),
      suppliers: base.suppliers || [],
      package: base.package,
      unit: base.unit || '',
      cost: line.price,
      price: base.price != null ? base.price : line.price,
      _qty: line.qty,
      _price: line.price,
      _discount: Number(line.discount || 0),
      _discountRate: line.discountRate,
      _total: line.total,
      _net: nets[idx],
      _unitNet: units[idx]
    }
  })
})

// ---- 导出 CSV / 打印(A4) ----
// 「隐藏单价与金额」勾选后剔除所有价格列，只留商品与数量：用于不带价对账场景
const hidePrice = ref(false)
// 打印/导出是否带供应商联系方式（联系人、电话、地址）。默认不带：单据打印出去多半是给外部的，
// 联系方式属于供应商档案，不该跟着一张对账单一起流出去；要留档时再勾上
const showPartyInfo = ref(false)
// 采购单详情默认不展示售价（商品档案当前卖价），需要时勾选「显示售价」查看
const showSellPrice = ref(false)
// 历史采购单默认只看「本次数据」：本单成交价已在「本次单价」列，档案进价属重复信息，
// 默认隐藏，需要对照档案进价时再勾「显示进价」；备注固定置底
const showCostCol = ref(false)
// 历史采购价 / 历史销售价 / 商品照片属于商品档案，不是本单数据：默认收起
const showHistory = ref(false)
// 对外查看：隐藏全部价格与金额、隐藏写操作（编辑/删除/退货/收付款/照片），只保留供应商、时间、结算状态等非金额信息
const externalView = ref(false)
// 价格脱敏：两个入口共用同一口径——手动勾选「隐藏单价与金额」或开启「对外查看」时，
// 页面上的单价/折扣/金额列、单头金额、付款金额同步隐藏（导出与打印沿用同一规则）
const priceHidden = computed(() => hidePrice.value || externalView.value)
const tablePriceColumns = computed(() => (priceHidden.value || !showSellPrice.value) ? [] : [{ prop: 'price', label: '售价' }])
const PRICE_LABELS = ['进价', '售价', '本次单价', '本次折扣', '本次金额', '折后单价（含整单折扣）', '折后金额（含整单折扣）']
const exportColumns = computed(() => {
  let cols = [
    { label: '编码', prop: 'code' },
    { label: '名称', prop: 'name' },
    { label: '单位', prop: 'unit' },
    { label: '供应商', value: r => (r.suppliers || []).join('、') },
    { label: '进价', value: r => (r._price == null || r._price === '' ? '' : Number(r._price).toFixed(2)) },
    { label: '售价', value: r => (r.price == null || r.price === '' ? '' : Number(r.price).toFixed(2)) },
    { label: '本次数量', prop: '_qty' },
    { label: '本次单价', value: r => (r._price == null || r._price === '' ? '' : Number(r._price).toFixed(2)) },
    ...(hasLineDiscount.value ? [{ label: '本次折扣', value: r => (Number(r._discount) ? Number(r._discount).toFixed(2) : '') }] : []),
    { label: '本次金额', value: r => (r._total == null || r._total === '' ? '' : Number(r._total).toFixed(2)) },
    ...(orderRate.value ? [{ label: '折后单价（含整单折扣）', value: r => Number(r._unitNet || 0).toFixed(2) }] : []),
    ...(orderRate.value ? [{ label: '折后金额（含整单折扣）', value: r => Number(r._net || 0).toFixed(2) }] : []),
    { label: '备注', prop: 'remark' }
  ]
  // 与页面表格同步：未勾选「显示售价 / 显示进价」时，导出/打印一律不带该档案价列（本单价看「本次单价」）
  if (!showSellPrice.value) cols = cols.filter(c => c.label !== '售价')
  // 对外查看：一律隐藏进价（成本），保持脱敏；隐藏单价与金额则剔除全部价格列（优先级最高）
  if (!showCostCol.value || externalView.value) cols = cols.filter(c => c.label !== '进价')
  if (hidePrice.value || externalView.value) cols = cols.filter(c => !PRICE_LABELS.includes(c.label))
  return cols
})
// 打印页副标题：商品行数摘要（完整单头信息见下方 fields 字段区，避免重复）
const docSubtitle = computed(() => `共 ${detailItems.value.length} 项商品`)
// 单头信息：供应商 + 日期 + 单据金额与结算字段（有折扣显示折扣）。
// 「隐藏单价与金额 / 对外查看」时剔除全部金额类字段（含折扣与折后金额），与明细列同一口径；
// 供应商编码属于系统内部标识，打印与导出一律不带；
// 联系人/电话/地址受「显示供应商信息详情」控制，默认不打印
const AMOUNT_FIELD_LABELS = ['合计', '原价合计', '整单折扣', '折后金额', '优惠', '应付', '实付', '未付']
const docHeaderFields = computed(() => {
  const o = purchase.value
  const s = supplierInfo.value
  const fields = [
    ['供应商', o.supplier || '—'],
    ...(showPartyInfo.value ? [['联系人', s.contact], ['电话', s.phone], ['地址', s.address]] : []),
    ['日期', o.date],
    ['合计', `¥${Number(o.total || 0).toFixed(2)}`]
  ]
  if (lineDiscountSum.value > 0) fields.push(['原价合计', `¥${grossSum.value.toFixed(2)}（单项折扣 -¥${lineDiscountSum.value.toFixed(2)}）`])
  if (orderRate.value) fields.push(['整单折扣', `${orderRate.value}（减 ¥${discountAmount.value.toFixed(2)}）`, 'hl'])
  if (hasDiscount.value) fields.push(['折后金额', `¥${discountedTotal.value.toFixed(2)}`])
  fields.push(
    ['优惠', `¥${Number(o.discount || 0).toFixed(2)}${Number(o.discount || 0) > 0 ? '（抹零优惠，未实际付款）' : ''}`],
    ['应付', `¥${dueAmount.value.toFixed(2)}`],
    ['实付', `¥${paidSum.value.toFixed(2)}${payments.value.length ? `（${payments.value.length} 笔）` : ''}`],
    ['未付', `¥${unpaid.value.toFixed(2)}`],
    ['结算状态', settleLabel.value],
    ['备注', o.remark]
  )
  if (hidePrice.value || externalView.value) return fields.filter(([label]) => !AMOUNT_FIELD_LABELS.includes(label))
  return fields
})
function doExport() {
  if (!detailItems.value.length) return ElMessage.warning('本单暂无商品明细')
  downloadCSV(`采购单-${purchase.value.id}.csv`, exportColumns.value, detailItems.value, docHeaderFields.value)
  ElMessage.success(`已导出 ${detailItems.value.length} 行${priceHidden.value ? '（已隐藏单价与金额）' : ''}`)
}
function doPrint(paper = 'A4') {
  if (!detailItems.value.length) return ElMessage.warning('本单暂无商品明细')
  printA4(`采购单 ${purchase.value.id}`, exportColumns.value, detailItems.value, docSubtitle.value, docHeaderFields.value, profileFields.value, paper, repeatHeaderPref.value)
}

async function onPaySaved(updated, payload) {
  // 付款流水与付款单（FK-）成对落库：编号先回写到流水上，详情页「资金单据编号」不再是「—」
  const r = await savePaymentWithVouchers(api, 'payable', purchases.value, updated, payload?.newRows, payload?.add)
  if (r.stage === 'orders') {
    // 保存失败要回滚并明确报错：否则界面显示已付款、线上其实没变，且弹窗不关可重复提交
    const fresh = await api.getPurchases().catch(() => null)
    if (fresh) purchases.value = fresh
    ElMessage.error(`保存失败：${(r.error && r.error.message) || '网络异常'}，本地改动已回滚`)
    return
  }
  purchases.value = r.merged
  payDialog.value = false
  ElMessage.success('已保存付款流水')
  // 超付转预付款 / 用预付款抵扣：按订单 id 幂等重建流水，重复保存不会重复加减（资金不泄漏）
  const addAmt = Number(payload?.add?.amount || 0)
  const deductAmt = Number(payload?.deduct?.amount || 0)
  if (addAmt > 0 || deductAmt > 0) {
    const list2 = await applyDepositFlows(api, 'payable', updated.supplier, updated.id, addAmt, deductAmt)
    if (list2) suppliers.value = list2
    const parts = []
    if (addAmt > 0) parts.push(`存入供应商预付款 ¥${addAmt.toFixed(2)}`)
    if (deductAmt > 0) parts.push(`扣减供应商预付款 ¥${deductAmt.toFixed(2)}`)
    if (parts.length) ElMessage.success(parts.join('；'))
  }
  // 每一笔新增付款流水各开一张付款单（关联本采购单号）；预付款抵扣为划转单；超额转存无单号
  voucherNotices('payable', r).forEach(n => ElMessage[n.type]({ message: n.text, duration: n.duration }))
}

// 保存照片：仅合并 photos 字段，单据其他信息与付款流水不动
async function onPhotosSaved(photos) {
  const cur = purchase.value
  const idx = purchases.value.findIndex(p => p.id === cur.id)
  if (idx < 0) return
  const origin = purchases.value[idx]
  purchases.value[idx] = { ...origin, photos }
  try {
    await api.savePurchases(purchases.value)
  } catch (e) {
    purchases.value[idx] = origin
    ElMessage.error(`保存失败：${e.message || '网络异常'}，请重试`)
    return
  }
  photoDialog.value = false
  ElMessage.success('已更新单据照片')
}

// 保存备注：只合并 remark 一个字段。金额、明细、付款流水原样带回去，
// 后端资金保护里退货单锁比对的是「去掉 photos/remark 的其余字段」，所以补备注不会被锁住，
// 也不会绕过锁改到金额
async function onRemarkSaved(text) {
  const cur = purchase.value
  const idx = purchases.value.findIndex(p => p.id === cur.id)
  if (idx < 0) return
  const origin = purchases.value[idx]
  purchases.value[idx] = { ...origin, remark: text }
  try {
    await api.savePurchases(purchases.value)
  } catch (e) {
    purchases.value[idx] = origin
    ElMessage.error(`保存失败：${e.message || '网络异常'}，请重试`)
    return
  }
  remarkDialog.value = false
  ElMessage.success(text ? '已保存备注' : '已清空备注')
}

// 编辑本单：弹窗组装好 entry 后在此落库，保存成功后重拉数据，页面原地刷新
async function onOrderSaved({ entry, depositDeduct, payRows }) {
  saving.value = true
  try {
    // 编辑单里的「补付」差额是真实资金变动 → 与付款单同批落库（编号回写到流水上）
    const r = await savePaymentWithVouchers(api, 'payable', purchases.value, entry, payRows || [], null)
    if (r.stage === 'orders') {
      ElMessage.error(`保存失败：${(r.error && r.error.message) || '网络异常'}，本地改动已回滚，请重试`)
      return
    }
    purchases.value = r.merged
    // 保存已成功：先关窗报成功；刷新单独容错，失败不再卡住弹窗（避免重复点击）
    editDialog.value = false
    ElMessage.success('已保存修改')
    // 商品建档、库存、历史价均由后端自动推导，重拉保证页面与线上一致
    try {
      const [p, it, sup] = await Promise.all([api.getPurchases(), api.getItems(), api.getSuppliers()])
      purchases.value = p
      items.value = it
      suppliers.value = sup
    } catch { /* 刷新失败：保留本地数据，下次进入页面会自动重拉 */ }
    // 兜底：若带预付款抵扣（正常编辑路径不会），一并扣减
    if (depositDeduct && Number(depositDeduct.amount) > 0) {
      const sup2 = await applyDepositFlows(api, 'payable', entry.supplier, entry.id, 0, depositDeduct.amount).catch(() => null)
      if (sup2) suppliers.value = sup2
      ElMessage.success(`已从供应商预付款扣减 ¥${Number(depositDeduct.amount).toFixed(2)}`)
    }
    voucherNotices('payable', r).forEach(n => ElMessage[n.type]({ message: n.text, duration: n.duration }))
  } finally { saving.value = false }
}

// 变更明细由弹窗自己落库（服务端一次提交生成退货单/补差单），这里只负责整页重拉：
// 库存、供应商往来账、历史进价都是派生数据，本地无法拼出变更后的结果
async function onAmended() {
  try {
    const [p, it, sup] = await Promise.all([api.getPurchases(), api.getItems(), api.getSuppliers()])
    purchases.value = p
    items.value = it
    suppliers.value = sup
  } catch { ElMessage.warning('变更已保存，但页面刷新失败，请返回列表重新进入') }
}

// 删除本单：库存与历史价由后端自动重算；删除成功后必须跳回列表，否则路由 id 失效只剩占位空单
async function removeOrder() {
  try {
    await ElMessageBox.confirm(
      `确定删除采购单 ${purchase.value.id}?\n删除后库存与历史价会自动重算，删除后将返回采购列表。`,
      '提示', { type: 'warning' })
  } catch { return }
  saving.value = true
  try {
    const snapshot = [...purchases.value]
    purchases.value = purchases.value.filter(p => p.id !== purchase.value.id)
    try {
      await api.savePurchases(purchases.value)
    } catch (e) {
      purchases.value = snapshot
      ElMessage.error(`删除失败：${e.message || '网络异常'}，本地改动已回滚，请重试`)
      return
    }
    ElMessage.success('已删除')
    // 删除单据时同步清掉其超付转存/抵扣标记的预付款流水
    const sup2 = await removeDepositFlows(api, 'payable', purchase.value.supplier, purchase.value.id).catch(() => null)
    if (sup2) suppliers.value = sup2
    router.push('/purchases')
  } finally { saving.value = false }
}

onMounted(async () => {
  try {
    const [p, it, sup, pf] = await Promise.all([api.getPurchases(), api.getItems(), api.getSuppliers(), api.getProfile().catch(() => ({}))])
    purchases.value = p
    items.value = it
    suppliers.value = sup
    profile.value = pf || {}
  } catch (e) { purchases.value = []; items.value = [] }
  finally { loading.value = false }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.related-sum { color: var(--text-secondary); font-size: var(--fs-sub); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.hide-price-cb { margin-right: 4px; white-space: nowrap; }
.hide-price-cb :deep(.el-checkbox__label) { font-size: var(--fs-sub); color: var(--text-regular); }
.opt-cb { margin-right: 4px; white-space: nowrap; }
.opt-cb :deep(.el-checkbox__label) { font-size: var(--fs-sub); color: var(--text-regular); }
.info { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px; color:var(--text-regular); font-size:var(--fs-base); align-items: center; }
.external-banner { margin-bottom: 12px; }
.price-hidden-note { color: var(--text-secondary); }
.order-discount { background: #fff7e6; border: 1px solid #f0c78a; color: #b26a00; padding: 2px 8px; border-radius: 4px; }
.order-discount b { font-weight: 700; }
.settle-cell { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.remark-cell { display: inline-flex; align-items: center; gap: 4px; }
.settle-btn { margin-left: 2px; }
.photos-block { margin-bottom: 12px; }
.photos-title { font-weight: 600; margin-bottom: 6px; color:var(--color-primary); display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.pay-card { margin-top: 12px; }
.debt { color:var(--color-danger); }
.zero { color:var(--color-success); }
.none { color:var(--text-placeholder); }
.discount { color:var(--color-success); }
.print-foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-color); display: flex; flex-wrap: wrap; gap: 4px 24px; color: var(--text-regular); font-size: var(--fs-sub); }
</style>
