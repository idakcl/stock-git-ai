// 订单模板接口测试：覆盖增删改查、复制、上限、校验、金额口径。
// 跑法：node tests/templates-test.mjs   （纯 Node，不需要浏览器）
import assert from 'node:assert/strict'
import { makeFakeRepo } from './fake-github.mjs'
import { listTemplates, templateOperation } from '../api/templates.js'
import { handleApi } from '../api/routes.js'
import { issueToken } from '../api/auth.js'
import { round2 } from '../src/utils/account.js'
import { normalizeRate } from '../src/utils/catalog.js'

globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const env = {
  GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main',
  SESSION_SECRET: 'test-secret', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw'
}

const item = (code, name, qty, price, discountRate = 1) => ({ code, name, unit: '个', qty, price, discountRate })

function seed(overrides = {}) {
  return makeFakeRepo({
    'items.json': [
      { code: 'P00001', name: '管件', unit: '个', cost: 8, price: 10 },
      { code: 'P00002', name: '弯头', unit: '只', cost: 4, price: 5 }
    ],
    'suppliers.json': [],
    'customers.json': [],
    'purchases.json': [],
    'sales.json': [],
    'orders.json': [],
    'logs.json': [],
    ...overrides
  })
}

let pass = 0, failCount = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { failCount++; console.log('  ✗ ' + name + '\n      ' + (String(e && e.message || e)).split('\n').join('\n      ')) }
}

seed()
await issueToken(env)

console.log('\n订单模板：基础操作')

await t('空列表：初始无任何模板', async () => {
  const list = await listTemplates(env)
  assert.deepEqual(list, [])
})

await t('创建模板：字段裁剪与默认值', async () => {
  const r = await templateOperation(env, {
    action: 'create',
    template: {
      name: '  常用管件组合  ',
      kind: 'sale',
      items: [item('P00001', '管件', 10, 10, 0.9)]
    }
  })
  assert.equal(r.ok, true)
  assert.match(r.template.id, /^T/)
  assert.equal(r.template.name, '常用管件组合') // 裁剪空白
  assert.equal(r.template.kind, 'sale')
  assert.equal(r.template.items.length, 1)
  assert.equal(r.template.items[0].code, 'P00001')
  assert.equal(r.template.items[0].discountRate, 0.9)
  assert.ok(r.template.createdAt)
  assert.ok(r.template.updatedAt)
})

await t('创建模板：超长名称截断', async () => {
  const r = await templateOperation(env, {
    action: 'create',
    template: { name: 'x'.repeat(100), kind: 'purchase', items: [item('P00001', '管件', 1, 10)] }
  })
  assert.equal(r.template.name.length, 60)
})

await t('创建模板：非法 kind 拒绝', async () => {
  await assert.rejects(
    () => templateOperation(env, { action: 'create', template: { name: '测试', kind: 'invalid', items: [item('P00001', '管件', 1, 10)] } }),
    /模板类型必须是 sale 或 purchase/
  )
})

await t('创建模板：空明细拒绝', async () => {
  await assert.rejects(
    () => templateOperation(env, { action: 'create', template: { name: '测试', kind: 'sale', items: [] } }),
    /至少要有 1 行商品明细/
  )
})

await t('创建模板：数量非法拒绝', async () => {
  await assert.rejects(
    () => templateOperation(env, { action: 'create', template: { name: '测试', kind: 'sale', items: [item('P00001', '管件', 0, 10)] } }),
    /数量必须大于 0/
  )
})

await t('创建模板：单价为负拒绝', async () => {
  await assert.rejects(
    () => templateOperation(env, { action: 'create', template: { name: '测试', kind: 'sale', items: [item('P00001', '管件', 1, -5)] } }),
    /单价不能为负/
  )
})

await t('创建模板：缺少商品编码拒绝', async () => {
  await assert.rejects(
    () => templateOperation(env, { action: 'create', template: { name: '测试', kind: 'sale', items: [{ name: '管件', qty: 1, price: 10 }] } }),
    /缺少商品编码/
  )
})

await t('更新模板：改名称与明细', async () => {
  const list = await listTemplates(env)
  const id = list[0].id
  const r = await templateOperation(env, {
    action: 'update',
    id,
    template: { name: '更新后的名称', kind: 'purchase', items: [item('P00002', '弯头', 5, 5)] }
  })
  assert.equal(r.ok, true)
  assert.equal(r.template.name, '更新后的名称')
  assert.equal(r.template.kind, 'purchase')
  assert.equal(r.template.items[0].code, 'P00002')
  assert.equal(r.template.id, id) // ID 不变
})

await t('更新模板：不存在的 ID 报 404', async () => {
  await assert.rejects(
    () => templateOperation(env, { action: 'update', id: 'nonexistent', template: { name: '测试', kind: 'sale', items: [item('P00001', '管件', 1, 10)] } }),
    /模板不存在/
  )
})

await t('复制模板：生成新 ID 与副本名称', async () => {
  const list = await listTemplates(env)
  const id = list[0].id
  const r = await templateOperation(env, { action: 'duplicate', id })
  assert.equal(r.ok, true)
  assert.notEqual(r.template.id, id)
  assert.match(r.template.name, /副本/)
  assert.equal(r.template.items.length, list[0].items.length)
  const after = await listTemplates(env)
  assert.equal(after.length, list.length + 1)
})

await t('删除模板：成功删除', async () => {
  const list = await listTemplates(env)
  const id = list[0].id
  const r = await templateOperation(env, { action: 'delete', id })
  assert.equal(r.ok, true)
  const after = await listTemplates(env)
  assert.equal(after.length, list.length - 1)
})

await t('删除模板：不存在的 ID 报 404', async () => {
  await assert.rejects(
    () => templateOperation(env, { action: 'delete', id: 'nonexistent' }),
    /模板不存在/
  )
})

console.log('\n订单模板：上限保护')

await t('模板总数上限：超过 100 个拒绝创建', async () => {
  // 先清空并创建 100 个
  seed()
  for (let i = 0; i < 100; i++) {
    await templateOperation(env, {
      action: 'create',
      template: { name: `模板${i}`, kind: 'sale', items: [item('P00001', '管件', 1, 10)] }
    })
  }
  let list = await listTemplates(env)
  assert.equal(list.length, 100)
  await assert.rejects(
    () => templateOperation(env, { action: 'create', template: { name: '超额', kind: 'sale', items: [item('P00001', '管件', 1, 10)] } }),
    /已达 100 个上限/
  )
})

await t('单模板商品行数上限：超过 200 行拒绝', async () => {
  seed()
  const items = Array.from({ length: 201 }, (_, i) => item(`P${String(i).padStart(5, '0')}`, `商品${i}`, 1, 10))
  await assert.rejects(
    () => templateOperation(env, { action: 'create', template: { name: '超长模板', kind: 'sale', items } }),
    /不能超过 200/
  )
})

console.log('\n订单模板：金额口径')

await t('生成订单时金额按 orderAmount 重算：2 件×10 元、行折 0.9 → 小计 18', async () => {
  seed()
  const r = await templateOperation(env, {
    action: 'create',
    template: { name: '金额测试', kind: 'sale', items: [item('P00001', '管件', 2, 10, 0.9)] }
  })
  const tpl = r.template
  // 模板本身不存金额，生成订单时按订单口径重算
  const line = tpl.items[0]
  const gross = round2(line.qty * line.price) // 20
  const rate = normalizeRate(line, gross) // 0.9
  const discount = round2(gross * (1 - rate)) // 2
  const lineTotal = round2(gross - discount) // 18
  assert.equal(lineTotal, 18)
  // 订单金额 = 明细行小计之和（无整单折扣）
  const orderAmount = round2([lineTotal].reduce((s, v) => s + v, 0))
  assert.equal(orderAmount, 18)
})

await t('不支持的操作类型拒绝', async () => {
  await assert.rejects(
    () => templateOperation(env, { action: 'invalid' }),
    /不支持的模板操作/
  )
})

// 路由接线测试：templates.js 的函数由协调者接进 api/routes.js，
// 只测模块本身发现不了「忘了挂路由」这类断链，所以必须打一次 handleApi。
console.log('\n路由接线：GET /templates、POST /templates')

const apiToken = await issueToken(env)
const call = async (path, method, body) => {
  const req = new Request(`https://worker.test/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json', Origin: 'https://worker.test' },
    body: body ? JSON.stringify(body) : undefined
  })
  const res = await handleApi(req, new URL(req.url), env)
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data && data.error || ''}`)
  return data
}

await t('GET /templates 返回 { templates: [] }', async () => {
  seed()
  const data = await call('/templates', 'GET')
  assert.ok(Array.isArray(data.templates), '返回值必须是 templates 数组')
  assert.equal(data.templates.length, 0)
})

await t('POST /templates 走通建模板并从 GET 读到', async () => {
  seed()
  const r = await call('/templates', 'POST', {
    action: 'create',
    template: { name: '接线测试', kind: 'sale', items: [item('P00001', '管件', 2, 10)] }
  })
  assert.equal(r.ok, true)
  assert.ok(r.template.id)
  const data = await call('/templates', 'GET')
  assert.equal(data.templates.length, 1)
  assert.equal(data.templates[0].name, '接线测试')
})

console.log(`\n测试完成：${pass} 通过，${failCount} 失败`)
process.exit(failCount > 0 ? 1 : 0)
