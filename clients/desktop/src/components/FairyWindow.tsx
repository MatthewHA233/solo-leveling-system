// ══════════════════════════════════════════════
// FairyWindow — 桌面宠物模式
// 常驻显示，接收 state 切换四个阶段动画
// 点击穿透由 Rust 侧光标监控处理
// ══════════════════════════════════════════════

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MessageSquare, Radio, Send } from 'lucide-react'
import { emit, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow, LogicalSize, PhysicalPosition } from '@tauri-apps/api/window'
import FairyHUD, { type FairyState } from './FairyHUD'
import HudSelect from './HudSelect'
import { MagneticButton } from './NeonUI'
import { hud, theme } from '../theme'
import type { ModelDef, ModelFreeQuota } from '../lib/local-api'
import { getFeatureModel, listModelFreeQuotas, setFeatureModel } from '../lib/model-audit'
import { MODEL_SELECT_POPUP_WIDTH, modelSelectOption } from '../lib/model-display'

type FairyPayload = { state: FairyState; text: string }
type FairyChatMode = 'regular' | 'omni'
type FairyConfigPayload = { scale?: number; aiMode?: FairyChatMode }
type FairyActionPayload =
  | { action: 'hide' }
  | { action: 'open-settings' }
  | { action: 'set-scale'; scale: number }
type FairyPanelMode = 'menu' | 'chat' | 'models'
type FairyPanel = { mode: FairyPanelMode; x: number; y: number }
type FairyFeature = 'fairy_chat' | 'fairy_omni_chat'

const MIN_SCALE = 0.4
const MAX_SCALE = 1
const DEFAULT_SCALE = 0.8
const BASE_FAIRY_W = 252
const BASE_FAIRY_H = 252
// fairy 视觉外圈半径 126px（最外环 360px × 0.7 缩放），气泡贴近圆右侧
const BASE_BUBBLE_LEFT = 224
const BASE_BUBBLE_TOP  = 86   // 气泡距窗口顶部，往上偏（fairy 中心 y=126）
const BUBBLE_PAD_H = 28     // bubble 左右内边距合计 (14*2)
const BUBBLE_PAD_V = 20     // bubble 上下内边距合计 (10*2)
const BUBBLE_MIN_W = 88     // 最小气泡宽度（仅状态动画/极短文字）
const BUBBLE_MAX_W = 480    // 最大气泡宽度
const BUBBLE_BOTTOM_MARGIN = 16  // 气泡底部到窗口底边留白
const RIGHT_MARGIN = 8      // 窗口右侧留白
const BUBBLE_FONT_STATE = 12  // 状态标签字号 px
const BUBBLE_FONT_TEXT  = 12  // 正文字号 px
const PANEL_MARGIN = 10
const PANEL_CENTER_OFFSET_X = 76
const PANEL_CENTER_OFFSET_Y = 34
const PANEL_BUBBLE_CLEARANCE = 10
const PANEL_SIZES: Record<FairyPanelMode, { w: number; h: number }> = {
  menu: { w: 210, h: 238 },
  chat: { w: 320, h: 238 },
  models: { w: 350, h: 268 },
}
const PANEL_Z_INDEX = 10020
const PANEL_POPUP_Z_INDEX = PANEL_Z_INDEX + 30
const PANEL_BOUNDS_SIZE = Object.values(PANEL_SIZES).reduce(
  (acc, size) => ({
    w: Math.max(acc.w, size.w),
    h: Math.max(acc.h, size.h),
  }),
  { w: 0, h: 0 },
)
const SCALE_PRESETS = [0.4, 0.6, 0.8, 1] as const
const MODEL_POPUP_WIDTH = Math.min(MODEL_SELECT_POPUP_WIDTH, 320)

function clampScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SCALE
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, n))
}

function scaled(value: number, scale: number): number {
  return Math.round(value * scale)
}

function getFairyMetrics(scale: number) {
  const s = clampScale(scale)
  const fairyW = scaled(BASE_FAIRY_W, s)
  const fairyH = scaled(BASE_FAIRY_H, s)
  return {
    fairyW,
    fairyH,
    bubbleLeft: scaled(BASE_BUBBLE_LEFT, s),
    bubbleTop: scaled(BASE_BUBBLE_TOP, s),
    radius: fairyW / 2,
  }
}

function getPanelSize(mode: FairyPanelMode) {
  return PANEL_SIZES[mode]
}

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

function isPanelElement(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.fairy-context-menu, .hud-select-popup')
}

function FairyMenuButton({
  children,
  meta,
  color = theme.electricBlue,
  onClick,
}: {
  readonly children: ReactNode
  readonly meta: string
  readonly color?: string
  readonly onClick: () => void
}) {
  return (
    <MagneticButton
      color={color}
      onClick={onClick}
      style={{
        width: '100%',
        height: 30,
        margin: '2px 0',
        padding: '0 8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        background: 'transparent',
        fontSize: 12,
        textAlign: 'left',
      }}
    >
      <span>{children}</span>
      <span style={{ fontFamily: theme.fontMono, fontSize: 9, opacity: 0.72 }}>{meta}</span>
    </MagneticButton>
  )
}

export default function FairyWindow() {
  const [state, setState] = useState<FairyState>('idle')
  const [text, setText] = useState('')
  const [bubbleW, setBubbleW] = useState(BUBBLE_MIN_W)
  const [scale, setScale] = useState(DEFAULT_SCALE)
  const [panel, setPanel] = useState<FairyPanel | null>(null)
  const [miniInput, setMiniInput] = useState('')
  const [miniMode, setMiniMode] = useState<FairyChatMode>('regular')
  const [models, setModels] = useState<ModelDef[]>([])
  const [freeQuotas, setFreeQuotas] = useState<ModelFreeQuota[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const modelsLoadedRef = useRef(false)
  const [featureModels, setFeatureModels] = useState<Record<FairyFeature, string>>({
    fairy_chat: 'qwen3.6-flash',
    fairy_omni_chat: 'qwen3.5-omni-flash-realtime',
  })
  const panelMode = panel?.mode ?? null
  const metrics = getFairyMetrics(scale)
  const expectedSizeRef = useRef<{ w: number; h: number }>({ w: metrics.fairyW, h: metrics.fairyH })
  const previousFairySizeRef = useRef<{ w: number; h: number }>({ w: metrics.fairyW, h: metrics.fairyH })
  const pendingSizeRef = useRef<{ w: number; h: number } | null>(null)
  const sizeRafRef = useRef<number | null>(null)

  const applyManagedSize = useCallback((w: number, h: number, immediate = false) => {
    const next = { w: Math.ceil(w), h: Math.ceil(h) }
    const prev = expectedSizeRef.current
    expectedSizeRef.current = next
    if (Math.abs(prev.w - next.w) < 1 && Math.abs(prev.h - next.h) < 1) return

    if (immediate) {
      if (sizeRafRef.current != null) {
        cancelAnimationFrame(sizeRafRef.current)
        sizeRafRef.current = null
      }
      pendingSizeRef.current = null
      getCurrentWindow().setSize(new LogicalSize(next.w, next.h)).catch(() => {})
      return
    }

    pendingSizeRef.current = next
    if (sizeRafRef.current != null) return

    sizeRafRef.current = requestAnimationFrame(() => {
      sizeRafRef.current = null
      const pending = pendingSizeRef.current
      pendingSizeRef.current = null
      if (!pending) return
      getCurrentWindow().setSize(new LogicalSize(pending.w, pending.h)).catch(() => {})
    })
  }, [])

  const ensurePanelWindowBounds = useCallback((nextPanel: FairyPanel) => {
    const w = Math.max(metrics.fairyW, Math.ceil(nextPanel.x + PANEL_BOUNDS_SIZE.w + PANEL_MARGIN))
    const h = Math.max(metrics.fairyH, Math.ceil(nextPanel.y + PANEL_BOUNDS_SIZE.h + PANEL_MARGIN))
    applyManagedSize(w, h, true)
  }, [applyManagedSize, metrics.fairyH, metrics.fairyW])

  const getDockedPanel = useCallback((mode: FairyPanelMode): FairyPanel => {
    const bubble = document.querySelector('.fairy-bubble') as HTMLElement | null
    const bubbleBottom = bubble?.getBoundingClientRect().bottom
    const dockY = metrics.fairyH / 2 + PANEL_CENTER_OFFSET_Y
    const clearBubbleY = bubbleBottom
      ? Math.ceil(bubbleBottom + PANEL_BUBBLE_CLEARANCE)
      : dockY

    return {
      mode,
      // 以 Fairy 中心为锚点，缩放时全局距离不漂。
      x: Math.round(metrics.fairyW / 2 + PANEL_CENTER_OFFSET_X),
      y: Math.round(Math.max(dockY, clearBubbleY)),
    }
  }, [metrics.fairyH, metrics.fairyW])

  const closePanel = useCallback(() => {
    setPanel(null)
    invoke('set_fairy_cursor_menu_open', { open: false }).catch(() => {})
  }, [])

  const openPanel = useCallback((mode: FairyPanelMode) => {
    invoke('set_fairy_cursor_menu_open', { open: true }).catch(() => {})
    setPanel((prev) => {
      const nextPanel = prev ? { ...prev, mode } : getDockedPanel(mode)
      ensurePanelWindowBounds(nextPanel)
      return nextPanel
    })
  }, [ensurePanelWindowBounds, getDockedPanel])

  const sendAction = useCallback(async (payload: FairyActionPayload) => {
    if (payload.action === 'set-scale') setScale(clampScale(payload.scale))
    await emit('fairy-action', payload).catch(() => {})
    if (payload.action === 'hide') {
      closePanel()
      getCurrentWindow().hide().catch(() => {})
    }
    if (payload.action === 'open-settings') closePanel()
  }, [closePanel])

  const updateScale = useCallback((nextScale: number) => {
    void sendAction({ action: 'set-scale', scale: clampScale(nextScale) })
  }, [sendAction])

  const handleMiniSubmit = useCallback(() => {
    const trimmed = miniInput.trim()
    if (!trimmed) return
    emit('fairy-chat-submit', { text: trimmed, mode: miniMode }).catch(() => {})
    setMiniInput('')
    closePanel()
  }, [closePanel, miniInput, miniMode])

  const handleFairyContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    invoke('set_fairy_cursor_menu_open', { open: true }).catch(() => {})
    const nextPanel = getDockedPanel('menu')
    ensurePanelWindowBounds(nextPanel)
    setPanel(nextPanel)
  }, [ensurePanelWindowBounds, getDockedPanel])

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
    invoke('setup_fairy', { radius: metrics.radius }).catch(() => {})

    const p = listen<FairyPayload>('fairy-state', e => {
      const { state: s, text: t } = e.payload
      setState(s)
      setText(t ?? '')
    })
    const c = listen<FairyConfigPayload>('fairy-config', e => {
      if (e.payload?.scale !== undefined) setScale(clampScale(e.payload.scale))
      if (e.payload?.aiMode === 'regular' || e.payload?.aiMode === 'omni') {
        setMiniMode(e.payload.aiMode)
      }
    })

    // 通知主窗口：fairy listener 已就绪，可以重发当前状态
    emit('fairy-window-ready', null).catch(() => {})

    return () => {
      closePanel()
      p.then(fn => fn())
      c.then(fn => fn())
    }
    // 只在窗口启动时安装 listener；半径更新由下面的 effect 负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    invoke('update_fairy_cursor_radius', { radius: metrics.radius }).catch(() => {})
  }, [metrics.radius])

  useEffect(() => {
    return () => {
      if (sizeRafRef.current != null) cancelAnimationFrame(sizeRafRef.current)
    }
  }, [])

  useEffect(() => {
    if (!panel) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closePanel, panel])

  useEffect(() => {
    if (!panel) return
    const onPointerDown = (e: PointerEvent) => {
      if (!isPanelElement(e.target)) closePanel()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [closePanel, panel])

  useEffect(() => {
    if (!panel) return
    let unlisten: (() => void) | null = null
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) closePanel()
    }).then((fn) => { unlisten = fn })
    return () => { unlisten?.() }
  }, [closePanel, panel])

  useEffect(() => {
    if (panelMode !== 'models') return
    let cancelled = false

    if (modelsLoadedRef.current) {
      Promise.all([
        listModelFreeQuotas(),
        getFeatureModel('fairy_chat', 'qwen3.6-flash'),
        getFeatureModel('fairy_omni_chat', 'qwen3.5-omni-flash-realtime'),
      ])
        .then(([quotaRows, chatModel, omniModel]) => {
          if (cancelled) return
          setFreeQuotas(quotaRows)
          setFeatureModels({ fairy_chat: chatModel, fairy_omni_chat: omniModel })
        })
        .catch(() => {})
      return () => { cancelled = true }
    }

    setModelsLoading(true)
    ;(async () => {
      try {
        const [rows, quotaRows, chatModel, omniModel] = await Promise.all([
          invoke<ModelDef[]>('list_models'),
          listModelFreeQuotas(),
          getFeatureModel('fairy_chat', 'qwen3.6-flash'),
          getFeatureModel('fairy_omni_chat', 'qwen3.5-omni-flash-realtime'),
        ])
        if (cancelled) return
        modelsLoadedRef.current = true
        setModels(rows)
        setFreeQuotas(quotaRows)
        setFeatureModels({ fairy_chat: chatModel, fairy_omni_chat: omniModel })
      } catch {
        if (!cancelled) setModels([])
      } finally {
        if (!cancelled) setModelsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [panelMode])

  const freeQuotaByModel = useMemo(() => new Map(freeQuotas.map((q) => [q.model_id, q])), [freeQuotas])
  const textModelOptions = useMemo(() => {
    const filtered = models.filter((m) => m.category === 'text')
    return (filtered.length > 0 ? filtered : models).map((m) => modelSelectOption(m, freeQuotaByModel.get(m.id)))
  }, [freeQuotaByModel, models])
  const realtimeModelOptions = useMemo(() => {
    const filtered = models.filter((m) => m.category === 'realtime')
    return (filtered.length > 0 ? filtered : models).map((m) => modelSelectOption(m, freeQuotaByModel.get(m.id)))
  }, [freeQuotaByModel, models])

  const changeFeatureModel = useCallback(async (feature: FairyFeature, modelId: string) => {
    setFeatureModels((prev) => ({ ...prev, [feature]: modelId }))
    try {
      await setFeatureModel(feature, modelId)
      await emit('model-feature-binding-updated', { feature, modelId }).catch(() => {})
      window.dispatchEvent(new CustomEvent('model-feature-binding-updated', {
        detail: { feature, modelId },
      }))
    } catch {}
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

  // 缩放时保持 Fairy 视觉中心点不动；否则 Tauri resize 会以窗口左上角为锚点。
  useLayoutEffect(() => {
    const prev = previousFairySizeRef.current
    const dx = (prev.w - metrics.fairyW) / 2
    const dy = (prev.h - metrics.fairyH) / 2
    previousFairySizeRef.current = { w: metrics.fairyW, h: metrics.fairyH }
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return

    setPanel((prevPanel) => prevPanel
      ? { ...prevPanel, x: prevPanel.x - dx, y: prevPanel.y - dy }
      : prevPanel)

    const win = getCurrentWindow()
    Promise.all([win.outerPosition(), win.scaleFactor()])
      .then(([pos, factor]) => {
        return win.setPosition(new PhysicalPosition(
          Math.round(pos.x + dx * factor),
          Math.round(pos.y + dy * factor),
        ))
      })
      .catch(() => {})
  }, [metrics.fairyH, metrics.fairyW])

  // 实测气泡高度 → 设置窗口尺寸（绕开字体度量估算误差，避免末尾字符被裁）
  useLayoutEffect(() => {
    const withPanelBounds = (w: number, h: number) => {
      if (!panel) return { w, h }
      return {
        w: Math.max(w, Math.ceil(panel.x + PANEL_BOUNDS_SIZE.w + PANEL_MARGIN)),
        h: Math.max(h, Math.ceil(panel.y + PANEL_BOUNDS_SIZE.h + PANEL_MARGIN)),
      }
    }

    const setManaged = (w: number, h: number) => {
      const next = withPanelBounds(w, h)
      applyManagedSize(next.w, next.h)
    }

    if (state === 'idle') {
      setManaged(metrics.fairyW, metrics.fairyH)
      return
    }

    const winW = metrics.bubbleLeft + bubbleW + RIGHT_MARGIN
    let lastH = 0
    const apply = (bubbleH: number) => {
      const winH = Math.max(metrics.fairyH, metrics.bubbleTop + Math.ceil(bubbleH) + BUBBLE_BOTTOM_MARGIN)
      if (winH === lastH && !panel) return
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
  }, [
    state,
    text,
    bubbleW,
    metrics.bubbleLeft,
    metrics.bubbleTop,
    metrics.fairyH,
    metrics.fairyW,
    panel,
    applyManagedSize,
  ])

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
    <div
      style={{ width: '100vw', height: '100vh', background: 'transparent' }}
      onMouseDown={(e) => {
        if (!panel) return
        if (!isPanelElement(e.target)) closePanel()
      }}
    >
      {/* fairy-overlay 锁左侧 280px；气泡 left 定位 + 动态宽度 */}
      <style>{`
        .fairy-overlay {
          width: ${metrics.fairyW}px !important;
          height: ${metrics.fairyH}px !important;
          left: 0 !important;
          top: 0 !important;
          right: auto !important;
          bottom: auto !important;
        }
        .fairy-bubble {
          left: ${metrics.bubbleLeft}px !important; right: auto !important;
          top: ${metrics.bubbleTop}px !important; transform: none !important;
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
        .fairy-context-menu {
          position: fixed;
          z-index: ${PANEL_Z_INDEX};
          width: ${panel ? getPanelSize(panel.mode).w : PANEL_SIZES.menu.w}px;
          padding: 8px;
          box-sizing: border-box;
          background: ${theme.hudFill};
          border: 1px solid ${theme.hudFrame};
          clip-path: ${hud.chamfer12};
          -webkit-clip-path: ${hud.chamfer12};
          box-shadow:
            0 12px 36px rgba(0,0,0,0.45),
            0 0 24px ${theme.hudHalo},
            inset 0 1px 0 rgba(255,255,255,0.08);
          pointer-events: auto;
          user-select: none;
          backdrop-filter: blur(12px);
          overflow: hidden;
          transform-origin: 18px 18px;
          will-change: transform, opacity;
          contain: layout paint style;
          animation: fairyPanelMaterialize 150ms cubic-bezier(.2,.9,.2,1) both;
          transition: width 150ms cubic-bezier(.2,.9,.2,1);
        }
        .fairy-context-menu::before {
          content: '';
          position: absolute;
          left: 8px;
          right: 8px;
          top: 0;
          height: 34px;
          background: linear-gradient(180deg, rgba(0,229,255,0.22), rgba(0,229,255,0));
          opacity: 0;
          transform: translateY(-42px);
          pointer-events: none;
          animation: fairyPanelSweep 420ms ease-out 35ms both;
        }
        .fairy-panel-content {
          position: relative;
          z-index: 1;
          animation: fairyPanelContentIn 150ms cubic-bezier(.2,.9,.2,1) both;
        }
        .fairy-context-title {
          padding: 4px 6px 7px;
          font-family: ${theme.fontMono};
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 1.5px;
          color: ${theme.electricBlue};
          text-shadow: 0 0 8px ${theme.electricBlue}88;
        }
        .fairy-context-subtitle {
          padding: 0 6px 8px;
          color: ${theme.textMuted};
          font-size: 10.5px;
          line-height: 1.5;
        }
        .fairy-context-scale-row {
          display: flex;
          justify-content: center;
          gap: 5px;
          margin: 7px auto 0;
          padding-top: 7px;
          border-top: 1px solid ${theme.hudFrameSoft};
        }
        .fairy-mini-input-wrap:focus-within {
          border-color: ${theme.electricBlue}66 !important;
          box-shadow: inset 0 0 16px ${theme.electricBlue}14, 0 0 0 1px ${theme.electricBlue}22 !important;
        }
        .fairy-mini-textarea::placeholder {
          color: ${theme.textMuted};
          font-family: ${theme.fontMono};
          letter-spacing: 0.5px;
        }
        .fairy-mini-textarea:focus { outline: none; }
        @keyframes fairyPanelMaterialize {
          0% {
            opacity: 0;
            transform: translate3d(-6px, 8px, 0) scale(0.965);
            filter: saturate(1.35) brightness(1.1);
          }
          100% {
            opacity: 1;
            transform: translate3d(0, 0, 0) scale(1);
            filter: saturate(1) brightness(1);
          }
        }
        @keyframes fairyPanelContentIn {
          0% { opacity: 0; transform: translate3d(10px, 0, 0); }
          100% { opacity: 1; transform: translate3d(0, 0, 0); }
        }
        @keyframes fairyPanelSweep {
          0% { opacity: 0; transform: translateY(-42px); }
          18% { opacity: 0.72; }
          100% { opacity: 0; transform: translateY(170px); }
        }
      `}</style>
      <FairyHUD state={state} text={text} scale={scale} onContextMenu={handleFairyContextMenu} />
      {panel && (
        <div
          className="fairy-context-menu"
          style={{ left: panel.x, top: panel.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div key={panel.mode} className="fairy-panel-content">
            {panel.mode === 'menu' && (
              <FairyQuickMenu
                scale={scale}
                onOpenPanel={openPanel}
                onOpenSettings={() => void sendAction({ action: 'open-settings' })}
                onHide={() => void sendAction({ action: 'hide' })}
                onScale={updateScale}
              />
            )}
            {panel.mode === 'chat' && (
              <FairyMiniChat
                value={miniInput}
                mode={miniMode}
                onChange={setMiniInput}
                onModeChange={setMiniMode}
                onBack={() => openPanel('menu')}
                onSubmit={handleMiniSubmit}
              />
            )}
            {panel.mode === 'models' && (
              <FairyModelQuickPanel
                modelsLoading={modelsLoading}
                textModel={featureModels.fairy_chat}
                omniModel={featureModels.fairy_omni_chat}
                textOptions={textModelOptions}
                omniOptions={realtimeModelOptions}
                onBack={() => openPanel('menu')}
                onChangeModel={changeFeatureModel}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FairyQuickMenu({
  scale,
  onOpenPanel,
  onOpenSettings,
  onHide,
  onScale,
}: {
  readonly scale: number
  readonly onOpenPanel: (mode: FairyPanelMode) => void
  readonly onOpenSettings: () => void
  readonly onHide: () => void
  readonly onScale: (scale: number) => void
}) {
  return (
    <>
      <div className="fairy-context-title">FAIRY QUICK PANEL</div>
      <FairyMenuButton meta="ALT" onClick={() => onOpenPanel('chat')}>呼出对话框</FairyMenuButton>
      <FairyMenuButton meta="MODEL" onClick={() => onOpenPanel('models')}>快捷换模型</FairyMenuButton>
      <FairyMenuButton meta="CFG" onClick={onOpenSettings}>Fairy详细设置</FairyMenuButton>
      <FairyMenuButton meta="HIDE" color={theme.warningOrange} onClick={onHide}>隐藏 Fairy</FairyMenuButton>
      <ScaleButtons scale={scale} onScale={onScale} />
    </>
  )
}

function FairyMiniChat({
  value,
  mode,
  onChange,
  onModeChange,
  onBack,
  onSubmit,
}: {
  readonly value: string
  readonly mode: FairyChatMode
  readonly onChange: (value: string) => void
  readonly onModeChange: (mode: FairyChatMode) => void
  readonly onBack: () => void
  readonly onSubmit: () => void
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const isOmniMode = mode === 'omni'

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <>
      <PanelHeader title="MINI CHAT" onBack={onBack} />
      <div className="fairy-context-subtitle">直接把一句话交给 Fairy，不切回主界面。</div>
      <div
        className="fairy-mini-input-wrap"
        style={{
          background: 'rgba(0,12,28,0.6)',
          border: `1px solid ${theme.hudFrameSoft}`,
          clipPath: hud.chamfer8,
          WebkitClipPath: hud.chamfer8,
          padding: '10px 12px',
          transition: 'border-color 0.2s, box-shadow 0.2s',
          boxShadow: 'inset 0 0 12px rgba(0,229,255,0.04)',
        }}
      >
        <textarea
          ref={inputRef}
          className="fairy-mini-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSubmit()
            }
          }}
          placeholder="输入消息..."
          rows={4}
          style={{
            width: '100%',
            minHeight: 78,
            maxHeight: 128,
            background: 'transparent',
            border: 'none',
            color: theme.textPrimary,
            fontFamily: theme.fontBody,
            fontSize: 13,
            lineHeight: 1.5,
            resize: 'none',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <button
            type="button"
            title={isOmniMode ? '当前：Omni 全模态，点击切换普通聊天' : '当前：普通聊天，点击切换 Omni 全模态'}
            onClick={() => onModeChange(isOmniMode ? 'regular' : 'omni')}
            style={{
              background: isOmniMode ? `${theme.shadowPurple}18` : `${theme.electricBlue}12`,
              border: `1px solid ${isOmniMode ? theme.shadowPurple + '88' : theme.electricBlue + '66'}`,
              padding: 0,
              width: 26,
              height: 26,
              color: isOmniMode ? '#C9A8FF' : theme.electricBlue,
              boxShadow: isOmniMode
                ? `0 0 8px ${theme.shadowPurple}66, inset 0 0 4px ${theme.shadowPurple}33`
                : `0 0 8px ${theme.electricBlue}44, inset 0 0 4px ${theme.electricBlue}22`,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              clipPath: hud.chamfer8,
              WebkitClipPath: hud.chamfer8,
            }}
          >
            {isOmniMode ? <Radio size={12} /> : <MessageSquare size={12} />}
          </button>
          <button
            className="send-btn"
            type="button"
            onClick={onSubmit}
            disabled={!value.trim()}
            style={{
              background: value.trim()
                ? `radial-gradient(circle at 35% 35%, ${theme.electricBlue}55 0%, ${theme.electricBlue}1A 70%)`
                : 'rgba(255,255,255,0.04)',
              border: `1px solid ${value.trim() ? theme.electricBlue + '88' : theme.hudFrameSoft}`,
              borderRadius: '50%',
              padding: 0,
              width: 26,
              height: 26,
              color: value.trim() ? theme.electricBlue : theme.textMuted,
              opacity: value.trim() ? 1 : 0.55,
              cursor: value.trim() ? 'pointer' : 'default',
              transition: 'all 0.15s ease',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Send size={12} style={{ marginLeft: -1 }} />
          </button>
        </div>
      </div>
    </>
  )
}

function FairyModelQuickPanel({
  modelsLoading,
  textModel,
  omniModel,
  textOptions,
  omniOptions,
  onBack,
  onChangeModel,
}: {
  readonly modelsLoading: boolean
  readonly textModel: string
  readonly omniModel: string
  readonly textOptions: ReturnType<typeof modelSelectOption>[]
  readonly omniOptions: ReturnType<typeof modelSelectOption>[]
  readonly onBack: () => void
  readonly onChangeModel: (feature: FairyFeature, modelId: string) => void
}) {
  return (
    <>
      <PanelHeader title="MODEL SWITCH" onBack={onBack} />
      <div className="fairy-context-subtitle">复用主对话框的模型选择器，改的是 Fairy 实际绑定。</div>
      <FeatureModelSelect
        label="常规聊天"
        value={textModel}
        options={textOptions}
        disabled={modelsLoading}
        onChange={(modelId) => onChangeModel('fairy_chat', modelId)}
      />
      <FeatureModelSelect
        label="Omni 全模态"
        value={omniModel}
        options={omniOptions}
        disabled={modelsLoading}
        onChange={(modelId) => onChangeModel('fairy_omni_chat', modelId)}
      />
      {modelsLoading && (
        <div style={{ marginTop: 8, color: theme.textMuted, fontSize: 10, fontFamily: theme.fontMono }}>
          SYNCING MODEL INDEX...
        </div>
      )}
    </>
  )
}

function FeatureModelSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly label: string
  readonly value: string
  readonly options: ReturnType<typeof modelSelectOption>[]
  readonly disabled: boolean
  readonly onChange: (modelId: string) => void
}) {
  return (
    <div style={{ display: 'grid', gap: 5, marginBottom: 10 }}>
      <div style={{
        fontSize: 10,
        fontFamily: theme.fontMono,
        letterSpacing: 1.2,
        color: theme.textSecondary,
      }}>
        {label}
      </div>
      <HudSelect
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled || options.length === 0}
        popupWidth={MODEL_POPUP_WIDTH}
        popupZIndex={PANEL_POPUP_Z_INDEX}
        placeholder={disabled ? '加载中...' : '选择模型'}
      />
    </div>
  )
}

function PanelHeader({
  title,
  onBack,
}: {
  readonly title: string
  readonly onBack: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px 7px' }}>
      <button
        type="button"
        onClick={onBack}
        style={{
          width: 24,
          height: 22,
          padding: 0,
          border: `1px solid ${theme.hudFrameSoft}`,
          background: 'rgba(0,229,255,0.04)',
          color: theme.electricBlue,
          clipPath: hud.chamfer8,
          WebkitClipPath: hud.chamfer8,
          cursor: 'pointer',
          fontFamily: theme.fontMono,
          fontSize: 13,
          lineHeight: '20px',
        }}
      >
        ‹
      </button>
      <div className="fairy-context-title" style={{ padding: 0 }}>{title}</div>
    </div>
  )
}

function ScaleButtons({
  scale,
  onScale,
}: {
  readonly scale: number
  readonly onScale: (scale: number) => void
}) {
  return (
    <div className="fairy-context-scale-row">
      {SCALE_PRESETS.map((nextScale) => (
        <MagneticButton
          key={nextScale}
          color={Math.abs(scale - nextScale) < 0.01 ? theme.expGreen : theme.electricBlue}
          onClick={() => onScale(nextScale)}
          style={{
            width: 40,
            height: 25,
            padding: '0 6px',
            fontSize: 10,
            background: Math.abs(scale - nextScale) < 0.01 ? `${theme.expGreen}12` : 'transparent',
          }}
        >
          {Math.round(nextScale * 100)}%
        </MagneticButton>
      ))}
    </div>
  )
}
