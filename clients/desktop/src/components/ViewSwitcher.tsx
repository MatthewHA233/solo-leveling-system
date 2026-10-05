// ══════════════════════════════════════════════
// ViewSwitcher — 主舞台视图切换（粗斜体斜切块，样式 .ti-tab）
//   · 左右拖拽换序（HTML5 native drag），顺序持久化到 localStorage
//   · 每个 tab 前有两位编号（01 02…）；当前视图 = 整块橙色 + 黑色粗斜体，一眼知道在哪
//   · 「静态示范」两个开发用页面默认隐藏：在 tab 栏上右键切换显示
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import { ti } from '../theme'

export type MainViewMode = 'motivation' | 'motivation_static' | 'daynight' | 'torrent' | 'torrent_static' | 'focus'

interface Props {
  readonly viewMode: MainViewMode
  readonly onChange: (m: MainViewMode) => void
  readonly protocolLabel: string
}

const LABELS: Record<MainViewMode, string> = {
  motivation: '今日协议',
  motivation_static: '协议志(静态示范)',
  daynight: '昼夜表',
  torrent: '洪流域',
  torrent_static: '洪流域(静态示范)',
  focus: '专注锁',
}

const DEFAULT_ORDER: ReadonlyArray<MainViewMode> = ['motivation', 'motivation_static', 'daynight', 'torrent', 'torrent_static', 'focus']
// v6 新增协议志静态示范，换 storage key
const ORDER_STORAGE_KEY = 'slu.viewSwitcher.order.v6'

const ALL_MODES: ReadonlyArray<MainViewMode> = ['motivation', 'motivation_static', 'daynight', 'torrent', 'torrent_static', 'focus']
const DEMO_MODES: ReadonlyArray<MainViewMode> = ['motivation_static', 'torrent_static']
const DEMO_STORAGE_KEY = 'slu.viewSwitcher.showDemos'

function loadShowDemos(): boolean {
  try { return localStorage.getItem(DEMO_STORAGE_KEY) === '1' } catch { return false }
}

function loadOrder(): MainViewMode[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(ORDER_STORAGE_KEY) : null
    if (!raw) return [...DEFAULT_ORDER]
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return [...DEFAULT_ORDER]
    const valid = parsed.filter((x): x is MainViewMode => ALL_MODES.includes(x as MainViewMode))
    for (const k of DEFAULT_ORDER) if (!valid.includes(k)) valid.push(k)
    return valid.slice(0, DEFAULT_ORDER.length)
  } catch {
    return [...DEFAULT_ORDER]
  }
}

export default function ViewSwitcher({ viewMode, onChange, protocolLabel }: Props) {
  const [order, setOrder] = useState<MainViewMode[]>(loadOrder)
  const [showDemos, setShowDemos] = useState<boolean>(loadShowDemos)
  const dragIdxRef = useRef<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)

  useEffect(() => {
    try { localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order)) } catch {}
  }, [order])

  useEffect(() => {
    try { localStorage.setItem(DEMO_STORAGE_KEY, showDemos ? '1' : '0') } catch {}
  }, [showDemos])

  const swap = (from: number, to: number) => {
    if (from === to) return
    setOrder((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  // 编号按"可见 tab"顺序数，隐藏的示范页不占号
  let visibleNo = 0

  return (
    <div
      title="右键：显示 / 隐藏示范页"
      onContextMenu={(e) => { e.preventDefault(); setShowDemos((v) => !v) }}
      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 12px 0 14px' }}
    >
      {order.map((id, idx) => {
        const active = id === viewMode
        // 示范页默认隐藏；正在看的那页照常显示，免得切过去后 tab 消失
        if (!showDemos && !active && DEMO_MODES.includes(id)) return null
        visibleNo += 1
        const no = String(visibleNo).padStart(2, '0')
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
            className="ti-tab"
            data-active={active ? '1' : undefined}
            aria-pressed={active}
          >
            <span className="ti-tab-inner">
              <span className="ti-tab-no">{no}</span>
              <span className="ti-tab-label">{label}</span>
            </span>
            {/* drag-over 时左侧 insert 指示线 */}
            {isDragOver && dragIdxRef.current !== idx && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: -5, top: 2, bottom: 2,
                  width: 2,
                  background: ti.led,
                }}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
