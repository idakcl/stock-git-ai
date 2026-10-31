// 单据里的「商品 / 供应商不存在」怎么办。
//
// 默认是严格的：编码不在商品库、单位不在名单 → 直接报错，逼调用方先建档。
// 原因是 AI 无人值守，名字错一个字就会悄悄多出一个重复档案，事后很难查。
//
// 但每次开单前都要多打两个接口也确实啰嗦，所以给了两个显式开关（必须每次请求自己写上）：
//   allowNewItems      —— 明细行可以只给 name（+ price），按名称匹配不到就自动建商品
//   allowNewSuppliers  —— 采购单的供应商可以只给名称，按名称匹配不到就自动建档案
// 共同规则：先按编码找 → 再按名称精确匹配（命中就复用，能挡掉大部分重复）→ 都没有才新建；
// 不限条数（整单在同一事务里提交，失败即整体回滚）；只写名称这类确定信息，不猜联系人/电话。
import { nextEntityCode } from '../src/utils/code.js'
import { round2 } from '../src/utils/account.js'

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e }

const cleanName = (v) => String(v == null ? '' : v).trim().slice(0, 60)
const money = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? round2(n) : null
}

// 一次写入里的「商品库 / 供应商名单」工作副本：
// 新建的记录先落在副本里，调用方确认整单校验通过后再整体替换进 state，保证「要么全成、要么全不写」。
export function autoCatalog(state, { allowNewItems = false, allowNewSuppliers = false } = {}) {
  const items = (state.items || []).map(i => ({ ...i }))
  const suppliers = (state.suppliers || []).map(s => ({ ...s }))
  const createdItems = []
  const createdSuppliers = []

  // 明细行 → 商品档案。先编码、再名称；都在库里找不到且开关打开时按名称新建。
  function resolveItem(line, index, kind) {
    const code = String(line.code || '').trim()
    const name = cleanName(line.name)
    const found = (code && items.find(i => i.code === code)) || (name && items.find(i => i.name === name))
    if (found) return found
    const where = `第 ${index + 1} 行商品`
    if (!allowNewItems) {
      fail(`${where}「${code || name || '（空）'}」不在商品库；请先用 POST /api/ai/v1/master 建档，或传 allowNewItems: true 自动建档`)
    }
    // 显式给了编码却查不到：多半是打错了，不能悄悄换成自动编码建档
    if (code) fail(`${where}编码「${code}」不存在；新建商品请只传 name`, 404)
    if (!name) fail(`${where}要自动建档时必须传 name`)
    const price = money(line.price)
    if (price == null) fail(`${where}要自动建档时必须传 price（0 或正数），会作为新商品的${kind === 'purchase' ? '成本' : '售价'}`)
    const rec = {
      code: nextEntityCode(items, 'P', 5),
      name,
      unit: String(line.unit || '').trim().slice(0, 20),
      // 销售单带售价、采购单带成本；另一项留空，等以后有单据再回填
      price: kind === 'purchase' ? null : price,
      cost: kind === 'purchase' ? price : null,
      suppliers: [],
      photos: []
    }
    items.push(rec)
    createdItems.push({ code: rec.code, name: rec.name })
    return rec
  }

  // 往来单位名称 → 档案。名称或编码命中即复用；否则开关打开时按名称新建（只写名称）。
  function resolveParty(ref, label) {
    const key = cleanName(ref)
    if (!key) fail(`请填写${label}名称`)
    const found = suppliers.find(s => s.name === key) || suppliers.find(s => s.code === key)
    if (found) return found
    if (!allowNewSuppliers) {
      fail(`${label}「${key}」还没有档案；请先用 POST /api/ai/v1/master 建档，或传 allowNewSuppliers: true 自动建档`)
    }
    const rec = {
      code: nextEntityCode(suppliers, 'S', 5),
      name: key,
      contact: '',
      phone: '',
      address: '',
      remark: '',
      advances: [],
      products: []
    }
    suppliers.push(rec)
    createdSuppliers.push({ code: rec.code, name: rec.name })
    return rec
  }

  // 把新建的记录写回 state（只在确实新建时才换数组，避免白改一次 items.json）
  function applyTo(target) {
    if (createdItems.length) target.items = items
    if (createdSuppliers.length) target.suppliers = suppliers
    return target
  }

  return { items, suppliers, createdItems, createdSuppliers, resolveItem, resolveParty, applyTo }
}
