// ══════════════════════════════════════════════
// 语境页自动生成：转录过的视频，不用点开，后台一个个补成语境页
//   什么时候跑：笔记第一次加载、窗口回到前台、语境库打开或刷新时。同一时刻只跑一趟。
//   读不到转录的视频这次运行里不再试（重开应用会再试一次）。
//   B 站来的语境页用视频封面当页面封面；老页面没有封面的补一遍（只补一次，之后你拿掉就不再加回来）。
// ══════════════════════════════════════════════

import { fetchBiliTranscriptSentences } from '../../lib/bili-transcript'
import { fetchContextFeed } from '../../lib/local-api'
import { ensureContextPage, fetchContextPages, fetchNotePage, updateNotePage } from '../../lib/notes-api'
import { transcriptToBlocks } from './context-blocks'
import { announceIndexChanged } from './notes-store'

export interface AutofillProgress {
  /** 这一趟要补的总数；0 = 没在跑 */
  readonly total: number
  readonly done: number
}

/** B 站封面要经本地代理才显示得出来（直连会被防盗链拦） */
const biliCover = (url: string) => `http://localhost:39733/api/bilibili/cover?url=${encodeURIComponent(url)}`

const COVER_BACKFILL_KEY = 'solevup.notes.contextCoverBackfill.v1'

const IDLE: AutofillProgress = { total: 0, done: 0 }
let progress: AutofillProgress = IDLE
let running = false
const skipped = new Set<string>()
const listeners = new Set<(p: AutofillProgress) => void>()

function setProgress(next: AutofillProgress) {
  progress = next
  listeners.forEach((fn) => fn(next))
}

export function getAutofillProgress(): AutofillProgress {
  return progress
}

export function subscribeAutofill(fn: (p: AutofillProgress) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 把还没有语境页的转录视频补上。已经在跑就什么都不做 */
export async function fillMissingContextPages(): Promise<void> {
  if (running) return
  running = true
  try {
    const [feed, pages] = await Promise.all([fetchContextFeed(), fetchContextPages()])
    const have = new Set(pages.map((p) => `${p.sourceKind}:${p.sourceId}`))
    const todo = feed.filter((v) => {
      if (v.kind !== 'bili_transcript' || !v.ref_path) return false
      const sourceId = v.bvid ?? v.id
      return !have.has(`bili:${sourceId}`) && !skipped.has(sourceId)
    })
    await backfillCovers(feed, pages.filter((p) => p.sourceKind === 'bili'))
    if (todo.length === 0) return
    setProgress({ total: todo.length, done: 0 })
    let made = 0
    for (let i = 0; i < todo.length; i += 1) {
      const v = todo[i]
      const sourceId = v.bvid ?? v.id
      try {
        const sentences = await fetchBiliTranscriptSentences(v.ref_path)
        if (!sentences) {
          skipped.add(sourceId)
        } else {
          const { blocks, text } = transcriptToBlocks(sentences)
          const page = await ensureContextPage({
            sourceKind: 'bili',
            sourceId,
            title: v.title ?? sourceId,
            icon: '🎬',
            content: blocks,
            contentText: text,
          })
          if (v.cover_url) await updateNotePage(page.id, { cover: biliCover(v.cover_url) })
          made += 1
        }
      } catch (e) {
        skipped.add(sourceId)
        console.error('[语境页自动生成] 这个视频没补上', sourceId, e)
      }
      setProgress({ total: todo.length, done: i + 1 })
    }
    if (made > 0) announceIndexChanged()
  } catch (e) {
    console.error('[语境页自动生成] 这一趟没跑成', e)
  } finally {
    running = false
    setProgress(IDLE)
  }
}

/** 老的 B 站语境页补封面：只跑成功一次 */
async function backfillCovers(
  feed: readonly { kind: string; bvid: string | null; id: string; cover_url: string | null }[],
  pages: readonly { id: string; sourceId: string }[],
): Promise<void> {
  try {
    if (localStorage.getItem(COVER_BACKFILL_KEY)) return
  } catch { return }
  const coverOf = new Map(feed.filter((v) => v.kind === 'bili_transcript' && v.cover_url).map((v) => [v.bvid ?? v.id, v.cover_url as string]))
  let changed = 0
  for (const p of pages) {
    const url = coverOf.get(p.sourceId)
    if (!url) continue
    const full = await fetchNotePage(p.id)
    if (full.cover) continue
    await updateNotePage(p.id, { cover: biliCover(url) })
    changed += 1
  }
  try { localStorage.setItem(COVER_BACKFILL_KEY, '1') } catch { /* 存不下就下次再补一遍 */ }
  if (changed > 0) announceIndexChanged()
}
