// 浏览器回归总入口：起 dev server → 逐个跑 tests/*browser-test.mjs → 汇总退出码。
//
// 为什么要这个脚本：这些用例验证的是「弹窗时序、按钮位置、肉眼看到的内容」，纯 Node 测不出来，
// 所以必须真的开一个 Chromium。CI 里跑一次，能把「界面改完没顺手修测试」挡在发版之前。
//
// 用法：
//   node tests/run-browser.mjs            # 本地 / CI 都可
//   PORT=5174 node tests/run-browser.mjs  # 端口被占用时换一个
//   SHARD_TOTAL=4 SHARD_INDEX=0 node tests/run-browser.mjs   # CI 分片：第 1/4 片
import { spawn, spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const port = Number(process.env.PORT || 5173)
const base = `http://127.0.0.1:${port}/`

const all = readdirSync(join(root, 'tests'))
  .filter(f => f.endsWith('browser-test.mjs'))
  .sort()
// 分片：CI 里 4 个 job 并行，避免 23 个套件串行把发版拖到半小时
const shardTotal = Math.max(1, Number(process.env.SHARD_TOTAL || 1))
const shardIndex = Math.max(0, Number(process.env.SHARD_INDEX || 0))
const files = shardTotal > 1 ? all.filter((_, i) => i % shardTotal === shardIndex) : all
if (!files.length) {
  console.error('没有找到浏览器用例')
  process.exit(1)
}

const server = spawn(join(root, 'node_modules', '.bin', 'vite'),
  ['--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] })

const stop = () => { try { server.kill('SIGTERM') } catch { /* 已退出 */ } }
process.on('exit', stop)
process.on('SIGINT', () => { stop(); process.exit(130) })

async function waitServer() {
  const started = Date.now()
  while (Date.now() - started < 60000) {
    try {
      const r = await fetch(base)
      if (r.ok) return
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`dev server 在 60 秒内没有就绪：${base}`)
}

await waitServer()
console.log(`dev server 就绪：${base}`)

const failed = []
for (const f of files) {
  console.log(`\n=== ${f}`)
  const r = spawnSync(process.execPath, [join(root, 'tests', f)], {
    cwd: root, stdio: 'inherit', timeout: 180000
  })
  if (r.status !== 0) failed.push(f)
}

stop()
if (failed.length) {
  console.error(`\n浏览器回归失败 ${failed.length} 个：\n  ${failed.join('\n  ')}`)
  process.exit(1)
}
console.log(`\n浏览器回归全部通过（${files.length} 个套件）`)
