// ══════════════════════════════════════════════
// Stream<T>
// 精简移植自 Claude Code utils/stream.ts（原版约70行）
//
// 设计要点：
// 1. 单次消费（started flag，第二次 iterate 直接 throw）
// 2. 选择性履行背压（enqueue 时检查是否有 pending consumer）
// 3. 持久错误态（hasError 永久存储，后续 next() 都 reject）
// 4. cleanup callback（for-await break 时自动调用 returned()）
// ══════════════════════════════════════════════

export class Stream<T> implements AsyncIterator<T> {
  private readonly queue: T[] = []
  private readResolve?: (value: IteratorResult<T>) => void
  private readReject?: (error: unknown) => void
  private isDone = false
  private hasError: unknown = undefined
  private started = false

  constructor(private readonly returned?: () => void) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    if (this.started) {
      throw new Error('Stream can only be iterated once')
    }
    this.started = true
    return this as unknown as AsyncIterableIterator<T>
  }

  next(): Promise<IteratorResult<T, unknown>> {
    // 先消费队列中已有的数据
    if (this.queue.length > 0) {
      return Promise.resolve({ done: false, value: this.queue.shift()! })
    }
    // 已结束
    if (this.isDone) {
      return Promise.resolve({ done: true, value: undefined })
    }
    // 持久错误态：无论何时 next() 都 reject 同一个错误
    if (this.hasError !== undefined) {
      return Promise.reject(this.hasError)
    }
    // 没有数据、没有结束、没有错误 → 挂起等待
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.readResolve = resolve
      this.readReject = reject
    })
  }

  /**
   * 生产者推送数据。
   * 选择性履行：有 pending consumer → 直接 fulfill（零延迟）
   *             没有           → 入队（背压）
   */
  enqueue(value: T): void {
    if (this.readResolve) {
      const resolve = this.readResolve
      this.readResolve = undefined
      this.readReject = undefined
      resolve({ done: false, value })
    } else {
      this.queue.push(value)
    }
  }

  /**
   * 生产者宣告结束。
   * 如果有 pending consumer 直接 fulfill done。
   */
  done(): void {
    this.isDone = true
    if (this.readResolve) {
      const resolve = this.readResolve
      this.readResolve = undefined
      this.readReject = undefined
      resolve({ done: true, value: undefined })
    }
  }

  /**
   * 生产者报错。
   * 持久化到 hasError，同时立即 reject pending consumer。
   */
  error(error: unknown): void {
    this.hasError = error
    if (this.readReject) {
      const reject = this.readReject
      this.readResolve = undefined
      this.readReject = undefined
      reject(error)
    }
  }

  /**
   * for-await-of break 时 JS 引擎自动调用此方法。
   * 触发 returned() cleanup（如 AbortController.abort()）。
   */
  return(): Promise<IteratorResult<T, unknown>> {
    this.isDone = true
    this.returned?.()
    return Promise.resolve({ done: true, value: undefined })
  }
}
