// ══════════════════════════════════════════════
// TranscriptPlayerWindow — 转录回放悬浮窗（HUD 风格）
//
//   语境库逐句转录点击 → 本悬浮窗播放对应本地视频并 seek 到该句。
//   · 全局单实例（挂在 TorrentFieldPanel 根），监听 solevup:transcript-play
//     detail: { refPath, title, sec } 打开/换片/跳播；{ close: true } 关闭
//   · 标题栏可拖拽，位置存 localStorage，关闭/重启后记忆
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
const WIN_WIDTH = 480           // 悬浮窗宽（视频 16:9 随之定高）
const TITLE_H = 32              // 标题栏高
const EDGE_MARGIN = 16          // 默认位置离视口右下边距 / 拖拽钳制边距
const BRACKET = 14              // 四角括号臂长
const POS_KEY = 'solevup:transcript-player-pos'

export interface TranscriptPlayDetail {
  refPath?: string
  title?: string | null
  sec?: number | null
  close?: boolean
}

interface Pos { x: number; y: number }

function loadPos(): Pos | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Pos
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return null
    return p
  } catch { return null }
}

function clampPos(p: Pos, w: number, h: number): Pos {
  return {
    x: Math.max(EDGE_MARGIN, Math.min(p.x, window.innerWidth - w - EDGE_MARGIN)),
    y: Math.max(EDGE_MARGIN, Math.min(p.y, window.innerHeight - h - EDGE_MARGIN)),
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
  const common: React.CSSProperties = { position: 'absolute', width: BRACKET, height: BRACKET, pointerEvents: 'none' }
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
  const [pos, setPos] = useState<Pos | null>(null)
  const [curSec, setCurSec] = useState(0)
  const playerRef = useRef<HudVideoHandle>(null)
  // seek 目标：HudVideoPlayer 转封/加载是异步的，先记下，<video> 就绪后再消费
  const pendingSeekRef = useRef<number | null>(null)
  const videoRefPathRef = useRef<string | null>(null)
  videoRefPathRef.current = video?.refPath ?? null

  const winHeight = TITLE_H + (WIN_WIDTH * 9) / 16

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
      // 首次打开：默认右下角或记忆位置
      setPos((prev) => {
        const base = prev ?? loadPos() ?? {
          x: window.innerWidth - WIN_WIDTH - EDGE_MARGIN,
          y: window.innerHeight - winHeight - EDGE_MARGIN,
        }
        return clampPos(base, WIN_WIDTH, winHeight)
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

  // 拖拽（标题栏）：pointer 事件 + 视口钳制 + 抬手时落 localStorage
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const onTitlePointerDown = (e: React.PointerEvent) => {
    if (!pos) return
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onTitlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setPos(clampPos({ x: e.clientX - d.dx, y: e.clientY - d.dy }, WIN_WIDTH, winHeight))
  }
  const onTitlePointerUp = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setPos((p) => {
      if (p) try { localStorage.setItem(POS_KEY, JSON.stringify(p)) } catch { /* 忽略 */ }
      return p
    })
  }

  if (!video || !pos) return null

  return createPortal(
    <div
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: WIN_WIDTH,
        zIndex: 9500,
        background: theme.hudFillDeep,
        border: `1px solid ${theme.hudFrame}`,
        boxShadow: `0 14px 44px rgba(0,0,0,0.65), 0 0 18px ${theme.electricBlue}22`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <CornerBrackets />

      {/* 标题栏：呼号 + 视频标题 + 当前时间 + 关闭；按住可拖拽 */}
      <div
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
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
