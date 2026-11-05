// ══════════════════════════════════════════════
// 一轮回复的 TTS 流式管线（对应 desktop App.tsx handleSend 里的 TtsState / pushToTts / 打断 / 收尾）
//
//   和 LLM 并行建连 → 流式文本按标点切句送 TTS → LLM 结束 flush → 等音频真正播完 → 取整段 WAV
//   主人一开口（按下说话）→ interrupt：停连接、停声、丢掉没播的
//
// 桌面端这些写在 App.tsx 里，靠 WebAudio 时间轴判断播完；手机端音频在 native 的 AudioTrack，
// 判断逻辑一样，只是把时间轴换成 getPlayback()。
// ══════════════════════════════════════════════

import { createFishTTS, type FishTTSClient, type FishTTSConfig } from './fish-tts'
import type { WavAudio } from './voice-native'

// 含逗号、分号、换行 → 长句中文用逗号断句也能边出边读，避免等到 LLM 结束才一次性 force-flush
const SENT_RE = /[。！？!?.…，,；;\n]+/
const MIN_SENTENCE_CHARS = 4
const CONNECT_POLL_MS = 50
const CONNECT_WAIT_MS = 5_000
const PLAYBACK_POLL_MS = 200
/** 音频已全部播完后再留的余量（桌面端 currentTime >= nextStartTime + 0.2） */
const PLAYBACK_TAIL_MS = 200
const PLAYBACK_TIMEOUT_MS = 60_000

export interface ReplyTts {
  /** 喂一段流式文本；凑够一句就送出去。force = 把缓冲区剩余文字全部送出 */
  readonly push: (chunk: string, force?: boolean) => void
  /** 打断：停连接、停声、丢掉没播的。可重复调用 */
  readonly interrupt: () => void
  /** LLM 结束后调用：flush 并等音频播完，返回整段音频（气泡回放 + 落盘）；没音频时返回 null */
  readonly finish: () => Promise<WavAudio | null>
  /** 这一轮没有要读的文字（回复为空 / 已被打断）：直接断开 */
  readonly abandon: () => void
}

let activeReply: ReplyTts | null = null

/** 打断正在播的回复（录音开始时调用；没有在播时是空操作） */
export function interruptReplyTts(): void {
  activeReply?.interrupt()
}

/** onConnectFailed：连不上 Fish（手机直连 api.fish.audio，网络不通时不告诉主人就是一直没声音） */
export function createReplyTts(config: FishTTSConfig, onConnectFailed?: (reason: string) => void): ReplyTts {
  let connected = false
  let finished = false
  let interrupted = false
  let pending: string[] = []
  let sentBuf = ''
  let finishResolve: (() => void) | null = null

  const client: FishTTSClient = createFishTTS(config, undefined, () => {
    finished = true
    finishResolve?.()
  })

  // 提前建连接（不 await，LLM 跑的同时握手）
  client.connect().then(() => {
    // 建连途中已被打断：stop 当时还没有连接可停，这里补上
    if (interrupted) {
      client.stop().catch(() => {})
      return
    }
    connected = true
    for (const s of pending) client.sendText(s).catch(() => {})
    pending = []
  }).catch((e) => {
    finished = true
    finishResolve?.()
    if (!interrupted) onConnectFailed?.(e instanceof Error ? e.message : String(e))
  })

  const push = (chunk: string, force = false) => {
    if (interrupted) return
    sentBuf += chunk
    if (!force && (!SENT_RE.test(sentBuf) || sentBuf.length < MIN_SENTENCE_CHARS)) return
    const sentence = sentBuf.trim()
    sentBuf = ''
    if (!sentence) return
    if (connected) {
      client.sendText(sentence).catch(() => {})
    } else {
      pending.push(sentence)
    }
  }

  const release = () => {
    if (activeReply === reply) activeReply = null
  }

  const interrupt = () => {
    if (interrupted) return
    interrupted = true
    pending = []
    sentBuf = ''
    client.stop().catch(() => {})
    finishResolve?.()
    release()
  }

  const waitConnected = () =>
    new Promise<void>((res) => {
      if (connected) { res(); return }
      const startedAt = Date.now()
      const poll = setInterval(() => {
        if (connected || finished || interrupted || Date.now() - startedAt >= CONNECT_WAIT_MS) {
          clearInterval(poll)
          res()
        }
      }, CONNECT_POLL_MS)
    })

  const waitPlayback = () =>
    new Promise<void>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | null = null
      let poll: ReturnType<typeof setInterval> | null = null
      const done = () => {
        if (timeout) clearTimeout(timeout)
        if (poll) clearInterval(poll)
        finishResolve = null
        resolve()
      }
      finishResolve = () => {
        // 连接结束后音频可能还在队列里播：有音频就继续等它播完，一块都没收到才提前结束
        // （桌面端 fish-tts-finish 会立刻收尾并关掉 AudioContext，把没播完的切掉）
        void client.getPlayback().then((st) => {
          if (!st?.hasAudio || interrupted) done()
        }).catch(done)
      }
      if (interrupted) { done(); return }
      timeout = setTimeout(done, PLAYBACK_TIMEOUT_MS)  // 60s 兜底
      poll = setInterval(() => {
        void client.getPlayback().then((st) => {
          // null = 这条连接已被新一轮顶替（顶替时旧连接不再发 finish），不用再等
          if (!st) { done(); return }
          // 收到首段音频前不要退出
          if (!st.hasAudio) {
            if (finished) done()
            return
          }
          if (st.drainedMs >= PLAYBACK_TAIL_MS) done()
        }).catch(done)
      }, PLAYBACK_POLL_MS)
      // 建连失败等情况在调用前就结束了：不等 fish-tts-finish 再来一次
      if (finished) finishResolve()
    })

  const finish = async (): Promise<WavAudio | null> => {
    try {
      if (!interrupted) {
        push('', true)  // flush 缓冲区剩余文字
        // 确保连接就绪后 flush
        await waitConnected()
        await client.flush().catch(() => {})
        await waitPlayback()
      }
      return await client.takeAudio().catch(() => null)
    } finally {
      // 桌面端这里只关 AudioContext，WS 一直留到服务端关闭；手机上主动断开，别攒着空闲连接
      client.stop().catch(() => {})
      release()
    }
  }

  const abandon = () => {
    interrupted = true
    client.stop().catch(() => {})
    release()
  }

  const reply: ReplyTts = { push, interrupt, finish, abandon }
  activeReply = reply
  return reply
}
