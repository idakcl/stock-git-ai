// 进程内滑动窗口限流：给「会花钱」的入口（AI-API）兜一道配额。
//
// 为什么是内存而不是 KV/DO：
//   本项目只绑了静态资源与 GitHub，没有 KV / Durable Object。限流是「防手滑、防失控脚本」的
//   软约束，不是计费口径：宁可漏算一点，也不能为了它新增一个有状态的付费组件。
//   代价必须说清：计数器活在单个 isolate 里，Cloudflare 多边缘节点各算各的，
//   所以真实上限 ≈ 配置值 × 同时在跑的节点数。真要严格配额，只能上 KV/DO。
//
// 两种口径配合使用：
//   · 按密钥（/分钟）：一把钥匙被脚本刷爆时只伤它自己，别的钥匙照常用；
//   · 全局（/分钟）：多签发几把钥匙也不能把免费子请求额度一口气烧完。
const buckets = new Map()
const MAX_BUCKETS = 5000      // 上限兜底：异常多的调用方不能把 isolate 内存撑爆

// 返回 { ok, remaining, retryAfter }。limit <= 0 视为不限流（显式关掉用）。
export function hit(id, limit, windowMs, now = Date.now()) {
  if (!(limit > 0)) return { ok: true, remaining: Infinity, retryAfter: 0 }
  let stamps = buckets.get(id)
  if (!stamps) {
    if (buckets.size >= MAX_BUCKETS) buckets.clear()
    stamps = []
    buckets.set(id, stamps)
  }
  // 窗口外的时间戳先丢掉：数组长度天然不会超过 limit（每次命中才 push 一条）
  const from = now - windowMs
  while (stamps.length && stamps[0] <= from) stamps.shift()
  if (stamps.length >= limit) {
    return { ok: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((stamps[0] + windowMs - now) / 1000)) }
  }
  stamps.push(now)
  return { ok: true, remaining: limit - stamps.length, retryAfter: 0 }
}

// 测试用：清空所有计数，避免用例之间互相污染
export function resetRateLimits() {
  buckets.clear()
}
