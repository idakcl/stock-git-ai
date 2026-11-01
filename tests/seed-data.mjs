// 测试夹具：完全自造的业务数据，不依赖 /data 真实数据仓。
// 目的：CI（以及任何干净环境）都能直接跑 api-test / storage-test，
// 同时保留「多年份片区、商品档案空字段、足够多的单据」这些被断言依赖的特征。

const pad = (n, w = 2) => String(n).padStart(w, '0')

// 商品档案故意带上待瘦身的空字段（''、0、[]），体积断言依赖它们
export function makeItems(count = 120) {
  return Array.from({ length: count }, (_, i) => ({
    code: 'P' + pad(i + 1, 5),
    name: '测试商品' + (i + 1),
    unit: '个',
    spec: '',
    priceRetail: 10 + (i % 50),
    priceWholesale: 0,
    priceInstaller: 0,
    package: '',
    warning: 0,
    remark: '',
    photos: [],
    saleCustomers: [],
    purchaseHistory: [],
    createdAt: '2024-01-01 08:00:00',
  }))
}

export function makeSuppliers(count = 12) {
  return Array.from({ length: count }, (_, i) => ({
    code: 'S' + pad(i + 1, 5),
    name: '测试供应商' + (i + 1),
    contact: '',
    phone: '',
    address: '',
    remark: '',
  }))
}

export function makeCustomers(count = 12) {
  return Array.from({ length: count }, (_, i) => ({
    code: 'C' + pad(i + 1, 5),
    name: '测试客户' + (i + 1),
    contact: '',
    phone: '',
    address: '',
    remark: '',
  }))
}

// 日期按年份轮转，保证每个年份都有单据（分片迁移需要多片）
function dateOf(i, years) {
  const year = years[i % years.length]
  const month = (i % 12) + 1
  const day = (i % 27) + 1
  return `${year}-${pad(month)}-${pad(day)}`
}

export function makePurchases(count = 96, years = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
  return Array.from({ length: count }, (_, i) => {
    const date = dateOf(i, years)
    const items = [0, 1].map((j) => {
      const code = 'P' + pad(((i * 2 + j) % 120) + 1, 5)
      const qty = 1 + (j % 3)
      const price = 10 + ((i + j) % 9)
      return { code, name: '测试商品', unit: '个', qty, price, total: qty * price }
    })
    const total = items.reduce((s, l) => s + l.total, 0)
    return {
      id: `C${date.replace(/-/g, '')}${pad((i % 24) + 8)}${pad((i % 60) + 1)}${pad(i + 1, 4)}`,
      date,
      supplier: 'S' + pad((i % 12) + 1, 5),
      total,
      paid: 0,
      received: 0,
      items,
      payments: [],
    }
  })
}

export function makeSales(count = 48, years = [2020, 2021, 2023, 2025, 2026]) {
  return Array.from({ length: count }, (_, i) => {
    const date = dateOf(i + 3, years)
    const items = [0].map((j) => {
      const code = 'P' + pad(((i + j) % 120) + 1, 5)
      const qty = 1 + (i % 2)
      const price = 20 + (i % 7)
      return { code, name: '测试商品', unit: '个', qty, price, total: qty * price }
    })
    const total = items.reduce((s, l) => s + l.total, 0)
    return {
      id: `S${date.replace(/-/g, '')}${pad((i % 24) + 8)}${pad((i % 60) + 1)}${pad(i + 1, 4)}`,
      date,
      customer: 'C' + pad((i % 12) + 1, 5),
      total,
      paid: 0,
      received: 0,
      items,
      payments: [],
    }
  })
}

// 交给 makeFakeRepo 的初始文件表：故意用 2 空格缩进，供「紧凑化」断言对比
export function seedFiles() {
  return {
    'items.json': JSON.stringify(makeItems(), null, 2),
    'suppliers.json': JSON.stringify(makeSuppliers(), null, 2),
    'customers.json': JSON.stringify(makeCustomers(), null, 2),
    'purchases.json': JSON.stringify(makePurchases(), null, 2),
    'sales.json': JSON.stringify(makeSales(), null, 2),
    'stock.json': '{}',
    'refunds.json': '[]',
    'receipts.json': '[]',
    'payment-vouchers.json': '[]',
    'logs.json': '[]',
  }
}
