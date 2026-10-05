import { useEffect, useState, useCallback } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { theme, tiSurface, ti, tiTitle } from '../theme'

const PREF_KEY = 'close-action-pref'
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000

type Action = 'minimize' | 'exit'

interface Pref { action: Action; until: number }

function loadPref(): Pref | null {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    if (!raw) return null
    const p: Pref = JSON.parse(raw)
    if (Date.now() > p.until) { localStorage.removeItem(PREF_KEY); return null }
    return p
  } catch { return null }
}

function savePref(action: Action) {
  const p: Pref = { action, until: Date.now() + ONE_MONTH_MS }
  localStorage.setItem(PREF_KEY, JSON.stringify(p))
}

async function doAction(action: Action) {
  if (action === 'minimize') {
    await getCurrentWindow().hide()
  } else {
    await invoke('exit_app')
  }
}

export function CloseConfirmModal() {
  const [visible, setVisible] = useState(false)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    const unlisten = listen('main-close-requested', async () => {
      const pref = loadPref()
      if (pref) { await doAction(pref.action); return }
      setVisible(true)
    })
    return () => { unlisten.then(fn => fn()) }
  }, [])

  const confirm = useCallback(async (action: Action) => {
    if (remember) savePref(action)
    setVisible(false)
    await doAction(action)
  }, [remember])

  if (!visible) return null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.72)',
    }}
      onClick={e => { if (e.target === e.currentTarget) setVisible(false) }}
    >
      <div style={{
        background: tiSurface.plate,
        border: 'none',
        boxShadow: tiSurface.plateShadow,
        borderRadius: 8,
        padding: '28px 32px 24px',
        minWidth: 340,
        fontFamily: theme.fontBody,
        color: theme.textPrimary,
      }}>
        {/* title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span className="ti-diamond" aria-hidden />
          <span style={{ ...tiTitle, fontSize: 14 }}>关闭窗口</span>
        </div>

        <div style={{ fontSize: 13, color: theme.textSecondary, marginBottom: 24, lineHeight: 1.6 }}>
          选择关闭行为：
        </div>

        {/* buttons */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          <button type="button" className="ti-key ti-key-primary" onClick={() => confirm('minimize')} style={btnStyle(null)}>
            最小化到托盘
          </button>
          <button type="button" className="ti-key" onClick={() => confirm('exit')} style={btnStyle(theme.dangerRed)}>
            退出程序
          </button>
        </div>

        {/* remember */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: theme.textMuted }}>
          <input
            type="checkbox"
            checked={remember}
            onChange={e => setRemember(e.target.checked)}
            style={{ accentColor: ti.led, width: 13, height: 13 }}
          />
          一个月内不再提示
        </label>
      </div>
    </div>
  )
}

/** 实体键尺寸；color 给了就是语义色字（退出 = 红），null 交给主键样式 */
function btnStyle(color: string | null): React.CSSProperties {
  return {
    flex: 1,
    height: 36,
    ...(color ? { color } : null),
    fontFamily: 'inherit',
    fontSize: 13,
    letterSpacing: '0.06em',
  }
}
