/**
 * BiliTranscribePanel — 视频详情左侧的转录面板（HUD 风格）
 *
 * 模式：音视频合并（默认）/ 仅音频 / 仅画面
 * 提示词：文字/PPT（默认）/ 通用
 * DB 缓存：进入时读取已存在的转录直接展示；流式完成后写回 DB。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Square, Copy, Check, AlertTriangle, Loader2, RotateCcw, X, Play, Cpu, Eye, AudioLines } from 'lucide-react'
import { theme, hud } from '../theme'
import { getDashScopeApiKey, loadConfig } from '../lib/agent/agent-config'
import { getFeatureModel, listModelFreeQuotas, logModelUsage, setFeatureModel } from '../lib/model-audit'
import type { ModelCallLog, ModelDef, ModelFreeQuota } from '../lib/local-api'
import { MODEL_SELECT_POPUP_WIDTH, modelSelectOption } from '../lib/model-display'
import {
  uploadVideo,
  extractAudio,
  streamTranscribeFromOss,
  VISUAL_TRANSCRIBE_PROMPT,
  AUDIO_TRANSCRIBE_PROMPT,
  COMBINED_GENERAL_PROMPT,
  COMBINED_TEXT_PROMPT,
  type TranscribeKind,
  type PromptType,
  type MediaType,
} from '../lib/qwen-omni/transcribe'
import {
  parseTranscript,
  formatTimecode,
  type TranscriptSegment,
} from '../lib/qwen-omni/segments'
import Tooltip from './Tooltip'
import HudSelect from './HudSelect'
import ModelUsageBadge from './ModelUsageBadge'
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

type TrackMode = 'combined' | 'audio' | 'visual'

const TRANSCRIBE_FEATURE_BY_MODE: Record<TrackMode, string> = {
  combined: 'bili_omni_transcribe',
  audio: 'bili_audio_transcribe',
  visual: 'bili_visual_transcribe',
}

const FALLBACK_TRANSCRIBE_MODEL_BY_MODE: Record<TrackMode, string> = {
  combined: 'qwen3.5-omni-plus',
  audio: 'qwen3.5-omni-flash',
  visual: 'qwen3.5-flash',
}

interface UploadedMedia {
  ossUrl: string
  mediaType: MediaType
  localPath?: string
  audioFormat?: string
}

interface TranscriptCache {
  visual: string | null
  audio: string | null
  combined: string | null
  visual_at: string | null
  audio_at: string | null
  combined_at: string | null
}

function getPrompt(track: TrackMode, prompt: PromptType): string {
  if (track === 'audio') return AUDIO_TRANSCRIBE_PROMPT
  if (track === 'visual') return VISUAL_TRANSCRIBE_PROMPT
  return prompt === 'text' ? COMBINED_TEXT_PROMPT : COMBINED_GENERAL_PROMPT
}

function inferAudioFormat(path: string): string {
  const filename = path.split(/[\\/]/).pop() ?? path
  const ext = filename.split('.').pop()?.toLowerCase()
  return ext || 'm4a'
}

function parseModalities(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function modelSupports(model: ModelDef | undefined, modality: string): boolean {
  return model ? parseModalities(model.modalities).includes(modality) : false
}

function modelSupportsMode(model: ModelDef, mode: TrackMode): boolean {
  if (mode === 'audio') {
    return model.category === 'omni' && modelSupports(model, 'audio_in')
  }
  if (mode === 'visual') return modelSupports(model, 'video')
  return model.category === 'omni' && modelSupports(model, 'video') && modelSupports(model, 'audio_in')
}

function featureForMode(mode: TrackMode): string {
  return TRANSCRIBE_FEATURE_BY_MODE[mode]
}

export default function BiliTranscribePanel({
  filePath, bvid, title, onClose, currentSec = null, onSeek, rightAnchor = 380,
}: Props) {
  const [trackMode, setTrackMode] = useState<TrackMode>('combined')
  const [promptType, setPromptType] = useState<PromptType>('text')
  const [featureModels, setFeatureModels] = useState<Record<TrackMode, string>>(FALLBACK_TRANSCRIBE_MODEL_BY_MODE)
  const [allModels, setAllModels] = useState<ModelDef[]>([])
  const [freeQuotas, setFreeQuotas] = useState<ModelFreeQuota[]>([])
  const [lastUsage, setLastUsage] = useState<ModelCallLog | null>(null)
  const [result, setResult] = useState<KindState>(INIT_KIND_STATE)
  const [localMediaPath, setLocalMediaPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const ossPromiseRef = useRef<Promise<UploadedMedia> | null>(null)
  const abortRef = useRef<(() => void) | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  // 用于切换视频时 flush 当前进行中的转录内容到 DB
  const resultRef = useRef<KindState>(INIT_KIND_STATE)
  const trackModeRef = useRef<TrackMode>('combined')

  // 同步 result / trackMode 到 ref，供切换视频时读取
  useEffect(() => { resultRef.current = result }, [result])
  useEffect(() => { trackModeRef.current = trackMode }, [trackMode])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [modelRows, quotaRows, combinedModel, audioModel, visualModel] = await Promise.all([
          invoke<ModelDef[]>('list_models'),
          listModelFreeQuotas(),
          getFeatureModel(TRANSCRIBE_FEATURE_BY_MODE.combined, FALLBACK_TRANSCRIBE_MODEL_BY_MODE.combined),
          getFeatureModel(TRANSCRIBE_FEATURE_BY_MODE.audio, FALLBACK_TRANSCRIBE_MODEL_BY_MODE.audio),
          getFeatureModel(TRANSCRIBE_FEATURE_BY_MODE.visual, FALLBACK_TRANSCRIBE_MODEL_BY_MODE.visual),
        ])
        if (cancelled) return
        setAllModels(modelRows)
        setFreeQuotas(quotaRows)
        setFeatureModels({ combined: combinedModel, audio: audioModel, visual: visualModel })
      } catch (e) {
        if (!cancelled) console.warn('[Transcribe] 读取转录模型绑定失败', e)
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onBindingUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ feature?: string; modelId?: string }>).detail
      if (!detail?.feature || !detail.modelId) return
      const mode = (Object.entries(TRANSCRIBE_FEATURE_BY_MODE) as Array<[TrackMode, string]>)
        .find(([, feature]) => feature === detail.feature)?.[0]
      if (!mode) return
      setFeatureModels((prev) => ({ ...prev, [mode]: detail.modelId! }))
      ossPromiseRef.current = null
    }
    window.addEventListener('model-feature-binding-updated', onBindingUpdated)
    return () => window.removeEventListener('model-feature-binding-updated', onBindingUpdated)
  }, [])

  useEffect(() => {
    const features = new Set(Object.values(TRANSCRIBE_FEATURE_BY_MODE))
    const onUsage = (event: Event) => {
      const call = (event as CustomEvent<ModelCallLog>).detail
      if (call?.feature && features.has(call.feature)) {
        setLastUsage(call)
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

  const transcribeModels = useMemo(
    () => allModels.filter((m) => modelSupportsMode(m, trackMode)),
    [allModels, trackMode],
  )

  const boundModel = featureModels[trackMode] ?? FALLBACK_TRANSCRIBE_MODEL_BY_MODE[trackMode]

  const currentModel = useMemo(() => {
    if (transcribeModels.some((m) => m.id === boundModel)) return boundModel
    return transcribeModels[0]?.id ?? boundModel
  }, [boundModel, transcribeModels])

  const modelOptions = useMemo(() => {
    const quotaByModel = new Map(freeQuotas.map((q) => [q.model_id, q]))
    const opts = transcribeModels.map((m) => modelSelectOption(m, quotaByModel.get(m.id)))
    return opts
  }, [freeQuotas, transcribeModels])

  const currentModelDef = useMemo(
    () => allModels.find((m) => m.id === currentModel),
    [allModels, currentModel],
  )

  const changeCurrentModel = useCallback(async (modelId: string) => {
    const mode = trackMode
    const feature = featureForMode(mode)
    setFeatureModels((prev) => ({ ...prev, [mode]: modelId }))
    ossPromiseRef.current = null
    try {
      await setFeatureModel(feature, modelId)
      window.dispatchEvent(new CustomEvent('model-feature-binding-updated', {
        detail: { feature, modelId },
      }))
    } catch (e) {
      setResult((s) => ({ ...s, errMsg: `模型绑定更新失败：${String(e)}` }))
    }
  }, [trackMode])

  // 切换 filePath 时重置；cleanup 会用旧 filePath flush 进行中的部分内容
  useEffect(() => {
    abortRef.current?.(); abortRef.current = null
    ossPromiseRef.current = null
    setResult(INIT_KIND_STATE)
    setLocalMediaPath(null)
    setCopied(false)

    let cancelled = false
    invoke<TranscriptCache>('get_bili_transcripts', { filePath })
      .then((cache) => {
        if (cancelled) return
        const text = cache.combined ?? cache.visual ?? cache.audio
        const at = cache.combined_at ?? cache.visual_at ?? cache.audio_at
        const kind: TranscribeKind = cache.combined ? 'combined' : cache.visual ? 'visual' : 'audio'
        if (text) {
          setResult({
            stage: 'done',
            text,
            segments: parseTranscript(text, kind),
            errMsg: null,
            cachedAt: at,
          })
        }
      })
      .catch((e) => console.warn('[Transcribe] 读取缓存失败', e))
    return () => {
      cancelled = true
      const prev = resultRef.current
      if ((prev.stage === 'uploading' || prev.stage === 'streaming') && prev.text.trim()) {
        invoke('update_bili_transcript', {
          filePath,
          kind: trackModeRef.current,
          text: prev.text,
        }).catch(() => {})
      }
    }
  }, [filePath])

  useEffect(() => () => { abortRef.current?.() }, [])

  // trackMode 变化时清空 OSS 缓存，确保用新的媒体类型重新上传
  useEffect(() => {
    ossPromiseRef.current = null
    setLocalMediaPath(null)
  }, [trackMode])

  const ensureOss = useCallback(async (apiKey: string, model: string): Promise<UploadedMedia> => {
    if (ossPromiseRef.current) return ossPromiseRef.current
    const p = (async (): Promise<UploadedMedia> => {
      if (trackMode === 'audio') {
        const audioPath = await extractAudio(filePath)
        setLocalMediaPath(audioPath)
        const ossUrl = await uploadVideo(audioPath, apiKey, model)
        return {
          ossUrl,
          mediaType: 'audio',
          localPath: audioPath,
          audioFormat: inferAudioFormat(audioPath),
        }
      }
      const ossUrl = await uploadVideo(filePath, apiKey, model)
      setLocalMediaPath(filePath)
      return {
        ossUrl,
        mediaType: 'video',
        localPath: filePath,
      }
    })()
    const cached = p.catch((e) => { ossPromiseRef.current = null; throw e })
    ossPromiseRef.current = cached
    return cached
  }, [filePath, trackMode])

  const start = useCallback(async () => {
    const cfg = loadConfig()
    const apiKey = getDashScopeApiKey(cfg)
    if (!apiKey) {
      setResult((s) => ({ ...s, stage: 'error', errMsg: '未配置 API Key（设置 → AI 模型 → 全模态 Omni）' }))
      return
    }
    const feature = featureForMode(trackMode)
    const model = currentModel || await getFeatureModel(feature, FALLBACK_TRANSCRIBE_MODEL_BY_MODE[trackMode])
    const modelDef = currentModelDef ?? transcribeModels.find((m) => m.id === model)
    if (allModels.length > 0 && (!modelDef || !modelSupportsMode(modelDef, trackMode))) {
      setResult((s) => ({
        ...s,
        stage: 'error',
        errMsg: `${model} 不支持当前转录模式。音视频需要 Omni 这类同时支持 video + audio_in 的模型；qwen3.6-plus 只能用于仅画面。`,
      }))
      return
    }
    setResult({ stage: 'uploading', text: '', segments: [], errMsg: null, cachedAt: null })

    let media: UploadedMedia
    try {
      media = await ensureOss(apiKey, model)
    } catch (e) {
      setResult((s) => ({ ...s, stage: 'error', errMsg: `上传失败：${String(e)}` }))
      return
    }

    setResult((s) => ({ ...s, stage: 'streaming' }))

    const prompt = getPrompt(trackMode, promptType)
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    let usageLogged = false

    abortRef.current = streamTranscribeFromOss({
      ossUrl: media.ossUrl,
      apiKey,
      model,
      prompt,
      kind: trackMode,
      mediaType: media.mediaType,
      audioFormat: media.audioFormat,
      callbacks: {
        onChunk: (delta) => setResult((s) => ({ ...s, text: s.text + delta })),
        onSegment: (segs) => setResult((s) => ({ ...s, segments: [...s.segments, ...segs] })),
        onUsage: (usage) => {
          usageLogged = true
          void logModelUsage({
            feature,
            modelId: model,
            startedAt,
            durationMs: Date.now() - startedMs,
            usage,
            success: true,
            metadata: { bvid, title, filePath, ossUrl: media.ossUrl, localPath: media.localPath, trackMode, promptType },
          }).then((row) => { if (row) setLastUsage(row) })
        },
        onDone: (full) => {
          const trimmed = full.trim()
          setResult((s) => {
            // 流式没解析出段落时（如模型用了 JSON 数组格式），对完整文本重新解析
            const segments = s.segments.length > 0
              ? s.segments
              : trimmed ? parseTranscript(trimmed, trackMode) : []
            const noSegments = segments.length === 0 && trimmed.length > 0
            return {
              ...s,
              stage: noSegments ? 'error' : 'done',
              segments,
              errMsg: noSegments
                ? `模型未按 JSONL 格式输出，原文（前 300 字）：\n${trimmed.slice(0, 300)}`
                : null,
            }
          })
          if (trimmed) {
            invoke('update_bili_transcript', { filePath, kind: trackMode, text: full })
              .catch((e) => console.warn('[Transcribe] 写入 DB 失败', e))
          }
        },
        onError: (msg) => {
          setResult((s) => ({ ...s, stage: 'error', errMsg: msg }))
          if (!usageLogged) {
            void logModelUsage({
              feature,
              modelId: model,
              startedAt,
              durationMs: Date.now() - startedMs,
              success: false,
              errorMessage: msg,
              metadata: { bvid, title, filePath, ossUrl: media.ossUrl, localPath: media.localPath, trackMode, promptType },
            }).then((row) => { if (row) setLastUsage(row) })
          }
        },
      },
    })
  }, [allModels.length, bvid, currentModel, currentModelDef, ensureOss, filePath, promptType, title, trackMode, transcribeModels])

  const stop = useCallback(() => {
    abortRef.current?.(); abortRef.current = null
    setResult((s) => ({ ...s, stage: 'idle' }))
  }, [])

  const isRunning = result.stage === 'uploading' || result.stage === 'streaming'

  const handleCopy = useCallback(async () => {
    if (!result.text) return
    const ok = await copyToClipboard(result.text)
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500) }
    else setResult((s) => ({ ...s, errMsg: '复制失败：剪贴板不可用' }))
  }, [result.text])

  // 流式自动滚到底
  useEffect(() => {
    if (result.stage === 'streaming' && transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [result.segments.length, result.stage])

  const activeSegIdx = useMemo(() => {
    if (currentSec == null) return -1
    return result.segments.findIndex((s) => currentSec >= s.start && currentSec < s.end)
  }, [currentSec, result.segments])

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
          border: `1px solid ${STAGE_COLOR[result.stage]}66`,
          background: `${STAGE_COLOR[result.stage]}11`,
          fontSize: 9, fontFamily: theme.fontMono,
          letterSpacing: 1,
          color: STAGE_COLOR[result.stage],
        }}>
          {isRunning && <Loader2 size={9} style={{ animation: 'spin 1.4s linear infinite' }} />}
          <span style={{
            display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
            background: STAGE_COLOR[result.stage],
            animation: isRunning ? 'btx-pulse-ring 1.4s ease-out infinite' : undefined,
          }} />
          {STAGE_LABEL[result.stage]}
        </span>

        <span style={{ flex: 1 }} />

        <Tooltip content="关闭">
          <button onClick={onClose} className="bhd-icon-btn" style={{ width: 22, height: 22 }}>
            <X size={12} />
          </button>
        </Tooltip>
      </div>

      {/* 模式选择行 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 12px',
        borderBottom: `1px solid ${ACCENT}22`,
        flexShrink: 0,
        background: 'rgba(0,0,0,0.2)',
        flexWrap: 'wrap',
      }}>
        {/* 提示词类型 */}
        <ModeGroup>
          <ModeBtn active={promptType === 'text'} onClick={() => setPromptType('text')} disabled={isRunning}>
            文字/PPT
          </ModeBtn>
          <ModeBtn active={promptType === 'general'} onClick={() => setPromptType('general')} disabled={isRunning}>
            通用
          </ModeBtn>
        </ModeGroup>

        <div style={{ width: 1, height: 14, background: `${ACCENT}33`, flexShrink: 0 }} />

        {/* 轨道模式 */}
        <ModeGroup>
          <ModeBtn active={trackMode === 'combined'} onClick={() => setTrackMode('combined')} disabled={isRunning}>
            <AudioLines size={9} /> 音视频
          </ModeBtn>
          <ModeBtn active={trackMode === 'audio'} onClick={() => setTrackMode('audio')} disabled={isRunning}>
            <AudioLines size={9} /> 仅音频
          </ModeBtn>
          <ModeBtn active={trackMode === 'visual'} onClick={() => setTrackMode('visual')} disabled={isRunning}>
            <Eye size={9} /> 仅画面
          </ModeBtn>
        </ModeGroup>

      </div>

      {/* 操作栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 12px',
        borderBottom: `1px solid ${theme.hudFrameSoft}`,
        flexShrink: 0,
      }}>
        {!isRunning && result.stage !== 'done' && (
          <button onClick={start} style={techBtn(ACCENT, true)}>
            {result.stage === 'error' ? <RotateCcw size={11} /> : <Play size={11} />}
            {result.stage === 'error' ? '重试' : '启动'}
          </button>
        )}
        {isRunning && (
          <button onClick={stop} style={techBtn(theme.dangerRed, false)}>
            <Square size={10} /> 中止
          </button>
        )}
        {result.stage === 'done' && (
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
            <button onClick={start} style={techBtn(ACCENT, true)}>
              <RotateCcw size={11} /> 重新转录
            </button>
            {result.cachedAt && (
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
        <ModelUsageBadge call={lastUsage} compact />
        <Tooltip content={trackMode === 'audio' ? '仅音频转录模型' : trackMode === 'visual' ? '仅画面转录模型' : '音视频全模态转录模型'}>
          <div style={{ maxWidth: 280 }}>
            <HudSelect
              inline
              value={currentModel}
              options={modelOptions}
              onChange={changeCurrentModel}
              disabled={isRunning}
              popupWidth={MODEL_SELECT_POPUP_WIDTH}
            />
          </div>
        </Tooltip>
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
        {localMediaPath && (
          <span
            title={localMediaPath}
            style={{
              maxWidth: 260,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: theme.fontMono,
              fontSize: 9,
              color: theme.textMuted,
            }}
          >
            {trackMode === 'audio' ? 'AUDIO' : 'LOCAL'}: {localMediaPath}
          </span>
        )}
      </div>

      {/* 错误 */}
      {result.errMsg && (
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
          <span>{result.errMsg}</span>
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
        {result.segments.length === 0 && result.stage !== 'done' && result.stage !== 'error' && (
          <>
            <TranscribeIdleAnimation
              stage={
                result.stage === 'uploading' ? 'uploading'
                : result.stage === 'streaming' ? 'streaming'
                : 'idle'
              }
            />
            {result.stage === 'idle' && (
              <EmptyState trackMode={trackMode} modelId={currentModel} onStart={start} />
            )}
            {(result.stage === 'uploading' || result.stage === 'streaming') && (
              <TranscribePrepOverlay stage={result.stage} />
            )}
          </>
        )}
        {result.segments.length > 0 && (
          <SegmentList
            segments={result.segments}
            activeIdx={activeSegIdx}
            trackMode={trackMode}
            onSeek={onSeek}
            streaming={isRunning}
          />
        )}

        {/* 流光扫描线（仅 streaming 时） */}
        {result.stage === 'streaming' && (
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

function ModeGroup({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 0 }}>
      {children}
    </div>
  )
}

function ModeBtn({
  active, onClick, disabled, children,
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 9px',
        fontFamily: theme.fontMono, fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
        color: active ? '#0a0f1a' : disabled ? theme.textMuted : `${ACCENT}CC`,
        background: active ? ACCENT : 'transparent',
        border: `1px solid ${active ? ACCENT : `${ACCENT}44`}`,
        borderRadius: 0,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled && !active ? 0.45 : 1,
        transition: 'all 0.12s ease',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  )
}

const KIND_LABEL: Record<NonNullable<TranscriptSegment['kind']>, string> = {
  speech: '人声', bgm: '音乐', sfx: '音效', ambient: '环境',
  scene: '画面', slide: '幻灯片',
}
const KIND_COLOR: Record<NonNullable<TranscriptSegment['kind']>, string> = {
  speech: '#7DF9FF', bgm: '#FFB37C', sfx: '#FFE07C', ambient: '#7CFFA0',
  scene: '#b378ff', slide: '#78c4ff',
}

function SegmentList({
  segments, activeIdx, trackMode, onSeek, streaming,
}: {
  segments: TranscriptSegment[]
  activeIdx: number
  trackMode: TrackMode
  onSeek?: (sec: number) => void
  streaming: boolean
}) {
  return (
    <>
      {segments.map((seg, i) => {
        const active = i === activeIdx
        const seekable = !!onSeek
        const kindColor = seg.kind ? KIND_COLOR[seg.kind] : undefined
        return (
          <div
            key={`${seg.start}-${i}`}
            data-seg-start={seg.start}
            onClick={() => onSeek?.(seg.start)}
            className={i === segments.length - 1 ? 'btx-hologram' : undefined}
            style={{
              marginBottom: 10,
              padding: '4px 8px',
              borderLeft: `2px solid ${active ? (kindColor ?? ACCENT) : `${ACCENT}33`}`,
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
              {seg.kind && (
                <span style={{
                  padding: '0 4px',
                  fontSize: 9,
                  color: KIND_COLOR[seg.kind],
                  border: `1px solid ${KIND_COLOR[seg.kind]}66`,
                }}>
                  {KIND_LABEL[seg.kind]}
                </span>
              )}
              {seg.speaker && (
                <span style={{ color: theme.textSecondary, fontFamily: theme.fontBody }}>
                  · {seg.speaker}
                </span>
              )}
              {trackMode === 'visual' && seg.tags && seg.tags.length > 0 && (
                <span style={{ color: theme.textMuted, fontSize: 9 }}>
                  · {seg.tags.join('/')}
                </span>
              )}
            </div>
            <div style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              color: theme.textPrimary,
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

function EmptyState({ trackMode, modelId, onStart }: { trackMode: TrackMode; modelId: string; onStart: () => void }) {
  const streamName = trackMode === 'visual' ? '画面流' : trackMode === 'audio' ? '音频流' : '音视频流'
  const streamCode = trackMode === 'visual' ? 'VIDEO_STREAM' : trackMode === 'audio' ? 'AUDIO_STREAM' : 'AV_STREAM'
  const tags = trackMode === 'visual' ? '镜头│动作│字幕│UI' : trackMode === 'audio' ? '人声│字幕│音乐│环境音' : '人声│幻灯片│字幕│场景'
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
          [ {streamCode} · {modelId} ]
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
