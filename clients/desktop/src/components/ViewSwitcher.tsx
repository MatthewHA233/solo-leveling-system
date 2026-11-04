// ══════════════════════════════════════════════
// ViewSwitcher — 主舞台视图切换（粗斜体斜切块，样式 .ti-tab）
//   · 顺序固定；按住标签拖动 = 拖窗口（顶栏当标题栏用，见 lib/window-drag），点一下才是切视图
//   · 每个 tab 前有两位编号（01 02…）；当前视图 = 整块橙色 + 黑色粗斜体，一眼知道在哪
//   · 「静态示范」两个开发用页面默认隐藏：在 tab 栏上右键切换显示
// ══════════════════════════════════════════════

import { useEffect, useState } from 'react'

export type MainViewMode = 'motivation' | 'motivation_static' | 'daynight' | 'torrent' | 'torrent_static'

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
}

// 专注锁不再单独占一个标签：搬进了协议志（协议志 → 视图 → 专注锁）
const VIEW_ORDER: ReadonlyArray<MainViewMode> = ['motivation', 'motivation_static', 'daynight', 'torrent', 'torrent_static']

const DEMO_MODES: ReadonlyArray<MainViewMode> = ['motivation_static', 'torrent_static']
const DEMO_STORAGE_KEY = 'slu.viewSwitcher.showDemos'

function loadShowDemos(): boolean {
  try { return localStorage.getItem(DEMO_STORAGE_KEY) === '1' } catch { return false }
}

export default function ViewSwitcher({ viewMode, onChange, protocolLabel }: Props) {
  const [showDemos, setShowDemos] = useState<boolean>(loadShowDemos)

  useEffect(() => {
    try {
      localStorage.setItem(DEMO_STORAGE_KEY, showDemos ? '1' : '0')
    } catch {
      // 存不下只是下次启动不记得开关，不影响使用
    }
  }, [showDemos])

  // 示范页默认隐藏；正在看的那页照常显示，免得切过去后 tab 消失。编号按可见 tab 数，隐藏的不占号
  const visible = VIEW_ORDER.filter((id) => showDemos || id === viewMode || !DEMO_MODES.includes(id))

  return (
    <div
      title="右键：显示 / 隐藏示范页"
      onContextMenu={(e) => { e.preventDefault(); setShowDemos((v) => !v) }}
      // 间距在 styles/topbar.css（顶栏变窄时收紧）
      className="tb-tabs"
    >
      {visible.map((id, idx) => {
        const active = id === viewMode
        const label = id === 'motivation' ? protocolLabel : LABELS[id]
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className="ti-tab"
            data-active={active ? '1' : undefined}
            aria-pressed={active}
          >
            <span className="ti-tab-inner">
              <span className="ti-tab-no">{String(idx + 1).padStart(2, '0')}</span>
              <span className="ti-tab-label">{label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
