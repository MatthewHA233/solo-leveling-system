/**
 * BiliTranscribePanel — 视频详情左侧的转录面板（HUD 风格）
 *
 * 当前只保留 ASR 录音文件识别：视频 → 提取音轨 → OSS → Qwen ASR FileTrans。
 * 面板只暴露真实可用的转录闭环，避免出现不可用的历史入口。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Square, Copy, Check, AlertTriangle, Loader2, RotateCcw, X, Play, Cpu,
  ScanText, Sparkles,
} from 'lucide-react'
import { theme, hud } from '../theme'
import { getDashScopeApiKey, loadConfig, updateConfig } from '../lib/agent/agent-config'
import { stitchOcrToSegments } from '../lib/ocr-stitch'
import { logModelUsage } from '../lib/model-audit'
import type { ModelCallLog } from '../lib/local-api'
import {
  uploadVideo,
  extractAudio,
  fileTranscribeAsr,
  ASR_FILETRANS_MODEL,
  type TranscribeKind,
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
  /** 右侧详情面板的当前宽度（用于给转录浮窗计算安全收缩边界） */
  rightAnchor?: number
}

type Stage = 'idle' | 'extracting' | 'uploading' | 'streaming' | 'done' | 'error'

const STAGE_LABEL: Record<Stage, string> = {
  idle: '待机',
  extracting: '提取中',
  uploading: '上传中',
  streaming: '转录中',
  done: '已完成',
  error: '失败',
}

const STAGE_COLOR: Record<Stage, string> = {
  idle: '#9aa0b3',
  extracting: '#6fd8ff',
  uploading: '#ffb454',
  streaming: '#00ffe0',
  done: '#6eff8c',
  error: '#ff5468',
}

const TRACE = '#00d7e8'
const TRACE_BRIGHT = '#7df9ff'
const SIGNAL = '#00ffe0'
const AMBER = '#ffb454'
const SURFACE = 'rgba(1, 8, 13, 0.96)'
const PANEL_LINE = 'rgba(0, 215, 232, 0.42)'
const PANEL_LINE_SOFT = 'rgba(0, 215, 232, 0.16)'
const PAPER = '#d9f8ff'
const ACCENT = TRACE

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

const TRANSCRIBE_FEATURE = 'bili_audio_transcribe'
const TRANSCRIBE_KIND: TranscribeKind = 'audio'

// 转录模式：音频 ASR / 滚动文章 OCR（OCR 本质=视觉转录，复用 kind='visual' + 同一套 JSONL/字幕/存储）
export type TranscribeMode = 'audio' | 'ocr_article'
const TRANSCRIBE_MODE_OPTIONS = [
  { value: 'audio', label: '音频' },
  { value: 'ocr_article', label: '滚动文章' },
]
const OCR_MODEL = 'qwen-vl-ocr'
const OCR_FEATURE = 'bili_ocr_transcribe'
const OCR_CONCURRENCY = 5       // OCR 并发路数
const FRAME_API = 'http://localhost:39733/api/ocr/frame?path='

interface OcrFrame { index: number; path: string; ts_sec: number }
type OcrPhase = 'idle' | 'config' | 'extracting' | 'ocr' | 'stitching'
const OCR_PHASE_LABEL: Record<OcrPhase, string> = {
  idle: '待命', config: '预览', extracting: '抽帧', ocr: 'OCR', stitching: '缝合',
}

interface TranscriptCache {
  visual: string | null
  audio: string | null
  combined: string | null
  visual_at: string | null
  audio_at: string | null
  combined_at: string | null
  history: TranscriptRun[]
}

interface TranscriptRun {
  id: string
  asset_id: string
  bvid: string
  download_path: string
  kind: string
  text: string
  model_id: string | null
  prompt_type: string | null
  source: string
  created_at: string
}

function doneStateFromTranscript(text: string, cachedAt: string | null, kind: TranscribeKind): KindState {
  return {
    stage: 'done',
    text,
    segments: parseTranscript(text, kind),
    errMsg: null,
    cachedAt,
  }
}

function formatTranscriptRunTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 16)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function BiliTranscribePanel({
  filePath, bvid, title, onClose, currentSec = null, onSeek, rightAnchor = 380,
}: Props) {
  const [mode, setMode] = useState<TranscribeMode>('audio')
  // OCR 即"视觉转录"，复用 kind='visual' 这一现有通道（同样的 JSONL 文本 + 字幕 + 存储）
  const kind: TranscribeKind = mode === 'ocr_article' ? 'visual' : 'audio'
  const feature = mode === 'ocr_article' ? OCR_FEATURE : TRANSCRIBE_FEATURE
  const [lastUsage, setLastUsage] = useState<ModelCallLog | null>(null)
  const [result, setResult] = useState<KindState>(INIT_KIND_STATE)
  const [transcriptHistory, setTranscriptHistory] = useState<TranscriptRun[]>([])
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null)
  const [localMediaPath, setLocalMediaPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // 滚动文章 OCR 的中间态（仅 ocr 模式、出结果前用）
  const [ocrPhase, setOcrPhase] = useState<OcrPhase>('idle')
  const [ocrInterval, setOcrInterval] = useState<number>(() => {
    const v = loadConfig().ocrFrameIntervalSec
    return Number.isFinite(v) && v > 0 ? Math.min(30, Math.max(5, v)) : 5
  })
  const [ocrDone, setOcrDone] = useState(0)
  const [ocrTotal, setOcrTotal] = useState(0)
  // 预览：仅两帧（第 0 秒 + 第 interval 秒），快速抓取、左右对比、拖动间隔实时重抓第二帧
  const [previewA, setPreviewA] = useState<string | null>(null)
  const [previewB, setPreviewB] = useState<string | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const ocrCancelRef = useRef(false)
  const ocrAbortRef = useRef<AbortController | null>(null)
  const grabSeqRef = useRef(0)
  const grabTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<(() => void) | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  // 用于切换视频时 flush 当前进行中的转录内容到 DB
  const resultRef = useRef<KindState>(INIT_KIND_STATE)

  // 同步 result 到 ref，供切换视频时读取
  useEffect(() => { resultRef.current = result }, [result])

  useEffect(() => {
    const onUsage = (event: Event) => {
      const call = (event as CustomEvent<ModelCallLog>).detail
      if (call?.feature === feature) {
        setLastUsage(call)
      }
    }
    window.addEventListener('model-usage-logged', onUsage)
    return () => window.removeEventListener('model-usage-logged', onUsage)
  }, [feature])

  const showTranscriptRun = useCallback((run: TranscriptRun) => {
    setResult(doneStateFromTranscript(run.text, run.created_at, kind))
    setCopied(false)
    setActiveHistoryId(run.id)
  }, [kind])

  const selectHistoryRun = useCallback((run: TranscriptRun) => {
    setActiveHistoryId(run.id)
    showTranscriptRun(run)
  }, [showTranscriptRun])

  // 切换 filePath / 模式时重置；cleanup 会用旧 filePath flush 进行中的部分内容
  useEffect(() => {
    abortRef.current?.(); abortRef.current = null
    ocrCancelRef.current = true; ocrAbortRef.current?.abort()
    if (grabTimerRef.current) { clearTimeout(grabTimerRef.current); grabTimerRef.current = null }
    setResult(INIT_KIND_STATE)
    setTranscriptHistory([])
    setActiveHistoryId(null)
    setLocalMediaPath(null)
    setCopied(false)
    setOcrPhase('idle'); setOcrDone(0); setOcrTotal(0)
    setPreviewA(null); setPreviewB(null); setPreviewBusy(false)

    return () => {
      const prev = resultRef.current
      if ((prev.stage === 'extracting' || prev.stage === 'uploading' || prev.stage === 'streaming') && prev.text.trim()) {
        invoke('update_bili_transcript', {
          filePath,
          kind,
          text: prev.text,
          saveHistory: false,
          source: 'partial_flush',
        }).catch(() => {})
      }
    }
  }, [filePath, mode])

  useEffect(() => () => { abortRef.current?.() }, [])

  // 进入视频 / 切模式时，读取对应 kind 的缓存与历史（音频=audio，滚动文章=visual）
  useEffect(() => {
    let cancelled = false
    invoke<TranscriptCache>('get_bili_transcripts', { filePath })
      .then((cache) => {
        if (cancelled) return
        const runs = (cache.history ?? []).filter((r) => r.kind === kind)
        setTranscriptHistory(runs)
        const cached = kind === 'visual' ? cache.visual : cache.audio
        const cachedAt = kind === 'visual' ? cache.visual_at : cache.audio_at
        if (cached?.trim()) {
          setResult(doneStateFromTranscript(cached, cachedAt, kind))
          setActiveHistoryId(runs[0]?.id ?? null)
        }
      })
      .catch((e) => console.warn('[Transcribe] 读取缓存失败', e))
    return () => { cancelled = true }
  }, [filePath, mode])

  const start = useCallback(async () => {
    const cfg = loadConfig()
    const apiKey = getDashScopeApiKey(cfg)
    if (!apiKey) {
      setResult((s) => ({ ...s, stage: 'error', errMsg: '未配置 API Key（设置 → AI 模型）' }))
      return
    }

    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    let cancelled = false
    abortRef.current = () => { cancelled = true }
    setResult({ stage: 'extracting', text: '', segments: [], errMsg: null, cachedAt: null })

    let audioPath = ''
    let ossUrl = ''
    try {
      audioPath = await extractAudio(filePath)
      if (cancelled) return
      setLocalMediaPath(audioPath)
      setResult((s) => ({ ...s, stage: 'uploading' }))
      ossUrl = await uploadVideo(audioPath, apiKey, ASR_FILETRANS_MODEL)
      if (cancelled) return
      setResult((s) => ({ ...s, stage: 'streaming' }))

      const asr = await fileTranscribeAsr(ossUrl, apiKey, ASR_FILETRANS_MODEL)
      if (cancelled) return
      const text = asr.jsonl.trim()
      const segments = text ? parseTranscript(text, TRANSCRIBE_KIND) : []
      if (!text || segments.length === 0) {
        setResult({
          stage: 'error',
          text,
          segments: [],
          errMsg: 'ASR 返回为空或没有句级时间戳',
          cachedAt: null,
        })
        return
      }
      setResult({ stage: 'done', text, segments, errMsg: null, cachedAt: null })
      void logModelUsage({
        feature: TRANSCRIBE_FEATURE,
        modelId: ASR_FILETRANS_MODEL,
        startedAt,
        durationMs: Date.now() - startedMs,
        success: true,
        metadata: {
          bvid,
          title,
          filePath,
          audioPath,
          ossUrl,
          pipeline: 'asr_filetrans',
          taskId: asr.task_id,
          transcriptionUrl: asr.transcription_url,
          usageSeconds: asr.usage_seconds,
          sentenceCount: segments.length,
          wordCount: asr.transcripts.reduce((sum, item) => sum + item.sentences.reduce((n, sentence) => n + sentence.words.length, 0), 0),
        },
      }).then((row) => { if (row) setLastUsage(row) })
      invoke<TranscriptRun | null>('update_bili_transcript', {
        filePath,
        kind: TRANSCRIBE_KIND,
        text,
        modelId: ASR_FILETRANS_MODEL,
        promptType: 'asr',
        source: 'asr_filetrans',
        saveHistory: true,
      })
        .then((run) => {
          if (!run) return
          setTranscriptHistory((items) => [run, ...items.filter((item) => item.id !== run.id)])
          setActiveHistoryId(run.id)
          setResult((s) => ({ ...s, cachedAt: run.created_at }))
          // 转录完成 → 该视频成为语境卡，通知洪流域实时刷新
          window.dispatchEvent(new CustomEvent('solevup:context-updated'))
          // 同时通知 B站历史列表：该视频现已转录，刷新绿标 + 计数
          window.dispatchEvent(new CustomEvent('solevup:bili-assets-changed', {
            detail: { bvid, reason: 'transcribed' },
          }))
        })
        .catch((e) => console.warn('[Transcribe] 写入 ASR 转录失败', e))
    } catch (e) {
      if (cancelled) return
      const msg = String(e)
      setResult((s) => ({ ...s, stage: 'error', errMsg: msg }))
      void logModelUsage({
        feature: TRANSCRIBE_FEATURE,
        modelId: ASR_FILETRANS_MODEL,
        startedAt,
        durationMs: Date.now() - startedMs,
        success: false,
        errorMessage: msg,
        metadata: { bvid, title, filePath, audioPath, ossUrl, pipeline: 'asr_filetrans' },
      }).then((row) => { if (row) setLastUsage(row) })
    } finally {
      if (abortRef.current) abortRef.current = null
    }
  }, [bvid, filePath, title])

  const stop = useCallback(() => {
    abortRef.current?.(); abortRef.current = null
    setResult((s) => ({ ...s, stage: 'idle' }))
  }, [])

  // ── 滚动文章 OCR 流程 ──
  // 快速抓单帧（预览用，后端 -ss 快进定位，不解码整片）
  const grabFrameAt = useCallback(async (ts: number): Promise<string | null> => {
    try { return await invoke<string>('grab_video_frame', { filePath, tsSec: ts }) }
    catch { return null }
  }, [filePath])

  const persistOcrInterval = useCallback((v: number) => {
    const c = Math.min(30, Math.max(5, v))
    setOcrInterval(c)
    updateConfig(loadConfig(), { ocrFrameIntervalSec: c })
    // 实时重抓第二帧（防抖 + 防乱序覆盖）
    if (grabTimerRef.current) clearTimeout(grabTimerRef.current)
    setPreviewBusy(true)
    const seq = ++grabSeqRef.current
    grabTimerRef.current = setTimeout(async () => {
      const b = await grabFrameAt(c)
      if (seq === grabSeqRef.current) { setPreviewB(b); setPreviewBusy(false) }
    }, 220)
  }, [grabFrameAt])

  // 点「转录/重新转录」进入预览：抓第 0 秒 + 第 interval 秒两帧
  const enterOcrConfig = useCallback(async () => {
    setResult(INIT_KIND_STATE)
    setOcrDone(0); setOcrTotal(0)
    setOcrPhase('config')
    setPreviewBusy(true)
    const seq = ++grabSeqRef.current
    const [a, b] = await Promise.all([grabFrameAt(0), grabFrameAt(ocrInterval)])
    if (seq === grabSeqRef.current) { setPreviewA(a); setPreviewB(b); setPreviewBusy(false) }
  }, [grabFrameAt, ocrInterval])

  // 开始转录全片：抽全片 → 并发 OCR → 大模型缝合成 JSONL 字幕 → 落库（kind=visual，同音频）
  const runOcrFull = useCallback(async () => {
    const apiKey = getDashScopeApiKey(loadConfig())
    if (!apiKey) { setResult((s) => ({ ...s, stage: 'error', errMsg: '未配置 API Key（设置 → AI 模型）' })); return }

    ocrCancelRef.current = false
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    setResult({ stage: 'idle', text: '', segments: [], errMsg: null, cachedAt: null })

    try {
      // 1) 抽全片
      setOcrPhase('extracting')
      const ex = await invoke<{ frames: OcrFrame[] }>('extract_video_frames', {
        filePath, intervalSec: ocrInterval,
      })
      if (ocrCancelRef.current) return
      const frames = ex.frames
      setOcrTotal(frames.length); setOcrDone(0)

      // 2) 并发 OCR（保序回填，单帧失败重试 1 次）
      setOcrPhase('ocr')
      const texts = new Array<string>(frames.length).fill('')
      let next = 0, completed = 0
      const worker = async () => {
        while (!ocrCancelRef.current) {
          const i = next++
          if (i >= frames.length) return
          try {
            texts[i] = (await invoke<string>('qwen_vl_ocr', { imagePath: frames[i].path, apiKey, model: OCR_MODEL })) ?? ''
          } catch {
            try { texts[i] = (await invoke<string>('qwen_vl_ocr', { imagePath: frames[i].path, apiKey, model: OCR_MODEL })) ?? '' }
            catch { texts[i] = '' }
          }
          completed += 1; setOcrDone(completed)
        }
      }
      await Promise.all(Array.from({ length: Math.min(OCR_CONCURRENCY, frames.length) }, () => worker()))
      if (ocrCancelRef.current) return

      // 3) 大模型缝合（去重 + 切时间戳）
      setOcrPhase('stitching')
      const ac = new AbortController(); ocrAbortRef.current = ac
      const ocrInput = frames.map((f, i) => ({ ts: f.ts_sec, text: texts[i] }))
      const res = await stitchOcrToSegments(ocrInput, { signal: ac.signal })
      if (ocrCancelRef.current) return
      if (res.segments.length === 0) {
        setOcrPhase('config')
        setResult((s) => ({ ...s, stage: 'error', errMsg: '缝合结果为空，可调小间隔后重试' }))
        return
      }

      // 4) 转成和音频一致的 JSONL（end=下一段起点），交给现有管线渲染/存储
      const jsonl = res.segments
        .map((s, i) => JSON.stringify({ start: s.start, end: res.segments[i + 1]?.start ?? s.start + 5, text: s.text }))
        .join('\n')
      setOcrPhase('idle')
      setResult(doneStateFromTranscript(jsonl, null, 'visual'))

      void logModelUsage({
        feature: OCR_FEATURE, modelId: res.model, startedAt, durationMs: Date.now() - startedMs, success: true,
        metadata: { bvid, title, filePath, frameCount: frames.length, intervalSec: ocrInterval, segmentCount: res.segments.length, pipeline: 'frame_ocr_stitch' },
      }).then((row) => { if (row) setLastUsage(row) })

      // 落库：kind='visual'，和音频走同一个命令、同一张表
      invoke<TranscriptRun | null>('update_bili_transcript', {
        filePath, kind: 'visual', text: jsonl,
        modelId: res.model, promptType: 'ocr_stitch', source: 'frame_ocr_stitch', saveHistory: true,
      }).then((run) => {
        if (!run) return
        setTranscriptHistory((items) => [run, ...items.filter((it) => it.id !== run.id)])
        setActiveHistoryId(run.id)
        setResult((s) => ({ ...s, cachedAt: run.created_at }))
        window.dispatchEvent(new CustomEvent('solevup:context-updated'))
        window.dispatchEvent(new CustomEvent('solevup:bili-assets-changed', { detail: { bvid, reason: 'transcribed' } }))
      }).catch((e) => console.warn('[OCR] 写入转录失败', e))
    } catch (e) {
      if (ocrCancelRef.current) return
      setOcrPhase('config')
      setResult((s) => ({ ...s, stage: 'error', errMsg: String(e) }))
    }
  }, [filePath, ocrInterval, bvid, title])

  const ocrStop = useCallback(() => {
    ocrCancelRef.current = true
    ocrAbortRef.current?.abort()
    setOcrPhase('config')
  }, [])

  const ocrMode = mode === 'ocr_article'
  const ocrBusy = ocrMode && (ocrPhase === 'extracting' || ocrPhase === 'ocr' || ocrPhase === 'stitching')
  const isRunning = result.stage === 'extracting' || result.stage === 'uploading' || result.stage === 'streaming'

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

  const historyOptions = useMemo(() => (
    transcriptHistory.map((run, index) => ({
      value: run.id,
      label: formatTranscriptRunTime(run.created_at),
      hint: index === 0 ? '最新' : `历史 ${transcriptHistory.length - index}`,
    }))
  ), [transcriptHistory])

  const activeHistoryValue = activeHistoryId ?? historyOptions[0]?.value ?? ''
  const handleHistoryChange = useCallback((id: string) => {
    const run = transcriptHistory.find((item) => item.id === id)
    if (run) selectHistoryRun(run)
  }, [selectHistoryRun, transcriptHistory])

  return (
    <div
      className="btx-transcribe-shell"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: 24,
        right: 24 + rightAnchor + 24,
        top: 24,
        bottom: 24,
        maxWidth: 720,
        transition: 'right 320ms cubic-bezier(.2,.8,.2,1)',
        zIndex: 11,
        background: `linear-gradient(180deg, ${SURFACE} 0%, rgba(0, 5, 9, 0.97) 100%)`,
        border: `1px solid ${PANEL_LINE}`,
        clipPath: hud.chamfer12, WebkitClipPath: hud.chamfer12,
        boxShadow: `0 18px 54px rgba(0,0,0,0.78), 0 0 18px rgba(0,215,232,0.22), inset 0 0 0 1px rgba(125,249,255,0.05)`,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <style>{`
        @keyframes btx-hologram-in {
          0%   { opacity: 0; transform: translateY(6px); filter: blur(3px); text-shadow: 0 0 14px ${TRACE_BRIGHT}; }
          50%  { opacity: 1; transform: translateY(0); filter: blur(0); text-shadow: 0 0 8px ${TRACE_BRIGHT}; }
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
          background: linear-gradient(to left, ${SIGNAL}, transparent);
          transform-origin: right center;
          animation: btx-stream-dot 0.9s linear infinite;
          pointer-events: none;
        }
        .btx-transcribe-shell {
          contain: layout paint;
        }
        .btx-actionbar {
          flex-wrap: wrap;
          row-gap: 6px;
        }
        .btx-flex-spacer {
          flex: 1 1 18px;
          min-width: 10px;
        }
        @media (max-width: 920px) {
          .btx-flex-spacer {
            display: none;
          }
        }
      `}</style>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '9px 12px',
        borderBottom: `1px solid ${PANEL_LINE_SOFT}`,
        flexShrink: 0,
        background: `linear-gradient(90deg, rgba(0,215,232,0.13) 0%, rgba(255,180,84,0.04) 42%, transparent 100%)`,
      }}>
        {ocrMode ? <ScanText size={11} style={{ color: TRACE_BRIGHT, flexShrink: 0 }} /> : <Cpu size={11} style={{ color: TRACE_BRIGHT, flexShrink: 0 }} />}
        <span style={{
          fontFamily: theme.fontDisplay, fontSize: 11, fontWeight: 700,
          letterSpacing: 2.4, color: PAPER,
          textShadow: `0 0 8px rgba(125,249,255,0.5)`,
        }}>
          转录
        </span>
        {(() => {
          const busyChip = ocrMode ? ocrBusy : isRunning
          const chipKey = ocrMode && ocrBusy ? 'streaming' : result.stage
          const chipText = ocrMode && ocrBusy ? OCR_PHASE_LABEL[ocrPhase] : STAGE_LABEL[result.stage]
          return (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '1px 6px',
              border: `1px solid ${STAGE_COLOR[chipKey]}66`,
              background: `linear-gradient(180deg, ${STAGE_COLOR[chipKey]}16, rgba(0,0,0,0.12))`,
              fontSize: 9, fontFamily: theme.fontMono,
              letterSpacing: 1,
              color: STAGE_COLOR[chipKey],
            }}>
              {busyChip && <Loader2 size={9} style={{ animation: 'spin 1.4s linear infinite' }} />}
              <span style={{
                display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
                background: STAGE_COLOR[chipKey],
                animation: busyChip ? 'btx-pulse-ring 1.4s ease-out infinite' : undefined,
              }} />
              {chipText}
            </span>
          )
        })()}

        <span className="btx-flex-spacer" />

        <Tooltip content="关闭">
          <button onClick={onClose} className="bhd-icon-btn" style={{ width: 22, height: 22 }}>
            <X size={12} />
          </button>
        </Tooltip>
      </div>

      {/* 操作栏 */}
      <div className="btx-actionbar" style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 12px',
        borderBottom: `1px solid ${PANEL_LINE_SOFT}`,
        background: 'rgba(2, 12, 17, 0.58)',
        flexShrink: 0,
      }}>
        {ocrMode ? (
          <>
            {ocrBusy && (
              <button onClick={ocrStop} style={techBtn(theme.dangerRed, false)}>
                <Square size={10} /> 中止
              </button>
            )}
            {!ocrBusy && ocrPhase === 'idle' && result.stage !== 'done' && (
              <button onClick={enterOcrConfig} style={techBtn(AMBER, true)}>
                <Play size={11} /> 转录
              </button>
            )}
            {!ocrBusy && result.stage === 'done' && (
              <>
                <Tooltip content={copied ? '已复制' : '复制全部'}>
                  <button onClick={handleCopy} style={techBtn(copied ? theme.expGreen : theme.electricBlue, false)}>
                    {copied ? <Check size={11} /> : <Copy size={11} />}
                    {copied ? '已复制' : '复制'}
                  </button>
                </Tooltip>
                <button onClick={enterOcrConfig} style={techBtn(AMBER, true)}>
                  <RotateCcw size={11} /> 重新转录
                </button>
              </>
            )}
          </>
        ) : (
          <>
            {!isRunning && result.stage !== 'done' && (
              <button onClick={start} style={techBtn(AMBER, true)}>
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
                <button onClick={start} style={techBtn(AMBER, true)}>
                  <RotateCcw size={11} /> 重新转录
                </button>
              </>
            )}
          </>
        )}

        {/* 模式下拉：默认音频，可切滚动文章 OCR */}
        <div style={{ minWidth: 96 }}>
          <HudSelect
            value={mode}
            options={TRANSCRIBE_MODE_OPTIONS as unknown as { value: string; label: string }[]}
            onChange={(v) => setMode(v as TranscribeMode)}
            disabled={ocrBusy || isRunning}
          />
        </div>

        {/* 滚动文章 OCR 参数配置子栏：点转录后出现（拖间隔→实时重抓第二帧预览 → 开始转录全片） */}
        {ocrMode && ocrPhase === 'config' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 100%', marginTop: 2 }}>
            <span style={{ fontSize: 11, color: theme.textSecondary, whiteSpace: 'nowrap' }}>抽帧间隔</span>
            <input
              type="range" min={5} max={30} step={1} value={ocrInterval}
              onChange={(e) => persistOcrInterval(parseFloat(e.target.value))}
              style={{ flex: 1, accentColor: TRACE }}
            />
            <span style={{ fontFamily: theme.fontMono, fontSize: 12, color: TRACE_BRIGHT, minWidth: 42, textAlign: 'right' }}>
              {ocrInterval.toFixed(0)}s
            </span>
            <button onClick={runOcrFull} style={techBtn(AMBER, true)}>
              <Sparkles size={12} /> 开始转录全片
            </button>
          </div>
        )}

        <span className="btx-flex-spacer" />
        <ModelUsageBadge call={lastUsage} minimal />
      </div>

      {transcriptHistory.length > 0 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 12px',
          borderBottom: `1px solid ${PANEL_LINE_SOFT}`,
          background: 'linear-gradient(90deg, rgba(0,215,232,0.06), rgba(0,0,0,0.08))',
          flexShrink: 0,
        }}>
          <span style={{
            fontFamily: theme.fontMono,
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: 1.5,
            color: TRACE_BRIGHT,
            whiteSpace: 'nowrap',
          }}>
            历史转录
          </span>
          <div style={{
            minWidth: 0,
            flex: '1 1 180px',
          }}>
            <HudSelect
              value={activeHistoryValue}
              options={historyOptions}
              onChange={handleHistoryChange}
              placeholder="选择历史日期"
              disabled={isRunning}
              popupWidth={260}
              popupZIndex={12000}
            />
          </div>
          {transcriptHistory.length > 0 && (
            <span style={{
              fontFamily: theme.fontMono,
              fontSize: 9,
              color: theme.textMuted,
              whiteSpace: 'nowrap',
            }}>
              {transcriptHistory.length} 次
            </span>
          )}
        </div>
      )}

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
          color: AMBER, letterSpacing: 1,
        }}>
          [{bvid}]
        </span>
        <span style={{
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {title}
        </span>
        {localMediaPath && (
          <Tooltip content={localMediaPath} wrapStyle={{ maxWidth: '32%', minWidth: 0 }}>
            <span
              style={{
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: theme.fontMono,
                fontSize: 9,
                color: theme.textMuted,
              }}
            >
              AUDIO: {localMediaPath}
            </span>
          </Tooltip>
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
            `linear-gradient(180deg, rgba(0,215,232,0.045), transparent 28%),
             repeating-linear-gradient(0deg, transparent 0, transparent 19px, rgba(0,215,232,0.055) 19px, rgba(0,215,232,0.055) 20px),
             linear-gradient(90deg, rgba(0,215,232,0.035), transparent 24%)`,
          backgroundSize: 'auto, 100% 20px',
          animation: isRunning ? 'btx-grid-shift 0.6s linear infinite' : undefined,
        }}
      >
        {result.segments.length === 0 && result.stage !== 'done' && (
          ocrMode ? (
            <OcrFlowBody
              phase={ocrPhase}
              ocrDone={ocrDone}
              ocrTotal={ocrTotal}
              previewA={previewA}
              previewB={previewB}
              previewBusy={previewBusy}
              interval={ocrInterval}
            />
          ) : result.stage !== 'error' && (
            <>
              <TranscribeIdleAnimation
                stage={
                  result.stage === 'uploading' ? 'uploading'
                  : result.stage === 'extracting' ? 'uploading'
                  : result.stage === 'streaming' ? 'streaming'
                  : 'idle'
                }
              />
              {result.stage === 'idle' && (
                <EmptyState onStart={start} />
              )}
              {(result.stage === 'extracting' || result.stage === 'uploading' || result.stage === 'streaming') && (
                <TranscribePrepOverlay stage={result.stage} />
              )}
            </>
          )
        )}
        {result.segments.length > 0 && (
          <SegmentList
            segments={result.segments}
            activeIdx={activeSegIdx}
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
              background: `linear-gradient(180deg, transparent 0%, rgba(0,255,224,0.14) 50%, transparent 100%)`,
              animation: 'btx-scan 2.4s linear infinite',
            }} />
          </div>
        )}
      </div>

    </div>
  )
}

// ── 滚动文章 OCR 内容区（两帧左右对比预览 / 进度 / 缝合提示） ──
function OcrFlowBody({
  phase, ocrDone, ocrTotal, previewA, previewB, previewBusy, interval,
}: {
  phase: OcrPhase
  ocrDone: number
  ocrTotal: number
  previewA: string | null
  previewB: string | null
  previewBusy: boolean
  interval: number
}) {
  if (phase === 'idle') {
    return (
      <div style={{ color: theme.textMuted, fontSize: 12, lineHeight: 1.9 }}>
        适用于"其实是一篇文章被自上而下滚动"的视频（语音转录无效）。<br />
        点上方 <b style={{ color: AMBER }}>转录</b> → 拖<b style={{ color: TRACE_BRIGHT }}>抽帧间隔</b>看前两帧滚动差 → 开始转录全片，
        最后由大模型去重缝合成<b style={{ color: TRACE_BRIGHT }}>带时间戳的字幕</b>。
      </div>
    )
  }
  if (phase === 'extracting') {
    return <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: theme.fontMono, color: TRACE_BRIGHT }}>
      <Loader2 size={14} style={{ animation: 'spin 1.4s linear infinite' }} /> 抽全片帧中…
    </div>
  }
  if (phase === 'ocr' || phase === 'stitching') {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: theme.fontMono, color: TRACE_BRIGHT, marginBottom: 8 }}>
          <Loader2 size={14} style={{ animation: 'spin 1.4s linear infinite' }} />
          {phase === 'ocr' ? `逐帧 OCR ${ocrDone}/${ocrTotal}（并发）` : '大模型缝合中（去重 + 切时间戳）…'}
        </div>
        {phase === 'ocr' && ocrTotal > 0 && (
          <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.round((ocrDone / ocrTotal) * 100)}%`, height: '100%', background: TRACE, transition: 'width 0.2s' }} />
          </div>
        )}
      </div>
    )
  }
  // config：前两帧左右对比（0s vs interval），拖间隔实时重抓右帧
  return (
    <div>
      <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 8, lineHeight: 1.7 }}>
        左=第 0 秒 / 右=第 {interval} 秒。看这两帧滚了多少：
        <b style={{ color: theme.textSecondary }}>重叠太多</b>→调大间隔（省钱）；
        <b style={{ color: theme.textSecondary }}>跳变太大可能漏字</b>→调小间隔。合适了点上方 <b style={{ color: AMBER }}>「开始转录全片」</b>。
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <FramePreviewPane label="0s" src={previewA} />
        <FramePreviewPane label={`${interval}s`} src={previewB} busy={previewBusy} />
      </div>
    </div>
  )
}

function FramePreviewPane({ label, src, busy }: { label: string; src: string | null; busy?: boolean }) {
  return (
    <div style={{
      flex: 1, minWidth: 0, height: 360, position: 'relative',
      border: `1px solid ${PANEL_LINE_SOFT}`, borderRadius: 4, overflow: 'hidden',
      background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {src
        ? <img src={`${FRAME_API}${encodeURIComponent(src)}`} alt={label}
            style={{ width: '100%', height: '100%', objectFit: 'contain', transition: 'opacity 0.18s' }} />
        : <span style={{ color: theme.textMuted, fontSize: 11 }}>抓取中…</span>}
      <span style={{ position: 'absolute', left: 4, top: 4, padding: '0 5px', borderRadius: 2, background: 'rgba(0,0,0,0.62)', color: PAPER, fontSize: 9, fontFamily: theme.fontMono }}>{label}</span>
      {busy && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.32)' }}>
          <Loader2 size={16} style={{ animation: 'spin 1.4s linear infinite', color: TRACE_BRIGHT }} />
        </div>
      )}
    </div>
  )
}

function SegmentList({
  segments, activeIdx, onSeek, streaming,
}: {
  segments: TranscriptSegment[]
  activeIdx: number
  onSeek?: (sec: number) => void
  streaming: boolean
}) {
  return (
    <>
      {segments.map((seg, i) => {
        const active = i === activeIdx
        const seekable = !!onSeek
        const speaker = displaySpeaker(seg.speaker)
        return (
          <div
            key={`${seg.start}-${i}`}
            data-seg-start={seg.start}
            onClick={() => onSeek?.(seg.start)}
            className={i === segments.length - 1 ? 'btx-hologram' : undefined}
            style={{
              marginBottom: 10,
              padding: '7px 10px 8px',
              borderLeft: `2px solid ${active ? AMBER : PANEL_LINE}`,
              background: active
                ? 'linear-gradient(90deg, rgba(255,180,84,0.12), rgba(0,215,232,0.035))'
                : 'rgba(2, 14, 18, 0.34)',
              cursor: seekable ? 'pointer' : 'default',
              transition: 'background 0.18s ease, border-color 0.18s ease, transform 0.18s ease',
            }}
            onMouseEnter={(e) => {
              if (seekable && !active) {
                e.currentTarget.style.background = 'rgba(0,215,232,0.07)'
                e.currentTarget.style.transform = 'translateX(2px)'
              }
            }}
            onMouseLeave={(e) => {
              if (seekable && !active) {
                e.currentTarget.style.background = 'rgba(2, 14, 18, 0.34)'
                e.currentTarget.style.transform = 'translateX(0)'
              }
            }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontFamily: theme.fontMono, fontSize: 10,
              color: active ? AMBER : TRACE_BRIGHT,
              letterSpacing: 0.5,
              marginBottom: 4,
              textShadow: active ? `0 0 6px rgba(255,180,84,0.5)` : undefined,
            }}>
              <span>{formatTimecode(seg.start)} – {formatTimecode(seg.end)}</span>
              {speaker && (
                <span style={{ color: theme.textSecondary, fontFamily: theme.fontBody }}>
                  · {speaker}
                </span>
              )}
            </div>
            <div style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              color: PAPER,
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
            background: SIGNAL,
            boxShadow: `0 0 8px ${SIGNAL}`,
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

function displaySpeaker(speaker: string | null | undefined): string | null {
  if (!speaker) return null
  const match = speaker.match(/^channel_(\d+)$/i)
  if (!match) return speaker
  const idx = Number(match[1])
  return Number.isFinite(idx) && idx > 0 ? `音轨 ${idx + 1}` : '主音轨'
}

function EmptyState({ onStart }: { onStart: () => void }) {
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

        {/* HUD 取景框 + 主标题 */}
        <div style={{
          position: 'relative',
          padding: '14px 38px 12px',
          marginTop: 4,
        }}>
          <Corner pos="tl" /><Corner pos="tr" />
          <Corner pos="bl" /><Corner pos="br" />

          <div style={{
            fontFamily: theme.fontDisplay, fontSize: 17, fontWeight: 700,
            letterSpacing: 9, color: PAPER,
            textShadow: `0 0 10px rgba(125,249,255,0.45), ${ts}`,
          }}>
            录音文件识别
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
          color: TRACE_BRIGHT, textShadow: `0 0 8px rgba(125,249,255,0.45), ${ts}`,
          marginTop: 8,
        }}>
          [ AUDIO_ASR · JSONL_TIMECODE ]
        </div>

        {/* 渐变分隔 */}
        <div style={{
          width: 120, height: 1,
          background: `linear-gradient(90deg, transparent, ${TRACE_BRIGHT}, transparent)`,
          marginTop: 10, marginBottom: 10,
          boxShadow: `0 0 8px rgba(125,249,255,0.45)`,
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
            color: hover ? '#061015' : AMBER,
            background: hover
              ? `linear-gradient(135deg, ${AMBER}, #ffd28a)`
              : `linear-gradient(135deg, rgba(255,180,84,0.16), rgba(0,215,232,0.05))`,
            border: `1px solid ${AMBER}`,
            borderRadius: 0,
            clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)',
            WebkitClipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)',
            cursor: 'pointer',
            boxShadow: hover
              ? `inset 0 0 12px rgba(255,255,255,0.28), 0 0 18px rgba(255,180,84,0.38)`
              : `inset 0 0 8px rgba(255,180,84,0.26), 0 0 10px rgba(255,180,84,0.24)`,
            textShadow: hover ? 'none' : `0 0 8px rgba(255,180,84,0.55), ${ts}`,
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
          INVOKE · 提取音轨并提交识别
        </div>

        {/* 终端输出说明 */}
        <div style={{
          fontFamily: theme.fontMono, fontSize: 10, fontWeight: 600, letterSpacing: 1,
          color: '#d4d8e5', textShadow: ts,
          marginTop: 16, lineHeight: 1.7,
          textAlign: 'left', minWidth: 240,
        }}>
          <div><span style={{ color: TRACE_BRIGHT }}>&gt;</span> OUT::JSONL · 时间戳段落</div>
          <div><span style={{ color: TRACE_BRIGHT }}>&gt;</span> SOURCE::主音轨</div>
        </div>
      </div>
    </div>
  )
}

function Corner({ pos }: { pos: 'tl' | 'tr' | 'bl' | 'br' }) {
  const c = TRACE_BRIGHT
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
    boxShadow: primary ? `inset 0 0 8px ${color}22, 0 0 8px ${color}33` : 'none',
    transition: 'all 0.15s ease',
  }
}
