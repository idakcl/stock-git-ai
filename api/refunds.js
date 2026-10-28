import { gh } from './github.js'
import { applyRefundOperation, backfillHistoricalRefunds } from '../src/utils/refunds.js'

const keys = ['items', 'suppliers', 'customers', 'purchases', 'sales', 'refunds', 'stock', 'logs']

// 固定提交快照读取；订单、库存、退款凭证在一个 Git commit 中发布，失败不重放。
export async function refundTransaction(env, input, derive, rebuildStock) {
  const branch = env.GITHUB_BRANCH || 'main'
  const ref = await gh(`/git/ref/heads/${encodeURIComponent(branch)}`, env)
  const parent = ref.object.sha
  const commit = await gh(`/git/commits/${parent}`, env)
  const state = {}
  await Promise.all(keys.map(async key => {
    let file
    try { file = await gh(`/contents/${key}.json?ref=${parent}`, env) }
    catch (e) {
      if (key === 'refunds' && /GitHub 404/.test(e.message)) { state[key] = []; return }
      throw e
    }
    if (!file.content && file.size > 0) file = await gh(`/git/blobs/${file.sha}`, env)
    if (!file.content) throw new Error(`${key}.json 内容为空，已中止`)
    state[key] = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0))))
    if (key !== 'stock' && !Array.isArray(state[key])) throw new Error(`${key}.json 格式错误`)
  }))
  const result = input.action === 'backfill' ? backfillHistoricalRefunds(state) : applyRefundOperation(state, input)
  if (result.duplicate) return { ok: true, code: result.code, duplicate: true }
  const next = result.state
  if (input.action !== 'backfill') {
    Object.assign(next, derive(next.items, next.suppliers, next.purchases, next.sales, next.customers))
    next.stock = rebuildStock(next.purchases, next.sales, next.items)
  }
  const tree = keys.filter(k => JSON.stringify(next[k]) !== JSON.stringify(state[k])).map(k => ({
    path: `${k}.json`, mode: '100644', type: 'blob', content: JSON.stringify(next[k], null, 2)
  }))
  if (!tree.length) return { ok: true, codes: result.codes || [], unchanged: true }
  const logs = [...state.logs, { time: new Date().toISOString(), source: 'refund', action: input.action, code: result.code, codes: result.codes }].slice(-200)
  tree.push({ path: 'logs.json', mode: '100644', type: 'blob', content: JSON.stringify(logs, null, 2) })
  const newTree = await gh('/git/trees', env, 'POST', { base_tree: commit.tree.sha, tree })
  const created = await gh('/git/commits', env, 'POST', {
    message: `refund: ${input.action} ${result.code || (result.codes || []).join(', ')}`,
    tree: newTree.sha, parents: [parent]
  })
  // force:false：其他写入先发布时拒绝本提交，不能把旧快照覆盖到新数据上。
  await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, env, 'PATCH', { sha: created.sha, force: false })
  return { ok: true, code: result.code, returnId: result.returnId, codes: result.codes, commit: created.sha }
}
