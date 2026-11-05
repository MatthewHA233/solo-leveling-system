// ══════════════════════════════════════════════
// 会话自动起标题的节奏（对齐 desktop src/lib/ai/session-title-flow.ts，
// 后者对齐 Claude Code bridge/initReplBridge.ts 的两步法）
//   · 主人第 1 句话：立刻截开头当临时标题（会话条不再停在「新会话」），同时让模型起正式标题替换
//   · 主人第 3 句话：拿整段对话再起一次，更准
//   · 数的是「主人说了几句」（没转写出文字的语音不算），不数消息条数——
//     消息条数会被工具消息、漏存的语音搅乱（Claude Code 的 REPL 也踩过这个坑，改成了标记）
//   · 主人手动改过名 / 点过重新生成：这个会话不再自动覆盖
//   · 晚回来的旧结果不覆盖新结果（第 1 句的结果比第 3 句晚到时直接丢弃）
// ══════════════════════════════════════════════

import type { AgentConfig } from '../agent/agent-config'
import { generateSessionTitle, type TitleMessage } from './session-title'

export const DEFAULT_SESSION_TITLE = '新会话'

/** 第几句时拿整段对话重起一次 */
const REFINE_AT = 3
/** 临时标题最长几个字 */
const PLACEHOLDER_MAX = 16

/** none = 还没起过；first = 起过第一次，等第 3 句重起；done = 不再自动起 */
type Stage = 'none' | 'first' | 'done'

export interface TitleFlowDeps {
  readonly getConfig: () => AgentConfig
  /** 当前会话已入库的消息（重起时连同刚说的这句一起送去） */
  readonly getMessages: () => readonly TitleMessage[]
  /** 显示 + 入库 */
  readonly apply: (sessionId: string, title: string) => void
}

export interface TitleFlow {
  /** 切到某个会话（启动恢复 / 切换 / 新建）；已有标题的会话视为起过了 */
  readonly reset: (sessionId: string | null, title: string, existingUserCount: number) => void
  /** 主人手动改名 / 重新生成过：这个会话不再自动覆盖 */
  readonly lock: (sessionId: string) => void
  /** 主人说了一句（打字发送，或语音转写定稿） */
  readonly onUserMessage: (text: string) => void
}

/** 临时标题：取第一句（到第一个标点为止），去掉开头的语气词，过长截断 */
export function derivePlaceholderTitle(text: string): string | null {
  // 先去掉开头的语气词（语音转写常见「嗯，……」），再取第一句
  const body = text.trim().replace(/^((嗯|呃|啊|哦|诶|欸|那个|就是)[，,。.、 ]*)+/, '')
  const firstClause = body.split(/[。！？!?.,，；;\n]/)[0] ?? ''
  const clean = firstClause.replace(/\s+/g, ' ').trim()
  if (!clean) return null
  return clean.length > PLACEHOLDER_MAX ? `${clean.slice(0, PLACEHOLDER_MAX - 1)}…` : clean
}

function userMessage(text: string): TitleMessage {
  return { role: 'user', content: text }
}

export function createTitleFlow(deps: TitleFlowDeps): TitleFlow {
  let sessionId: string | null = null
  let userCount = 0
  let stage: Stage = 'none'
  // 每次发起 / 切会话 / 上锁都 +1：只认最新一次的结果
  let seq = 0
  const locked = new Set<string>()

  const generate = (sid: string, messages: readonly TitleMessage[]) => {
    const mySeq = ++seq
    generateSessionTitle(messages, deps.getConfig())
      .then((title) => {
        if (!title || mySeq !== seq || sid !== sessionId || locked.has(sid)) return
        deps.apply(sid, title)
      })
      .catch(() => {})
  }

  return {
    reset(sid, title, existingUserCount) {
      sessionId = sid
      userCount = existingUserCount
      seq++
      const t = title.trim()
      stage = !t || t === DEFAULT_SESSION_TITLE ? 'none' : 'done'
    },

    lock(sid) {
      locked.add(sid)
      if (sid === sessionId) {
        stage = 'done'
        seq++
      }
    },

    onUserMessage(text) {
      const sid = sessionId
      const t = text.trim()
      if (!sid || !t || locked.has(sid) || stage === 'done') return
      userCount++
      const latest = userMessage(t)

      if (stage === 'none') {
        if (userCount === 1) {
          // 新会话第一句：先挂临时标题，再让模型只看这一句起正式标题
          const placeholder = derivePlaceholderTitle(t)
          if (placeholder) deps.apply(sid, placeholder)
          generate(sid, [latest])
          stage = 'first'
        } else {
          // 之前聊过但一直没起成标题的会话：直接拿整段对话起
          generate(sid, [...deps.getMessages(), latest])
          stage = userCount >= REFINE_AT ? 'done' : 'first'
        }
        return
      }

      if (stage === 'first' && userCount >= REFINE_AT) {
        generate(sid, [...deps.getMessages(), latest])
        stage = 'done'
      }
    },
  }
}
