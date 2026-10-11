export function matchText(q, ...values) {
  const keyword = String(q || '').trim().toLowerCase()
  if (!keyword) return true
  return values.some(v => String(v ?? '').toLowerCase().includes(keyword))
}
