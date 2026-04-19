// ══════════════════════════════════════════════
// FairyWindow — 桌面宠物模式
// 常驻显示，接收 state 切换四个阶段动画
// 点击穿透由 Rust 侧光标监控处理
// ══════════════════════════════════════════════

import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import FairyHUD, { type FairyState } from './FairyHUD'

type FairyPayload = { state: FairyState; text: string }

export default function FairyWindow() {
  const [state, setState] = useState<FairyState>('idle')
  const [text, setText] = useState('')

  // Alt 键中继：此窗口聚焦时 WebView2 拦截系统键，需 DOM 捕获后转发给主窗口
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code === 'AltRight') { e.preventDefault(); import('@tauri-apps/api/event').then(({ emit }) => emit('ralt-keydown', null)) }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'AltRight') { e.preventDefault(); import('@tauri-apps/api/event').then(({ emit }) => emit('ralt-keyup', null)) }
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
  }, [])

  useEffect(() => {
    invoke('setup_fairy').catch(() => {})

    const p = listen<FairyPayload>('fairy-state', e => {
      setState(e.payload.state)
      setText(e.payload.text ?? '')
    })

    // 通知主窗口：fairy listener 已就绪，可以重发当前状态
    import('@tauri-apps/api/event').then(({ emit }) =>
      emit('fairy-window-ready', null).catch(() => {})
    )

    return () => { p.then(fn => fn()) }
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', background: 'transparent' }}>
      <FairyHUD state={state} text={text} />
    </div>
  )
}
