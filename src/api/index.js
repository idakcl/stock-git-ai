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
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: authHeaders({ 'Content-Type': 'application/json', ...(options.headers || {}) })
  })
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

function invalidate(path) { readCache.delete(path) }

// 保存采购单/销售单时，服务端会同步重算派生数据（商品档案、库存、供应商链接）。
// 这些路径必须一并失效，否则 15 秒缓存窗口内报表/看板/库存看到的还是旧成本、旧库存、旧历史价。
function invalidateAfterOrderSave() {
  invalidate('/items')
  invalidate('/stock')
  invalidate('/suppliers')
}

export const api = {
  login: (password, remember = false) =>
    request('/login', { method: 'POST', body: JSON.stringify({ password, remember }) }),
  // 启动时自检：票据是否仍然有效
  verify: () => request('/session'),

  getItems: () => cachedGet('/items'),
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
  // 上传图片/单据照片到图床，返回 { url }
  uploadPhoto: async (file) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(BASE + '/upload', { method: 'POST', body: fd, headers: authHeaders() })
    return handle(res)
  }
}
