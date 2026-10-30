// 统一 API 层：自动携带登录票据，会话失效时清理状态并通知界面跳登录
const BASE = '/api'
const TOKEN_KEY = 'stock.auth.token'

export const auth = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || ''
    } catch {
      return ''
    }
  },
  set(token, remember = false) {
    try {
      localStorage.removeItem(TOKEN_KEY)
      sessionStorage.removeItem(TOKEN_KEY)
      // 「记住我」存 localStorage（跨标签页保留），否则仅当前会话有效
      const store = remember ? localStorage : sessionStorage
      store.setItem(TOKEN_KEY, token)
    } catch (e) { /* 隐私模式下忽略 */ }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY)
      sessionStorage.removeItem(TOKEN_KEY)
    } catch (e) { /* 忽略 */ }
  }
}

// 会话过期广播：由 App.vue 监听并跳转登录页
export function onUnauthorized() {
  auth.clear()
  window.dispatchEvent(new CustomEvent('auth:expired'))
}

function authHeaders(extra = {}) {
  const t = auth.get()
  return { ...extra, ...(t ? { Authorization: `Bearer ${t}` } : {}) }
}

async function handle(res) {
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) onUnauthorized()
  if (!res.ok) { const error = new Error(data.error || res.statusText); error.status = res.status; throw error }
  return data
}

async function request(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const headers = authHeaders({ 'Content-Type': 'application/json', ...(options.headers || {}) })
  // 刚写入后的刷新：绕过 CDN 边缘缓存，确保读到最新数据（no-cache 让 Worker 回源，已实测有效）。
  // 不影响前端本地的 15s 内存缓存命中（命中时直接返回、不进此函数）。
  if (needFresh() && method === 'GET') headers['Cache-Control'] = 'no-cache'
  const res = await fetch(BASE + path, { ...options, method, headers })
  return handle(res)
}

// ---------- 读接口短 TTL 内存缓存 ----------
// 列表 → 详情的连续导航都要拉全量数据（商品/单据 JSON 较大，首次约 1-2s），
// 同一份数据 15 秒内直接命中内存缓存，避免每次进详情页都白屏等待；
// 保存类操作成功后立即失效对应缓存，保证数据一致性。
const CACHE_TTL = 15000
const readCache = new Map()   // path → { data, expire }
const inflight = new Map()    // path → Promise（并发请求去重）

function cachedGet(path) {
  const hit = readCache.get(path)
  if (hit && hit.expire > Date.now()) return Promise.resolve(structuredClone(hit.data))
  if (inflight.has(path)) return inflight.get(path)
  const p = request(path).then(data => {
    readCache.set(path, { data, expire: Date.now() + CACHE_TTL })
    return structuredClone(data)
  }).finally(() => inflight.delete(path))
  inflight.set(path, p)
  return p
}

// Phase 0 回归修复：写入成功后，CDN 的 s-maxage 边缘缓存无法被 Worker 跨节点清除，
// 会导致「保存后立即刷新」读到的仍是旧缓存（表现为「保存没效果」）。
// 写入后开启一个短暂窗口（20s），窗口内发出的 GET 强制绕过 CDN 缓存（no-cache），
// 保证立刻读到刚写入的数据；窗口外恢复正常缓存提速。前端本就有 15s 内存缓存，
// 这里只补 CDN 层的一致性缺口（Worker 的 caches.default.delete 是 per-edge，清不掉全局 CDN）。
let freshUntil = 0
function markFresh() { freshUntil = Date.now() + 20000 }
const needFresh = () => Date.now() < freshUntil

function invalidate(path) {
  readCache.delete(path)
  markFresh()
}

// 保存采购单/销售单时，服务端会同步重算派生数据（商品档案、库存、供应商链接）。
// 这些路径必须一并失效，否则 15 秒缓存窗口内报表/看板/库存看到的还是旧成本、旧库存、旧历史价。
function invalidateAfterOrderSave() {
  invalidate('/items')
  invalidate('/stock')
  invalidate('/suppliers')
  invalidate('/purchase-history')
  invalidate('/sale-history')
}

export const api = {
  login: (password, remember = false) =>
    request('/login', { method: 'POST', body: JSON.stringify({ password, remember }) }),
  // 启动时自检：票据是否仍然有效
  verify: () => request('/session'),

  getItems: () => cachedGet('/items'),
  // 历史采购价（{ 商品编码: [行] }）：服务端按采购单实时派生，只在展开历史价时取一次
  getPurchaseHistory: () => cachedGet('/purchase-history'),
  // 历史销售价：同上，按销售单实时派生，不落 items.json
  getSaleHistory: () => cachedGet('/sale-history'),
  saveItems: async (items) => {
    const r = await request('/items', { method: 'POST', body: JSON.stringify({ items }) })
    invalidate('/items')
    // 服务端会同步供应商档案里的商品列表，一并失效避免看到旧数据
    invalidate('/suppliers')
    return r
  },
  getSuppliers: () => cachedGet('/suppliers'),
  saveSuppliers: async (suppliers) => {
    const r = await request('/suppliers', { method: 'POST', body: JSON.stringify({ suppliers }) })
    invalidate('/suppliers')
    return r
  },
  getCustomers: () => cachedGet('/customers'),
  saveCustomers: async (customers) => {
    const r = await request('/customers', { method: 'POST', body: JSON.stringify({ customers }) })
    invalidate('/customers')
    return r
  },
  // 收款单/付款单：纯资金单据集合，照抄客户集合范式（保存后失效自身缓存，不触发派生数据重算）
  getReceipts: () => cachedGet('/receipts'),
  saveReceipts: async (receipts) => {
    const r = await request('/receipts', { method: 'POST', body: JSON.stringify({ receipts }) })
    invalidate('/receipts')
    return r
  },
  getPaymentVouchers: () => cachedGet('/payment-vouchers'),
  savePaymentVouchers: async (vouchers) => {
    const r = await request('/payment-vouchers', { method: 'POST', body: JSON.stringify({ 'payment-vouchers': vouchers }) })
    invalidate('/payment-vouchers')
    return r
  },
  getRefunds: () => cachedGet('/refunds'),
  saveRefundOperation: async (operation) => {
    const result = await request('/refunds', { method: 'POST', body: JSON.stringify(operation) })
    for (const path of ['/refunds', '/sales', '/purchases', '/customers', '/suppliers', '/items', '/stock', '/purchase-history', '/sale-history']) invalidate(path)
    return result
  },
  // 订单（未过账单据）：住在独立的 orders.json，不进库存、不进应收，随便改随便删。
  // 写接口只接收操作指令（save/deposit/post/unpost/delete），不接受整表覆盖 ——
  // 过账会真正生成销售/采购单，因此服务端是一次 git 提交把单据、库存、凭证、日志一起写下去。
  getOrders: () => cachedGet('/orders'),
  orderOperation: async (operation) => {
    const result = await request('/orders', { method: 'POST', body: JSON.stringify(operation) })
    invalidate('/orders')
    // 订金会开收款单/付款单（SK-/FK-），两类凭证都失效，免得资金页看到旧账
    invalidate('/receipts')
    invalidate('/payment-vouchers')
    // 只有过账/撤销过账会增删单据，才需要连带失效单据与派生数据缓存
    if (operation.action === 'post' || operation.action === 'unpost') {
      for (const path of ['/sales', '/purchases', '/stock', '/items', '/customers', '/suppliers', '/purchase-history', '/sale-history']) invalidate(path)
    }
    return result
  },
  // 单据变更：原单不动，减少的商品生成退货单、增加的商品生成补差单（一次提交）。
  // requestId 由调用方生成并在失败重试时复用，服务端据此幂等，绝不重复生成两张单。
  amendOrder: async (operation) => {
    const result = await request('/amends', { method: 'POST', body: JSON.stringify(operation) })
    for (const path of ['/sales', '/purchases', '/refunds', '/receipts', '/payment-vouchers', '/customers', '/suppliers', '/items', '/stock', '/purchase-history', '/sale-history']) invalidate(path)
    return result
  },
  // 作废单据：单据置作废 + 其收款单/付款单一起作废，库存与预存预付同步回滚（服务端一次提交）。
  // 作废会影响几乎所有派生数据，这里把相关缓存全部失效，避免 15 秒窗口内看到旧库存/旧欠款。
  voidDoc: async (operation) => {
    const result = await request('/voids', { method: 'POST', body: JSON.stringify(operation) })
    for (const path of ['/sales', '/purchases', '/orders', '/refunds', '/receipts', '/payment-vouchers', '/customers', '/suppliers', '/items', '/stock', '/purchase-history', '/sale-history']) invalidate(path)
    return result
  },
  // 备份恢复：整表替换订单草稿（备份导入用；与 saveXxx 的整表语义一致，但走操作接口）
  restoreOrders: async (orders) => {
    const r = await request('/orders', { method: 'POST', body: JSON.stringify({ action: 'restore', orders }) })
    invalidate('/orders')
    return r
  },
  // 备份恢复：整表替换退款/核销凭证（不触发库存派生，凭证只是台账）
  restoreRefunds: async (refunds) => {
    const r = await request('/refunds', { method: 'POST', body: JSON.stringify({ action: 'restore', refunds }) })
    invalidate('/refunds')
    return r
  },
  getPurchases: () => cachedGet('/purchases'),
  savePurchases: async (purchases) => {
    const r = await request('/purchases', { method: 'POST', body: JSON.stringify({ purchases }) })
    invalidate('/purchases')
    invalidateAfterOrderSave()
    return r
  },
  getSales: () => cachedGet('/sales'),
  saveSales: async (sales) => {
    const r = await request('/sales', { method: 'POST', body: JSON.stringify({ sales }) })
    invalidate('/sales')
    invalidateAfterOrderSave()
    return r
  },
  getStock: () => cachedGet('/stock'),
  getLogs: () => request('/logs'),
  // 数据整理：后端重跑全量派生，修复历史单据乱码编码并重建历史价/库存/供应商链接。
  // 全部衍生数据已重写，统一失效缓存，避免 15 秒窗口内看到旧编码
  normalizeData: async () => {
    const r = await request('/normalize', { method: 'POST', body: JSON.stringify({}) })
    invalidate('/items')
    invalidate('/suppliers')
    invalidate('/customers')
    invalidate('/purchases')
    invalidate('/sales')
    invalidate('/stock')
    invalidate('/purchase-history')
    invalidate('/sale-history')
    return r
  },
  // 分类合并导入：与库内现有数据按主键比对去重后追加（不覆盖）。
  // 前端会先用同一份 dedupe 逻辑做预览，这里传预览判定为「新增」的记录，
  // 服务端仍会重新比对一次（预览到确认之间数据可能变化），以服务端结果为准。
  importMerge: async (key, records) => {
    const r = await request('/import-merge', { method: 'POST', body: JSON.stringify({ key, records }) })
    invalidate(`/${key}`)
    // 商品导入后服务端会重算供应商档案里的商品列表；单据导入后会重算库存/商品档案/供应商/客户
    if (key === 'items') invalidate('/suppliers')
    if (key === 'purchases' || key === 'sales') invalidateAfterOrderSave()
    return r
  },
  // 上传图片/单据照片到图床，返回 { url }
  uploadPhoto: async (file) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(BASE + '/upload', { method: 'POST', body: fd, headers: authHeaders() })
    return handle(res)
  }
}
