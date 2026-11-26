// ══════════════════════════════════════════════
// 笔记页面信息的模块级快照 + 「打开某页」广播
//   编辑器里的自定义块（子页面链接、@页面）由 BlockNote 自己挂载，不保证在我们的 React 上下文里，
//   所以页面标题 / 图标走这份外部快照（useSyncExternalStore），跳页走 window 事件。
// ══════════════════════════════════════════════

import { useSyncExternalStore } from 'react'
import type { AnchorSentence, NotePageMeta } from '../../lib/notes-api'

let snapshot: ReadonlyMap<string, NotePageMeta> = new Map()
const listeners = new Set<() => void>()

export function publishNotePages(pages: readonly NotePageMeta[]): void {
  snapshot = new Map(pages.map((p) => [p.id, p]))
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useNotePagesMap(): ReadonlyMap<string, NotePageMeta> {
  return useSyncExternalStore(subscribe, () => snapshot)
}

export function getNotePagesMap(): ReadonlyMap<string, NotePageMeta> {
  return snapshot
}

// ── 把编辑器里正在拖的块丢到侧栏某个页面上 = 移到那一页 ──
//   侧栏收到落点后只知道目标页 id；拖的是哪些块、怎么搬，由当前打开的编辑器处理
type BlockDropHandler = (targetPageId: string) => void
let blockDropHandler: BlockDropHandler | null = null

export function setBlockDropHandler(handler: BlockDropHandler): () => void {
  blockDropHandler = handler
  return () => { if (blockDropHandler === handler) blockDropHandler = null }
}

export function dropDraggedBlocksOnPage(targetPageId: string): void {
  blockDropHandler?.(targetPageId)
}

/** 「打开某页」：笔记视图收到后切过去（编辑器里的链接块 / @页面 / 搜索结果都走这个）。
 *  带 blockId 就再跳到那一块（从引用、想法卡片点回原处用） */
export const NOTES_OPEN_EVENT = 'solevup:notes-open'

export function openNotePage(id: string, blockId?: string): void {
  window.dispatchEvent(new CustomEvent(NOTES_OPEN_EVENT, { detail: { id, blockId } }))
}

/** 语境页里点了某句转录前面的时间：页面收到后让播放器跳过去 */
export const NOTES_TRANSCRIPT_SEEK_EVENT = 'solevup:notes-transcript-seek'

/** 笔记里的索引数据（引用、批注、锚点句各版）刚变过：侧栏的锚点统计、想法卡片页收到后重拉 */
export const NOTES_INDEX_CHANGED_EVENT = 'solevup:notes-index-changed'

export function announceIndexChanged(): void {
  window.dispatchEvent(new CustomEvent(NOTES_INDEX_CHANGED_EVENT))
}

// ── 当前打开的锚点页里各条锚点句的信息（第几版、几处引用）──
//   锚点句块由编辑器自己挂载，和子页面链接一样读外部快照

interface SentenceSnapshot {
  readonly pageId: string
  readonly byBlock: ReadonlyMap<string, AnchorSentence>
}

let sentenceSnapshot: SentenceSnapshot = { pageId: '', byBlock: new Map() }
const sentenceListeners = new Set<() => void>()

export function publishAnchorSentences(pageId: string, sentences: readonly AnchorSentence[]): void {
  sentenceSnapshot = { pageId, byBlock: new Map(sentences.map((s) => [s.blockId, s])) }
  sentenceListeners.forEach((l) => l())
}

function subscribeSentences(listener: () => void): () => void {
  sentenceListeners.add(listener)
  return () => { sentenceListeners.delete(listener) }
}

export function useAnchorSentenceInfo(blockId: string): { pageId: string; info: AnchorSentence | undefined } {
  const snap = useSyncExternalStore(subscribeSentences, () => sentenceSnapshot)
  return { pageId: snap.pageId, info: snap.byBlock.get(blockId) }
}
