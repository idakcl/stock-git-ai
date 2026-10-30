// 复制文本：优先 Clipboard API（需要 https / localhost），
// 失败时回退到隐藏 textarea + execCommand（局域网 http 访问时也能用）。
export async function copyText(text) {
  const value = String(text == null ? '' : text)
  if (!value) throw new Error('没有可复制的内容')
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch { /* 继续走回退方案 */ }

  const ta = document.createElement('textarea')
  ta.value = value
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, value.length)
  try {
    const ok = document.execCommand('copy')
    if (!ok) throw new Error('复制失败')
    return true
  } finally {
    document.body.removeChild(ta)
  }
}

export function shareLinkOf(token) {
  return `${window.location.origin}/share/${token}`
}
