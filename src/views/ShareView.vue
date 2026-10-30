<template>
  <div class="share-page">
    <div v-if="data" class="share-card">
      <header class="share-head">
        <div>
          <div class="doc-label">{{ data.doc.docLabel }}</div>
          <div class="doc-id">{{ data.doc.id }}</div>
        </div>
        <span class="readonly-badge">只读分享</span>
      </header>

      <div class="meta">
        <span>{{ data.doc.partyLabel }}：<b>{{ data.doc.party || '—' }}</b></span>
        <span>日期：{{ data.doc.date || '—' }}</span>
        <span v-if="data.doc.no">业务单号：{{ data.doc.no }}</span>
        <span v-if="data.kind === 'order'">状态：{{ data.doc.status }}</span>
      </div>

      <div class="table-scroll">
        <table class="share-table">
          <thead>
            <tr>
              <th class="idx">#</th>
              <th>商品名称</th>
              <th class="unit">单位</th>
              <th class="num">数量</th>
              <th class="num">单价</th>
              <th v-if="totals.hasLineDiscount" class="num">折扣率</th>
              <th v-if="totals.hasLineDiscount" class="num">本次折扣</th>
              <th class="num">本次金额</th>
              <th v-if="totals.hasOrderDiscount" class="num">折后金额</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(line, i) in data.lines" :key="i">
              <td class="idx">{{ i + 1 }}</td>
              <td>
                <div>{{ line.name }}</div>
                <div v-if="line.code" class="code">{{ line.code }}</div>
              </td>
              <td class="unit">{{ line.unit || '—' }}</td>
              <td class="num">{{ fmtQty(line.qty) }}</td>
              <td class="num">{{ money(line.price) }}</td>
              <td v-if="totals.hasLineDiscount" class="num">{{ line.discountRate < 1 ? line.discountRate.toFixed(2) : '—' }}</td>
              <td v-if="totals.hasLineDiscount" class="num">{{ line.discount > 0 ? '-' + money(line.discount) : '—' }}</td>
              <td class="num">{{ money(line.total) }}</td>
              <td v-if="totals.hasOrderDiscount" class="num">{{ money(line.net) }}</td>
            </tr>
            <tr v-if="!data.lines.length">
              <td :colspan="columnCount" class="empty">暂无商品明细</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="totals">
        <div v-if="totals.lineDiscount > 0" class="total-row">
          <span>原价合计</span><b>¥{{ money(totals.gross) }}</b>
        </div>
        <div v-if="totals.lineDiscount > 0" class="total-row">
          <span>单项折扣</span><b class="discount">-¥{{ money(totals.lineDiscount) }}</b>
        </div>
        <div class="total-row">
          <span>合计</span><b>¥{{ money(totals.total) }}</b>
        </div>
        <div v-if="totals.hasOrderDiscount" class="total-row">
          <span>整单折扣</span><b>×{{ rateValue }}</b>
        </div>
        <div v-if="totals.hasOrderDiscount" class="total-row">
          <span>折后金额</span><b>¥{{ money(totals.discountedTotal) }}</b>
        </div>
        <div v-if="totals.discount > 0" class="total-row">
          <span>整单优惠</span><b>¥{{ money(totals.discount) }}</b>
        </div>
        <div class="total-row due">
          <span>{{ dueLabel }}</span><b>¥{{ money(totals.due) }}</b>
        </div>
        <div v-if="totals.paid" class="total-row">
          <span>{{ paidLabel }}</span><b>¥{{ money(totals.paid) }}</b>
        </div>
        <div class="total-row">
          <span>{{ unpaidLabel }}</span><b :class="totals.unpaid > 0 ? 'debt' : ''">¥{{ money(totals.unpaid) }}</b>
        </div>
      </div>

      <div v-if="data.doc.remark" class="remark">
        <span class="remark-label">备注</span>{{ data.doc.remark }}
      </div>

      <footer class="share-foot">
        <span>此链接仅供查看，无编辑权限</span>
        <span v-if="data.share.expiresAt">有效期至 {{ fmtCNTime(data.share.expiresAt) || data.share.expiresAt }}</span>
        <span v-else>长期有效</span>
      </footer>
    </div>

    <div v-else-if="error" class="share-tip-card">
      <div class="tip-icon">!</div>
      <h3>{{ error }}</h3>
      <p>请联系分享人重新生成链接。</p>
    </div>

    <div v-else class="share-loading">加载中…</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { fmtCNTime } from '../utils/time.js'

const route = useRoute()
const data = ref(null)
const error = ref('')

const totals = computed(() => (data.value && data.value.totals) || {
  gross: 0, lineDiscount: 0, total: 0, rateText: '', discountAmount: 0,
  discountedTotal: 0, discount: 0, due: 0, paid: 0, unpaid: 0,
  hasLineDiscount: false, hasOrderDiscount: false
})
const columnCount = computed(() => {
  let n = 6 // # 名称 单位 数量 单价 本次金额
  if (totals.value.hasLineDiscount) n += 2
  if (totals.value.hasOrderDiscount) n += 1
  return n
})
const rateValue = computed(() => {
  const text = String(totals.value.rateText || '')
  const m = /×([\d.]+)(?:\s*=\s*×([\d.]+))?/.exec(text)
  if (!m) return '1.00'
  return m[2] || m[1]
})
const dueLabel = computed(() => (data.value?.kind === 'order' ? '订单金额' : (data.value?.kind === 'sale' ? '应收' : '应付')))
const paidLabel = computed(() => {
  if (data.value?.kind === 'order') return '已收订金'
  return data.value?.kind === 'sale' ? '实收' : '实付'
})
const unpaidLabel = computed(() => {
  const purchaseSide = data.value?.kind === 'purchase' || (data.value?.kind === 'order' && data.value?.doc.partyLabel === '供应商')
  return purchaseSide ? '未付' : '未收'
})

const money = (v) => Number(v || 0).toFixed(2)
const fmtQty = (v) => {
  const n = Number(v || 0)
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000)
}

onMounted(async () => {
  try {
    data.value = await api.getShare(route.params.token)
  } catch (e) {
    error.value = e.message || '分享链接无效'
  }
})
</script>

<style scoped>
.share-page {
  min-height: 100vh;
  padding: 16px;
  background: var(--bg-page);
  display: flex;
  justify-content: center;
  align-items: flex-start;
}
.share-card {
  width: 100%;
  max-width: 960px;
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 18px 20px 14px;
}
.share-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--border-light); }
.doc-label { font-size: var(--fs-title); font-weight: 700; color: var(--text-primary); }
.doc-id { margin-top: 2px; color: var(--text-secondary); font-size: var(--fs-sub); word-break: break-all; }
.readonly-badge { flex: none; padding: 2px 10px; border: 1px solid var(--color-primary); color: var(--color-primary); border-radius: 999px; font-size: var(--fs-mini); font-weight: 600; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 22px; padding: 12px 0; color: var(--text-regular); font-size: var(--fs-sub); }
.meta b { color: var(--text-primary); }
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.share-table { width: 100%; border-collapse: collapse; font-size: var(--fs-table); min-width: 560px; }
.share-table th, .share-table td { border: 1px solid var(--border-color); padding: 8px 10px; text-align: left; vertical-align: top; }
.share-table th { background: var(--bg-soft); color: var(--text-regular); font-weight: 600; white-space: nowrap; }
.share-table .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.share-table .idx { width: 40px; text-align: center; color: var(--text-secondary); }
.share-table .unit { width: 70px; }
.share-table .code { color: var(--text-secondary); font-size: var(--fs-mini); }
.share-table .empty { text-align: center; color: var(--text-secondary); padding: 24px 0; }
.totals { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
.total-row { display: flex; gap: 18px; justify-content: space-between; min-width: 260px; color: var(--text-regular); font-size: var(--fs-sub); }
.total-row b { font-variant-numeric: tabular-nums; color: var(--text-primary); }
.total-row.due { padding-top: 8px; border-top: 1px solid var(--border-light); font-size: var(--fs-base); }
.total-row.due b { font-size: 20px; color: var(--color-primary); }
.total-row .discount { color: var(--color-success); }
.total-row .debt { color: var(--color-danger); }
.remark { margin-top: 14px; padding: 10px 12px; background: var(--bg-stat); border-radius: var(--radius-sm); color: var(--text-regular); font-size: var(--fs-sub); line-height: 1.7; }
.remark-label { color: var(--text-secondary); margin-right: 8px; }
.share-foot { margin-top: 16px; padding-top: 10px; border-top: 1px solid var(--border-light); display: flex; flex-wrap: wrap; gap: 4px 24px; color: var(--text-secondary); font-size: var(--fs-mini); }
.share-loading { margin-top: 20vh; color: var(--text-secondary); font-size: var(--fs-base); }
.share-tip-card { margin-top: 16vh; max-width: 420px; width: 100%; background: #fff; border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 28px 20px; text-align: center; }
.tip-icon { width: 44px; height: 44px; margin: 0 auto 12px; border-radius: 50%; background: var(--color-danger); color: #fff; font-size: 24px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.share-tip-card h3 { font-size: var(--fs-title); margin-bottom: 8px; color: var(--text-primary); }
.share-tip-card p { color: var(--text-secondary); font-size: var(--fs-sub); }
@media (max-width: 768px) {
  .share-page { padding: 8px; }
  .share-card { padding: 14px 12px; border-radius: var(--radius-md); }
  .total-row { min-width: 220px; }
}
</style>
