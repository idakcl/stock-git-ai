// 订单模板：把「常用商品组合」存成可复用的草稿，一键生成正式订单。
//
// 设计要点：
//   · 模板只存「商品 + 数量 + 单价 + 行折扣率」，不存客户/日期/单号：
//     这些信息每次生成订单时由用户现场填写，避免「模板绑死某个客户」的误用。
//   · 模板本身不存金额（金额由 orderAmount 在生成订单时按订单口径重算），
//     保证「模板打印」与「转订单」两条路径的金额口径完全一致。
//   · 数据存 order-templates.json，与订单/单据集合完全解耦，不触发任何派生。
import { readCollection, writeCollection } from './storage.js'
import { normalizeRate } from '../src/utils/catalog.js'
import { round2 } from '../src/utils/account.js'

const TEMPLATES_KEY = 'order-templates'
const MAX_TEMPLATES = 100        // 模板总数上限：避免单用户把数据仓撑胖
const MAX_ITEMS_PER_TEMPLATE = 200 // 单模板商品行数上限：打印 A4 一页装得下
const KINDS = new Set(['sale', 'purchase'])

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e }

// 模板字段裁剪：名称限长、kind 必须合法、明细行逐行校验。
// 裁剪策略与 profile.js 一致——多余字段直接丢弃，不报错，避免脚本塞大段文本。
function clampName(name) {
  return String(name == null ? '' : name).trim().slice(0, 60)
}

function normalizeItem(item, index) {
  if (!item || typeof item !== 'object') fail(`第 ${index + 1} 行明细不是合法对象`)
  const code = String(item.code || '').trim()
  if (!code) fail(`第 ${index + 1} 行缺少商品编码`)
  const name = String(item.name || '').trim().slice(0, 80)
  const unit = String(item.unit || '').trim().slice(0, 20)
  const qty = Number(item.qty)
  if (!Number.isFinite(qty) || qty <= 0) fail(`第 ${index + 1} 行数量必须大于 0`)
  const price = Number(item.price)
  if (!Number.isFinite(price) || price < 0) fail(`第 ${index + 1} 行单价不能为负`)
  // 行折扣率复用 catalog.js 的归一化：非法值按 1 处理，与订单/单据同一口径
  const gross = round2(qty * price)
  const discountRate = normalizeRate(item, gross)
  return { code, name, unit, qty, price, discountRate }
}

function normalizeTemplate(input, existing) {
  if (!input || typeof input !== 'object') fail('模板数据必须是对象')
  const name = clampName(input.name)
  if (!name) fail('模板名称不能为空')
  const kind = String(input.kind || '').trim()
  if (!KINDS.has(kind)) fail('模板类型必须是 sale 或 purchase')
  const items = Array.isArray(input.items) ? input.items : []
  if (!items.length) fail('模板至少要有 1 行商品明细')
  if (items.length > MAX_ITEMS_PER_TEMPLATE) fail(`单模板商品行数不能超过 ${MAX_ITEMS_PER_TEMPLATE}`)
  const normalizedItems = items.map((it, i) => normalizeItem(it, i))
  const now = new Date().toISOString()
  return {
    id: existing?.id || `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name,
    kind,
    items: normalizedItems,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  }
}

export async function listTemplates(env) {
  const list = await readCollection(env, TEMPLATES_KEY)
  if (!Array.isArray(list)) return []
  // 过滤非法记录（手动改库、旧版本残留），按创建时间倒序
  return list
    .filter(t => t && t.id && t.name && KINDS.has(t.kind) && Array.isArray(t.items))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}

export async function templateOperation(env, input) {
  const action = input && input.action
  const list = await listTemplates(env)

  if (action === 'create') {
    if (list.length >= MAX_TEMPLATES) fail(`模板数量已达 ${MAX_TEMPLATES} 个上限，请先删除部分模板`)
    const tpl = normalizeTemplate(input.template, null)
    await writeCollection(env, TEMPLATES_KEY, [...list, tpl], `create template ${tpl.id}`)
    return { ok: true, template: tpl }
  }

  if (action === 'update') {
    const id = String(input.id || '').trim()
    if (!id) fail('缺少模板 ID')
    const idx = list.findIndex(t => t.id === id)
    if (idx < 0) fail('模板不存在', 404)
    const updated = normalizeTemplate(input.template, list[idx])
    updated.id = id // 保持原 ID 不变
    updated.createdAt = list[idx].createdAt
    const next = list.slice()
    next[idx] = updated
    await writeCollection(env, TEMPLATES_KEY, next, `update template ${id}`)
    return { ok: true, template: updated }
  }

  if (action === 'delete') {
    const id = String(input.id || '').trim()
    if (!id) fail('缺少模板 ID')
    const next = list.filter(t => t.id !== id)
    if (next.length === list.length) fail('模板不存在', 404)
    await writeCollection(env, TEMPLATES_KEY, next, `delete template ${id}`)
    return { ok: true }
  }

  if (action === 'duplicate') {
    const id = String(input.id || '').trim()
    if (!id) fail('缺少模板 ID')
    const src = list.find(t => t.id === id)
    if (!src) fail('模板不存在', 404)
    if (list.length >= MAX_TEMPLATES) fail(`模板数量已达 ${MAX_TEMPLATES} 个上限，请先删除部分模板`)
    const copy = {
      ...src,
      id: `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name: `${src.name}（副本）`.slice(0, 60),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: src.items.map(it => ({ ...it }))
    }
    await writeCollection(env, TEMPLATES_KEY, [...list, copy], `duplicate template ${id}`)
    return { ok: true, template: copy }
  }

  fail('不支持的模板操作')
}
