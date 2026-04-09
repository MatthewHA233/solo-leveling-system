// ══════════════════════════════════════════════
// withRetry — 指数退避重试
// 精简移植自 Claude Code services/api/withRetry.ts
//
// 退避公式（精确）：
//   baseDelay = 500 * 2^(attempt-1)，上限 32000ms
//   jitter    = Math.random() * 0.25 * baseDelay   ← 0~+25%（不是±12.5%）
//   final     = baseDelay + jitter
//
// 熔断器：连续3次 429/503（服务过载）触发，直接抛出
// 重试条件：429 / 5xx / 408 / 409 / 网络错误
// 不重试：400 / 401 / 403（无效请求/认证失败，重试无意义）
// ══════════════════════════════════════════════

const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 32_000
const MAX_RETRIES = 4           // 比 Claude Code 的 10 保守，Qwen 更敏感
const MAX_OVERLOAD_RETRIES = 3  // 连续过载熔断（对应 Claude Code MAX_529_RETRIES = 3）

// ── 退避延迟计算 ──

export function getRetryDelay(attempt: number, retryAfterHeader?: string | null): number {
  // 尊重服务端的 Retry-After 头
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) return seconds * 1000
  }

  const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS)
  const jitter = Math.random() * 0.25 * baseDelay  // 0~+25%（单侧正向）
  return Math.round(baseDelay + jitter)
}

// ── 重试判断 ──

export interface RetryableError {
  status?: number
  message?: string
  retryAfter?: string | null  // Retry-After 响应头
  isNetworkError?: boolean
}

function isOverloadError(err: RetryableError): boolean {
  // 429 = 限流，503 = 服务不可用（Qwen 用这个表示过载）
  return err.status === 429 || err.status === 503
}

export function shouldRetry(err: RetryableError): boolean {
  if (err.isNetworkError) return true
  if (!err.status) return false

  // 请求超时/锁超时
  if (err.status === 408 || err.status === 409) return true

  // 限流/过载（熔断器在外层计数，这里返回 true）
  if (err.status === 429 || err.status === 503) return true

  // 服务端错误（5xx）
  if (err.status >= 500) return true

  // 400/401/403：参数错误/认证失败，重试没意义
  return false
}

// ── 核心：withRetry ──

/**
 * 带指数退避重试的函数包装器。
 *
 * @param fn - 每次尝试调用的函数，接受 attempt 序号（从1开始）
 * @param maxRetries - 最大重试次数（不含首次尝试）
 * @param signal - AbortSignal，取消时立即停止等待
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  maxRetries = MAX_RETRIES,
  signal?: AbortSignal,
): Promise<T> {
  let consecutiveOverloadErrors = 0

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await fn(attempt)
      consecutiveOverloadErrors = 0  // 成功后重置熔断计数
      return result
    } catch (err) {
      const retryable = toRetryableError(err)

      // 过载错误熔断器
      if (isOverloadError(retryable)) {
        consecutiveOverloadErrors++
        if (consecutiveOverloadErrors >= MAX_OVERLOAD_RETRIES) {
          throw new Error(
            `服务连续 ${MAX_OVERLOAD_RETRIES} 次过载（${retryable.status}），已停止重试`,
          )
        }
      } else {
        consecutiveOverloadErrors = 0
      }

      // 最后一次尝试失败，或不可重试的错误，直接抛出
      const isLastAttempt = attempt > maxRetries
      if (isLastAttempt || !shouldRetry(retryable)) {
        throw err
      }

      // 计算延迟并等待
      const delayMs = getRetryDelay(attempt, retryable.retryAfter)
      await sleep(delayMs, signal)
    }
  }

  // 不应到达这里（TypeScript exhaustion guard）
  throw new Error('withRetry: 超出最大重试次数')
}

// ── helpers ──

function toRetryableError(err: unknown): RetryableError {
  if (err instanceof Error) {
    // fetch 网络错误（连接失败、DNS 失败等）
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      return { isNetworkError: true, message: err.message }
    }
    // 格式化的 API 错误（由 queryModel 的 error chunk 转换而来）
    const match = err.message.match(/API 错误 (\d+):/)
    if (match) {
      return { status: parseInt(match[1], 10), message: err.message }
    }
  }
  return { message: String(err) }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}
