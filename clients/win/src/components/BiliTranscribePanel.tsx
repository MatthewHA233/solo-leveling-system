/**
 * BiliTranscribePanel — 视频详情左侧的转录面板（HUD 风格）
 *
 * 双 Tab：画面（visual） / 音频（audio）；同一次 OSS 上传被两路复用。
 * DB 缓存：进入时读取已存在的转录直接展示；流式完成后写回 DB。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Square, Copy, Check, AlertTriangle, Loader2, RotateCcw, X, Play, Cpu, Eye, AudioLines } from 'lucide-react'
import { theme, hud } from '../theme'
import { loadConfig } from '../lib/agent/agent-config'
import {
  uploadVideo,
  streamTranscribeFromOss,
  VISUAL_TRANSCRIBE_PROMPT,
  AUDIO_TRANSCRIBE_PROMPT,
  type TranscribeKind,
} from '../lib/qwen-omni/transcribe'
import {
  parseTranscript,
  formatTimecode,
  type TranscriptSegment,
} from '../lib/qwen-omni/segments'
import Tooltip from './Tooltip'
import TranscribePrepOverlay from './TranscribePrepOverlay'
import TranscribeIdleAnimation from './TranscribeIdleAnimation'

interface Props {
  filePath: string
  bvid: string
  title: string
  onClose: () => void
  /** 当前播放秒数（用于高亮当前段；未播放时传 null） */
  currentSec?: number | null
  /** 用户点击 segment 时回调，跳转视频到对应时间 */
  onSeek?: (sec: number) => void
  /** 右侧详情面板的当前宽度（决定转录面板 right 偏移；面板自身不再硬编码 width，左贴边按比例填充） */
  rightAnchor?: number
}

type Stage = 'idle' | 'uploading' | 'streaming' | 'done' | 'error'

const STAGE_LABEL: Record<Stage, string> = {
  idle: '待机',
  uploading: '上传中',
  streaming: '转录中',
  done: '已完成',
  error: '失败',
}

const STAGE_COLOR: Record<Stage, string> = {
  idle: '#9aa0b3',
  uploading: '#b378ff',
  streaming: '#b378ff',
  done: '#6eff8c',
  error: '#ff5468',
}

const TRANSCRIBE_MODEL = 'qwen3.5-omni-plus'
const ACCENT = '#b378ff'

function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => resolve(true)).catch(() => resolve(legacyCopy(text)))
    } else {
      resolve(legacyCopy(text))
    }
  })
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.left = '-9999px'
    document.body.appendChild(ta); ta.focus(); ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch { return false }
}

interface KindState {
  stage: Stage
  text: string                       // 累计原文（用于复制 / 写 DB）
  segments: TranscriptSegment[]      // 已解析的段落
  errMsg: string | null
  cachedAt: string | null            // 来自 DB 的转录时间戳
}

const INIT_KIND_STATE: KindState = {
  stage: 'idle', text: '', segments: [], errMsg: null, cachedAt: null,
}

interface TranscriptCache {
  visual: string | null
  audio: string | null
  visual_at: string | null
  audio_at: string | null
}

export default function BiliTranscribePanel({
  filePath, bvid, title, onClose, currentSec = null, onSeek, rightAnchor = 380,
}: Props) {
  const [activeKind, setActiveKind] = useState<TranscribeKind>('audio')
  const [visual, setVisual] = useState<KindState>(INIT_KIND_STATE)
  const [audio, setAudio] = useState<KindState>(INIT_KIND_STATE)
  const [copied, setCopied] = useState(false)
  const ossPromiseRef = useRef<Promise<string> | null>(null)
  const abortVisualRef = useRef<(() => void) | null>(null)
  const abortAudioRef = useRef<(() => void) | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)

  const setKindState = useCallback((kind: TranscribeKind, patch: Partial<KindState>) => {
    if (kind === 'visual') setVisual((s) => ({ ...s, ...patch }))
    else setAudio((s) => ({ ...s, ...patch }))
  }, [])

  // 切换 bvid / filePath 时重置 + 加载 DB 缓存
  useEffect(() => {
    abortVisualRef.current?.(); abortVisualRef.current = null
    abortAudioRef.current?.();  abortAudioRef.current = null
    ossPromiseRef.current = null
    setVisual(INIT_KIND_STATE)
    setAudio(INIT_KIND_STATE)
    setCopied(false)

    let cancelled = false
    invoke<TranscriptCache>('get_bili_transcripts', { filePath })
      .then((cache) => {
        if (cancelled) return
        if (cache.visual) {
          setVisual({
            stage: 'done',
            text: cache.visual,
            segments: parseTranscript(cache.visual, 'visual'),
            errMsg: null,
            cachedAt: cache.visual_at,
          })
        }
        if (cache.audio) {
          setAudio({
            stage: 'done',
            text: cache.audio,
            segments: parseTranscript(cache.audio, 'audio'),
            errMsg: null,
            cachedAt: cache.audio_at,
          })
        }
      })
      .catch((e) => console.warn('[Transcribe] 读取缓存失败', e))
    return () => { cancelled = true }
  }, [filePath])

  useEffect(() => () => {
    abortVisualRef.current?.()
    abortAudioRef.current?.()
  }, [])

  // 复用 oss URL：第一次调用上传，后续直接拿 promise
  const ensureOss = useCallback(async (apiKey: string): Promise<string> => {
    if (ossPromiseRef.current) return ossPromiseRef.current
    const p = uploadVideo(filePath, apiKey, TRANSCRIBE_MODEL)
      .catch((e) => { ossPromiseRef.current = null; throw e })
    ossPromiseRef.current = p
    return p
  }, [filePath])

  const start = useCallback(async (kind: TranscribeKind) => {
    const cfg = loadConfig()
    const apiKey = cfg.omniApiKey || cfg.openaiApiKey
    if (!apiKey) {
      setKindState(kind, { stage: 'error', errMsg: '未配置 API Key（设置 → AI 模型 → 全模态 Omni）' })
      return
    }
    setKindState(kind, { stage: 'uploading', text: '', segments: [], errMsg: null, cachedAt: null })

    let url: string
    try {
      url = await ensureOss(apiKey)
    } catch (e) {
      setKindState(kind, { stage: 'error', errMsg: `上传失败：${String(e)}` })
      return
    }

    setKindState(kind, { stage: 'streaming' })

    const prompt = kind === 'visual' ? VISUAL_TRANSCRIBE_PROMPT : AUDIO_TRANSCRIBE_PROMPT
    const ref = kind === 'visual' ? abortVisualRef : abortAudioRef
    ref.current = streamTranscribeFromOss({
      ossUrl: url, apiKey, model: TRANSCRIBE_MODEL, prompt, kind,
      callbacks: {
        onChunk: (delta) => {
          if (kind === 'visual') setVisual((s) => ({ ...s, text: s.text + delta }))
          else setAudio((s) => ({ ...s, text: s.text + delta }))
        },
        onSegment: (segs) => {
          if (kind === 'visual') setVisual((s) => ({ ...s, segments: [...s.segments, ...segs] }))
          else setAudio((s) => ({ ...s, segments: [...s.segments, ...segs] }))
        },
        onDone: (full) => {
          setKindState(kind, { stage: 'done' })
          if (full.trim()) {
            invoke('update_bili_transcript', { filePath, kind, text: full })
              .catch((e) => console.warn('[Transcribe] 写入 DB 失败', e))
          }
        },
        onError: (msg) => setKindState(kind, { stage: 'error', errMsg: msg }),
      },
    })
  }, [ensureOss, filePath, setKindState])

  const stop = useCallback((kind: TranscribeKind) => {
    if (kind === 'visual') { abortVisualRef.current?.(); abortVisualRef.current = null }
    else { abortAudioRef.current?.(); abortAudioRef.current = null }
    setKindState(kind, { stage: 'idle' })
  }, [setKindState])

  const current = activeKind === 'visual' ? visual : audio
  const isRunning = current.stage === 'uploading' || current.stage === 'streaming'

  const handleCopy = useCallback(async () => {
    if (!current.text) return
    const ok = await copyToClipboard(current.text)
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500) }
    else setKindState(activeKind, { errMsg: '复制失败：剪贴板不可用' })
  }, [current.text, activeKind, setKindState])

  // 流式自动滚到底（基于 segments 数量增长）
  useEffect(() => {
    if (current.stage === 'streaming' && transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [current.segments.length, current.stage])

  // 切换 tab 时滚到顶
  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = 0
    setCopied(false)
  }, [activeKind])

  // 当前播放秒数对应的高亮段索引
  const activeSegIdx = useMemo(() => {
    if (currentSec == null) return -1
    return current.segments.findIndex((s) => currentSec >= s.start && currentSec < s.end)
  }, [currentSec, current.segments])

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: 24,
        right: 24 + rightAnchor + 24, top: 24, bottom: 24,
        // 不固定 width：左贴边 + 右锚点 → 中间缝隙 / 转录宽度按比例自然分配
        maxWidth: 720,
        transition: 'right 320ms cubic-bezier(.2,.8,.2,1)',
        zIndex: 11,
        background: theme.hudFillDeep,
        border: `1px solid ${ACCENT}88`,
        clipPath: hud.chamfer12, WebkitClipPath: hud.chamfer12,
        boxShadow: `0 16px 48px rgba(0,0,0,0.8), 0 0 32px ${ACCENT}55`,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <style>{`
        @keyframes btx-hologram-in {
          0%   { opacity: 0; transform: translateY(8px) skewX(-12deg); filter: blur(4px) hue-rotate(40deg); text-shadow: 0 0 18px ${ACCENT}, 0 0 6px #fff; }
          50%  { opacity: 1; transform: translateY(0) skewX(0); filter: blur(0); text-shadow: 0 0 12px ${ACCENT}, 0 0 4px #fff; }
          100% { opacity: 1; transform: translateY(0) skewX(0); filter: blur(0); text-shadow: 0 0 0 transparent; }
        }
        @keyframes btx-scan {
          0%   { top: -80px; }
          100% { top: 100%; }
        }
        @keyframes btx-cursor { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
        @keyframes btx-stream-dot {
          0%   { transform: translateX(0)    scaleX(1);   opacity: 0.0; }
          25%  { opacity: 1; }
          100% { transform: translateX(-46px) scaleX(0.6); opacity: 0; }
        }
        @keyframes btx-pulse-ring {
          0%   { box-shadow: 0 0 0 0 ${ACCENT}88; }
          70%  { box-shadow: 0 0 0 6px ${ACCENT}00; }
          100% { box-shadow: 0 0 0 0 ${ACCENT}00; }
        }
        @keyframes btx-grid-shift {
          0%   { background-position: 0 0; }
          100% { background-position: 0 -20px; }
        }
        .btx-hologram { animation: btx-hologram-in 0.7s cubic-bezier(.2,.8,.2,1) both; }
        .btx-stream-line {
          position: absolute; left: 0; top: 50%;
          width: 46px; height: 1px;
          background: linear-gradient(to left, ${ACCENT}, transparent);
          transform-origin: right center;
          animation: btx-stream-dot 0.9s linear infinite;
          pointer-events: none;
        }
      `}</style>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px',
        borderBottom: `1px solid ${ACCENT}33`,
        flexShrink: 0,
        background: `linear-gradient(90deg, ${ACCENT}14 0%, transparent 100%)`,
      }}>
        <Cpu size={11} style={{ color: ACCENT, flexShrink: 0 }} />
        <span style={{
          fontFamily: theme.fontDisplay, fontSize: 11, fontWeight: 700,
          letterSpacing: 2, color: ACCENT,
          textShadow: `0 0 6px ${ACCENT}AA`,
        }}>
          多模态 · 转录
        </span>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '1px 6px',
          border: `1px solid ${STAGE_COLOR[current.stage]}66`,
          background: `${STAGE_COLOR[current.stage]}11`,
          fontSize: 9, fontFamily: theme.fontMono,
          letterSpacing: 1,
          color: STAGE_COLOR[current.stage],
        }}>
          {isRunning && <Loader2 size={9} style={{ animation: 'spin 1.4s linear infinite' }} />}
          <span style={{
            display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
            background: STAGE_COLOR[current.stage],
            animation: isRunning ? 'btx-pulse-ring 1.4s ease-out infinite' : undefined,
          }} />
          {STAGE_LABEL[current.stage]}
        </span>

        <span style={{ flex: 1 }} />

        <Tooltip content="关闭">
          <button
            onClick={onClose}
            className="bhd-icon-btn"
            style={{ width: 22, height: 22 }}
          >
            <X size={12} />
          </button>
        </Tooltip>
      </div>

      {/* Tab 切换 */}
      <div style={{
        display: 'flex',
        borderBottom: `1px solid ${ACCENT}33`,
        flexShrink: 0,
        background: 'rgba(0,0,0,0.25)',
      }}>
        <TabBtn
          active={activeKind === 'audio'}
          onClick={() => setActiveKind('audio')}
          icon={<AudioLines size={11} />}
          label="音频"
          stage={audio.stage}
        />
        <TabBtn
          active={activeKind === 'visual'}
          onClick={() => setActiveKind('visual')}
          icon={<Eye size={11} />}
          label="画面"
          stage={visual.stage}
        />
      </div>

      {/* 操作栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 12px',
        borderBottom: `1px solid ${theme.hudFrameSoft}`,
        flexShrink: 0,
      }}>
        {!isRunning && current.stage !== 'done' && (
          <button onClick={() => start(activeKind)} style={techBtn(ACCENT, true)}>
            {current.stage === 'error' ? <RotateCcw size={11} /> : <Play size={11} />}
            {current.stage === 'error' ? '重试' : '启动'}
          </button>
        )}
        {isRunning && (
          <button onClick={() => stop(activeKind)} style={techBtn(theme.dangerRed, false)}>
            <Square size={10} /> 中止
          </button>
        )}
        {current.stage === 'done' && (
          <>
            <Tooltip content={copied ? '已复制' : '复制全部'}>
              <button
                onClick={handleCopy}
                style={techBtn(copied ? theme.expGreen : theme.electricBlue, false)}
              >
                {copied ? <Check size={11} /> : <Copy size={11} />}
                {copied ? '已复制' : '复制'}
              </button>
            </Tooltip>
            <button onClick={() => start(activeKind)} style={techBtn(ACCENT, true)}>
              <RotateCcw size={11} /> 重新转录
            </button>
            {current.cachedAt && (
              <span style={{
                fontFamily: theme.fontMono, fontSize: 9,
                color: theme.textMuted, letterSpacing: 0.5,
              }}>
                · 缓存
              </span>
            )}
          </>
        )}

        <span style={{ flex: 1 }} />
        <span style={{
          fontFamily: theme.fontMono, fontSize: 9,
          color: theme.textMuted, letterSpacing: 0.5,
        }}>
          {TRANSCRIBE_MODEL}
        </span>
      </div>

      {/* 元数据 */}
      <div style={{
        padding: '6px 12px',
        fontSize: 11,
        color: theme.textSecondary,
        borderBottom: `1px solid ${theme.hudFrameSoft}`,
        flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{
          fontFamily: theme.fontMono, fontSize: 9,
          color: ACCENT, letterSpacing: 1,
        }}>
          [{bvid}]
        </span>
        <span style={{
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {title}
        </span>
      </div>

      {/* 错误 */}
      {current.errMsg && (
        <div style={{
          padding: '8px 12px',
          fontSize: 10, color: theme.dangerRed,
          background: 'rgba(255,80,80,0.06)',
          borderBottom: `1px solid ${theme.dangerRed}33`,
          display: 'flex', gap: 6, alignItems: 'flex-start',
          wordBreak: 'break-all', lineHeight: 1.5,
          flexShrink: 0,
        }}>
          <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{current.errMsg}</span>
        </div>
      )}

      {/* 转录内容 */}
      <div
        ref={transcriptRef}
        style={{
          flex: 1, minHeight: 0, position: 'relative',
          overflowY: 'auto',
          padding: '14px 16px',
          fontFamily: theme.fontBody,
          fontSize: 12, lineHeight: 1.75,
          color: theme.textPrimary,
          background:
            `linear-gradient(rgba(180,120,255,0.04), transparent 30%),
             repeating-linear-gradient(0deg, transparent 0, transparent 19px, ${ACCENT}08 19px, ${ACCENT}08 20px)`,
          backgroundSize: 'auto, 100% 20px',
          animation: isRunning ? 'btx-grid-shift 0.6s linear infinite' : undefined,
        }}
      >
        {current.segments.length === 0 && current.stage !== 'done' && current.stage !== 'error' && (
          <>
            <TranscribeIdleAnimation
              stage={
                current.stage === 'uploading' ? 'uploading'
                : current.stage === 'streaming' ? 'streaming'
                : 'idle'
              }
            />
            {current.stage === 'idle' && (
              <EmptyState kind={activeKind} onStart={() => start(activeKind)} />
            )}
            {(current.stage === 'uploading' || current.stage === 'streaming') && (
              <TranscribePrepOverlay stage={current.stage} />
            )}
          </>
        )}
        {current.segments.length > 0 && (
          <SegmentList
            segments={current.segments}
            activeIdx={activeSegIdx}
            kind={activeKind}
            onSeek={onSeek}
            streaming={isRunning}
          />
        )}

        {/* 流光扫描线（仅 streaming 时） */}
        {current.stage === 'streaming' && (
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none',
            overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', left: 0, right: 0, height: 80, top: -80,
              background: `linear-gradient(180deg, transparent 0%, ${ACCENT}22 50%, transparent 100%)`,
              animation: 'btx-scan 2.4s linear infinite',
            }} />
          </div>
        )}
      </div>

    </div>
  )
}

function TabBtn({
  active, onClick, icon, label, stage,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  stage: Stage
}) {
  const dotColor = STAGE_COLOR[stage]
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        padding: '7px 10px',
        background: active ? `${ACCENT}1A` : 'transparent',
        color: active ? ACCENT : theme.textSecondary,
        border: 'none',
        borderBottom: active ? `2px solid ${ACCENT}` : '2px solid transparent',
        fontFamily: theme.fontMono, fontSize: 11, fontWeight: 700,
        letterSpacing: 1.2,
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        textShadow: active ? `0 0 6px ${ACCENT}88` : 'none',
      }}
    >
      {icon}
      <span>{label}</span>
      <span style={{
        display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
        background: dotColor,
        boxShadow: stage === 'streaming' || stage === 'uploading' ? `0 0 6px ${dotColor}` : 'none',
      }} />
    </button>
  )
}

const KIND_LABEL: Record<NonNullable<TranscriptSegment['kind']>, string> = {
  speech: '人声', bgm: '音乐', sfx: '音效', ambient: '环境',
}
const KIND_COLOR: Record<NonNullable<TranscriptSegment['kind']>, string> = {
  speech: '#7DF9FF', bgm: '#FFB37C', sfx: '#FFE07C', ambient: '#7CFFA0',
}

function SegmentList({
  segments, activeIdx, kind, onSeek, streaming,
}: {
  segments: TranscriptSegment[]
  activeIdx: number
  kind: TranscribeKind
  onSeek?: (sec: number) => void
  streaming: boolean
}) {
  return (
    <>
      {segments.map((seg, i) => {
        const active = i === activeIdx
        const seekable = !!onSeek
        return (
          <div
            key={`${seg.start}-${i}`}
            data-seg-start={seg.start}
            onClick={() => onSeek?.(seg.start)}
            className={i === segments.length - 1 ? 'btx-hologram' : undefined}
            style={{
              marginBottom: 10,
              padding: '4px 8px',
              borderLeft: `2px solid ${active ? ACCENT : `${ACCENT}33`}`,
              background: active ? `${ACCENT}1A` : 'transparent',
              cursor: seekable ? 'pointer' : 'default',
              transition: 'background 0.18s ease, border-color 0.18s ease',
            }}
            onMouseEnter={(e) => { if (seekable && !active) e.currentTarget.style.background = `${ACCENT}0E` }}
            onMouseLeave={(e) => { if (seekable && !active) e.currentTarget.style.background = 'transparent' }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontFamily: theme.fontMono, fontSize: 10,
              color: active ? ACCENT : `${ACCENT}AA`,
              letterSpacing: 0.5,
              marginBottom: 2,
              textShadow: active ? `0 0 6px ${ACCENT}88` : undefined,
            }}>
              <span>{formatTimecode(seg.start)} – {formatTimecode(seg.end)}</span>
              {kind === 'audio' && seg.kind && (
                <span style={{
                  padding: '0 4px',
                  fontSize: 9,
                  color: KIND_COLOR[seg.kind],
                  border: `1px solid ${KIND_COLOR[seg.kind]}66`,
                }}>
                  {KIND_LABEL[seg.kind]}
                </span>
              )}
              {kind === 'audio' && seg.speaker && (
                <span style={{ color: theme.textSecondary, fontFamily: theme.fontBody }}>
                  · {seg.speaker}
                </span>
              )}
              {kind === 'visual' && seg.tags && seg.tags.length > 0 && (
                <span style={{ color: theme.textMuted, fontSize: 9 }}>
                  · {seg.tags.join('/')}
                </span>
              )}
            </div>
            <div style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              color: active ? theme.textPrimary : theme.textPrimary,
            }}>
              {seg.text}
            </div>
          </div>
        )
      })}
      {streaming && (
        <span style={{ position: 'relative', display: 'inline-block' }}>
          <span style={{
            display: 'inline-block', width: 7, height: 13,
            background: ACCENT,
            boxShadow: `0 0 8px ${ACCENT}`,
            animation: 'btx-cursor 1s steps(2) infinite',
            verticalAlign: 'middle',
          }} />
          <span style={{ position: 'absolute', right: -2, top: '50%', width: 0, height: 0, pointerEvents: 'none' }}>
            <span className="btx-stream-line" />
            <span className="btx-stream-line" style={{ animationDelay: '0.3s' }} />
            <span className="btx-stream-line" style={{ animationDelay: '0.6s' }} />
          </span>
        </span>
      )}
    </>
  )
}

function EmptyState({ kind, onStart }: { kind: TranscribeKind; onStart: () => void }) {
  const streamName = kind === 'visual' ? '画面流' : '音频流'
  const streamCode = kind === 'visual' ? 'VIDEO_STREAM' : 'AUDIO_STREAM'
  const tags = kind === 'visual' ? '镜头│动作│字幕│UI' : '人声│字幕│音乐│环境音'
  const [hover, setHover] = useState(false)
  // 三层黑色描边，把文字"压"出粒子背景
  const ts = '0 0 12px rgba(0,0,0,1), 0 0 6px rgba(0,0,0,1), 0 0 3px rgba(0,0,0,1), 0 1px 2px rgba(0,0,0,1)'

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', zIndex: 2 }}>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 6,
        pointerEvents: 'none',
      }}>
        {/* 顶部状态码 */}
        <div style={{
          fontFamily: theme.fontMono, fontSize: 9.5, fontWeight: 700, letterSpacing: 3,
          color: '#7DF9FF', textShadow: `0 0 6px #7DF9FF, ${ts}`,
        }}>
          ▶ SYS · STANDBY
        </div>

        {/* HUD 取景框 + 主标题（中文紫主 / 英文白副） */}
        <div style={{
          position: 'relative',
          padding: '14px 38px 12px',
          marginTop: 4,
        }}>
          <Corner pos="tl" /><Corner pos="tr" />
          <Corner pos="bl" /><Corner pos="br" />

          <div style={{
            fontFamily: theme.fontDisplay, fontSize: 17, fontWeight: 700,
            letterSpacing: 10, color: '#fff',
            textShadow: `0 0 14px ${ACCENT}, 0 0 8px ${ACCENT}, ${ts}`,
          }}>
            {streamName}
          </div>
          <div style={{
            fontFamily: theme.fontMono, fontSize: 10, fontWeight: 700, letterSpacing: 4,
            color: '#fff', textShadow: ts,
            marginTop: 6, textAlign: 'center',
          }}>
            AWAITING · TRIGGER
          </div>
        </div>

        {/* 元信息 */}
        <div style={{
          fontFamily: theme.fontMono, fontSize: 10.5, fontWeight: 700, letterSpacing: 2,
          color: ACCENT, textShadow: `0 0 8px ${ACCENT}, ${ts}`,
          marginTop: 8,
        }}>
          [ {streamCode} · QWEN3.5-OMNI-PLUS ]
        </div>

        {/* 渐变分隔 */}
        <div style={{
          width: 120, height: 1,
          background: `linear-gradient(90deg, transparent, ${ACCENT}, transparent)`,
          marginTop: 10, marginBottom: 10,
          boxShadow: `0 0 8px ${ACCENT}AA`,
        }} />

        {/* 启动按钮 */}
        <button
          onClick={onStart}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            pointerEvents: 'auto',
            display: 'inline-flex', alignItems: 'center', gap: 10,
            padding: '10px 30px',
            fontFamily: theme.fontDisplay, fontSize: 13, fontWeight: 700, letterSpacing: 6,
            color: hover ? '#fff' : ACCENT,
            background: hover
              ? `linear-gradient(135deg, ${ACCENT}55, ${ACCENT}22)`
              : `linear-gradient(135deg, ${ACCENT}22, ${ACCENT}08)`,
            border: `1px solid ${ACCENT}`,
            borderRadius: 0,
            clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)',
            WebkitClipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)',
            cursor: 'pointer',
            boxShadow: hover
              ? `inset 0 0 14px ${ACCENT}99, 0 0 28px ${ACCENT}AA, 0 0 10px ${ACCENT}`
              : `inset 0 0 8px ${ACCENT}55, 0 0 14px ${ACCENT}77`,
            textShadow: `0 0 10px ${ACCENT}, ${ts}`,
            transition: 'all 0.18s ease',
          }}
        >
          <span style={{ fontSize: 14, letterSpacing: 0 }}>▶</span>
          <span>启动</span>
        </button>
        <div style={{
          fontFamily: theme.fontMono, fontSize: 9.5, fontWeight: 600, letterSpacing: 2,
          color: '#d4d8e5', textShadow: ts,
          marginTop: 6,
        }}>
          INVOKE · 发起多模态推理
        </div>

        {/* 终端输出说明 */}
        <div style={{
          fontFamily: theme.fontMono, fontSize: 10, fontWeight: 600, letterSpacing: 1,
          color: '#d4d8e5', textShadow: ts,
          marginTop: 16, lineHeight: 1.7,
          textAlign: 'left', minWidth: 240,
        }}>
          <div><span style={{ color: ACCENT }}>&gt;</span> OUT::JSONL · 时间戳段落</div>
          <div><span style={{ color: ACCENT }}>&gt;</span> TAGS::{tags}</div>
        </div>
      </div>
    </div>
  )
}

function Corner({ pos }: { pos: 'tl' | 'tr' | 'bl' | 'br' }) {
  const c = ACCENT
  const sz = 12
  const common: React.CSSProperties = {
    position: 'absolute',
    width: sz, height: sz,
    pointerEvents: 'none',
  }
  switch (pos) {
    case 'tl': return <span style={{ ...common, top: 0, left: 0, borderTop: `1px solid ${c}`, borderLeft: `1px solid ${c}`, boxShadow: `-1px -1px 4px ${c}55` }} />
    case 'tr': return <span style={{ ...common, top: 0, right: 0, borderTop: `1px solid ${c}`, borderRight: `1px solid ${c}`, boxShadow: `1px -1px 4px ${c}55` }} />
    case 'bl': return <span style={{ ...common, bottom: 0, left: 0, borderBottom: `1px solid ${c}`, borderLeft: `1px solid ${c}`, boxShadow: `-1px 1px 4px ${c}55` }} />
    case 'br': return <span style={{ ...common, bottom: 0, right: 0, borderBottom: `1px solid ${c}`, borderRight: `1px solid ${c}`, boxShadow: `1px 1px 4px ${c}55` }} />
  }
}

function techBtn(color: string, primary: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '4px 12px',
    fontFamily: theme.fontMono, fontSize: 10, fontWeight: 700,
    letterSpacing: 1,
    color, background: primary ? `${color}1A` : 'rgba(0,0,0,0.3)',
    border: `1px solid ${color}`, borderRadius: 0,
    clipPath: 'polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)',
    cursor: 'pointer',
    boxShadow: primary ? `inset 0 0 8px ${color}33, 0 0 6px ${color}55` : 'none',
    transition: 'all 0.15s ease',
  }
}
