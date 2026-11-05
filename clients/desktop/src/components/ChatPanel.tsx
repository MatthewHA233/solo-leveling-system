// ══════════════════════════════════════════════
// Chat Panel — 与 Fairy 的对话（钛合金机体：通讯模块）
//
// 视觉：
//   · 左侧一条机体侧脊：竖排铭文 + LED 灯柱，灯柱跟 Fairy 状态走
//     （待命常亮一格 / 思考逐格追光 / 在听随你的音量涨落 / 说话整柱呼吸）
//   · 头部是一条全息玻璃带：呼号 + 状态行 + 上下文段码条（满了会压缩旧对话）
//   · Fairy 的话直接落在钛板上；主人的话在下沉的黑玻璃槽里；语音波形是 LED 点阵柱
//   · 冷色只在「系统时刻」出现：按住右 Alt 时的 LISTENING
// ══════════════════════════════════════════════

import { useCallback, useMemo, useRef, useEffect, useState, type MutableRefObject } from 'react'
import { MessageSquare, Camera, Eye, Volume2, VolumeX, Bug, Radio, History, X, Play, Pause, ImagePlus } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createPortal } from 'react-dom'
import { theme, ti } from '../theme'
import type { ChatMessage, OmniDebugInfo } from '../App'
import type { ApiRequestSnapshot } from '../lib/llm/api'
import { CHAT_IMAGES_UPDATED, MAX_CHAT_IMAGES, prepareChatImage, type PendingImage } from '../lib/agent/chat-images'
import type { ModelCallLog, ModelDef, ModelFreeQuota } from '../lib/local-api'
import { MODEL_SELECT_POPUP_WIDTH, modelSelectOption } from '../lib/model-display'
import { getFeatureModel, listModelFreeQuotas, setFeatureModel } from '../lib/model-audit'
import type { FairyState } from './FairyHUD'
import DebugRequestModal from './DebugRequestModal'
import OmniDebugModal from './OmniDebugModal'
import Tooltip from './Tooltip'
import HudSelect from './HudSelect'
import ModelUsageBadge from './ModelUsageBadge'
import IconButton from './ui/IconButton'
import LedSegments from './ui/LedSegments'
import FairyMarkdown from './FairyMarkdown'

// ── 可调旋钮 ──
const TEXT_SIZE = 13.5
const SPINE_WIDTH = 24
const SPINE_LEDS = 8
const LED_ROW = 3            // 点阵柱每格高度（2px 灯 + 1px 缝）
const WAVEFORM_BARS = 24
const LISTEN_BARS = 28

const STATE_LABEL: Record<FairyState, string> = {
  idle: '待命',
  thinking: '思考中',
  listening: '在听',
  speaking: '说话中',
}
const STATE_DOT: Record<FairyState, string> = {
  idle: 'ti-dot ti-dot-ok',
  thinking: 'ti-dot ti-dot-led',
  listening: 'ti-dot ti-dot-sys',
  speaking: 'ti-dot ti-dot-sys',
}

/** 纯 ASCII 的呼号用大写科技字（FAIRY），中文呼号原样显示 */
function displayCallsign(name: string): string {
  return /^[\x20-\x7E]+$/.test(name) ? name.toUpperCase() : name
}

/** 音量 0–1 → 点阵柱高度（按 3px 一格取整，灯格对齐才像 LED） */
function ledHeight(v: number, maxRows: number): number {
  return Math.max(1, Math.round(Math.min(1, Math.max(0, v)) * maxRows)) * LED_ROW
}

function ledColumn(color: string): string {
  return `repeating-linear-gradient(0deg, ${color} 0 2px, transparent 2px ${LED_ROW}px)`
}

/** Rust 录音的实时音量（voice://level）；只在 active 时订阅 */
function useVoiceLevels(active: boolean, keep: number): number[] {
  const [levels, setLevels] = useState<number[]>(() => Array(keep).fill(0))
  useEffect(() => {
    if (!active) {
      setLevels(Array(keep).fill(0))
      return
    }
    let disposed = false
    let unlisten: (() => void) | null = null
    listen<{ level: number }>('voice://level', ({ payload }) => {
      // 与 Fairy 悬浮窗同一套映射：先减底噪再放大
      const v = Math.min(1, Math.max(0, payload.level - 0.012) * 6)
      setLevels((prev) => [...prev.slice(1), v])
    }).then((u) => {
      if (disposed) u()
      else unlisten = u
    }).catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [active, keep])
  return levels
}

interface Props {
  readonly messages: readonly ChatMessage[]
  readonly isProcessing: boolean
  readonly onSend: (text: string, images: readonly PendingImage[]) => void
  /** 语音发送时取走待发的图片（面板把取图函数写进这里） */
  readonly takeVoiceImagesRef?: MutableRefObject<() => readonly PendingImage[]>
  /** 呼号来自 AI 人设配置（名称 / 称呼用户为），不硬编码 */
  readonly agentName?: string
  readonly userCallsign?: string
  /** 主人在洪流域锁定的卡片（Fairy 正注视的目标），显示注视提示条 */
  readonly gazeTarget?: { kind: 'thought' | 'bili_transcript'; title: string | null; text: string } | null
  readonly aiMode?: 'regular' | 'omni'
  readonly onToggleAiMode?: () => void
  readonly cameraReady?: boolean
  readonly cameraPresent?: boolean
  readonly cameraWindowOpen?: boolean
  readonly onToggleCamera?: () => void
  readonly ttsEnabled?: boolean
  readonly onToggleTts?: () => void
  readonly onOpenSessions?: () => void
  readonly sessionsOpen?: boolean
  /** 当前会话标题（AI 起名 / 手动重命名后更新） */
  readonly sessionTitle?: string
  /** Fairy 此刻的状态：驱动侧脊灯柱、状态行、底部 LISTENING */
  readonly fairyState?: FairyState
  /** 上下文占用 0–1（历史字符数 / 压缩高水位） */
  readonly contextRatio?: number
}

function parseModalityList(raw: string | null | undefined): string[] {
  try {
    const list = JSON.parse(raw ?? '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export default function ChatPanel({ messages, isProcessing, onSend, takeVoiceImagesRef, agentName = 'Fairy', userCallsign = '主人', gazeTarget = null, aiMode = 'regular', onToggleAiMode, cameraReady, cameraPresent, cameraWindowOpen, onToggleCamera, ttsEnabled, onToggleTts, onOpenSessions, sessionsOpen, sessionTitle, fairyState = 'idle', contextRatio = 0 }: Props) {
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<readonly PendingImage[]>([])
  const pendingImagesRef = useRef<readonly PendingImage[]>([])
  const [imageNote, setImageNote] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [models, setModels] = useState<ModelDef[]>([])
  const [freeQuotas, setFreeQuotas] = useState<ModelFreeQuota[]>([])
  const [featureModels, setFeatureModels] = useState<Record<'fairy_chat' | 'fairy_omni_chat', string>>({
    fairy_chat: 'qwen3.6-flash',
    fairy_omni_chat: 'qwen3.5-omni-flash-realtime',
  })
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [activeDebugSnaps, setActiveDebugSnaps] = useState<ApiRequestSnapshot[] | null>(null)
  const [activeOmniDebug, setActiveOmniDebug] = useState<OmniDebugInfo | null>(null)
  const isOmniMode = aiMode === 'omni'
  const listening = fairyState === 'listening'

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, messages[messages.length - 1]?.content, messages[messages.length - 1]?.transcript])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [rows, quotaRows, chatModel, omniModel] = await Promise.all([
          invoke<ModelDef[]>('list_models'),
          listModelFreeQuotas(),
          getFeatureModel('fairy_chat', 'qwen3.6-flash'),
          getFeatureModel('fairy_omni_chat', 'qwen3.5-omni-flash-realtime'),
        ])
        if (cancelled) return
        setModels(rows)
        setFreeQuotas(quotaRows)
        setFeatureModels({ fairy_chat: chatModel, fairy_omni_chat: omniModel })
      } catch {}
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onBindingUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ feature?: string; modelId?: string }>).detail
      if ((detail?.feature === 'fairy_chat' || detail?.feature === 'fairy_omni_chat') && detail.modelId) {
        setFeatureModels((prev) => ({ ...prev, [detail.feature!]: detail.modelId! }))
      }
    }
    window.addEventListener('model-feature-binding-updated', onBindingUpdated)
    return () => window.removeEventListener('model-feature-binding-updated', onBindingUpdated)
  }, [])

  useEffect(() => {
    const onUsage = (event: Event) => {
      const call = (event as CustomEvent<ModelCallLog>).detail
      if (call?.feature === 'fairy_chat' || call?.feature === 'fairy_omni_chat') {
        // 调用后刷一下额度，让模型选择器的小环跟着更新
        void listModelFreeQuotas().then(setFreeQuotas).catch(() => {})
      }
    }
    window.addEventListener('model-usage-logged', onUsage)
    return () => window.removeEventListener('model-usage-logged', onUsage)
  }, [])

  useEffect(() => {
    const onQuotaUpdated = () => { void listModelFreeQuotas().then(setFreeQuotas).catch(() => {}) }
    window.addEventListener('model-free-quota-updated', onQuotaUpdated)
    return () => window.removeEventListener('model-free-quota-updated', onQuotaUpdated)
  }, [])

  const currentFeature: 'fairy_chat' | 'fairy_omni_chat' = isOmniMode ? 'fairy_omni_chat' : 'fairy_chat'
  const currentModel = featureModels[currentFeature]
  const freeQuotaByModel = useMemo(() => new Map(freeQuotas.map((q) => [q.model_id, q])), [freeQuotas])
  const modelOptions = useMemo(() => {
    const wanted = isOmniMode ? 'realtime' : 'text'
    const filtered = models.filter((m) => m.category === wanted)
    return (filtered.length > 0 ? filtered : models).map((m) => {
      return modelSelectOption(m, freeQuotaByModel.get(m.id))
    })
  }, [freeQuotaByModel, isOmniMode, models])

  const changeModel = useCallback(async (modelId: string) => {
    setFeatureModels((prev) => ({ ...prev, [currentFeature]: modelId }))
    try {
      await setFeatureModel(currentFeature, modelId)
      window.dispatchEvent(new CustomEvent('model-feature-binding-updated', {
        detail: { feature: currentFeature, modelId },
      }))
    } catch {}
  }, [currentFeature])

  // 发图走聊天模型（实时语音模式下打字也是）。不在模型库里的让它试，不支持时接口会报错
  const chatModelDef = models.find((m) => m.id === featureModels.fairy_chat)
  const chatModelSeesImages = !chatModelDef || parseModalityList(chatModelDef.modalities).includes('image')
  const noImageNote = `${chatModelDef?.display_name ?? featureModels.fairy_chat} 看不了图片，先换一个能看图的模型`

  const addImages = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return
    if (!chatModelSeesImages) {
      setImageNote(noImageNote)
      return
    }
    setImageNote('')
    const room = MAX_CHAT_IMAGES - pendingImagesRef.current.length
    if (files.length > room) setImageNote(`一次最多发 ${MAX_CHAT_IMAGES} 张`)
    const results = await Promise.allSettled(files.slice(0, Math.max(0, room)).map(prepareChatImage))
    const ready = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    if (results.some((r) => r.status === 'rejected')) setImageNote('有图片读不了（这个格式可能不支持）')
    pendingImagesRef.current = [...pendingImagesRef.current, ...ready].slice(0, MAX_CHAT_IMAGES)
    setPendingImages(pendingImagesRef.current)
  }, [chatModelSeesImages, noImageNote])

  const removeImage = useCallback((id: string) => {
    pendingImagesRef.current = pendingImagesRef.current.filter((p) => p.id !== id)
    setPendingImages(pendingImagesRef.current)
  }, [])

  useEffect(() => {
    if (!takeVoiceImagesRef) return
    takeVoiceImagesRef.current = () => {
      const images = pendingImagesRef.current
      if (images.length === 0) return []
      // 选完图又换了模型：图留着，换回来还能发
      if (!chatModelSeesImages) {
        setImageNote(noImageNote)
        return []
      }
      pendingImagesRef.current = []
      setPendingImages([])
      setImageNote('')
      return images
    }
  }, [takeVoiceImagesRef, chatModelSeesImages, noImageNote])

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    void addImages(files)
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault()
  }

  const handleDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    void addImages([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')))
  }

  const handleSend = () => {
    const trimmed = input.trim()
    if ((!trimmed && pendingImages.length === 0) || isProcessing) return
    // 选完图又换了模型：图和字都留着，换回来还能发
    if (pendingImages.length > 0 && !chatModelSeesImages) {
      setImageNote(noImageNote)
      return
    }
    onSend(trimmed, pendingImages)
    setInput('')
    setImageNote('')
    pendingImagesRef.current = []
    setPendingImages([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const canSend = (input.trim().length > 0 || pendingImages.length > 0) && !isProcessing
  const ctxPct = Math.round(Math.min(1, contextRatio) * 100)

  return (
    <div onDragOver={handleDragOver} onDrop={handleDrop} style={{
      display: 'flex',
      height: '100%', fontFamily: theme.fontBody,
      position: 'relative',
      overflow: 'hidden',
    }}>
      <style>{`
        .chat-textarea::placeholder { color: ${ti.textMuted}; }
        .chat-textarea:focus { outline: none; }
        .chat-input-wrap:focus-within {
          box-shadow: inset 0 1px 4px rgba(0,0,0,0.95), 0 1px 0 rgba(255,255,255,0.06), 0 0 0 1px rgba(255,138,76,0.35) !important;
        }
        /* 历史会话搜索命中片段跳转后的高亮（外层 div data-msg-ts） */
        @keyframes msgJumpFlash {
          0%,100% { background: transparent; }
          30%     { background: rgba(255,138,76,0.12); }
        }
        .msg-jump-flash { animation: msgJumpFlash 1.6s ease-in-out; border-radius: 6px; }
        .chat-session-strip { transition: box-shadow 0.15s; }
        .chat-session-strip:hover,
        .chat-session-strip[data-open="1"] {
          box-shadow: inset 0 1px 4px rgba(0,0,0,0.95), 0 1px 0 rgba(255,255,255,0.06), 0 0 0 1px rgba(255,138,76,0.55);
        }
      `}</style>

      <Spine state={fairyState} />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* ── Header：呼号 + 状态行 / CTX 段码条 / 实体键 ── */}
        <div className="ti-holo-band" style={{
          display: 'flex', alignItems: 'center', gap: 10,
          height: 58, padding: '0 12px 0 14px',
          position: 'relative',   // CameraPreview 定位锚点
          flexShrink: 0,
        }}>
          <div data-chassis-tab style={{ minWidth: 0, flex: '1 1 auto' }}>
            <div style={{
              fontSize: 19, fontWeight: 900, fontStyle: 'italic', letterSpacing: '0.06em', lineHeight: 1.1,
              color: theme.paper,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {agentName}
            </div>
            {/* 状态 + 上下文占用放在名字下面一行，头部让给名字和按键 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, fontSize: 11, color: theme.paperMuted, whiteSpace: 'nowrap' }}>
              <span className={STATE_DOT[fairyState]} aria-hidden style={{ width: 5, height: 5 }} />
              {STATE_LABEL[fairyState]}
              <span style={{ color: '#55514C' }}>·</span>
              <Tooltip content={`上下文占用 ${ctxPct}%（满了会自动压缩较早的对话）`}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  上下文
                  <LedSegments value={contextRatio} count={8} thickness={2.5} length={8} gap={1.5} />
                </span>
              </Tooltip>
            </div>
          </div>
          <div data-chassis-tower style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {onToggleTts && (
              <IconButton tip={ttsEnabled ? '打字时也朗读：开' : '打字时也朗读：关（语音提问总会语音回答）'} active={ttsEnabled} onClick={onToggleTts} size={30}>
                {ttsEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
              </IconButton>
            )}
            {onToggleCamera && (
              <IconButton
                tip={cameraWindowOpen ? '关闭摄像头预览' : cameraPresent ? '摄像头：已检测到你' : '打开摄像头预览'}
                active={cameraWindowOpen}
                dim={!cameraReady}
                onClick={onToggleCamera}
                size={30}
              >
                <Camera size={15} />
              </IconButton>
            )}
          </div>
        </div>

        {/* ── 会话条：历史键贴着左边缘（抽屉就从这一侧抽出来），右边是当前会话标题 ── */}
        {onOpenSessions && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 10px 14px', flexShrink: 0 }}>
            <IconButton tip={sessionsOpen ? '收起历史会话' : '历史会话'} active={sessionsOpen} onClick={onOpenSessions} size={28}>
              <History size={14} />
            </IconButton>
            <Tooltip content={sessionsOpen ? '收起历史会话' : '打开历史会话'} wrapStyle={{ flex: 1, minWidth: 0 }}>
              <button
                type="button"
                className="ti-well chat-session-strip"
                data-open={sessionsOpen ? '1' : undefined}
                onClick={onOpenSessions}
                style={{
                  width: '100%', height: 28,
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '0 10px',
                  border: 'none', borderRadius: 5, cursor: 'pointer',
                  textAlign: 'left', fontFamily: theme.fontBody,
                }}
              >
                <span style={{ fontSize: 10.5, color: ti.textFaint, letterSpacing: '0.12em', flexShrink: 0 }}>会话</span>
                <span style={{
                  flex: 1, minWidth: 0,
                  fontSize: 12.5, fontWeight: 700, color: theme.paper,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {sessionTitle?.trim() || '新会话'}
                </span>
              </button>
            </Tooltip>
          </div>
        )}

        <div className="ti-groove-h" />

        {/* ── Messages ── */}
        <div
          ref={scrollRef}
          style={{
            flex: 1, overflowY: 'auto',
            padding: '16px 14px 12px',
            display: 'flex', flexDirection: 'column', gap: 16,
          }}
        >
          {messages.length === 0 && (
            <div style={{
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              height: '100%', gap: 10, padding: '0 24px', textAlign: 'center',
            }}>
              <div style={{ fontSize: 14, color: theme.paperDim }}>
                想到什么，就跟 {agentName} 说
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: theme.paperMuted }}>
                打字，或按住 <span className="ti-keycap">右 Alt</span> 说话
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <Bubble
              key={msg.id}
              message={msg}
              agentName={agentName}
              userCallsign={userCallsign}
              onDebug={msg.debugSnapshots ? () => setActiveDebugSnaps(msg.debugSnapshots!) : undefined}
              onOmniDebug={msg.omniDebugInfo ? () => setActiveOmniDebug(msg.omniDebugInfo!) : undefined}
            />
          ))}

          {isProcessing && messages[messages.length - 1]?.role !== 'agent' && (
            <TypingLeds />
          )}
        </div>

        {/* ── Debug Modals ── */}
        {activeDebugSnaps && createPortal(
          <DebugRequestModal
            snapshots={activeDebugSnaps}
            onClose={() => setActiveDebugSnaps(null)}
          />,
          document.body,
        )}
        {activeOmniDebug && createPortal(
          <OmniDebugModal
            info={activeOmniDebug}
            onClose={() => setActiveOmniDebug(null)}
          />,
          document.body,
        )}

        {/* ── 注视提示条：Fairy 正注视主人锁定的卡片 ── */}
        {gazeTarget && (
          <div className="ti-well" style={{
            display: 'flex', alignItems: 'center', gap: 8,
            margin: '0 12px 8px 14px',
            padding: '5px 6px 5px 10px',
            fontSize: 12,
            color: theme.paperMuted,
            flexShrink: 0,
            borderRadius: 5,
          }}>
            <Eye size={13} style={{ color: ti.ledHi, flexShrink: 0 }} />
            <span style={{ flexShrink: 0, color: ti.ledHi }}>注视</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
              {gazeTarget.kind === 'thought' ? '想法卡' : `B站《${gazeTarget.title ?? '未命名'}》`} · {gazeTarget.text.slice(0, 42)}
            </span>
            <IconButton
              tip="取消注视"
              size={22}
              onClick={() => {
                // 广播 clear：App 清注视状态，洪流域 FlomoMain 熄灭锁定框
                window.dispatchEvent(new CustomEvent('solevup:card-focus', { detail: { clear: true } }))
              }}
            >
              <X size={12} />
            </IconButton>
          </div>
        )}

        {/* ── 正在听（系统时刻：唯一用冷色的地方）── */}
        {listening && <ListeningBar />}

        {/* ── 输入坞：下沉输入槽 + 模型 / 模式 / 发送 ── */}
        <div style={{
          flexShrink: 0,
          padding: '12px 12px 12px 14px',
          borderTop: '1px solid rgba(0,0,0,0.75)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)',
        }}>
          <div className="ti-well chat-input-wrap" style={{ padding: '9px 11px 6px', borderRadius: 5, transition: 'box-shadow 0.15s' }}>
            {pendingImages.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {pendingImages.map((img) => (
                  <Tooltip key={img.id} content="移除这张图片">
                    <button
                      type="button"
                      aria-label="移除这张图片"
                      onClick={() => removeImage(img.id)}
                      style={{ position: 'relative', width: 52, height: 52, padding: 0, border: 'none', borderRadius: 3, overflow: 'hidden', cursor: 'pointer', background: 'transparent' }}
                    >
                      <img src={img.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                      <span style={{ position: 'absolute', top: 1, right: 1, display: 'flex', padding: 1, borderRadius: 2, background: 'rgba(0,0,0,0.7)', color: theme.paper }}>
                        <X size={10} />
                      </span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
              <span className="ti-led" aria-hidden style={{ fontSize: 15, lineHeight: '22px' }}>&gt;</span>
              <textarea
                ref={inputRef}
                className="chat-textarea"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="说点什么……"
                rows={2}
                style={{
                  flex: 1, minWidth: 0, background: 'transparent', border: 'none',
                  color: theme.paper,
                  fontFamily: theme.fontBody,
                  fontSize: TEXT_SIZE, outline: 'none', resize: 'none',
                  lineHeight: 1.6, minHeight: 44, maxHeight: 200, overflowY: 'auto',
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, fontSize: 11, color: ti.textMuted }}>
              {imageNote && <span style={{ flex: 1, minWidth: 0, color: theme.dangerRed }}>{imageNote}</span>}
              按住 <span className="ti-keycap">右 Alt</span> 说话
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
            <Tooltip
              content={isOmniMode ? 'Fairy 实时语音模型（实验，只管语音）' : 'Fairy 聊天模型（打字和语音共用）'}
              display="flex"
              wrapStyle={{ flex: '1 1 auto', minWidth: 0, maxWidth: 220 }}
            >
              <div style={{ width: '100%', minWidth: 0 }}>
                <HudSelect
                  value={currentModel}
                  options={modelOptions}
                  onChange={changeModel}
                  disabled={isProcessing}
                  popupWidth={MODEL_SELECT_POPUP_WIDTH}
                />
              </div>
            </Tooltip>
            <span style={{ flex: 1 }} />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                void addImages([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
            <IconButton tip="添加图片（也可以直接粘贴）" disabled={isProcessing} onClick={() => fileInputRef.current?.click()} size={28}>
              <ImagePlus size={13} />
            </IconButton>
            {onToggleAiMode && (
              <IconButton
                tip={isOmniMode
                  ? '当前：实时语音（实验）——说话交给独立的小模型，打字仍走常规模型。点击切回级联语音'
                  : '当前：级联语音（推荐）——说话和打字都是同一个 Fairy。点击切换实时语音（实验）'}
                active={isOmniMode}
                disabled={isProcessing}
                onClick={onToggleAiMode}
                size={28}
              >
                {isOmniMode ? <Radio size={13} /> : <MessageSquare size={13} />}
              </IconButton>
            )}
            <Tooltip content="发送（Enter）">
              <button
                type="button"
                className="ti-key ti-key-primary"
                onClick={handleSend}
                disabled={!canSend}
                style={{
                  height: 32, padding: '0 18px',
                  fontSize: 13, letterSpacing: '0.3em',
                }}
              >
                发送
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 侧脊：竖排铭文 + LED 灯柱（跟 Fairy 状态走）──

function Spine({ state }: { state: FairyState }) {
  const levels = useVoiceLevels(state === 'listening', 4)
  const level = Math.max(...levels)
  const listenLit = Math.max(1, Math.ceil(level * SPINE_LEDS))
  return (
    <div
      className="ti-hatch"
      aria-hidden
      style={{
        width: SPINE_WIDTH, flexShrink: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 0',
        backgroundColor: '#121110',
        borderRight: '1px solid rgba(0,0,0,0.9)',
        boxShadow: '1px 0 0 rgba(255,255,255,0.1)',
        userSelect: 'none',
      }}
    >
      <span style={{ writingMode: 'vertical-rl', fontSize: 10, letterSpacing: '0.6em', color: ti.textFaint }}>
        通讯频道
      </span>
      <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 3 }}>
        {Array.from({ length: SPINE_LEDS }, (_, i) => {
          const base: React.CSSProperties = { width: 8, height: 3, borderRadius: 1, background: ti.ledOff }
          if (state === 'thinking') {
            return <span key={i} style={{ ...base, animation: `tiChase 1.2s ease-in-out ${i * 0.12}s infinite` }} />
          }
          if (state === 'listening') {
            const on = i < listenLit
            return <span key={i} style={{ ...base, background: on ? ti.sys : ti.ledOff, boxShadow: on ? '0 0 5px rgba(150,215,245,0.9)' : 'none', transition: 'background 90ms, box-shadow 90ms' }} />
          }
          if (state === 'speaking') {
            return <span key={i} style={{ ...base, background: ti.sys, boxShadow: '0 0 5px rgba(150,215,245,0.8)', animation: `tiBreath 1.4s ease-in-out ${i * 0.08}s infinite` }} />
          }
          // 待命：最底一格常亮
          return <span key={i} style={i === 0 ? { ...base, background: ti.led, boxShadow: '0 0 5px rgba(255,120,60,0.9)' } : base} />
        })}
      </div>
    </div>
  )
}

// ── 正在听：随主人声音跳动的冷色 LED 点阵（音量来自 Rust 录音 voice://level）──

function ListeningBar() {
  const levels = useVoiceLevels(true, LISTEN_BARS)
  return (
    <div className="ti-well" style={{
      display: 'flex', alignItems: 'center', gap: 10,
      margin: '0 12px 8px 14px',
      padding: '7px 10px',
      borderRadius: 5,
      flexShrink: 0,
      animation: 'fadeSlideIn 0.15s ease',
    }}>
      <span className="ti-dot ti-dot-sys" aria-hidden />
      <span style={{ fontSize: 12, color: ti.sys, flexShrink: 0 }}>
        正在听
      </span>
      <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 2, height: 18 }}>
        {levels.map((v, i) => (
          <span key={i} style={{
            flex: 1,
            height: ledHeight(v, 6),
            backgroundImage: ledColumn(ti.sys),
            opacity: 0.45 + v * 0.55,
            transition: 'height 90ms linear',
          }} />
        ))}
      </div>
      <span style={{ flexShrink: 0, color: theme.paperMuted, fontSize: 11 }}>松开发送</span>
    </div>
  )
}

// ── 语音条：橙色播放键 + LED 点阵波形 + 点阵时长 ──

function AudioBubble({ audioUrl, durationMs }: { audioUrl: string; durationMs?: number }) {
  const [playing, setPlaying]   = useState(false)
  const [progress, setProgress] = useState(0)          // 0–1，rAF 驱动
  const [duration, setDuration] = useState(            // 从 audio 元素取真实时长
    durationMs != null ? durationMs / 1000 : 0
  )
  const [waveform, setWaveform] = useState<number[]>([])
  const audioRef = useRef<HTMLAudioElement>(null)
  const rafRef   = useRef<number>(0)

  // rAF 驱动进度（丝滑 60fps）
  useEffect(() => {
    if (!playing) { cancelAnimationFrame(rafRef.current); return }
    const tick = () => {
      const el = audioRef.current
      if (el && el.duration > 0)
        setProgress(el.currentTime / el.duration)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing])

  // 真实时长（onLoadedMetadata）
  const handleMeta = () => {
    const el = audioRef.current
    if (el && isFinite(el.duration) && el.duration > 0)
      setDuration(el.duration)
  }

  // 解码真实波形（RMS 采样，更贴近听感）
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const buf   = await (await fetch(audioUrl)).arrayBuffer()
        const ctx   = new AudioContext()
        const decoded = await ctx.decodeAudioData(buf)
        await ctx.close()
        if (cancelled) return
        const data  = decoded.getChannelData(0)
        const block = Math.floor(data.length / WAVEFORM_BARS)
        const rms   = Array.from({ length: WAVEFORM_BARS }, (_, i) => {
          let sum = 0
          const off = i * block
          for (let j = 0; j < block; j++) sum += data[off + j] ** 2
          return Math.sqrt(sum / block)
        })
        const maxRms = Math.max(...rms, 0.001)
        setWaveform(rms.map((v) => v / maxRms))
      } catch {
        if (!cancelled)
          setWaveform(Array.from({ length: WAVEFORM_BARS }, () => 0.25 + Math.random() * 0.75))
      }
    })()
    return () => { cancelled = true }
  }, [audioUrl])

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    if (playing) { el.pause(); setPlaying(false) }
    else         { el.play().then(() => setPlaying(true)).catch(() => setPlaying(false)) }
  }

  const fmtSec = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  const bars       = waveform.length > 0 ? waveform : Array.from({ length: WAVEFORM_BARS }, () => 0.3)
  const playedBars = Math.round(progress * WAVEFORM_BARS)

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <audio
        ref={audioRef}
        src={audioUrl}
        onLoadedMetadata={handleMeta}
        onEnded={() => { setPlaying(false); setProgress(0) }} onError={() => { setPlaying(false); setProgress(0) }}
      />
      <button
        type="button"
        className="ti-key ti-key-primary"
        onClick={toggle}
        aria-label={playing ? '暂停' : '播放'}
        style={{ width: 24, height: 24, borderRadius: 4 }}
      >
        {playing ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" style={{ marginLeft: 1 }} />}
      </button>
      <div aria-hidden style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 18 }}>
        {bars.map((amp, i) => (
          <span key={i} style={{
            width: 3,
            height: ledHeight(Math.sqrt(amp), 6),
            backgroundImage: ledColumn(i < playedBars ? ti.ledHi : 'rgba(255,154,92,0.32)'),
          }} />
        ))}
      </div>
      <span className="ti-led-dim" style={{ fontSize: 13, fontWeight: 900, color: theme.paperDim, flexShrink: 0 }}>
        {playing ? fmtSec(progress * duration) : fmtSec(duration)}
      </span>
    </div>
  )
}

// ── 消息元信息：呼号 · 点阵时刻 ──

function fmtClock(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function MsgMeta({ label, ts, align, fairy = false, actions }: {
  label: string
  ts: string
  align: 'left' | 'right'
  fairy?: boolean
  actions?: React.ReactNode
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
      marginBottom: 6, userSelect: 'none',
    }}>
      {fairy ? (
        <span className="ti-tech" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.18em', color: ti.ledHi }}>
          {displayCallsign(label)}
        </span>
      ) : (
        <span style={{ fontSize: 11, color: theme.paperDim }}>{label}</span>
      )}
      <span className="ti-led-dim" style={{ fontSize: 11 }}>{fmtClock(ts)}</span>
      {actions}
    </div>
  )
}

/** 元信息行里的小动作按钮（debug 等） */
function MetaIconBtn({ tip, onClick, children }: {
  tip: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip content={tip}>
      <button
        type="button"
        className="ui-icon-btn"
        onClick={onClick}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: theme.paperMuted, padding: '1px 2px', borderRadius: 4,
          display: 'flex', alignItems: 'center', flexShrink: 0,
        }}
      >
        {children}
      </button>
    </Tooltip>
  )
}

// ── 思考过程（思考模型的推理流）──
// 流式期间自动展开、贴底滚动；正文开始后自动折叠成一行，可手动展开回看

function ReasoningBlock({ text, answered }: { text: string; answered: boolean }) {
  const [userToggle, setUserToggle] = useState<boolean | null>(null)
  const expanded = userToggle ?? !answered
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [text, expanded])

  const charLabel = text.length >= 1000 ? `${(text.length / 1000).toFixed(1)}K` : String(text.length)

  return (
    <div style={{ margin: '0 0 8px' }}>
      <button
        type="button"
        onClick={() => setUserToggle(!expanded)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          background: 'transparent', border: 'none', padding: 0,
          color: theme.paperMuted, fontSize: 12, cursor: 'pointer',
        }}
      >
        {answered
          ? <>思考过程 · {charLabel} 字 {expanded ? '▾' : '▸'}</>
          : <>正在思考<span style={{ animation: 'glowPulse 1s ease-in-out infinite' }}>…</span></>}
      </button>
      {expanded && (
        <div
          ref={scrollRef}
          className="ti-well"
          style={{
            marginTop: 6,
            maxHeight: 170,
            overflowY: 'auto',
            padding: '8px 12px',
            borderRadius: 5,
            fontSize: 12,
            lineHeight: 1.7,
            color: theme.paperMuted,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </div>
      )}
    </div>
  )
}

// ── 气泡里的图片：点开看大图；别的设备发的图，文件不在这台上（规则见 lib/agent/chat-images.ts）──

function BubbleImages({ images }: { images: NonNullable<ChatMessage['images']> }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [missing, setMissing] = useState<readonly string[]>([])
  // 同步拉到了新图片文件：占位再试一次
  useEffect(() => {
    const retry = () => setMissing([])
    window.addEventListener(CHAT_IMAGES_UPDATED, retry)
    return () => window.removeEventListener(CHAT_IMAGES_UPDATED, retry)
  }, [])
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
      {images.map((img) => (missing.includes(img.id) || !img.url ? (
        <div key={img.id} style={{ width: 96, height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 6, boxSizing: 'border-box', fontSize: 11, lineHeight: 1.4, textAlign: 'center', color: theme.paperMuted, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3 }}>
          图片不在这台设备上
        </div>
      ) : (
        <button
          key={img.id}
          type="button"
          aria-label="查看大图"
          onClick={() => setPreview(img.url)}
          style={{ width: 96, height: 96, padding: 0, border: 'none', borderRadius: 3, overflow: 'hidden', cursor: 'zoom-in', background: 'transparent' }}
        >
          <img
            src={img.url}
            alt=""
            onError={() => setMissing((prev) => [...prev, img.id])}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </button>
      )))}
      {preview && createPortal(
        <div
          role="button"
          aria-label="关闭大图"
          onClick={() => setPreview(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(0,0,0,0.85)', cursor: 'zoom-out' }}
        >
          <img src={preview} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>,
        document.body,
      )}
    </div>
  )
}

// ── 单条消息 ──

function Bubble({ message, agentName, userCallsign, onDebug, onOmniDebug }: {
  message: ChatMessage
  agentName: string
  userCallsign: string
  onDebug?: () => void
  onOmniDebug?: () => void
}) {
  // 系统 / 工具消息：一行等宽小字，不抢眼
  if (message.role === 'system') {
    const isErr = message.content.startsWith('错误')
    return (
      <div style={{
        fontFamily: theme.fontMono,
        fontSize: 11,
        lineHeight: 1.6,
        color: isErr ? theme.dangerRed : theme.paperMuted,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        opacity: isErr ? 1 : 0.85,
      }}>
        {message.content}
      </div>
    )
  }

  const isUser = message.role === 'user'

  // 主人语音：一个下沉槽里装语音条 + 转写
  if (isUser && message.audioUrl) {
    return (
      <div data-msg-ts={message.timestamp} style={{ animation: 'fadeSlideIn 0.2s ease' }}>
        <MsgMeta label={userCallsign} ts={message.timestamp} align="right" />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div className="ti-well" style={{ maxWidth: '88%', padding: '8px 12px 9px' }}>
            {message.images && message.images.length > 0 && <BubbleImages images={message.images} />}
            <AudioBubble audioUrl={message.audioUrl} durationMs={message.durationMs} />
            {message.transcript && (
              <div style={{
                marginTop: 7,
                fontSize: TEXT_SIZE - 0.5,
                color: theme.paperDim,
                lineHeight: 1.65,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {message.transcript}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // 主人文字（含边说边出的中间结果）：右侧下沉槽
  if (isUser) {
    return (
      <div data-msg-ts={message.timestamp} style={{ animation: 'fadeSlideIn 0.2s ease' }}>
        <MsgMeta label={userCallsign} ts={message.timestamp} align="right" />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div className="ti-well" style={{
            maxWidth: '88%',
            padding: '8px 12px 9px',
            color: theme.paper,
            fontSize: TEXT_SIZE,
            lineHeight: 1.65,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {message.images && message.images.length > 0 && <BubbleImages images={message.images} />}
            {message.content}
          </div>
        </div>
      </div>
    )
  }

  // Fairy：文字直接落在钛板上
  return (
    <div data-msg-ts={message.timestamp} style={{ animation: 'fadeSlideIn 0.2s ease' }}>
      <MsgMeta
        label={agentName}
        ts={message.timestamp}
        align="left"
        fairy
        actions={
          <>
            {onDebug && (
              <MetaIconBtn tip="查看本轮 AI 请求" onClick={onDebug}>
                <Bug size={11} />
              </MetaIconBtn>
            )}
            {onOmniDebug && (
              <MetaIconBtn tip="查看本轮 Omni 上下文" onClick={onOmniDebug}>
                <Radio size={11} />
              </MetaIconBtn>
            )}
          </>
        }
      />
      {message.reasoning && (
        <ReasoningBlock text={message.reasoning} answered={message.content.length > 0} />
      )}
      {/* markdown 渲染（加粗 / 列表 / 代码 / 表格……）；用量小牌紧跟在最后一句后面 */}
      <div className={message.usage ? 'fairy-md has-badge' : 'fairy-md'} style={{
        fontSize: TEXT_SIZE,
        lineHeight: 1.78,
        color: theme.paper,
        wordBreak: 'break-word',
      }}>
        <FairyMarkdown text={message.content} />
        {message.usage && <ModelUsageBadge call={message.usage} minimal />}
      </div>
      {message.audioUrl && (
        <div className="ti-well" style={{ display: 'inline-block', marginTop: 8, padding: '7px 12px 7px 8px' }}>
          <AudioBubble audioUrl={message.audioUrl} />
        </div>
      )}
    </div>
  )
}

// ── 正在回复：三颗逐个亮起的 LED ──

function TypingLeds() {
  return (
    <div aria-label="正在回复" style={{ display: 'inline-flex', gap: 4, alignItems: 'center', alignSelf: 'flex-start', padding: '4px 2px' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 6, height: 6, borderRadius: 1,
            background: ti.ledOff,
            animation: `tiChase 1.1s ease-in-out ${i * 0.18}s infinite`,
          }}
        />
      ))}
    </div>
  )
}
