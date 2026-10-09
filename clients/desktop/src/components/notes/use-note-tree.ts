// 洪流域 · 笔记的页面树数据：全部页面元信息 + 增删改移。
// 和清单（use-checklist）同一个套路：改动先落本地状态（界面立刻有反应）再写后端；失败整表重拉，并把错误交给界面提示。

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createNotePage, fetchNotePages, moveNotePage, restoreNotePage, trashNotePage, updateNotePage,
  type NotePageMeta,
} from '../../lib/notes-api'
import { applyMove, indexPages, subtreeIds, type PageIndex } from './note-model'
import { publishNotePages } from './notes-store'

type LocalPatch = Partial<Pick<NotePageMeta, 'title' | 'icon' | 'favorite' | 'updatedAt'>>

export interface NoteTree {
  readonly pages: readonly NotePageMeta[]
  readonly index: PageIndex
  readonly loading: boolean
  readonly error: string | null
  readonly clearError: () => void
  /** 别处（编辑器的块菜单）出错也走同一条提示 */
  readonly reportError: (message: string) => void
  readonly reload: () => Promise<void>
  readonly create: (parentId: string | null, init?: { title?: string; icon?: string }) => Promise<NotePageMeta | null>
  /** 只改本地（页面里打标题时侧栏跟着变；真正保存由页面自己做） */
  readonly patchLocal: (id: string, patch: LocalPatch) => void
  readonly rename: (id: string, title: string) => Promise<void>
  readonly setIcon: (id: string, icon: string | null) => Promise<void>
  readonly setFavorite: (id: string, favorite: boolean) => Promise<void>
  readonly move: (id: string, parentId: string | null, index: number) => Promise<void>
  readonly trash: (id: string) => Promise<void>
  readonly restore: (id: string) => Promise<NotePageMeta | null>
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function useNoteTree(): NoteTree {
  const [pages, setPages] = useState<readonly NotePageMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const index = useMemo(() => indexPages(pages), [pages])

  // 编辑器里的链接块读这份快照拿标题 / 图标
  useEffect(() => { publishNotePages(pages) }, [pages])

  const reload = useCallback(async () => {
    try {
      setPages(await fetchNotePages())
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  // 写操作的统一收尾：失败记错误并整表重拉（本地乐观状态可能已经不对）
  const commit = useCallback(async (work: () => Promise<void>) => {
    try {
      await work()
    } catch (e) {
      setError(errorText(e))
      await reload()
    }
  }, [reload])

  const patchLocal = useCallback((id: string, patch: LocalPatch) => {
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }, [])

  const create = useCallback<NoteTree['create']>(async (parentId, init) => {
    try {
      const page = await createNotePage(parentId, init)
      setPages((prev) => [...prev, page])
      setError(null)
      return page
    } catch (e) {
      setError(errorText(e))
      return null
    }
  }, [])

  const rename = useCallback<NoteTree['rename']>(async (id, title) => {
    patchLocal(id, { title })
    await commit(() => updateNotePage(id, { title }))
  }, [commit, patchLocal])

  const setIcon = useCallback<NoteTree['setIcon']>(async (id, icon) => {
    patchLocal(id, { icon })
    await commit(() => updateNotePage(id, { icon: icon ?? '' }))
  }, [commit, patchLocal])

  const setFavorite = useCallback<NoteTree['setFavorite']>(async (id, favorite) => {
    patchLocal(id, { favorite })
    await commit(() => updateNotePage(id, { favorite }))
  }, [commit, patchLocal])

  const move = useCallback<NoteTree['move']>(async (id, parentId, at) => {
    setPages((prev) => applyMove(prev, id, parentId, at))
    await commit(() => moveNotePage(id, parentId, at))
  }, [commit])

  const trash = useCallback<NoteTree['trash']>(async (id) => {
    // 整棵子树一起进回收站：本地先拿掉
    setPages((prev) => {
      const doomed = subtreeIds(id, indexPages(prev))
      return prev.filter((p) => !doomed.has(p.id))
    })
    await commit(() => trashNotePage(id))
  }, [commit])

  const restore = useCallback<NoteTree['restore']>(async (id) => {
    try {
      const meta = await restoreNotePage(id)
      // 一起删的子页面也回来了：整表重拉最省心
      await reload()
      return meta
    } catch (e) {
      setError(errorText(e))
      return null
    }
  }, [reload])

  const clearError = useCallback(() => setError(null), [])
  const reportError = useCallback((message: string) => setError(message), [])

  return { pages, index, loading, error, clearError, reportError, reload, create, patchLocal, rename, setIcon, setFavorite, move, trash, restore }
}
