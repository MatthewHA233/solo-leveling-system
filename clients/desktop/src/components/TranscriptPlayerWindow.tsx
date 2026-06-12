// ══════════════════════════════════════════════
// TranscriptPlayerWindow — 转录回放悬浮窗（HUD 风格）
//
//   语境库逐句转录点击 → 本悬浮窗播放对应本地视频并 seek 到该句。
//   · 全局单实例（挂在 TorrentFieldPanel 根），监听 solevup:transcript-play
//     detail: { refPath, title, sec } 打开/换片/跳播；{ close: true } 关闭
//   · 标题栏拖拽移动；左右/底边/底角拖拽调整大小（16:9，宽度驱动）
//     手势期间直接改 DOM style 不走 React 重渲染（否则 video 子树每帧重渲染会卡）
//     位置 + 尺寸存 localStorage，关闭/重启后记忆
//   · 播放中持续广播 solevup:transcript-time { refPath, sec }，逐句视图点亮当前句
//   · 解码复用 HudVideoPlayer（h264 自愈 + 49733 流式）
// ══════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { theme } from '../theme'
import HudVideoPlayer, { type HudVideoHandle } from './HudVideoPlayer'
import Tooltip from './Tooltip'

// ── 可调旋钮 ──
const DEFAULT_W = 480           // 默认宽（视频 16:9 随之定高）
const MIN_W = 320               // 最小宽
const MAX_W = 1100              // 最大宽
const TITLE_H = 32              // 标题栏高
const EDGE_MARGIN = 16          // 默认位置离视口右下边距 / 拖拽钳制边距
const BRACKET = 14              // 四角括号臂长
const GRIP = 7                  // 边缘 resize 手柄厚度
const CORNER_GRIP = 16          // 底角 resize 手柄边长
const POS_KEY = 'solevup:transcript-player-pos'

export interface TranscriptPlayDetail {
  refPath?: string
  title?: string | null
  sec?: number | null
  close?: boolean
}

interface Geom { x: number; y: number; w: number }

type ResizeEdge = 'left' | 'right' | 'bottom' | 'bottom-left' | 'bottom-right'

const winHeight = (w: number) => TITLE_H + (w * 9) / 16

function loadGeom(): Geom | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<Geom>
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return null
    return { x: p.x, y: p.y, w: typeof p.w === 'number' ? p.w : DEFAULT_W }
  } catch { return null }
}

function clampGeom(g: Geom): Geom {
  const w = Math.max(MIN_W, Math.min(g.w, MAX_W, window.innerWidth - EDGE_MARGIN * 2))
  return {
    w,
    x: Math.max(EDGE_MARGIN, Math.min(g.x, window.innerWidth - w - EDGE_MARGIN)),
    y: Math.max(EDGE_MARGIN, Math.min(g.y, window.innerHeight - winHeight(w) - EDGE_MARGIN)),
  }
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}

/** 四角括号（与聊天面板 Fairy 帧同语义的目标锁定角） */
function CornerBrackets() {
  const c = theme.electricBlue
  const common: React.CSSProperties = { position: 'absolute', width: BRACKET, height: BRACKET, pointerEvents: 'none', zIndex: 2 }
  return (
    <>
      <span style={{ ...common, left: -1, top: -1, borderLeft: `2px solid ${c}`, borderTop: `2px solid ${c}` }} />
      <span style={{ ...common, right: -1, top: -1, borderRight: `2px solid ${c}`, borderTop: `2px solid ${c}` }} />
      <span style={{ ...common, left: -1, bottom: -1, borderLeft: `2px solid ${c}`, borderBottom: `2px solid ${c}` }} />
      <span style={{ ...common, right: -1, bottom: -1, borderRight: `2px solid ${c}`, borderBottom: `2px solid ${c}` }} />
    </>
  )
}

export default function TranscriptPlayerWindow() {
  const [video, setVideo] = useState<{ refPath: string; title: string | null } | null>(null)
  const [geom, setGeom] = useState<Geom | null>(null)
  const [curSec, setCurSec] = useState(0)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<HudVideoHandle>(null)
  // seek 目标：HudVideoPlayer 转封/加载是异步的，先记下，<video> 就绪后再消费
  const pendingSeekRef = useRef<number | null>(null)
  const videoRefPathRef = useRef<string | null>(null)
  videoRefPathRef.current = video?.refPath ?? null

  // 打开/换片/跳播事件
  useEffect(() => {
    const onPlay = (e: Event) => {
      const d = (e as CustomEvent).detail as TranscriptPlayDetail | undefined
      if (!d) return
      if (d.close) {
        setVideo(null)
        return
      }
      if (!d.refPath) return
      const sec = typeof d.sec === 'number' ? d.sec : null
      if (videoRefPathRef.current === d.refPath) {
        // 同一支视频：直接 seek（未就绪则记 pending）
        if (sec !== null) {
          pendingSeekRef.current = sec
          tryConsumeSeek()
        }
      } else {
        pendingSeekRef.current = sec
        setVideo({ refPath: d.refPath, title: d.title ?? null })
        setCurSec(sec ?? 0)
      }
      // 首次打开：记忆几何或默认右下角
      setGeom((prev) => {
        const base = prev ?? loadGeom() ?? {
          w: DEFAULT_W,
          x: window.innerWidth - DEFAULT_W - EDGE_MARGIN,
          y: window.innerHeight - winHeight(DEFAULT_W) - EDGE_MARGIN,
        }
        return clampGeom(base)
      })
    }
    window.addEventListener('solevup:transcript-play', onPlay)
    return () => window.removeEventListener('solevup:transcript-play', onPlay)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tryConsumeSeek = useCallback(() => {
    const target = pendingSeekRef.current
    if (target === null) return
    const el = playerRef.current?.el()
    if (el && el.readyState >= 1) {
      pendingSeekRef.current = null
      playerRef.current?.seek(target)
    }
  }, [])

  // pending seek 消费循环：视频转封/加载就绪前每 300ms 试一次
  useEffect(() => {
    if (!video) return
    const timer = setInterval(tryConsumeSeek, 300)
    return () => clearInterval(timer)
  }, [video, tryConsumeSeek])

  // 关闭时广播一次"无播放位置"，让逐句视图熄灭当前句
  const close = useCallback(() => {
    setVideo(null)
    window.dispatchEvent(new CustomEvent('solevup:transcript-time', { detail: { refPath: null, sec: 0 } }))
  }, [])

  // ── 移动 / 调整大小：手势期间直接写 DOM style（不 setState），抬手才提交 + 落盘 ──
  const gestureRef = useRef<{
    kind: 'move' | ResizeEdge
    startX: number
    startY: number
    startGeom: Geom
    live: Geom
  } | null>(null)

  const applyLive = (g: Geom) => {
    const el = boxRef.current
    if (!el) return
    el.style.left = `${g.x}px`
    el.style.top = `${g.y}px`
    el.style.width = `${g.w}px`
  }

  const beginGesture = (kind: 'move' | ResizeEdge) => (e: React.PointerEvent) => {
    if (!geom) return
    e.preventDefault()
    gestureRef.current = { kind, startX: e.clientX, startY: e.clientY, startGeom: geom, live: geom }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onGestureMove = (e: React.PointerEvent) => {
    const g = gestureRef.current
    if (!g) return
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    const s = g.startGeom
    let next: Geom
    switch (g.kind) {
      case 'move':
        next = { ...s, x: s.x + dx, y: s.y + dy }
        break
      case 'right':
        next = { ...s, w: s.w + dx }
        break
      case 'left':
        // 左缘：右缘保持不动
        next = { x: s.x + dx, y: s.y, w: s.w - dx }
        break
      case 'bottom': {
        // 底缘：高度差换算回宽度（16:9 宽度驱动）
        const w = ((winHeight(s.w) + dy - TITLE_H) * 16) / 9
        next = { ...s, w }
        break
      }
      case 'bottom-right':
        next = { ...s, w: s.w + dx }
        break
      case 'bottom-left':
        next = { x: s.x + dx, y: s.y, w: s.w - dx }
        break
    }
    // 钳制宽度时左缘拖拽要保持右缘锚定
    const anchoredRight = g.kind === 'left' || g.kind === 'bottom-left'
    const clamped = clampGeom(next)
    if (anchoredRight && clamped.w !== next.w) {
      clamped.x = s.x + s.w - clamped.w
    }
    g.live = clamped
    applyLive(clamped)
  }

  const onGestureEnd = () => {
    const g = gestureRef.current
    if (!g) return
    gestureRef.current = null
    setGeom(g.live)
    try { localStorage.setItem(POS_KEY, JSON.stringify(g.live)) } catch { /* 忽略 */ }
  }

  if (!video || !geom) return null

  // 手势期间播放进度 setCurSec 触发的重渲染会用旧 geom 覆盖 DOM——渲染时优先取手势 live 值
  const renderGeom = gestureRef.current?.live ?? geom

  // resize 手柄公共属性
  const grip = (edge: ResizeEdge, style: React.CSSProperties) => (
    <div
      onPointerDown={beginGesture(edge)}
      onPointerMove={onGestureMove}
      onPointerUp={onGestureEnd}
      style={{ position: 'absolute', zIndex: 3, touchAction: 'none', ...style }}
    />
  )

  return createPortal(
    <div
      ref={boxRef}
      style={{
        position: 'fixed',
        left: renderGeom.x,
        top: renderGeom.y,
        width: renderGeom.w,
        zIndex: 9500,
        background: theme.hudFillDeep,
        border: `1px solid ${theme.hudFrame}`,
        boxShadow: `0 14px 44px rgba(0,0,0,0.65), 0 0 18px ${theme.electricBlue}22`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <CornerBrackets />

      {/* 边缘 / 底角 resize 手柄 */}
      {grip('left', { left: -GRIP / 2, top: TITLE_H, bottom: CORNER_GRIP, width: GRIP, cursor: 'ew-resize' })}
      {grip('right', { right: -GRIP / 2, top: TITLE_H, bottom: CORNER_GRIP, width: GRIP, cursor: 'ew-resize' })}
      {grip('bottom', { left: CORNER_GRIP, right: CORNER_GRIP, bottom: -GRIP / 2, height: GRIP, cursor: 'ns-resize' })}
      {grip('bottom-left', { left: -GRIP / 2, bottom: -GRIP / 2, width: CORNER_GRIP, height: CORNER_GRIP, cursor: 'nesw-resize' })}
      {grip('bottom-right', { right: -GRIP / 2, bottom: -GRIP / 2, width: CORNER_GRIP, height: CORNER_GRIP, cursor: 'nwse-resize' })}

      {/* 标题栏：呼号 + 视频标题 + 当前时间 + 关闭；按住可拖拽移动 */}
      <div
        onPointerDown={beginGesture('move')}
        onPointerMove={onGestureMove}
        onPointerUp={onGestureEnd}
        style={{
          height: TITLE_H,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 10px',
          borderBottom: `1px solid ${theme.hudFrameSoft}`,
          fontFamily: theme.fontMono,
          fontSize: 10,
          letterSpacing: 1,
          color: theme.textMuted,
          cursor: 'grab',
          userSelect: 'none',
          touchAction: 'none',
          flexShrink: 0,
        }}
      >
        <span style={{ color: theme.electricBlue, fontWeight: 700, flexShrink: 0 }}>▶ 转录回放</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
          {video.title ?? ''}
        </span>
        <span style={{ color: theme.electricBlue, flexShrink: 0 }}>{fmtTime(curSec)}</span>
        <Tooltip content="关闭">
          <button
            type="button"
            onClick={close}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: theme.textMuted, padding: 1, display: 'flex', alignItems: 'center', flexShrink: 0,
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = theme.dangerRed)}
            onMouseLeave={(e) => (e.currentTarget.style.color = theme.textMuted)}
          >
            <X size={12} />
          </button>
        </Tooltip>
      </div>

      <HudVideoPlayer
        ref={playerRef}
        filePath={video.refPath}
        onTimeUpdate={(sec) => {
          setCurSec(sec)
          tryConsumeSeek()
          window.dispatchEvent(new CustomEvent('solevup:transcript-time', {
            detail: { refPath: video.refPath, sec },
          }))
        }}
      />
    </div>,
    document.body,
  )
}
