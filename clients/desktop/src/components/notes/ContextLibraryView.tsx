// ══════════════════════════════════════════════
// 语境库·B站：一张自动填的表，每一行是一个转录过的 B 站视频，点开是一页
//   每个来源以后各有一张自己的表（语境库·书籍、语境库·剪藏网页……），所以这里没有「来源」一列。
//   页面由后台自动生成（context-autofill.ts）：把转录按句子拼成段落放进去，
//   之后你在上面涂、批注、插 # 都留在这一页里。还没补到的那几行点开时当场生成。
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { fetchBiliTranscriptSentences } from '../../lib/bili-transcript'
import { fetchContextFeed, searchBiliHistory, type ContextFeedItem } from '../../lib/local-api'
import { ensureContextPage, fetchContextPages, type ContextPage } from '../../lib/notes-api'
import { transcriptToBlocks } from './context-blocks'
import { formatNoteTime } from './note-model'
import { NOTES_INDEX_CHANGED_EVENT, openNotePage } from './notes-store'
import { fillMissingContextPages, getAutofillProgress, subscribeAutofill } from './context-autofill'

// UP 主名：语境流里没有，按 BV 号去本地的 B 站历史里查，查过的记着
const upNames = new Map<string, string>()
async function loadUpNames(bvids: readonly string[]): Promise<void> {
  const todo = bvids.filter((b) => !upNames.has(b))
  const BATCH = 8
  for (let i = 0; i < todo.length; i += BATCH) {
    await Promise.all(todo.slice(i, i + BATCH).map(async (bvid) => {
      try {
        const hit = (await searchBiliHistory(bvid, 5)).find((h) => h.bvid === bvid)
        upNames.set(bvid, hit?.author_name ?? '')
      } catch { /* 这次没查到，下次打开再查 */ }
    }))
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface Row {
  readonly key: string
  readonly title: string
  readonly sourceId: string
  readonly time: string
  /** 已经生成的页面；还没点开过是 null */
  readonly page: ContextPage | null
  /** B 站视频的本地文件路径（生成页面时读转录用） */
  readonly refPath: string | null
}

export default function ContextLibraryView() {
  const [videos, setVideos] = useState<readonly ContextFeedItem[]>([])
  const [pages, setPages] = useState<readonly ContextPage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [upTick, setUpTick] = useState(0)

  const reload = useCallback(async () => {
    // 两路分开拉：视频列表拉不到（后端旧 / 没开）时，已经生成的页面照样能列出来
    const [feed, made] = await Promise.allSettled([fetchContextFeed(), fetchContextPages()])
    if (feed.status === 'fulfilled') setVideos(feed.value.filter((f) => f.kind === 'bili_transcript'))
    if (made.status === 'fulfilled') setPages(made.value)
    setError(
      feed.status === 'rejected' ? `读不到转录过的视频：${errorText(feed.reason)}`
        : made.status === 'rejected' ? `读不到已经生成的语境页：${errorText(made.reason)}`
          : null,
    )
    setLoading(false)
  }, [])

  useEffect(() => { void reload(); void fillMissingContextPages() }, [reload])

  const [filling, setFilling] = useState(getAutofillProgress)
  useEffect(() => subscribeAutofill(setFilling), [])

  useEffect(() => {
    const onChanged = () => { void reload() }
    window.addEventListener(NOTES_INDEX_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(NOTES_INDEX_CHANGED_EVENT, onChanged)
  }, [reload])

  useEffect(() => {
    let alive = true
    const bvids = videos.map((v) => v.bvid).filter((b): b is string => !!b)
    void loadUpNames(bvids).then(() => { if (alive) setUpTick((n) => n + 1) })
    return () => { alive = false }
  }, [videos])

  const rows = useMemo<Row[]>(() => {
    const bySource = new Map(pages.map((p) => [`${p.sourceKind}:${p.sourceId}`, p]))
    const out: Row[] = videos.map((v) => {
      const sourceId = v.bvid ?? v.id
      return {
        key: `bili:${sourceId}`,
        title: v.title ?? sourceId,
        sourceId,
        time: v.created_at.replace('T', ' ').slice(0, 19),
        page: bySource.get(`bili:${sourceId}`) ?? null,
        refPath: v.ref_path,
      }
    })
    // 已经生成了页面、但来源那边查不到了的（视频删了）：照样列着，页面还在
    const listed = new Set(out.map((r) => r.key))
    for (const p of pages) {
      const key = `${p.sourceKind}:${p.sourceId}`
      if (listed.has(key)) continue
      out.push({
        key,
        title: p.title || p.sourceId,
        sourceId: p.sourceId,
        time: p.createdAt,
        page: p,
        refPath: null,
      })
    }
    const q = query.trim().toLowerCase()
    return out
      .filter((r) => !q || r.title.toLowerCase().includes(q) || r.sourceId.toLowerCase().includes(q)
        || (upNames.get(r.sourceId) ?? '').toLowerCase().includes(q))
      .sort((a, b) => b.time.localeCompare(a.time))
    // upTick：UP 主名查回来以后重算一次（按 UP 主找要用）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos, pages, query, upTick])

  const open = async (row: Row) => {
    if (row.page) {
      openNotePage(row.page.id)
      return
    }
    setOpening(row.key)
    try {
      const sentences = await fetchBiliTranscriptSentences(row.refPath)
      if (!sentences) throw new Error('读不到这个视频的转录')
      const { blocks, text } = transcriptToBlocks(sentences)
      const page = await ensureContextPage({
        sourceKind: 'bili',
        sourceId: row.sourceId,
        title: row.title,
        icon: '🎬',
        content: blocks,
        contentText: text,
      })
      openNotePage(page.id)
    } catch (e) {
      setError(`打不开「${row.title}」：${errorText(e)}`)
    } finally {
      setOpening(null)
    }
  }

  const withThoughts = rows.filter((r) => (r.page?.thoughts ?? 0) > 0).length

  return (
    <div className="nt-library">
      <header className="nt-library-head">
        <div className="nt-thoughts-title">语境库·B站</div>
        <span className="nt-kind-note">
          {rows.length} 个语境 · {withThoughts} 个留过批注
          {filling.total > 0 ? ` · 正在自动生成页面 ${filling.done}/${filling.total}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <label className="nt-library-search">
          <Search size={13} />
          <input
            className="nt-inline-input"
            value={query}
            placeholder="按标题或 UP 主找"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </header>
      {error && <div className="nt-float-error">{error}</div>}
      <div className="nt-library-scroll">
        <table className="nt-table">
          <thead>
            <tr>
              <th>标题</th>
              <th style={{ width: 150 }}>UP 主</th>
              <th style={{ width: 132 }}>转录于</th>
              <th style={{ width: 70 }}>批注</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-busy={opening === row.key ? '1' : undefined} onClick={() => { void open(row) }}>
                <td className="nt-table-title">{row.title}</td>
                <td>{upNames.get(row.sourceId) ?? ''}</td>
                <td>{formatNoteTime(row.time)}</td>
                <td>{row.page && row.page.thoughts > 0 ? row.page.thoughts : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && (
          <div className="nt-thoughts-empty">
            {query.trim() ? '没有对得上的语境。' : '还没有语境。在 B 站历史里转录一个视频，它就会出现在这里。'}
          </div>
        )}
      </div>
    </div>
  )
}
