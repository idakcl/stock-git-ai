const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

export const api = {
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
  saveStock: (stock) => request('/stock', { method: 'POST', body: JSON.stringify({ stock }) }),
  getLogs: () => request('/logs'),
  // 上传图片/单据照片到图床，返回 { url }
  uploadPhoto: async (file) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(BASE + '/upload', { method: 'POST', body: fd })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || res.statusText)
    return data
  }
}
