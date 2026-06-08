import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import html2canvas from 'html2canvas'
import TorrentScreen, { type TorrentScreenDevSource } from '../../../src/screens/TorrentScreen'

// ══════════════════════════════════════════════
// Solevup 对照工作台
//  左侧栏：视频对象（选视频 → ffmpeg 拆帧），切换当前视频
//  主区：当前视频的对照栏 —— 左帧选择器 + 右快照画廊
//  悬浮镜像：全局唯一的真实 TorrentScreen，在里面浏览，截快照存进对照栏
//  配置按视频分组持久化到 .cache/bench-config.json
// ══════════════════════════════════════════════

const API_BASE = import.meta.env.VITE_SOLEVUP_MIRROR_API_BASE || ''
const DEFAULT_PANEL_H = 760
const LS_SIDEBAR = 'solevup-bench-sidebar-collapsed'
const LS_MIRROR_POS = 'solevup-bench-mirror-pos'
const LS_MIRROR_MODE = 'solevup-bench-mirror-mode'
const LS_MIRROR_DOCK_H = 'solevup-bench-mirror-dock-h'
const DEFAULT_DOCK_H = 760
const MIN_H = 200
type MirrorMode = 'floating' | 'dock'

type VideoMeta = {
  id: string
  label: string
  startRealTs: string
  fps: number
  frameCount: number
  frames: { n: number; file: string }[]
}
type Snapshot = { id: string; url: string; ts: number }
type PanelStatus = 'ok' | 'error' | 'resolved'
// 纯多选：frameIdxs 选取的帧集（允许空）；activeFrame 浏览时看第几张；frameIdx 仅为读旧数据保留
type Panel = { id: string; frameIdxs?: number[]; activeFrame?: number; frameIdx?: number; snapshots: Snapshot[]; activeSnap?: number; height?: number; status?: PanelStatus; note?: string; resolvedSnapId?: string }
type Captures = { items: any[]; total: number; a11yOn: boolean }
type BenchConfig = { activeVideoId: string | null; panelsByVideo: Record<string, Panel[]> }

// ── 时间工具 ──
const pad = (n: number) => String(n).padStart(2, '0')
function frameRealTs(v: VideoMeta, n: number): string {
  if (!v.startRealTs) return ''
  const [h, m, s] = v.startRealTs.split(':').map(Number)
  const base = h * 3600 + m * 60 + s + Math.floor((n - 1) / (v.fps || 3))
  return `${pad(Math.floor(base / 3600) % 24)}:${pad(Math.floor(base / 60) % 60)}:${pad(base % 60)}`
}
const uid = () => Math.random().toString(36).slice(2, 9)

// ══════════════════════════════════════════════
// 左：帧选择器（视频已由当前对象锁定，这里只选帧）
// ══════════════════════════════════════════════
function FrameViewer({
  video,
  panel,
  onChange,
  onView,
}: {
  video: VideoMeta
  panel: Panel
  onChange: (p: Partial<Panel>) => void
  onView: (url: string) => void
}) {
  const frames = video.frames
  const [editing, setEditing] = useState(false)
  const [editPreview, setEditPreview] = useState<number | null>(null) // 编辑时仅浏览预览的帧（不影响选中）
  const thumbStep = Math.max(1, video.fps)
  // 编辑模式候选：全部帧稀疏（每秒一张），保留原始帧下标 i
  const allThumbs = useMemo(
    () => frames.map((f, i) => ({ ...f, i })).filter((_, i) => i % thumbStep === 0),
    [frames, thumbStep],
  )
  const stripRef = useRef<HTMLDivElement>(null)
  const editTargetRef = useRef<HTMLButtonElement>(null)
  // 进入编辑模式 → 缩略条立即横向定位到当前/最后选取的帧
  useEffect(() => {
    if (!editing) return
    const strip = stripRef.current, t = editTargetRef.current
    if (!strip || !t) return
    strip.scrollTo({ left: Math.max(0, t.offsetLeft - strip.clientWidth / 2 + t.clientWidth / 2), behavior: 'auto' })
  }, [editing])

  if (!frames.length) return <div className="frame-empty">该视频还没有帧</div>

  // 纯多选：frameIdxs 是唯一数据源（允许空数组=不选）；仅旧数据无 frameIdxs 时迁移一次 frameIdx
  const selected = (panel.frameIdxs ?? (panel.frameIdx != null ? [panel.frameIdx] : []))
    .filter((i) => i >= 0 && i < frames.length)
  const selSet = new Set(selected)
  const activeIdx = selected.length ? Math.min(panel.activeFrame ?? selected.length - 1, selected.length - 1) : -1
  const curFrame = activeIdx >= 0 ? frames[selected[activeIdx]] : null

  const toggleFrame = (i: number) => {
    const s = new Set(selected)
    s.has(i) ? s.delete(i) : s.add(i)
    onChange({ frameIdxs: [...s].sort((a, b) => a - b) })
  }
  const removeFrame = (fi: number) => {
    const s = selected.filter((x) => x !== fi)
    onChange({ frameIdxs: s, activeFrame: Math.max(0, Math.min(activeIdx, s.length - 1)) })
  }

  // 进入编辑要定位到的帧：当前查看帧；无则最后一个选取帧 → 找最接近的缩略图
  const targetFrameIdx = curFrame ? selected[activeIdx] : (selected.length ? selected[selected.length - 1] : 0)
  let editTargetThumbI = -1
  if (allThumbs.length) {
    let bestD = Infinity
    for (const t of allThumbs) { const d = Math.abs(t.i - targetFrameIdx); if (d < bestD) { bestD = d; editTargetThumbI = t.i } }
  }
  // 编辑时大图预览：默认最后选取帧，点缩略图改预览（不改选中）
  const previewIdx = editPreview ?? targetFrameIdx
  const stageFrame = editing ? frames[previewIdx] : curFrame

  return (
    <div className="frame-col">
      {/* stage：浏览=当前选取帧；编辑=预览帧（点缩略图切换，不改选中） */}
      <div
        className="stage"
        style={stageFrame ? { cursor: 'zoom-in' } : undefined}
        onClick={() => stageFrame && onView(`${API_BASE}/frames/${video.id}/${stageFrame.file}`)}
      >
        {stageFrame ? (
          <img className="stage-img" src={`${API_BASE}/frames/${video.id}/${stageFrame.file}`} alt={`frame ${stageFrame.n}`} />
        ) : (
          <div className="stage-hint">还没选帧 · 点右上「编辑」挑选</div>
        )}
      </div>

      <div className="col-overlay col-overlay-top">
        <div className="headline">
          {editing ? (
            <>
              <span className="headline-main">{stageFrame ? `预览 第 ${stageFrame.n} 帧` : '编辑'}<span className="sel-badge">已选 {selected.length} 帧</span></span>
              <span className="headline-sub">{stageFrame ? frameRealTs(video, stageFrame.n) : '点缩略图浏览，角标勾选'}</span>
            </>
          ) : curFrame ? (
            <>
              <span className="headline-main">第 {curFrame.n} 帧<span className="sel-badge">已选 {selected.length} 帧</span></span>
              <span className="headline-sub">第 {activeIdx + 1}/{selected.length} 张 · {frameRealTs(video, curFrame.n)}</span>
            </>
          ) : (
            <span className="headline-main">未选帧</span>
          )}
        </div>
        <button
          className={`multi-btn${editing ? ' multi-btn-on' : ''}`}
          onClick={() => { setEditing((e) => !e); setEditPreview(null) }}
        >
          {editing ? '完成' : '编辑'}
        </button>
      </div>

      {/* 底部横向缩略条：编辑=全部帧（放大 + 勾选，常显）；浏览=选取帧画廊（点切/移出，hover 浮现） */}
      <div className={`col-overlay col-overlay-bottom${editing ? '' : ' auto-hide'}`}>
        <div ref={stripRef} className={`thumb-strip${editing ? ' thumb-strip-lg' : ''}`}>
          {editing
            ? allThumbs.map((t) => (
                <button
                  key={t.n}
                  ref={t.i === editTargetThumbI ? editTargetRef : undefined}
                  className={`thumb${selSet.has(t.i) ? ' thumb-sel' : ''}${t.i === previewIdx ? ' thumb-preview' : ''}`}
                  onClick={() => setEditPreview(t.i)}
                  title={`${frameRealTs(video, t.n)} · 帧 ${t.n}`}
                >
                  <img src={`${API_BASE}/frames/${video.id}/${t.file}`} alt="" loading="lazy" />
                  <span className="thumb-cap">#{t.n}<br />{frameRealTs(video, t.n)}</span>
                  <span
                    className={`pick${selSet.has(t.i) ? ' pick-on' : ''}`}
                    title={selSet.has(t.i) ? '取消选取' : '选取此帧'}
                    onClick={(e) => { e.stopPropagation(); toggleFrame(t.i) }}
                  >
                    {selSet.has(t.i) ? '✓' : ''}
                  </span>
                </button>
              ))
            : selected.map((fi, k) => {
                const f = frames[fi]
                if (!f) return null
                return (
                  <div key={fi} className={`thumb snap-thumb${k === activeIdx ? ' thumb-active' : ''}`}>
                    <img src={`${API_BASE}/frames/${video.id}/${f.file}`} alt="" loading="lazy" onClick={() => onChange({ activeFrame: k })} />
                    <button className="snap-del" title="移出此帧" onClick={() => removeFrame(fi)}>×</button>
                  </div>
                )
              })}
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════
// 右：快照画廊（多张，从悬浮镜像截图存进来）
// ══════════════════════════════════════════════
function SnapGallery({
  panel,
  capturing,
  onCapture,
  onChange,
  onViewSnap,
}: {
  panel: Panel
  capturing: boolean
  onCapture: () => void
  onChange: (p: Partial<Panel>) => void
  onViewSnap: (url: string) => void
}) {
  const snaps = panel.snapshots || []
  const active = snaps.length ? Math.min(panel.activeSnap ?? snaps.length - 1, snaps.length - 1) : -1
  const current = active >= 0 ? snaps[active] : null

  const removeSnap = (id: string) =>
    onChange({ snapshots: snaps.filter((s) => s.id !== id) })

  return (
    <div className="snaps-col">
      <div className="stage stage-snap" onClick={() => current && onViewSnap(`${API_BASE}${current.url}`)}>
        {current ? (
          <img className="stage-img" src={`${API_BASE}${current.url}`} alt="snapshot" />
        ) : (
          <div className="stage-hint">在右下悬浮镜像里浏览到目标画面<br />点右上「截取镜像」存进这里</div>
        )}
      </div>

      <div className="col-overlay col-overlay-top">
        <div className="headline">
          <span className="headline-main">快照</span>
          <span className="headline-sub">{snaps.length ? `${active + 1}/${snaps.length} 张` : '尚无'}</span>
        </div>
        {panel.status === 'error' && current && (
          <button
            className="resolve-btn"
            title="把当前这张快照设为「验证已解决」镜像，对照转为已解决"
            onClick={() => onChange({ status: 'resolved', resolvedSnapId: current.id })}
          >标记已解决</button>
        )}
        <button className="capture-btn" onClick={onCapture} disabled={capturing}>
          {capturing ? '截取中…' : '截取镜像'}
        </button>
      </div>

      <div className="col-overlay col-overlay-bottom auto-hide">
        <div className="thumb-strip">
          {snaps.map((s, i) => (
            <div key={s.id} className={`thumb snap-thumb${i === active ? ' thumb-active' : ''}${s.id === panel.resolvedSnapId ? ' snap-resolved' : ''}`}>
              <img src={`${API_BASE}${s.url}`} alt="" onClick={() => onChange({ activeSnap: i })} />
              <button className="snap-del" title="删除这张" onClick={() => removeSnap(s.id)}>×</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════
// 高度控制：直接填数值 + 复位（对照栏 / dock 镜像复用）
// ══════════════════════════════════════════════
function HeightControl({ value, def, onChange }: { value: number; def: number; onChange: (h: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (raw?: number) => {
    const n = Math.max(MIN_H, Math.round(raw ?? (Number(draft) || def)))
    onChange(n)
    setDraft(String(n))
  }
  const bump = (d: number) => commit(value + d)
  return (
    <span className="height-ctl">
      <span className="num-field">
        <input
          className="num-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            else if (e.key === 'ArrowUp') { e.preventDefault(); bump(10) }
            else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-10) }
          }}
        />
        <span className="num-spin">
          <button className="num-step" tabIndex={-1} title="+10" onClick={() => bump(10)}>+</button>
          <button className="num-step" tabIndex={-1} title="-10" onClick={() => bump(-10)}>−</button>
        </span>
      </span>
      <span className="height-unit">px</span>
      <button className="text-btn" title="恢复默认高度" disabled={value === def} onClick={() => onChange(def)}>复位</button>
    </span>
  )
}

// ══════════════════════════════════════════════
// 单个对照栏
// ══════════════════════════════════════════════
function ComparePanel({
  index,
  panel,
  video,
  capturing,
  onCapture,
  onChange,
  onRemove,
  onViewSnap,
}: {
  index: number
  panel: Panel
  video: VideoMeta
  capturing: boolean
  onCapture: () => void
  onChange: (p: Partial<Panel>) => void
  onRemove: () => void
  onViewSnap: (url: string) => void
}) {
  const height = panel.height || DEFAULT_PANEL_H
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const onMove = (ev: MouseEvent) =>
      onChange({ height: Math.max(380, Math.round(startH + (ev.clientY - startY))) })
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'ns-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const status = panel.status
  return (
    <section className={`panel${status === 'error' ? ' panel-error' : status === 'resolved' ? ' panel-resolved' : ''}`} style={{ height }}>
      <div className="panel-head">
        <span className="panel-no">对照 #{index + 1}</span>
        <span className="status-pills">
          <button
            className={`pill${status === 'ok' ? ' pill-ok-on' : ''}`}
            onClick={() => onChange({ status: status === 'ok' ? undefined : 'ok' })}
          >正常</button>
          <button
            className={`pill${status === 'error' ? ' pill-err-on' : ''}`}
            onClick={() => onChange({ status: status === 'error' ? undefined : 'error' })}
          >错误</button>
          {status === 'resolved' && (
            <button
              className="pill pill-resolved-on"
              title="重新打开为错误"
              onClick={() => onChange({ status: 'error' })}
            >已解决 ✓</button>
          )}
        </span>
        <span className="panel-spacer" />
        <HeightControl value={height} def={DEFAULT_PANEL_H} onChange={(h) => onChange({ height: h })} />
        <button className="text-btn text-btn-danger" title="删除此栏" onClick={onRemove}>删除</button>
      </div>
      {(status === 'error' || status === 'resolved') && (
        <div className="note-row">
          <input
            className="note-input"
            placeholder="错误原因 / 批注…（AI 可读）"
            value={panel.note || ''}
            onChange={(e) => onChange({ note: e.target.value })}
          />
        </div>
      )}
      <div className="panel-body">
        <FrameViewer video={video} panel={panel} onChange={onChange} onView={onViewSnap} />
        <SnapGallery
          panel={panel}
          capturing={capturing}
          onCapture={onCapture}
          onChange={onChange}
          onViewSnap={onViewSnap}
        />
      </div>
      <div className="panel-resize" onMouseDown={startResize} title="拖拽调整高度" />
    </section>
  )
}

// ══════════════════════════════════════════════
// 悬浮镜像（全局唯一真实 TorrentScreen，可拖动）
// ══════════════════════════════════════════════
function FloatingMirror({
  devSource,
  remountKey,
  phoneRef,
  mode,
  onToggleMode,
}: {
  devSource: TorrentScreenDevSource
  remountKey: string
  phoneRef: React.RefObject<HTMLDivElement | null>
  mode: MirrorMode
  onToggleMode: () => void
}) {
  const [searchText, setSearchText] = useState('')
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const raw = localStorage.getItem(LS_MIRROR_POS)
      if (raw) return JSON.parse(raw)
    } catch {}
    return { x: Math.max(20, window.innerWidth - 430), y: 88 }
  })
  const [collapsed, setCollapsed] = useState(false)
  const [dockHeight, setDockHeight] = useState<number>(() => Number(localStorage.getItem(LS_MIRROR_DOCK_H)) || DEFAULT_DOCK_H)
  useEffect(() => { localStorage.setItem(LS_MIRROR_DOCK_H, String(dockHeight)) }, [dockHeight])
  const isFloat = mode === 'floating'

  const startDrag = (e: React.MouseEvent) => {
    if (!isFloat) return // 第三栏模式不可拖
    e.preventDefault()
    const offX = e.clientX - pos.x
    const offY = e.clientY - pos.y
    const onMove = (ev: MouseEvent) => {
      const x = Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - offX))
      const y = Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - offY))
      setPos({ x, y })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setPos((p) => { localStorage.setItem(LS_MIRROR_POS, JSON.stringify(p)); return p })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const bodyHidden = isFloat && collapsed
  return (
    <div
      className={`floating-mirror mode-${mode}${isFloat && collapsed ? ' collapsed' : ''}`}
      style={isFloat ? { left: pos.x, top: pos.y } : undefined}
    >
      <div className="fm-bar" onMouseDown={startDrag}>
        {isFloat && <span className="fm-grip" />}
        <span className="fm-title">{isFloat ? '悬浮镜像' : '镜像 · 第三栏'}</span>
        <span className="panel-spacer" />
        {!isFloat && (
          <span onMouseDown={(e) => e.stopPropagation()}>
            <HeightControl value={dockHeight} def={DEFAULT_DOCK_H} onChange={setDockHeight} />
          </span>
        )}
        <button className="text-btn" onMouseDown={(e) => e.stopPropagation()} onClick={onToggleMode}>
          {isFloat ? '停靠为第三栏' : '重新悬浮'}
        </button>
        {isFloat && (
          <button className="text-btn" onMouseDown={(e) => e.stopPropagation()} onClick={() => setCollapsed((c) => !c)}>
            {collapsed ? '展开' : '收起'}
          </button>
        )}
      </div>
      {/* phone-frame 始终挂载（保证随时可截图）；悬浮收起时仅视觉隐藏 */}
      <div className="fm-body" style={bodyHidden ? { display: 'none' } : undefined}>
        <div className="fm-search">
          <input
            className="search-input"
            placeholder="搜动作 / 卡片文本…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          {searchText ? <button className="search-clear" onClick={() => setSearchText('')}>×</button> : null}
        </div>
        <div className="phone-frame" ref={phoneRef} style={!isFloat ? { height: dockHeight } : undefined}>
          <TorrentScreen key={remountKey} devSource={devSource} searchText={searchText} />
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════
// 大图查看
// ══════════════════════════════════════════════
function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div className="lightbox" onClick={onClose}>
      <img src={url} alt="snapshot" onClick={(e) => e.stopPropagation()} />
    </div>
  )
}

// ══════════════════════════════════════════════
// 工作台
// ══════════════════════════════════════════════
function App() {
  const [videos, setVideos] = useState<VideoMeta[]>([])
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null)
  // 配置只以服务端 .cache/bench-config.json 为权威：截图 dataUrl 太大，localStorage 会超 5MB
  // 上限抛错，曾导致用旧少量数据覆盖服务端。这里初始空，等服务端加载后才允许写回。
  const [panelsByVideo, setPanelsByVideo] = useState<Record<string, Panel[]>>({})
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(LS_SIDEBAR) === '1')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [mirrorMode, setMirrorMode] = useState<MirrorMode>(() => (localStorage.getItem(LS_MIRROR_MODE) as MirrorMode) || 'floating')
  const [syncing, setSyncing] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [capturingId, setCapturingId] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [syncVersion, setSyncVersion] = useState(0)
  const [status, setStatus] = useState<{ rowCount?: number; adbSerial?: string; lastError?: string }>({})
  const capturesRef = useRef<Captures>({ items: [], total: 0, a11yOn: true })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const phoneRef = useRef<HTMLDivElement | null>(null)
  const configLoadedRef = useRef(false) // 服务端配置加载完成前，禁止写回（防止空/旧值覆盖）

  const activeVideo = videos.find((v) => v.id === activeVideoId) || null
  const panels = (activeVideoId && panelsByVideo[activeVideoId]) || []
  const errorCount = panels.filter((p) => p.status === 'error').length

  // 持久化：仅写服务端 json（debounce）。加载完成前不写，杜绝首挂载用空值覆盖。
  useEffect(() => {
    if (!configLoadedRef.current) return
    const cfg: BenchConfig = { activeVideoId, panelsByVideo }
    const t = setTimeout(() => {
      fetch(`${API_BASE}/api/bench-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cfg),
      }).catch(() => {})
    }, 500)
    return () => clearTimeout(t)
  }, [activeVideoId, panelsByVideo])

  // 启动从服务端读（唯一权威）；读完才解锁持久化
  useEffect(() => {
    fetch(`${API_BASE}/api/bench-config`).then((r) => r.json()).then((d: Partial<BenchConfig>) => {
      if (d.panelsByVideo && typeof d.panelsByVideo === 'object') setPanelsByVideo(d.panelsByVideo)
      if (d.activeVideoId) setActiveVideoId(d.activeVideoId)
    }).catch(() => {}).finally(() => { configLoadedRef.current = true })
  }, [])

  const loadVideos = () =>
    fetch(`${API_BASE}/api/videos`).then((r) => r.json()).then((d) => {
      const vs: VideoMeta[] = d.videos || []
      setVideos(vs)
      return vs
    })

  useEffect(() => {
    loadVideos().then((vs) => setActiveVideoId((prev) => prev || vs[0]?.id || null)).catch(() => {})
  }, [])

  // sync = 从手机拉最新 db；失败（手机没连）不阻断，照常用 .cache 里缓存的 db 读 captures
  async function doSync() {
    setSyncing(true)
    try { await fetch(`${API_BASE}/api/sync`, { method: 'POST' }) } catch {}
    try {
      const r = await fetch(`${API_BASE}/api/captures?limit=50000`, { cache: 'no-store' }).then((x) => x.json())
      capturesRef.current = { items: r.rows || [], total: r.status?.rowCount ?? (r.rows?.length || 0), a11yOn: true }
      setStatus({ rowCount: r.status?.rowCount, adbSerial: r.status?.adbSerial, lastError: r.status?.lastError })
      setSyncVersion((v) => v + 1)
    } catch (e) {
      setStatus((s) => ({ ...s, lastError: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSyncing(false)
    }
  }
  // 启动：直接读缓存 db 出数据（不强制拉手机）；想要手机最新数据时手动点「同步 DB」
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/captures?limit=50000`, { cache: 'no-store' }).then((x) => x.json())
        capturesRef.current = { items: r.rows || [], total: r.status?.rowCount ?? (r.rows?.length || 0), a11yOn: true }
        setStatus({ rowCount: r.status?.rowCount, adbSerial: r.status?.adbSerial, lastError: r.status?.lastError })
        setSyncVersion((v) => v + 1)
      } catch {
        // 缓存 db 都没有时，才尝试拉手机
        doSync()
      }
    })()
  }, [])

  const devSource = useMemo<TorrentScreenDevSource>(() => ({
    load: async () => capturesRef.current,
    loadAppMonitor: async (startMs, endMs) => {
      const qs = `startMs=${Math.round(startMs)}&endMs=${Math.round(endMs)}`
      const segRes = await fetch(`${API_BASE}/api/app-monitor-segments?${qs}&limit=100000`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ rows: [] }))
      if (segRes.rows?.length) return { segments: segRes.rows }
      const [windowRes, powerRes] = await Promise.all([
        fetch(`${API_BASE}/api/window-events?${qs}&limit=5000`, { cache: 'no-store' }).then((r) => r.json()),
        fetch(`${API_BASE}/api/power-events?${qs}&limit=2000`, { cache: 'no-store' }).then((r) => r.json()),
      ])
      return {
        events: windowRes.rows || [],
        powerEvents: powerRes.rows || [],
      }
    },
    clear: async () => {},
    clearLabel: '刷新',
    openAccessibilitySettings: () => {},
  }), [])

  const setActivePanels = (updater: (ps: Panel[]) => Panel[]) => {
    if (!activeVideoId) return
    setPanelsByVideo((m) => ({ ...m, [activeVideoId]: updater(m[activeVideoId] || []) }))
  }
  const updatePanel = (id: string, patch: Partial<Panel>) =>
    setActivePanels((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  const removePanel = (id: string) => setActivePanels((ps) => ps.filter((p) => p.id !== id))
  const addPanel = () => setActivePanels((ps) => {
    const maxIdx = (activeVideo?.frames.length ?? 1) - 1
    const step = Math.max(1, activeVideo?.fps ?? 3) // 缩略卡片间隔（每秒一张）
    const last = ps[ps.length - 1]
    // 默认接前一栏「最后一个选取帧」的下一张卡片（= 下一个缩略，+step 帧，不是物理下一帧）
    const lastSel = last?.frameIdxs?.length ? last.frameIdxs[last.frameIdxs.length - 1] : (last?.frameIdx ?? -1)
    const nextIdx = last ? Math.min((Math.floor(lastSel / step) + 1) * step, maxIdx) : 0
    return [...ps, { id: uid(), frameIdxs: [nextIdx], snapshots: [], height: DEFAULT_PANEL_H }]
  })

  // 截取悬浮镜像 → dataURL → 追加进指定对照栏
  const captureToPanel = async (panelId: string) => {
    const el = phoneRef.current
    if (!el) { alert('悬浮镜像未就绪（若已收起请先展开）'); return }
    setCapturingId(panelId)
    try {
      const canvas = await html2canvas(el, { backgroundColor: '#f5f6f8', scale: 1, logging: false, useCORS: true })
      // 截图存独立文件，json 只记 url 引用（绝不把大 base64 塞进配置）
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
      if (!blob) throw new Error('canvas 转 blob 失败')
      const res = await fetch(`${API_BASE}/api/snapshot`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob })
      const d = await res.json()
      if (!res.ok || !d.url) throw new Error(d.error || '上传截图失败')
      setActivePanels((ps) => ps.map((p) => {
        if (p.id !== panelId) return p
        const snaps = [...(p.snapshots || []), { id: d.id || uid(), url: d.url, ts: Date.now() }]
        return { ...p, snapshots: snaps, activeSnap: snaps.length - 1 }
      }))
    } catch (e) {
      alert(`截图失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCapturingId(null)
    }
  }

  const onPickVideo = () => fileInputRef.current?.click()
  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setExtracting(true)
    try {
      const res = await fetch(`${API_BASE}/api/extract?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || '拆帧失败')
      await loadVideos()
      if (d.videoId) setActiveVideoId(d.videoId)
    } catch (err) {
      alert(`新建视频对象失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setExtracting(false)
    }
  }

  const toggleSidebar = () => setSidebarCollapsed((c) => {
    const next = !c
    localStorage.setItem(LS_SIDEBAR, next ? '1' : '0')
    return next
  })
  const toggleMirrorMode = () => setMirrorMode((m) => {
    const next: MirrorMode = m === 'floating' ? 'dock' : 'floating'
    localStorage.setItem(LS_MIRROR_MODE, next)
    return next
  })

  const synced = syncVersion > 0

  return (
    <div className="bench">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          Solevup 对照工作台
        </div>
        <div className="status">
          <span className={status.adbSerial ? 'dot dot-ok' : 'dot dot-warn'} />
          <span className="status-text">{status.adbSerial || '未连接'}</span>
          {synced && <span className="status-rows">{status.rowCount ?? capturesRef.current.total} 条</span>}
          {status.lastError && <span className="status-err" title={status.lastError}>同步异常</span>}
        </div>
        <div className="top-actions">
          <button
            className={`btn${errorsOnly ? ' btn-toggle-on' : ''}`}
            onClick={() => setErrorsOnly((v) => !v)}
            disabled={!activeVideo}
            title="只看标记为错误的对照"
          >
            {errorsOnly ? '仅错误 ✓' : '仅错误'}{errorCount ? ` (${errorCount})` : ''}
          </button>
          <button className="btn" onClick={doSync} disabled={syncing}>{syncing ? '同步中…' : '同步 DB'}</button>
          <button className="btn btn-primary" onClick={addPanel} disabled={!activeVideo}>新建对照</button>
        </div>
      </header>

      <div className="bench-body">
        <aside className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
          <div className="sidebar-head">
            {!sidebarCollapsed && <div className="sidebar-title">视频对象</div>}
            <button className="text-btn" onClick={toggleSidebar} title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}>
              {sidebarCollapsed ? '»' : '«'}
            </button>
          </div>

          {sidebarCollapsed ? (
            <div className="video-rail">
              {videos.map((v, i) => (
                <button
                  key={v.id}
                  className={`rail-item${v.id === activeVideoId ? ' active' : ''}`}
                  onClick={() => setActiveVideoId(v.id)}
                  title={`${v.label}（${v.frameCount} 帧）`}
                >
                  {i + 1}
                </button>
              ))}
              <button className="rail-item rail-add" onClick={onPickVideo} disabled={extracting} title="新建视频对象">
                {extracting ? '…' : '+'}
              </button>
            </div>
          ) : (
            <>
              <div className="video-list">
                {videos.length === 0 && <div className="video-empty">还没有视频对象<br />点下方「新建」选一个录屏</div>}
                {videos.map((v) => (
                  <button
                    key={v.id}
                    className={`video-item${v.id === activeVideoId ? ' active' : ''}`}
                    onClick={() => setActiveVideoId(v.id)}
                    title={v.label}
                  >
                    <span className="video-item-label">{v.label}</span>
                    <span className="video-item-meta">{v.startRealTs || '—'} · {v.frameCount} 帧</span>
                  </button>
                ))}
              </div>
              <button className="new-video-btn" onClick={onPickVideo} disabled={extracting}>
                {extracting ? '拆帧中…' : '新建视频对象'}
              </button>
            </>
          )}
          <input ref={fileInputRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={onFileChosen} />
        </aside>

        <main className="panels">
          {!synced && <div className="loading">首次同步手机 DB 中…（adb exec-out solevup_perception.db）</div>}
          {synced && !activeVideo && <div className="loading">左侧选择 / 新建一个视频对象</div>}
          {synced && activeVideo && panels.length === 0 && (
            <div className="loading">「{activeVideo.label}」还没有对照栏 · 点右上「新建对照」</div>
          )}
          {synced && activeVideo && errorsOnly && errorCount === 0 && panels.length > 0 && (
            <div className="loading">没有标记为错误的对照</div>
          )}
          {synced && activeVideo && panels.map((p, i) => (
            (!errorsOnly || p.status === 'error') ? (
              <ComparePanel
                key={p.id}
                index={i}
                panel={p}
                video={activeVideo}
                capturing={capturingId === p.id}
                onCapture={() => captureToPanel(p.id)}
                onChange={(patch) => updatePanel(p.id, patch)}
                onRemove={() => removePanel(p.id)}
                onViewSnap={setLightbox}
              />
            ) : null
          ))}
          {synced && activeVideo && panels.length > 0 && !errorsOnly && (
            <button className="add-panel" onClick={addPanel}>新建对照栏</button>
          )}
        </main>
        {synced && (
          <FloatingMirror
            devSource={devSource}
            remountKey={`mirror-${syncVersion}`}
            phoneRef={phoneRef}
            mode={mirrorMode}
            onToggleMode={toggleMirrorMode}
          />
        )}
      </div>

      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}

// ══════════════════════════════════════════════
// 样式
// ══════════════════════════════════════════════
const CSS = `
* { box-sizing: border-box; }
html, body, #root { width: 100%; height: 100%; margin: 0; }
body {
  background: #0e1014;
  color: #e6e8ec;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
}
#root { display: flex; flex-direction: column; overflow: hidden; }
.bench { display: flex; flex-direction: column; height: 100%; }

/* 滚动条：贴合深色主题 */
* { scrollbar-width: thin; scrollbar-color: #2a313d transparent; }
::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #2a313d; border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: #3a4252; background-clip: padding-box; }
::-webkit-scrollbar-corner { background: transparent; }

.topbar { flex: none; display: flex; align-items: center; gap: 16px; padding: 12px 20px; background: #15181f; border-bottom: 1px solid #232831; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; letter-spacing: .3px; }
.brand-dot { width: 9px; height: 9px; border-radius: 50%; background: linear-gradient(135deg,#5b8cff,#9d6bff); box-shadow: 0 0 8px #5b8cff88; }
.status { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.dot { width: 7px; height: 7px; border-radius: 50%; }
.dot-ok { background: #4ade80; }
.dot-warn { background: #fbbf24; }
.status-text { color: #8b93a1; }
.status-rows { color: #8b93a1; font-variant-numeric: tabular-nums; margin-left: 4px; }
.status-err { color: #f87171; margin-left: 4px; }
.top-actions { margin-left: auto; display: flex; gap: 10px; }
.btn { padding: 7px 14px; border-radius: 8px; border: 1px solid #2c3340; background: #1c212b; color: #cfd4dc; font-size: 13px; cursor: pointer; transition: .15s; }
.btn:hover:not(:disabled) { background: #232a36; border-color: #3a4252; }
.btn:disabled { opacity: .45; cursor: default; }
.btn-primary { background: linear-gradient(135deg,#3b6fff,#7b5bff); border: none; color: #fff; font-weight: 600; }
.btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
.btn-toggle-on { background: #3a1d22; border-color: #7a3038; color: #ffb4bc; }
.btn-toggle-on:hover:not(:disabled) { background: #45222a; border-color: #8a3842; }

.text-btn { padding: 4px 10px; border-radius: 7px; border: 1px solid #2c3340; background: #1c212b; color: #9aa3b2; cursor: pointer; font-size: 12px; transition: .15s; }
.text-btn:hover:not(:disabled) { background: #232a36; border-color: #3a4252; color: #cfd4dc; }
.text-btn:disabled { opacity: .4; cursor: default; }
.text-btn-danger:hover:not(:disabled) { background: #2a1d22; border-color: #5a2d35; color: #f87171; }

.bench-body { flex: 1; min-height: 0; display: flex; }

/* 左侧栏 */
.sidebar { flex: none; width: 244px; background: #12151c; border-right: 1px solid #232831; display: flex; flex-direction: column; padding: 14px; gap: 12px; transition: width .18s ease; }
.sidebar.collapsed { width: 56px; padding: 14px 8px; align-items: center; }
.sidebar-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; }
.sidebar-title { font-size: 12px; font-weight: 700; letter-spacing: .5px; color: #8b93a1; }
.video-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 7px; }
.video-empty { color: #5b6472; font-size: 12px; line-height: 1.7; padding: 8px 4px; }
.video-item { display: flex; flex-direction: column; gap: 3px; text-align: left; padding: 10px 11px; border-radius: 9px; border: 1px solid #232831; background: #171b24; color: #cfd4dc; cursor: pointer; transition: .15s; }
.video-item:hover { border-color: #3a4252; background: #1c212b; }
.video-item.active { border-color: #5b8cff; background: #1a2336; box-shadow: 0 0 0 1px #5b8cff66; }
.video-item-label { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.video-item-meta { font-size: 11px; color: #7d8593; font-variant-numeric: tabular-nums; }
.new-video-btn { flex: none; padding: 9px; border-radius: 9px; border: 1px dashed #39414f; background: transparent; color: #9aa3b2; cursor: pointer; font-size: 13px; transition: .15s; }
.new-video-btn:hover:not(:disabled) { border-color: #5b8cff; color: #9db4ff; }
.new-video-btn:disabled { opacity: .6; cursor: default; }
.video-rail { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; align-items: center; gap: 8px; width: 100%; }
.rail-item { flex: none; width: 38px; height: 38px; border-radius: 9px; border: 1px solid #232831; background: #171b24; color: #aeb4c0; cursor: pointer; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; transition: .15s; }
.rail-item:hover:not(:disabled) { border-color: #3a4252; background: #1c212b; }
.rail-item.active { border-color: #5b8cff; background: #1a2336; color: #9db4ff; box-shadow: 0 0 0 1px #5b8cff66; }
.rail-add { border-style: dashed; color: #6b7280; }
.rail-add:hover:not(:disabled) { border-color: #5b8cff; color: #9db4ff; }
.rail-add:disabled { opacity: .5; cursor: default; }

.panels { flex: 1; min-width: 0; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 18px; }
.loading { color: #6b7280; text-align: center; padding: 60px 0; font-size: 14px; }

/* 对照栏 */
.panel { background: #141821; border: 1px solid #232831; border-radius: 14px; overflow: hidden; display: flex; flex-direction: column; position: relative; flex: none; }
.panel-error { border-color: #6e2a32; box-shadow: 0 0 0 1px #6e2a3266; }
.panel-resolved { border-color: #2f6e44; box-shadow: 0 0 0 1px #2f6e4466; }
.panel-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #1f242e; background: #171b24; }
.panel-no { font-weight: 700; font-size: 13px; color: #aeb4c0; }
.status-pills { display: inline-flex; gap: 4px; margin-left: 6px; }
.pill { padding: 3px 12px; border-radius: 12px; border: 1px solid #2c3340; background: #1c212b; color: #8b93a1; font-size: 12px; cursor: pointer; transition: .15s; }
.pill:hover { border-color: #3a4252; color: #cfd4dc; }
.pill-ok-on { background: #173a26; border-color: #2f7a4a; color: #74e6a0; }
.pill-err-on { background: #3a1d22; border-color: #7a3038; color: #ffb4bc; }
.pill-resolved-on { background: #173a26; border-color: #3aa564; color: #8ef0b4; }
.resolve-btn { padding: 6px 14px; border-radius: 8px; border: 1px solid #3aa564; background: #173a26; color: #8ef0b4; font-size: 12px; font-weight: 600; cursor: pointer; }
.resolve-btn:hover { background: #1c4a30; }
.snap-resolved { border-color: #3aa564; box-shadow: 0 0 0 1px #3aa564; }
.snap-resolved::after { content: '✓ 验证'; position: absolute; left: 0; right: 0; bottom: 0; padding: 2px; font-size: 9px; text-align: center; color: #fff; background: #2f7a44cc; }
.note-row { padding: 8px 14px; border-bottom: 1px solid #1f242e; background: #1a1418; }
.note-input { width: 100%; padding: 7px 11px; border-radius: 8px; border: 1px solid #5a2d35; background: #221319; color: #f3d6da; font-size: 13px; outline: none; }
.note-input:focus { border-color: #a04450; box-shadow: 0 0 0 1px #a0445044; }
.note-input::placeholder { color: #8a6068; }
.panel-spacer { flex: 1; }
.panel-h { font-size: 11px; color: #6b7280; font-variant-numeric: tabular-nums; }
.panel-resize { position: absolute; left: 0; right: 0; bottom: 0; height: 7px; cursor: ns-resize; }
.panel-resize:hover { background: linear-gradient(180deg, transparent, #5b8cff66); }
.panel-body { display: flex; flex: 1; min-height: 0; }

/* 左右两列：stage 大图满铺，控件做成底部覆盖式 overlay（默认隐藏，hover 浮现），
   这样图片缩放永远占满整列、左右严格等大对齐，缩略条不挤压布局 */
.frame-col, .snaps-col { position: relative; flex: 1; min-width: 0; overflow: hidden; }
.frame-col { border-right: 1px solid #1f242e; }
.frame-empty { flex: 1; padding: 40px; color: #6b7280; }

.stage { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: #0a0c10; }
.stage-snap { cursor: zoom-in; }
.multi-btn { margin-left: auto; padding: 5px 14px; border-radius: 8px; border: 1px solid #3a4252; background: #1c212b; color: #cfd4dc; font-size: 12px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px #0006; }
.multi-btn:hover { background: #232a36; }
.multi-btn-on { background: linear-gradient(135deg,#3b6fff,#7b5bff); border-color: transparent; color: #fff; }
.stage-img { max-width: 100%; max-height: 100%; object-fit: contain; }
.stage-hint { color: #5b6472; font-size: 12px; line-height: 1.8; text-align: center; padding: 20px; }

.col-overlay { position: absolute; left: 0; right: 0; padding: 12px 14px; z-index: 2; pointer-events: none; }
.col-overlay > * { pointer-events: auto; }
.col-overlay-top { top: 0; display: flex; align-items: flex-start; gap: 12px; background: linear-gradient(180deg, #000a 0%, transparent 100%); }
.col-overlay-bottom { bottom: 0; display: flex; flex-direction: column; gap: 8px; background: linear-gradient(0deg, #000d 0%, #000a 55%, transparent 100%); }
.auto-hide { opacity: 0; transform: translateY(10px); transition: opacity .18s ease, transform .18s ease; }
.frame-col:hover .auto-hide, .snaps-col:hover .auto-hide { opacity: 1; transform: none; }

.headline { flex: 1; min-width: 0; display: flex; flex-direction: column; text-shadow: 0 1px 3px #000a; }
.headline-main { font-size: 18px; font-weight: 700; color: #f3f5f8; line-height: 1.2; display: inline-flex; align-items: center; gap: 8px; }
.sel-badge { font-size: 11px; font-weight: 600; color: #9db4ff; background: #1a2336cc; border: 1px solid #5b8cff66; border-radius: 10px; padding: 1px 8px; font-variant-numeric: tabular-nums; }
.headline-sub { font-size: 11px; color: #c0c6d0; font-variant-numeric: tabular-nums; }
.capture-btn { margin-left: auto; padding: 6px 14px; border-radius: 8px; border: none; background: linear-gradient(135deg,#3b6fff,#7b5bff); color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px #0006; }
.capture-btn:hover:not(:disabled) { filter: brightness(1.08); }
.capture-btn:disabled { opacity: .55; cursor: default; }

.slider-row { display: flex; align-items: center; gap: 10px; }
.step-btn { width: 30px; height: 30px; border-radius: 8px; border: 1px solid #2c3340; background: #1c212b; color: #cfd4dc; font-size: 18px; cursor: pointer; line-height: 1; }
.step-btn:hover { background: #232a36; }
/* 自定义滑块（脱离浏览器默认） */
.slider { flex: 1; -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px; background: #2c3340; cursor: pointer; }
.slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #5b8cff; box-shadow: 0 0 0 3px #5b8cff33; cursor: pointer; }
.slider::-moz-range-thumb { width: 14px; height: 14px; border: none; border-radius: 50%; background: #5b8cff; cursor: pointer; }

/* 高度控制：自定义数字输入 + 上下微调（无浏览器默认 spinner） */
.height-ctl { display: inline-flex; align-items: center; gap: 6px; }
.num-field { display: inline-flex; align-items: stretch; height: 26px; border: 1px solid #2c3340; border-radius: 7px; background: #1c212b; overflow: hidden; }
.num-field:focus-within { border-color: #5b8cff; box-shadow: 0 0 0 1px #5b8cff44; }
.num-input { width: 46px; border: none; background: transparent; color: #e6e8ec; font-size: 12px; text-align: right; padding: 0 6px; outline: none; font-variant-numeric: tabular-nums; }
.num-spin { display: flex; flex-direction: column; width: 18px; border-left: 1px solid #2c3340; }
.num-step { flex: 1; border: none; background: #232a36; color: #9aa3b2; font-size: 11px; line-height: 1; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; }
.num-step:first-child { border-bottom: 1px solid #2c3340; }
.num-step:hover { background: #2c3646; color: #cfd4dc; }
.height-unit { font-size: 11px; color: #6b7280; }

.thumb-strip { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 4px; height: 84px; }
.thumb { position: relative; flex: none; width: 44px; height: 78px; padding: 0; border: 2px solid transparent; border-radius: 6px; overflow: hidden; cursor: pointer; background: #0a0c10; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb-active { border-color: #5b8cff; box-shadow: 0 0 0 1px #5b8cff; }
/* 编辑模式：横向缩略条（紧凑，带帧号+时间戳标签 + 勾选高亮） */
.thumb-strip-lg { height: 116px; gap: 4px; }
.thumb-strip-lg .thumb { width: 62px; height: 110px; }
.thumb-cap { position: absolute; left: 0; right: 0; bottom: 0; padding: 2px 2px 3px; font-size: 8.5px; line-height: 1.2; color: #eef0f3; text-align: center; background: linear-gradient(0deg, #000e, #000a 55%, transparent); font-variant-numeric: tabular-nums; }
.thumb-sel { border-color: #5b8cff; box-shadow: 0 0 0 1px #5b8cff; }
.thumb-preview { outline: 2px solid #fff; outline-offset: -2px; }
/* 勾选角标：独立可点（点缩略图本身只是预览，不改选中） */
.pick { position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid #fff9; background: #0007; color: #fff; font-size: 11px; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 1px 4px #0008; }
.pick:hover { border-color: #5b8cff; }
.pick-on { background: #5b8cff; border-color: #5b8cff; }
.snap-thumb { width: 56px; }
.snap-del { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border: none; border-radius: 4px; background: #000a; color: #fff; font-size: 11px; line-height: 1; cursor: pointer; opacity: 0; transition: .15s; }
.snap-thumb:hover .snap-del { opacity: 1; }
.snap-del:hover { background: #f87171; }

/* 镜像：悬浮浮层 ⇄ 第三栏 两态 */
.floating-mirror { background: #15181f; border: 1px solid #2c3340; display: flex; flex-direction: column; overflow: hidden; }
.floating-mirror.mode-float { position: fixed; z-index: 50; width: 410px; border-radius: 16px; box-shadow: 0 16px 48px #000b; }
.floating-mirror.mode-float.collapsed { width: 200px; }
/* 第三栏：bench-body 的固定列，始终可见、不随对照栏滚动 */
/* 第三栏：固定列、整栏可滚（高度由 dockHeight 决定，可超视口），bar 吸顶 */
.floating-mirror.mode-dock { flex: none; width: 420px; border-top: 0; border-right: 0; border-bottom: 0; border-radius: 0; overflow-y: auto; }
.fm-bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 12px; background: #1a1e27; border-bottom: 1px solid #232831; user-select: none; }
.mode-float .fm-bar { cursor: grab; }
.mode-float .fm-bar:active { cursor: grabbing; }
.mode-dock .fm-bar { cursor: default; position: sticky; top: 0; z-index: 1; }
.fm-grip { width: 22px; height: 4px; border-radius: 2px; background: #3a4252; }
.fm-title { font-size: 12px; font-weight: 700; color: #aeb4c0; white-space: nowrap; }
.fm-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.fm-search { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #1c212b; border: 1px solid #2c3340; border-radius: 10px; }
.fm-search:focus-within { border-color: #5b8cff; box-shadow: 0 0 0 1px #5b8cff44; }
.search-input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: #e6e8ec; font-size: 13px; }
.search-input::placeholder { color: #6b7280; }
.search-clear { flex: none; width: 20px; height: 20px; border: none; border-radius: 6px; background: transparent; color: #8b93a1; cursor: pointer; font-size: 14px; line-height: 1; }
.search-clear:hover { background: #2a1d22; color: #f87171; }
.phone-frame { width: 386px; align-self: center; background: #f5f6f8; border-radius: 18px; overflow: hidden; display: flex; flex-direction: column; box-shadow: inset 0 0 0 1px #2c3340; }
.mode-float .phone-frame { height: 720px; }
/* dock 模式 phone-frame 高度由 inline dockHeight 决定，超出靠第三栏自身滚动 */

.add-panel { align-self: center; margin: 4px 0 20px; padding: 10px 28px; border-radius: 10px; border: 1px dashed #39414f; background: transparent; color: #8b93a1; cursor: pointer; font-size: 13px; }
.add-panel:hover { border-color: #5b8cff; color: #9db4ff; }

/* 大图查看 */
.lightbox { position: fixed; inset: 0; z-index: 100; background: #000c; display: flex; align-items: center; justify-content: center; cursor: zoom-out; }
.lightbox img { max-width: 92vw; max-height: 92vh; border-radius: 10px; box-shadow: 0 12px 48px #000; }
`

const styleEl = document.createElement('style')
styleEl.textContent = CSS
document.head.appendChild(styleEl)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
