// ══════════════════════════════════════════════
// 提示缓存断没断：读到的缓存量比上一次请求掉了一截，就在控制台留一行。desktop 与 mobile 两份逐字一致，改要两端一起改
// 照 Claude Code 的 services/api/promptCacheBreakDetection.ts：掉了 5% 以上、并且超过 2000 token 才算断。
//
// 只盯聊天这一条线（query-loop.ts 每次回复后调 noteCacheRead）。自己主动改历史的地方（压成摘要、清工具结果、丢旧图）
// 先调 expectCacheDrop 说明原因；没人说明又隔得很近，多半是服务端的原因，或者组请求体的代码把前缀改坏了。
// ══════════════════════════════════════════════

const MIN_CACHE_MISS_TOKENS = 2_000
const CACHE_TTL_MS = 60 * 60 * 1000

let previousRead: number | null = null
let previousAt = 0
let expected: string | null = null

/** 接下来读到的缓存量会掉，是我们自己改了历史 */
export function expectCacheDrop(reason: string): void {
  expected = reason
}

/** 换了会话：前缀整个不一样，重新记 */
export function resetCacheWatch(): void {
  previousRead = null
  expected = null
}

/**
 * 记一次请求读到的缓存量。断了返回原因（并在控制台留一行），没断返回 null。
 * 第一次请求没有可比的，不算
 */
export function noteCacheRead(cacheReadTokens: number, now = Date.now()): string | null {
  const before = previousRead
  const gap = now - previousAt
  const explained = expected
  previousRead = cacheReadTokens
  previousAt = now
  expected = null
  if (before === null) return null
  const drop = before - cacheReadTokens
  if (cacheReadTokens >= before * 0.95 || drop < MIN_CACHE_MISS_TOKENS) return null
  const reason = explained
    ?? (gap >= CACHE_TTL_MS ? '隔了一小时以上，缓存过期' : '历史没改、隔得也近：多半是服务端的原因，连着出现就查组请求体的代码')
  console.warn(`[缓存] 读到的缓存从 ${before} 掉到 ${cacheReadTokens}：${reason}`)
  return reason
}
