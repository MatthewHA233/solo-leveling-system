// ══════════════════════════════════════════════
// 想法沉淀（对应 desktop App.tsx handleSend 里的 Distill 段）：后台跑，不阻塞回复
//   绑定了语境卡（展开转录的那张）→ 锚定到语境卡 + 生成绑定语境的想法卡
//   没绑定（日常聊天）→ 生成独立想法卡
//
// 和桌面端的差异：写入走 anchor-outbox（桌面端不在线时暂存，连上后补发），不直写 API。
// 建卡、绑定、发 CONTEXT_UPDATED_EVENT 都在 outbox 里；这里只决定目标、提炼、出提示。
// 手机端还没有语境卡界面，activeContext / focusedCard / lastBiliContext 目前都是 null，
// 三级目标链先照搬，有界面后接上字段就能走。
// ══════════════════════════════════════════════

import { anchorToContext } from '../ai/anchor-to-context'
import { submitContextAnchor, submitDistilledThought } from '../ai/anchor-outbox'
import { distillThought } from '../ai/thought-distill'
import type { ActiveContext, ChatCore } from './chat-core'
import { fetchBiliTranscriptPlain } from './tools'

const OFFLINE_SUFFIX = '（桌面端不在线，已暂存，连上后自动写入）'

/** 拉转录失败等于没有这一级目标（桌面端读本地盘失败也是 null） */
function transcriptOf(refPath: string | null | undefined): Promise<string | null> {
  return fetchBiliTranscriptPlain(refPath).catch(() => null)
}

export async function runThoughtDistill(core: ChatCore, speech: string): Promise<void> {
  const active = core.activeContext
  const focused = core.focusedCard
  try {
    // 锚定目标三级链：展开转录 > 当前注视的 B 站卡 > 本会话最近注视过的 B 站卡。
    // 最后一级解决"聊着聊着切走了锁定但想法明明源于语境"的常见场景；
    // 误挂由锚定器的相关性闸门兜住（无关 → null → 回落独立沉淀）
    let target: ActiveContext | null = active
    if (!target && focused?.kind === 'bili_transcript') {
      const fullText = await transcriptOf(focused.refPath)
      if (fullText) {
        target = { cardId: focused.cardId, text: fullText, title: focused.title ?? '语境卡' }
      }
    }
    if (!target && core.lastBiliContext) {
      const last = core.lastBiliContext
      const fullText = await transcriptOf(last.refPath)
      if (fullText) {
        target = { cardId: last.cardId, text: fullText, title: last.title ?? '语境卡' }
      }
    }
    // 锚定器判"与语境无关/不值得"返回 null → 回落独立沉淀，想法不能丢
    const r = target ? await anchorToContext(target.text, speech) : null
    if (target && r) {
      const { delivered, highlighted } = await submitContextAnchor(target, r)
      const kw = r.anchors.map((a) => a.keyword).join('、')
      core.addSystemNote(
        `📍 已锚定到语境${highlighted ? '并高亮原文' : ''}：${r.thought.slice(0, 22)}${r.thought.length > 22 ? '…' : ''}${kw ? `（锚点：${kw}）` : ''}${delivered ? '' : OFFLINE_SUFFIX}`,
      )
    } else {
      const distilled = await distillThought(speech)
      if (!distilled) return
      const { delivered } = await submitDistilledThought(speech, distilled)
      const kw = distilled.anchors.map((a) => a.keyword).join('、')
      const preview = distilled.cardText.length > 24 ? distilled.cardText.slice(0, 24) + '…' : distilled.cardText
      core.addSystemNote(`📝 已记成想法卡：${preview}${kw ? `（锚点：${kw}）` : ''}${delivered ? '' : OFFLINE_SUFFIX}`)
    }
  } catch (e) {
    console.error('[Distill] 沉淀失败', e)
  }
}
