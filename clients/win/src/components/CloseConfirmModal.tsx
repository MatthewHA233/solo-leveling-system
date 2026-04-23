import { useEffect, useState, useCallback } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { theme } from '../theme'

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
        background: theme.hudFillDeep,
        border: `1px solid ${theme.hudFrame}`,
        boxShadow: `0 0 32px ${theme.hudHalo}, inset 0 0 16px rgba(0,0,0,0.4)`,
        borderRadius: 2,
        padding: '28px 32px 24px',
        minWidth: 340,
        fontFamily: theme.fontMono,
        color: theme.textPrimary,
        clipPath: 'polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px))',
      }}>
        {/* title */}
        <div style={{
          fontFamily: theme.fontDisplay,
          fontSize: 12,
          letterSpacing: '0.12em',
          color: theme.electricBlue,
          textShadow: `0 0 8px ${theme.electricBlue}`,
          marginBottom: 16,
          textTransform: 'uppercase',
        }}>
          CLOSE WINDOW
        </div>

        <div style={{ fontSize: 13, color: theme.textSecondary, marginBottom: 24, lineHeight: 1.6 }}>
          选择关闭行为：
        </div>

        {/* buttons */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          <button onClick={() => confirm('minimize')} style={btnStyle(theme.electricBlue)}>
            最小化到托盘
          </button>
          <button onClick={() => confirm('exit')} style={btnStyle(theme.dangerRed)}>
            退出程序
          </button>
        </div>

        {/* remember */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: theme.textMuted }}>
          <input
            type="checkbox"
            checked={remember}
            onChange={e => setRemember(e.target.checked)}
            style={{ accentColor: theme.electricBlue, width: 13, height: 13 }}
          />
          一个月内不再提示
        </label>
      </div>
    </div>
  )
}

function btnStyle(color: string): React.CSSProperties {
  return {
    flex: 1,
    padding: '9px 0',
    background: 'transparent',
    border: `1px solid ${color}`,
    borderRadius: 2,
    color,
    fontFamily: 'inherit',
    fontSize: 12,
    letterSpacing: '0.06em',
    cursor: 'pointer',
    transition: 'background 0.15s',
  }
}
