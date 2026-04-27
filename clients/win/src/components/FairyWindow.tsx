// ══════════════════════════════════════════════
// FairyWindow — 桌面宠物模式
// 常驻显示，接收 state 切换四个阶段动画
// 点击穿透由 Rust 侧光标监控处理
// ══════════════════════════════════════════════

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import FairyHUD, { type FairyState } from './FairyHUD'

type FairyPayload = { state: FairyState; text: string }

const FAIRY_W = 280
const FAIRY_H = 280
// fairy 圆形视觉边界约在 230px（右侧有 ~50px 透明区），气泡左边缘贴近圆边
const BUBBLE_LEFT = 248
const BUBBLE_TOP  = 96   // 气泡距窗口顶部，往上偏（fairy 中心 y=140）
const BUBBLE_PAD_H = 28     // bubble 左右内边距合计 (14*2)
const BUBBLE_PAD_V = 20     // bubble 上下内边距合计 (10*2)
const BUBBLE_MIN_W = 88     // 最小气泡宽度（仅状态动画/极短文字）
const BUBBLE_MAX_W = 480    // 最大气泡宽度
const BUBBLE_BOTTOM_MARGIN = 16  // 气泡底部到窗口底边留白
const RIGHT_MARGIN = 8      // 窗口右侧留白
const BUBBLE_FONT_STATE = 12  // 状态标签字号 px
const BUBBLE_FONT_TEXT  = 12  // 正文字号 px

function rawTextWidth(text: string): number {
  let raw = 0
  for (const c of text) raw += c.charCodeAt(0) > 127 ? BUBBLE_FONT_TEXT : Math.ceil(BUBBLE_FONT_TEXT * 0.6)
  return raw
}

// 按 2 行估算宽度，超过最大值封顶
function calcBubbleWidth(text: string): number {
  if (!text) return BUBBLE_MIN_W
  const twoLine = Math.ceil(rawTextWidth(text) / 2) + BUBBLE_PAD_H
  return Math.min(Math.max(twoLine, BUBBLE_MIN_W), BUBBLE_MAX_W)
}

export default function FairyWindow() {
  const [state, setState] = useState<FairyState>('idle')
  const [text, setText] = useState('')
  const [bubbleW, setBubbleW] = useState(BUBBLE_MIN_W)

  // Alt 键中继：此窗口聚焦时 WebView2 拦截系统键，需 DOM 捕获后转发给主窗口
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code === 'AltRight') { e.preventDefault(); import('@tauri-apps/api/event').then(({ emit }) => emit('ralt-keydown', null)) }
      else if (e.code === 'ControlRight') { e.preventDefault(); import('@tauri-apps/api/event').then(({ emit }) => emit('voice-cancel', null)) }
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
      const { state: s, text: t } = e.payload
      setState(s)
      setText(t ?? '')
    })

    // 通知主窗口：fairy listener 已就绪，可以重发当前状态
    import('@tauri-apps/api/event').then(({ emit }) =>
      emit('fairy-window-ready', null).catch(() => {})
    )

    return () => { p.then(fn => fn()) }
  }, [])

  // 宽度先按估算（用于约束气泡 layout），高度由 ResizeObserver 实测气泡 DOM 决定
  useEffect(() => {
    const goIdle = state === 'idle'
    const targetBubbleW = goIdle ? BUBBLE_MIN_W : calcBubbleWidth(text)
    const timer = window.setTimeout(() => {
      setBubbleW(targetBubbleW)
    }, 80)
    return () => window.clearTimeout(timer)
  }, [state, text])

  // 期望尺寸（管理性 setSize 的目标）— 用于 onResized 反弹检测
  const expectedSizeRef = useRef<{ w: number; h: number }>({ w: FAIRY_W, h: FAIRY_H })

  // 实测气泡高度 → 设置窗口尺寸（绕开字体度量估算误差，避免末尾字符被裁）
  useLayoutEffect(() => {
    const win = getCurrentWindow()

    const setManaged = (w: number, h: number) => {
      expectedSizeRef.current = { w, h }
      win.setSize(new LogicalSize(w, h)).catch(() => {})
    }

    if (state === 'idle') {
      setManaged(FAIRY_W, FAIRY_H)
      return
    }

    const winW = BUBBLE_LEFT + bubbleW + RIGHT_MARGIN
    let lastH = 0
    const apply = (bubbleH: number) => {
      const winH = Math.max(FAIRY_H, BUBBLE_TOP + Math.ceil(bubbleH) + BUBBLE_BOTTOM_MARGIN)
      if (winH === lastH) return
      lastH = winH
      setManaged(winW, winH)
    }

    let raf = 0
    const tick = () => {
      const el = document.querySelector('.fairy-bubble') as HTMLElement | null
      if (el) {
        apply(el.getBoundingClientRect().height)
        const ro = new ResizeObserver((entries) => {
          for (const e of entries) apply(e.contentRect.height + BUBBLE_PAD_V)
        })
        ro.observe(el)
        ;(tick as any).cleanup = () => ro.disconnect()
      } else {
        raf = requestAnimationFrame(tick)
      }
    }
    tick()
    return () => {
      cancelAnimationFrame(raf)
      ;(tick as any).cleanup?.()
    }
  }, [state, text, bubbleW])

  // 反 Aero Snap 守卫：用户 Win+方向键 / 拖到屏幕边缘会强制改变窗口尺寸，
  // 监听 onResized 检测偏差并恢复到 expectedSize
  useEffect(() => {
    const win = getCurrentWindow()
    let unlisten: (() => void) | null = null
    let scale = 1
    let restoring = false
    win.scaleFactor().then((s) => { scale = s })
    win.onResized(({ payload }) => {
      if (restoring) return
      const exp = expectedSizeRef.current
      const actualW = payload.width / scale
      const actualH = payload.height / scale
      const dW = Math.abs(actualW - exp.w)
      const dH = Math.abs(actualH - exp.h)
      // 容忍 4px 误差（HiDPI 取整），超过则视为外部 snap，恢复
      if (dW > 4 || dH > 4) {
        restoring = true
        win.setSize(new LogicalSize(exp.w, exp.h)).finally(() => {
          setTimeout(() => { restoring = false }, 50)
        })
      }
    }).then((fn) => { unlisten = fn })
    return () => { unlisten?.() }
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', background: 'transparent' }}>
      {/* fairy-overlay 锁左侧 280px；气泡 left 定位 + 动态宽度 */}
      <style>{`
        .fairy-overlay { width: ${FAIRY_W}px !important; left: 0 !important; right: auto !important; }
        .fairy-bubble {
          left: ${BUBBLE_LEFT}px !important; right: auto !important;
          top: ${BUBBLE_TOP}px !important; transform: none !important;
          max-width: ${bubbleW}px !important; width: ${bubbleW}px !important;
          padding: 10px 14px !important;
          background: linear-gradient(135deg, rgba(8,22,48,0.92) 0%, rgba(14,40,80,0.92) 100%) !important;
          border: 1px solid rgba(80,170,255,0.45) !important;
          border-radius: 14px !important;
          box-shadow:
            0 4px 16px rgba(0,0,0,0.4),
            0 0 18px rgba(60,150,255,0.25),
            inset 0 1px 0 rgba(255,255,255,0.08) !important;
        }
        /* 气泡尾巴：从左下指向 fairy */
        .fairy-bubble::before {
          content: '';
          position: absolute;
          left: -7px; bottom: 14px;
          width: 0; height: 0;
          border-style: solid;
          border-width: 6px 8px 6px 0;
          border-color: transparent rgba(80,170,255,0.45) transparent transparent;
        }
        .fairy-bubble::after {
          content: '';
          position: absolute;
          left: -5px; bottom: 14px;
          width: 0; height: 0;
          border-style: solid;
          border-width: 6px 8px 6px 0;
          border-color: transparent rgba(14,40,80,0.92) transparent transparent;
        }
        .fairy-bubble-state {
          font-size: ${BUBBLE_FONT_STATE}px !important;
          color: rgba(120,200,255,1) !important;
          letter-spacing: 1.5px !important;
          margin-bottom: 4px !important;
          text-shadow: 0 0 8px rgba(80,170,255,0.6) !important;
        }
        .fairy-bubble-text {
          font-size: ${BUBBLE_FONT_TEXT}px !important;
          color: rgba(220,235,255,0.95) !important;
          line-height: 1.55 !important;
          word-break: normal !important;
          overflow-wrap: anywhere !important;
        }
      `}</style>
      <FairyHUD state={state} text={text} />
    </div>
  )
}
