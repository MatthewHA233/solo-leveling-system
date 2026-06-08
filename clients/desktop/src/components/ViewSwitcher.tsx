// ══════════════════════════════════════════════
// ViewSwitcher — VSCode 风格主舞台 tab
//   · 矮窄单行（~26px 高），字号 12，padding 紧凑，节省垂直空间
//   · 左右拖拽换序（HTML5 native drag），顺序持久化到 localStorage
//   · 不可关闭（无 × 按钮）— 今日/当日协议、昼夜表、洪流域三个固定视图
//   · active 视觉：底部 1px 白色 underline + 文字加粗
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import { theme } from '../theme'

export type MainViewMode = 'motivation' | 'daynight' | 'torrent'

interface Props {
  readonly viewMode: MainViewMode
  readonly onChange: (m: MainViewMode) => void
  readonly protocolLabel: string
}

const LABELS: Record<MainViewMode, string> = {
  motivation: '今日协议',
  daynight: '昼夜表',
  torrent: '洪流域',
}

const DEFAULT_ORDER: ReadonlyArray<MainViewMode> = ['motivation', 'daynight', 'torrent']
// v3 新增洪流域，换 storage key（旧值不再生效，自动 fallback 到 default order）
const ORDER_STORAGE_KEY = 'slu.viewSwitcher.order.v3'

function loadOrder(): MainViewMode[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(ORDER_STORAGE_KEY) : null
    if (!raw) return [...DEFAULT_ORDER]
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return [...DEFAULT_ORDER]
    const valid = parsed.filter((x): x is MainViewMode => x === 'motivation' || x === 'daynight' || x === 'torrent')
    for (const k of DEFAULT_ORDER) if (!valid.includes(k)) valid.push(k)
    return valid.slice(0, DEFAULT_ORDER.length)
  } catch {
    return [...DEFAULT_ORDER]
  }
}

export default function ViewSwitcher({ viewMode, onChange, protocolLabel }: Props) {
  const [order, setOrder] = useState<MainViewMode[]>(loadOrder)
  const dragIdxRef = useRef<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)

  useEffect(() => {
    try { localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order)) } catch {}
  }, [order])

  const swap = (from: number, to: number) => {
    if (from === to) return
    setOrder((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'stretch',
      // 紧贴下方面板 frame 顶边 — 不留底部 padding
    }}>
      {order.map((id, idx) => {
        const active = id === viewMode
        const isDragOver = dragOverIdx === idx
        const label = id === 'motivation' ? protocolLabel : LABELS[id]
        return (
          <button
            key={id}
            type="button"
            draggable
            onDragStart={(e) => {
              dragIdxRef.current = idx
              e.dataTransfer.effectAllowed = 'move'
              try { e.dataTransfer.setData('text/plain', id) } catch {}
            }}
            onDragOver={(e) => {
              if (dragIdxRef.current === null) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (dragOverIdx !== idx) setDragOverIdx(idx)
            }}
            onDragLeave={() => {
              if (dragOverIdx === idx) setDragOverIdx(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              const from = dragIdxRef.current
              if (from != null) swap(from, idx)
              dragIdxRef.current = null
              setDragOverIdx(null)
            }}
            onDragEnd={() => {
              dragIdxRef.current = null
              setDragOverIdx(null)
            }}
            onClick={() => onChange(id)}
            style={{
              position: 'relative',
              padding: '0 12px',
              height: 20,
              minWidth: 0,
              background: active
                ? 'rgba(255,255,255,0.04)'
                : isDragOver ? 'rgba(255,255,255,0.06)' : 'transparent',
              border: 'none',
              borderRight: `1px solid ${theme.hudFrameSoft}`,
              borderLeft: idx === 0 ? `1px solid ${theme.hudFrameSoft}` : 'none',
              color: active ? theme.textPrimary : theme.textMuted,
              cursor: 'pointer',
              fontFamily: theme.fontBody,
              fontSize: 11,
              fontWeight: active ? 700 : 500,
              letterSpacing: 0.3,
              lineHeight: 1,
              transition: 'background 0.12s, color 0.12s',
              outline: 'none',
              display: 'inline-flex',
              alignItems: 'center',
            }}
            onMouseEnter={(e) => {
              if (!active) (e.currentTarget as HTMLButtonElement).style.color = theme.textPrimary
            }}
            onMouseLeave={(e) => {
              if (!active) (e.currentTarget as HTMLButtonElement).style.color = theme.textMuted
            }}
          >
            {label}
            {/* active 底部 1px 白色 underline */}
            {active && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 0, right: 0, bottom: -1,
                  height: 1,
                  background: theme.textPrimary,
                  boxShadow: `0 0 4px ${theme.textPrimary}88`,
                }}
              />
            )}
            {/* drag-over 时左侧 insert 指示线 */}
            {isDragOver && dragIdxRef.current !== idx && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: -1, top: 0, bottom: 0,
                  width: 2,
                  background: theme.warningOrange,
                  boxShadow: `0 0 4px ${theme.warningOrange}AA`,
                }}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
