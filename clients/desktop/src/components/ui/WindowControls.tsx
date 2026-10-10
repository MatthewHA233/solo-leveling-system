// ══════════════════════════════════════════════
// 窗口键：最小化 / 最大化（还原）/ 关闭——Windows 上去掉了系统标题栏（主窗口 decorations=false，见 lib.rs），
// 由顶栏自己画。关闭键走和系统关闭一样的路（后端拦下关闭请求 → 前端弹关闭确认框）。
// macOS 保留系统红绿灯，这里不画。
// ══════════════════════════════════════════════

import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Copy, Minus, Square, X } from 'lucide-react'

/** WebView2 的 UA 里带 Windows NT；mac 上保留系统标题栏，不画这组键 */
const IS_WINDOWS = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')

const KEY_STYLE = { width: 30, height: 26 } as const

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const win = getCurrentWindow()
    let alive = true
    let unlisten: (() => void) | undefined
    const sync = () => {
      win.isMaximized().then((m) => {
        if (!alive) return
        setMaximized(m)
        // 最大化时窗口贴满屏幕，四角不再挖空（topbar.css 的 html.frameless）
        document.documentElement.toggleAttribute('data-window-maximized', m)
      }).catch(() => {})
    }
    sync()
    // 双击顶栏 / 拖到屏幕顶端 / Win+↑ 都会改最大化状态：跟着窗口尺寸变化重新读
    win.onResized(sync).then((u) => {
      if (alive) unlisten = u
      else u()
    }).catch(() => {})
    return () => {
      alive = false
      unlisten?.()
    }
  }, [])

  if (!IS_WINDOWS) return null

  const run = (action: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>) => () => {
    action(getCurrentWindow()).catch((e: unknown) => console.error('[WindowControls] 窗口操作失败', e))
  }

  return (
    <div className="tb-winctl">{/* 间距在 styles/topbar.css */}
      <button type="button" className="ti-key" aria-label="最小化" style={KEY_STYLE} onClick={run((w) => w.minimize())}>
        <Minus size={14} strokeWidth={2.4} />
      </button>
      <button type="button" className="ti-key" aria-label={maximized ? '还原' : '最大化'} style={KEY_STYLE} onClick={run((w) => w.toggleMaximize())}>
        {maximized ? <Copy size={12} strokeWidth={2.2} /> : <Square size={11} strokeWidth={2.4} />}
      </button>
      <button type="button" className="ti-key ti-key-danger" aria-label="关闭" style={KEY_STYLE} onClick={run((w) => w.close())}>
        <X size={14} strokeWidth={2.4} />
      </button>
    </div>
  )
}
