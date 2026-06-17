// ══════════════════════════════════════════════
// BiliJobsWidget — 顶栏「任务」小按钮 + 浮层进度面板
//
// 监听后端两条事件流（下载/转录都在后端常驻，关界面也继续）：
//   - 'bili-download-progress'  { bvid, stage, percent, message, output_path }
//   - 'bili-transcribe-progress'{ bvid, file_path, stage, message }
// 标题由 'solevup:bili-job' { bvid, title } 富化（入队方派发）。
// 按 bvid 聚合成任务行：下载阶段 + 转录阶段 + 出错可重试。
// ══════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { Loader2, X, RotateCcw, ListChecks, Check, AlertTriangle } from 'lucide-react'
import { theme } from '../theme'
import { getDashScopeApiKey, loadConfig } from '../lib/agent/agent-config'

type DlStage = 'queued' | 'fetching_meta' | 'downloading_video' | 'downloading_audio' | 'merging' | 'done' | 'error'
type TrStage = 'queued' | 'extracting' | 'uploading' | 'transcribing' | 'done' | 'error'

const DL_LABEL: Record<string, string> = {
  queued: '下载排队', fetching_meta: '解析流', downloading_video: '下视频', downloading_audio: '下音频',
  merging: '合并', done: '已下载', error: '下载失败',
}
const TR_LABEL: Record<string, string> = {
  queued: '转录排队', extracting: '抽音轨', uploading: '上传', transcribing: '识别中', done: '已转录', error: '转录失败',
}

interface Job {
  bvid: string
  title?: string
  cover?: string          // B站封面原始 URL（经本地代理显示）
  filePath?: string
  dlStage?: DlStage
  dlPercent?: number
  trStage?: TrStage
  updatedAt: number
}

const isActive = (s?: string) => !!s && s !== 'done' && s !== 'error'
function jobActive(j: Job): boolean {
  return isActive(j.dlStage) || isActive(j.trStage)
}

const TRACE = '#00d7e8'
const TRACE_BRIGHT = '#7df9ff'

export default function BiliJobsWidget() {
  const [jobs, setJobs] = useState<Map<string, Job>>(new Map())
  const [open, setOpen] = useState(false)
  // 触发按钮位置（来自 toggle 事件的 rect）：面板据此锚定在按钮正下方
  const [anchor, setAnchor] = useState<{ bottom: number; right: number; cx: number } | null>(null)
  const tick = useRef(0)

  const upsert = (bvid: string, patch: Partial<Job>) => {
    setJobs((prev) => {
      const next = new Map(prev)
      const cur = next.get(bvid) ?? { bvid, updatedAt: 0 }
      next.set(bvid, { ...cur, ...patch, bvid, updatedAt: ++tick.current })
      return next
    })
  }

  // 下载完成后需自动接力转录的 bvid 集合（批量"下载+转录"用）
  const pendingTrRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const unlisteners: Array<() => void> = []
    listen<{ bvid: string; stage: DlStage; percent: number; output_path?: string | null }>(
      'bili-download-progress',
      (e) => {
        const p = e.payload
        if (!p?.bvid) return
        upsert(p.bvid, { dlStage: p.stage, dlPercent: p.percent, filePath: p.output_path ?? undefined })
        // 下载完成 → 接力转录（仅批量标记过的）
        if (p.stage === 'done' && pendingTrRef.current.has(p.bvid)) {
          pendingTrRef.current.delete(p.bvid)
          const apiKey = getDashScopeApiKey(loadConfig())
          if (apiKey && p.output_path) {
            upsert(p.bvid, { trStage: 'queued' })
            invoke('enqueue_transcribe', { bvid: p.bvid, filePath: p.output_path, apiKey }).catch(() => {})
          }
        }
      },
    ).then((u) => unlisteners.push(u)).catch(() => {})

    listen<{ bvid: string; file_path: string; stage: TrStage }>(
      'bili-transcribe-progress',
      (e) => {
        const p = e.payload
        if (!p?.bvid) return
        upsert(p.bvid, { trStage: p.stage, filePath: p.file_path || undefined })
        // 转录完成 → 刷新历史列表绿标 + 语境
        if (p.stage === 'done') {
          window.dispatchEvent(new CustomEvent('solevup:bili-assets-changed', { detail: { bvid: p.bvid, reason: 'transcribed' } }))
          window.dispatchEvent(new CustomEvent('solevup:context-updated'))
        }
      },
    ).then((u) => unlisteners.push(u)).catch(() => {})

    const onMeta = (e: Event) => {
      const d = (e as CustomEvent<{ bvid: string; title?: string; cover?: string }>).detail
      if (d?.bvid) upsert(d.bvid, { title: d.title, cover: d.cover })
    }
    window.addEventListener('solevup:bili-job', onMeta)

    // 批量「下载+转录」：已下载的直接转录；未下载的先下载、完成后接力转录
    const onBatch = async (e: Event) => {
      const d = (e as CustomEvent<{
        videos: { bvid: string; title?: string; cover?: string }[]
        mode?: 'download' | 'transcribe' | 'download_transcribe'
      }>).detail
      const videos = d?.videos ?? []
      const mode = d?.mode ?? 'download_transcribe'
      if (!videos.length) return
      setOpen(true)
      const cfg = loadConfig()
      const apiKey = getDashScopeApiKey(cfg)
      const startDownload = (bvid: string) => invoke('enqueue_bili_download', {
        bvid, saveDir: cfg.biliDownloadPath || 'E:\\BiliDownloads', quality: cfg.biliDownloadQuality || 'auto',
      }).catch(() => {})
      for (const v of videos) {
        upsert(v.bvid, { title: v.title, cover: v.cover })
        try {
          const assets = await invoke<{ download_status: string; download_path: string | null }[]>(
            'get_bili_assets_by_bvid', { bvid: v.bvid },
          )
          const done = (assets || []).find((a) => a.download_status === 'done' && a.download_path)
          if (mode === 'transcribe') {
            // 只转录：仅对已下载的视频生效
            if (done?.download_path && apiKey) {
              upsert(v.bvid, { dlStage: 'done', trStage: 'queued', filePath: done.download_path })
              await invoke('enqueue_transcribe', { bvid: v.bvid, filePath: done.download_path, apiKey }).catch(() => {})
            }
          } else if (mode === 'download') {
            // 只下载：已下载则直接标记完成，否则下载
            if (done?.download_path) {
              upsert(v.bvid, { dlStage: 'done', filePath: done.download_path })
            } else {
              upsert(v.bvid, { dlStage: 'queued' })
              await startDownload(v.bvid)
            }
          } else {
            // 下载并转录：已下载直接转录；未下载先下载、完成后接力转录
            if (done?.download_path) {
              if (apiKey) {
                upsert(v.bvid, { dlStage: 'done', trStage: 'queued', filePath: done.download_path })
                await invoke('enqueue_transcribe', { bvid: v.bvid, filePath: done.download_path, apiKey }).catch(() => {})
              }
            } else {
              pendingTrRef.current.add(v.bvid)
              upsert(v.bvid, { dlStage: 'queued' })
              await startDownload(v.bvid)
            }
          }
        } catch { /* 跳过该条 */ }
      }
    }
    window.addEventListener('solevup:bili-batch-enqueue', onBatch as EventListener)

    // 外部入口（B站历史弹窗工具栏）打开/关闭进度面板；带按钮 rect → 面板锚定其下方
    const onToggle = (e: Event) => {
      const r = (e as CustomEvent).detail?.rect as { bottom: number; right: number; cx: number } | undefined
      setOpen((v) => { const next = !v; if (next && r) setAnchor(r); return next })
    }
    window.addEventListener('solevup:toggle-bili-jobs', onToggle as EventListener)

    return () => {
      unlisteners.forEach((u) => u())
      window.removeEventListener('solevup:bili-job', onMeta)
      window.removeEventListener('solevup:bili-batch-enqueue', onBatch as EventListener)
      window.removeEventListener('solevup:toggle-bili-jobs', onToggle as EventListener)
    }
  }, [])

  const list = useMemo(
    () => [...jobs.values()], // Map 保持入队顺序：下载中 progress 频繁刷新不再触发重排（消除闪烁）
    [jobs],
  )
  const activeCount = useMemo(() => list.filter(jobActive).length, [list])
  const hasAny = list.length > 0

  // 顶栏已无按钮：把活跃任务数广播给外部入口（B站历史弹窗）的角标
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('solevup:bili-jobs-active', { detail: { count: activeCount } }))
  }, [activeCount])

  const retryTranscribe = async (j: Job) => {
    const apiKey = getDashScopeApiKey(loadConfig())
    if (!apiKey || !j.filePath) return
    upsert(j.bvid, { trStage: 'queued' })
    await invoke('enqueue_transcribe', { bvid: j.bvid, filePath: j.filePath, apiKey }).catch(() => {})
  }
  const retryDownload = async (j: Job) => {
    const cfg = loadConfig()
    upsert(j.bvid, { dlStage: 'queued' })
    await invoke('enqueue_bili_download', {
      bvid: j.bvid, saveDir: cfg.biliDownloadPath || 'E:\\BiliDownloads', quality: cfg.biliDownloadQuality || 'auto',
    }).catch(() => {})
  }
  // 移除单条任务记录（仅清前端展示，不影响已下载文件 / 转录结果）
  const removeJob = (bvid: string) => {
    setJobs((prev) => { const next = new Map(prev); next.delete(bvid); return next })
  }

  // 顶栏不再渲染按钮：本组件常驻 App 仅负责「批量编排 + 后端进度收集 + 进度面板」，
  // 面板由 B站历史弹窗工具栏的入口经 'solevup:toggle-bili-jobs' 打开（编排逻辑因此关弹窗也继续）。
  // 锚定定位：向下弹、右缘对齐触发按钮（无锚点信息时回退右上角）
  const PANEL_W = 380
  const panelTop = anchor ? Math.round(anchor.bottom + 8) : 128
  const panelRight = anchor ? Math.max(8, Math.round(window.innerWidth - anchor.right)) : 24
  return (
    <>
      {open && createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 99980 }} />
          {anchor && (
            <span style={{
              position: 'fixed', top: panelTop - 7, left: anchor.cx, transform: 'translateX(-50%)',
              width: 0, height: 0, borderStyle: 'solid', zIndex: 99982,
              borderWidth: '0 7px 7px 7px',
              borderColor: `transparent transparent ${TRACE} transparent`,
              filter: `drop-shadow(0 -1px 1px ${TRACE}66)`,
            }} />
          )}
          <div style={{
            position: 'fixed', top: panelTop, right: panelRight, width: PANEL_W, maxHeight: '70vh', zIndex: 99981,
            background: theme.hudFill, border: `1px solid ${TRACE}66`,
            boxShadow: `0 16px 48px rgba(0,0,0,0.7), 0 0 24px ${TRACE}33`,
            borderRadius: 6, display: 'flex', flexDirection: 'column', overflow: 'hidden',
            fontFamily: theme.fontBody,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
              borderBottom: `1px solid ${theme.hudFrameSoft}`, flexShrink: 0,
            }}>
              <ListChecks size={13} style={{ color: TRACE_BRIGHT }} />
              <span style={{ fontFamily: theme.fontDisplay, fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: TRACE_BRIGHT }}>
                下载 / 转录任务
              </span>
              {activeCount > 0 && <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: theme.fontMono }}>进行中 {activeCount}</span>}
              <span style={{ flex: 1 }} />
              <button onClick={() => setOpen(false)} className="bhd-icon-btn" style={{ width: 20, height: 20 }}><X size={12} /></button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: hasAny ? 6 : 24 }}>
              {!hasAny && (
                <div style={{ color: theme.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 1.8 }}>
                  还没有任务。<br />在 B站历史里多选视频 → 「下载+转录」即可批量并发。
                </div>
              )}
              {list.map((j) => (
                <JobRow key={j.bvid} job={j} onRemove={removeJob} onRetryTr={retryTranscribe} onRetryDl={retryDownload} />
              ))}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  )
}

// B站封面经本地代理（与 BiliVideoPanel 一致）
const COVER_API = 'http://localhost:39733/api/bilibili/cover?url='

// 转录无真实百分比 → 阶段映射出"进度感"（像下载软件那种推进但不精确的进度）
const TR_PCT: Record<string, number> = {
  queued: 6, extracting: 28, uploading: 56, transcribing: 82, done: 100, error: 100,
}

// 单条任务主进度条：下载用真百分比，转录用阶段假进度
function jobProgress(job: Job): { percent: number; color: string; text: string; state: 'run' | 'done' | 'error' } {
  const dl = job.dlStage
  const tr = job.trStage
  if (dl && dl !== 'done') {
    if (dl === 'error') return { percent: 100, color: theme.dangerRed, text: '下载失败', state: 'error' }
    const p = job.dlPercent ?? 0
    return { percent: p, color: TRACE_BRIGHT, text: `${DL_LABEL[dl] ?? dl}${p > 0 ? ' ' + Math.round(p) + '%' : ''}`, state: 'run' }
  }
  if (tr) {
    if (tr === 'error') return { percent: 100, color: theme.dangerRed, text: '转录失败', state: 'error' }
    if (tr === 'done') return { percent: 100, color: theme.expGreen, text: '已转录', state: 'done' }
    return { percent: TR_PCT[tr] ?? 50, color: '#FF9F45', text: TR_LABEL[tr] ?? '转录中', state: 'run' }
  }
  if (dl === 'done') return { percent: 100, color: theme.expGreen, text: '已下载', state: 'done' }
  return { percent: 0, color: TRACE_BRIGHT, text: '等待', state: 'run' }
}

function JobRow({ job, onRemove, onRetryTr, onRetryDl }: {
  job: Job
  onRemove: (bvid: string) => void
  onRetryTr: (j: Job) => void
  onRetryDl: (j: Job) => void
}) {
  const pr = jobProgress(job)
  const dlErr = job.dlStage === 'error'
  const trErr = job.trStage === 'error'
  return (
    <div style={{
      display: 'flex', gap: 8, padding: 7, marginBottom: 5, borderRadius: 5,
      background: 'rgba(0, 215, 232, 0.045)', border: `1px solid ${theme.hudFrameSoft}`,
    }}>
      {/* 封面：贴合 B站搜索结果的「图片 + 标题」风格 */}
      <div style={{
        width: 68, aspectRatio: '16 / 10', flexShrink: 0, borderRadius: 3, overflow: 'hidden',
        background: 'rgba(20,20,30,0.5)', border: `1px solid ${theme.hudFrameSoft}`,
      }}>
        {job.cover && (
          <img
            src={COVER_API + encodeURIComponent(job.cover)} alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        )}
      </div>
      {/* 右侧：标题 + 进度条 + 状态 */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5, justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            flex: 1, minWidth: 0, fontSize: 11.5, color: theme.textPrimary,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{job.title || job.bvid}</span>
          {dlErr && <button onClick={() => onRetryDl(job)} title="重试下载" style={iconMini}><RotateCcw size={10} /></button>}
          {trErr && job.filePath && <button onClick={() => onRetryTr(job)} title="重试转录" style={iconMini}><RotateCcw size={10} /></button>}
          <button onClick={() => onRemove(job.bvid)} title="移除记录" style={iconMini}><X size={11} /></button>
        </div>
        <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.09)', overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: 2, background: pr.color, width: `${pr.percent}%`, transition: 'width 0.25s, background 0.25s' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9.5, fontFamily: theme.fontMono, color: pr.color }}>
          {pr.state === 'run' ? <Loader2 size={9} style={{ animation: 'spin 1.4s linear infinite' }} />
            : pr.state === 'done' ? <Check size={9} />
            : <AlertTriangle size={9} />}
          {pr.text}
        </div>
      </div>
    </div>
  )
}

const iconMini: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 18, height: 18, flexShrink: 0, padding: 0,
  color: theme.textMuted, background: 'transparent',
  border: `1px solid ${theme.hudFrameSoft}`, borderRadius: 3, cursor: 'pointer',
}
