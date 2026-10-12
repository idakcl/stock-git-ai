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

export const api = {
  login: (password, remember = false) =>
    request('/login', { method: 'POST', body: JSON.stringify({ password, remember }) }),
  // 启动时自检：票据是否仍然有效
  verify: () => request('/session'),

  getItems: () => request('/items'),
  saveItems: (items) => request('/items', { method: 'POST', body: JSON.stringify({ items }) }),
  getSuppliers: () => request('/suppliers'),
  saveSuppliers: (suppliers) => request('/suppliers', { method: 'POST', body: JSON.stringify({ suppliers }) }),
  getCustomers: () => request('/customers'),
  saveCustomers: (customers) => request('/customers', { method: 'POST', body: JSON.stringify({ customers }) }),
  getPurchases: () => request('/purchases'),
  savePurchases: (purchases) => request('/purchases', { method: 'POST', body: JSON.stringify({ purchases }) }),
  getSales: () => request('/sales'),
  saveSales: (sales) => request('/sales', { method: 'POST', body: JSON.stringify({ sales }) }),
  getStock: () => request('/stock'),
  getLogs: () => request('/logs'),
  // 上传图片/单据照片到图床，返回 { url }
  uploadPhoto: async (file) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(BASE + '/upload', { method: 'POST', body: fd, headers: authHeaders() })
    return handle(res)
  }
}
