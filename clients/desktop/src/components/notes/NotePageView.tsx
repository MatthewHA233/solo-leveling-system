// ══════════════════════════════════════════════
// 笔记 · 单页：顶条（路径 / 保存灯 / 收藏 / 更多）+ 封面 + 图标 + 标题 + 块编辑器
//   保存节奏：标题和正文改动攒 600ms 一起写；切页 / 卸载时立刻把没写的写掉（keepalive，页面走了请求也发完）
//   回收站里的页面只读展示，顶上给「恢复 / 彻底删除」
// ══════════════════════════════════════════════

import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, FileText, ImagePlus, Maximize2, MoreHorizontal, RotateCcw, Smile, Star, Trash2, Upload, X } from 'lucide-react'
import {
  fetchNotePage, updateNotePage, uploadNoteAsset,
  type NotePage, type NotePagePatch,
} from '../../lib/notes-api'
import Tooltip from '../Tooltip'
import EmojiPicker from './EmojiPicker'
import Floating from './Floating'
import NoteEditor from './editor/NoteEditor'
import type { NoteEditorInstance } from './editor/note-schema'
import { ancestorsOf, blocksToText, formatNoteTime, pageTitle } from './note-model'
import { openNotePage } from './notes-store'
import { COVER_PRESETS, coverBackground } from './note-visuals'
import PopMenu from './PopMenu'
import type { NoteTree } from './use-note-tree'

const SAVE_DELAY_MS = 600

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

const SAVE_LABEL: Record<SaveState, string> = {
  saved: '已保存',
  dirty: '未保存',
  saving: '保存中',
  error: '保存失败',
}

export interface NotePageViewProps {
  readonly pageId: string
  readonly tree: NoteTree
  /** 恢复 / 彻底删除回收站里的这一页（交给外面，好弹确认、刷新回收站） */
  readonly onRestore: (id: string) => void
  readonly onPurge: (id: string) => void
  readonly onTrash: (id: string) => void
  /** 在这一页里建了子页面：侧栏把这一页展开，好看到新页面 */
  readonly onRevealChildren: (id: string) => void
}

export default function NotePageView({ pageId, tree, onRestore, onPurge, onTrash, onRevealChildren }: NotePageViewProps) {
  const [page, setPage] = useState<NotePage | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [cover, setCover] = useState<string | null>(null)
  const [fullWidth, setFullWidth] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('saved')

  const editorRef = useRef<NoteEditorInstance | null>(null)
  const pendingRef = useRef<{ -readonly [K in keyof NotePagePatch]: NotePagePatch[K] }>({})
  const contentDirtyRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const treeRef = useRef(tree)
  useLayoutEffect(() => { treeRef.current = tree })

  useEffect(() => {
    let alive = true
    fetchNotePage(pageId)
      .then((p) => {
        if (!alive) return
        setPage(p)
        setTitle(p.title)
        setCover(p.cover)
        setFullWidth(p.fullWidth)
      })
      .catch((e: unknown) => { if (alive) setLoadError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [pageId])

  // 把攒着的改动写出去。leaving = 这一页要走了：'unmount' 切页（JS 还活着，普通请求照样发完，只是不再更新界面），
  // 'unload' 关窗（要 keepalive 才能发出去）
  const flush = useCallback((leaving: 'unmount' | 'unload' | null = null): Promise<void> => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const patch: NotePagePatch = { ...pendingRef.current }
    let withContent = patch
    if (contentDirtyRef.current && editorRef.current) {
      try {
        const blocks = editorRef.current.document
        withContent = { ...patch, content: blocks, contentText: blocksToText(blocks) }
        // 编辑器万一被重建（开发时热更新会这样），要从最新内容起步——
        // 退回进页时拿到的旧内容，下一次保存就会把正文冲掉
        setPage((p) => (p ? { ...p, content: blocks } : p))
      } catch (e) {
        console.error('[Notes] 读取编辑器内容失败', e)
      }
    }
    pendingRef.current = {}
    contentDirtyRef.current = false
    if (Object.keys(withContent).length === 0) return Promise.resolve()
    if (!leaving) setSaveState('saving')
    return updateNotePage(pageId, withContent, { keepalive: leaving === 'unload' })
      .then(() => {
        if (leaving) return
        setSaveState((s) => (s === 'saving' ? 'saved' : s))
        treeRef.current.patchLocal(pageId, { updatedAt: localNow() })
      })
      .catch((e: unknown) => {
        console.error('[Notes] 保存失败', e)
        if (leaving) return
        // 没写进去的放回去，下次改动或手动重试时一起再写
        pendingRef.current = { ...withContent, ...pendingRef.current }
        setSaveState('error')
      })
  }, [pageId])

  const schedule = useCallback(() => {
    setSaveState('dirty')
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => { void flush() }, SAVE_DELAY_MS)
  }, [flush])

  // 卸载（切页）时立刻存：放在 layout 清理里，赶在编辑器视图被拆掉之前读到正文
  useLayoutEffect(() => () => { void flush('unmount') }, [flush])

  // 关窗 / 刷新前也存一下
  useEffect(() => {
    const onUnload = () => { void flush('unload') }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [flush])

  const onEditorChange = useCallback(() => {
    contentDirtyRef.current = true
    schedule()
  }, [schedule])

  const onEditorReady = useCallback((ed: NoteEditorInstance | null) => {
    // 卸载时不清空：最后一次保存要读它（layout 清理比编辑器自己的清理早）
    if (ed) editorRef.current = ed
  }, [])

  const changeTitle = (v: string) => {
    setTitle(v)
    pendingRef.current.title = v
    tree.patchLocal(pageId, { title: v })
    schedule()
  }

  const focusEditorStart = () => {
    const ed = editorRef.current
    if (!ed) return
    const first = ed.document[0]
    if (first) ed.setTextCursorPosition(first, 'start')
    ed.focus()
  }

  const saveField = (patch: NotePagePatch) => {
    setSaveState('saving')
    updateNotePage(pageId, patch)
      .then(() => setSaveState('saved'))
      .catch((e: unknown) => {
        console.error('[Notes] 保存失败', e)
        setSaveState('error')
      })
  }

  const changeCover = (next: string | null) => {
    setCover(next)
    saveField({ cover: next ?? '' })
  }

  const toggleFullWidth = () => {
    const next = !fullWidth
    setFullWidth(next)
    saveField({ fullWidth: next })
  }

  const createChildPage = useCallback(async (init?: { title?: string; icon?: string }) => {
    const child = await treeRef.current.create(pageId, init)
    if (child) onRevealChildren(pageId)
    return child
  }, [pageId, onRevealChildren])

  if (loadError) {
    return <div className="nt-page-empty">这一页打不开：{loadError}</div>
  }
  if (!page) {
    return <div className="nt-page-empty">正在打开…</div>
  }

  const live = tree.index.byId.get(pageId)
  const trashed = page.deletedAt != null && !live
  const icon = live ? live.icon : page.icon
  const favorite = live?.favorite ?? false
  const crumbs = live ? ancestorsOf(pageId, tree.index.byId) : []
  const coverBg = coverBackground(cover)

  return (
    <div className="nt-page">
      <PageTopBar
        crumbs={crumbs.map((c) => ({ id: c.id, icon: c.icon, title: pageTitle(c) }))}
        current={{ icon, title: pageTitle({ title }) }}
        saveState={trashed ? null : saveState}
        editedAt={live?.updatedAt ?? page.updatedAt}
        favorite={favorite}
        fullWidth={fullWidth}
        trashed={trashed}
        onRetrySave={() => { contentDirtyRef.current = true; void flush() }}
        onToggleFavorite={() => { void tree.setFavorite(pageId, !favorite) }}
        onToggleFullWidth={toggleFullWidth}
        // 先把最后的改动写进去再删，不然删完再写会被后端拒（回收站里的页不能改）
        onTrash={() => { void flush().then(() => onTrash(pageId)) }}
      />

      {trashed && (
        <div className="nt-trash-banner">
          <Trash2 size={14} />
          <span>这一页在回收站里，只能看不能改。</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="ti-key nt-mini-key" onClick={() => onRestore(pageId)}>
            <RotateCcw size={12} />恢复
          </button>
          <button type="button" className="ti-key nt-mini-key" data-danger="1" onClick={() => onPurge(pageId)}>
            <X size={12} />彻底删除
          </button>
        </div>
      )}

      <div className="nt-page-scroll">
        {coverBg && (
          <CoverBand background={coverBg} readOnly={trashed} pageId={pageId} onChange={changeCover} />
        )}
        <div className="nt-page-column" data-full={fullWidth ? '1' : undefined}>
          <PageHeading
            pageId={pageId}
            icon={icon}
            hasCover={coverBg != null}
            title={title}
            readOnly={trashed}
            onIcon={(e) => { void tree.setIcon(pageId, e) }}
            onAddCover={() => changeCover(`preset:${COVER_PRESETS[Math.floor(Math.random() * COVER_PRESETS.length)].key}`)}
            onTitle={changeTitle}
            onTitleEnter={focusEditorStart}
          />
          <EditorBoundary>
            <NoteEditor
              key={pageId}
              pageId={pageId}
              initialContent={page.content}
              readOnly={trashed}
              onChange={onEditorChange}
              onReady={onEditorReady}
              onCreateChildPage={createChildPage}
              onError={tree.reportError}
            />
          </EditorBoundary>
        </div>
      </div>
    </div>
  )
}

function localNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ── 顶条 ──

function PageTopBar(props: {
  readonly crumbs: readonly { id: string; icon: string | null; title: string }[]
  readonly current: { icon: string | null; title: string }
  readonly saveState: SaveState | null
  readonly editedAt: string
  readonly favorite: boolean
  readonly fullWidth: boolean
  readonly trashed: boolean
  readonly onRetrySave: () => void
  readonly onToggleFavorite: () => void
  readonly onToggleFullWidth: () => void
  readonly onTrash: () => void
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  return (
    <div className="nt-topbar">
      <div className="nt-crumbs">
        {props.crumbs.map((c) => (
          <span key={c.id} className="nt-crumb-wrap">
            <button type="button" className="nt-crumb" onClick={() => openNotePage(c.id)}>
              <span className="nt-crumb-icon">{c.icon ?? <FileText size={12} />}</span>
              <span className="nt-crumb-title">{c.title}</span>
            </button>
            <ChevronRight size={12} className="nt-crumb-sep" />
          </span>
        ))}
        <span className="nt-crumb" data-current="1">
          <span className="nt-crumb-icon">{props.current.icon ?? <FileText size={12} />}</span>
          <span className="nt-crumb-title">{props.current.title}</span>
        </span>
      </div>

      {props.saveState && (
        <Tooltip content={props.saveState === 'error' ? '点一下重试' : `编辑于 ${formatNoteTime(props.editedAt)}`}>
          <button
            type="button"
            className="nt-save"
            data-state={props.saveState}
            onClick={props.saveState === 'error' ? props.onRetrySave : undefined}
          >
            <span className="nt-save-dot" />
            {SAVE_LABEL[props.saveState]}
          </button>
        </Tooltip>
      )}

      {!props.trashed && (
        <>
          <Tooltip content={props.favorite ? '取消收藏' : '收藏（出现在侧栏「收藏」里）'}>
            <button type="button" className="ti-key nt-icon-key" data-active={props.favorite ? '1' : undefined}
              onClick={props.onToggleFavorite} aria-label="收藏">
              <Star size={13} />
            </button>
          </Tooltip>
          <button type="button" className="ti-key nt-icon-key" aria-label="更多"
            onClick={(e) => { const el = e.currentTarget; setMenuAnchor((cur) => (cur ? null : el)) }}>
            <MoreHorizontal size={14} />
          </button>
          {menuAnchor && (
            <PopMenu
              anchor={menuAnchor}
              placement="bottom-end"
              onClose={() => setMenuAnchor(null)}
              items={[
                { key: 'full', label: '全宽显示', icon: Maximize2, checked: props.fullWidth, onSelect: props.onToggleFullWidth },
                'sep',
                { key: 'trash', label: '移到回收站', icon: Trash2, danger: true, onSelect: props.onTrash },
              ]}
            />
          )}
        </>
      )}
    </div>
  )
}

// ── 封面 ──

function CoverBand({ background, readOnly, pageId, onChange }: {
  readonly background: string
  readonly readOnly: boolean
  readonly pageId: string
  readonly onChange: (cover: string | null) => void
}) {
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null)
  return (
    <div className="nt-cover" style={{ background }}>
      {!readOnly && (
        <div className="nt-cover-actions">
          <button type="button" className="ti-key nt-mini-key"
            onClick={(e) => { const el = e.currentTarget; setPickerAnchor((cur) => (cur ? null : el)) }}>
            <ImagePlus size={12} />更换封面
          </button>
          <button type="button" className="ti-key nt-mini-key" onClick={() => onChange(null)}>
            <X size={12} />移除
          </button>
        </div>
      )}
      {pickerAnchor && (
        <CoverPicker anchor={pickerAnchor} pageId={pageId} onPick={onChange} onClose={() => setPickerAnchor(null)} />
      )}
    </div>
  )
}

function CoverPicker({ anchor, pageId, onPick, onClose }: {
  readonly anchor: HTMLElement
  readonly pageId: string
  readonly onPick: (cover: string) => void
  readonly onClose: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = async (file: File | undefined) => {
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const asset = await uploadNoteAsset(file, pageId)
      onPick(asset.url)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  return (
    <Floating anchor={anchor} onClose={onClose} placement="bottom-end" width={320} className="nt-cover-picker">
      <div className="nt-emoji-head">
        <span className="nt-float-title">封面</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="ti-key nt-mini-key" disabled={uploading} onClick={() => fileRef.current?.click()}>
          <Upload size={12} />{uploading ? '上传中…' : '上传图片'}
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void upload(e.target.files?.[0]) }} />
      </div>
      {error && <div className="nt-float-error">{error}</div>}
      <div className="nt-cover-grid">
        {COVER_PRESETS.map((p) => (
          <button key={p.key} type="button" className="nt-cover-swatch" style={{ background: p.css }}
            onClick={() => { onPick(`preset:${p.key}`); onClose() }}>
            <span>{p.label}</span>
          </button>
        ))}
      </div>
    </Floating>
  )
}

// ── 图标 + 标题 ──

function PageHeading({ pageId, icon, hasCover, title, readOnly, onIcon, onAddCover, onTitle, onTitleEnter }: {
  readonly pageId: string
  readonly icon: string | null
  readonly hasCover: boolean
  readonly title: string
  readonly readOnly: boolean
  readonly onIcon: (emoji: string | null) => void
  readonly onAddCover: () => void
  readonly onTitle: (v: string) => void
  readonly onTitleEnter: () => void
}) {
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const [picker, setPicker] = useState<HTMLElement | null>(null)

  // 标题框跟着内容长高（长标题换行）
  useLayoutEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [title])

  // 新建的空页面：直接把光标放进标题
  useEffect(() => {
    if (!readOnly && !title) titleRef.current?.focus()
    // 只在进页面时判断一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId])

  return (
    <div className="nt-heading" data-cover={hasCover ? '1' : undefined}>
      {icon && (
        <button type="button" className="nt-page-icon" disabled={readOnly}
          onClick={(e) => setPicker(e.currentTarget)}>
          {icon}
        </button>
      )}
      {!readOnly && (
        <div className="nt-heading-actions">
          {!icon && (
            <button type="button" className="nt-ghost-key" onClick={(e) => setPicker(e.currentTarget)}>
              <Smile size={13} />添加图标
            </button>
          )}
          {!hasCover && (
            <button type="button" className="nt-ghost-key" onClick={onAddCover}>
              <ImagePlus size={13} />添加封面
            </button>
          )}
        </div>
      )}
      <textarea
        ref={titleRef}
        className="nt-title"
        rows={1}
        value={title}
        placeholder="无标题"
        readOnly={readOnly}
        spellCheck={false}
        onChange={(e) => onTitle(e.target.value.replace(/\n/g, ''))}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault()
            onTitleEnter()
          }
        }}
      />
      {picker && (
        <EmojiPicker
          anchor={picker}
          onClose={() => setPicker(null)}
          onPick={(e) => onIcon(e)}
          onRemove={icon ? () => onIcon(null) : undefined}
        />
      )}
    </div>
  )
}

// ── 编辑器出错兜底：某页内容解析失败时别把整个笔记区带崩 ──

class EditorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }

  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) }
  }

  componentDidCatch(e: unknown) {
    console.error('[Notes] 编辑器出错', e)
  }

  render() {
    if (this.state.error) {
      return <div className="nt-page-empty" style={{ height: 'auto', padding: '24px 0' }}>这一页的内容读不出来：{this.state.error}</div>
    }
    return this.props.children
  }
}
