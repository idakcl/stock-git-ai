// 明细重复商品提示：新增商品时若本单已有同一商品，弹出「本商品已录入」，
// 让用户选择「定位到已录入商品」（滚动到那一行并蓝色闪烁两下）或「再次添加」（允许同一商品出现多行）。
import { nextTick } from 'vue'
import { ElMessageBox } from 'element-plus'

/**
 * 询问重复商品怎么处理。
 * @param {{ name: string, index: number }} p 商品名与已录入行号（0 基）
 * @returns {Promise<'locate'|'add'|'cancel'>} 定位 / 再次添加 / 关闭弹窗（不处理）
 */
export async function askDuplicateItem({ name, index }) {
  try {
    await ElMessageBox.confirm(
      `本商品已录入（第 ${index + 1} 行）。可以定位到已录入的那一行，也可以再添加一行。`,
      '本商品已录入',
      {
        type: 'warning',
        confirmButtonText: '定位到已录入商品',
        cancelButtonText: '再次添加',
        distinguishCancelAndClose: true,
        closeOnClickModal: false
      }
    )
    return 'locate'
  } catch (action) {
    // confirm 被 reject 时：cancel = 点了「再次添加」，close = 右上角关闭 / ESC
    return action === 'cancel' ? 'add' : 'cancel'
  }
}

let flashTimer = null

/**
 * 把明细表第 index 行滚到可视区中间，并加蓝色外框闪烁两下（动画结束自动摘掉 class）。
 * @param {import('vue').Ref} tableRef el-table 的模板引用
 * @param {number} index 0 基行号
 */
export async function flashTableRow(tableRef, index) {
  await nextTick()
  const root = tableRef.value?.$el
  const rows = root?.querySelectorAll('.el-table__body-wrapper tbody tr')
  const row = rows?.[index]
  if (!row) return
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  // 重启动画：先摘掉 class 并强制回流，连续两次定位同一行也能重新闪
  row.classList.remove('locate-flash')
  void row.offsetWidth
  row.classList.add('locate-flash')
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => row.classList.remove('locate-flash'), 1800)
}
