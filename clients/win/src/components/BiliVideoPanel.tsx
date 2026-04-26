/**
 * BiliVideoPanel — B站视频轨道悬浮/固定时，右侧栏展示的面板
 * 显示：封面缩略图、标题、UP主、时长/进度
 */

import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Download, Check, AlertTriangle, Loader2, FolderOpen } from 'lucide-react'
import type { BiliSpan } from '../lib/local-api'
import { theme } from '../theme'
import { loadConfig } from '../lib/agent/agent-config'
import Tooltip from './Tooltip'
import HudSelect from './HudSelect'

type QualityKey = 'auto' | '4k' | '1080p_plus' | '1080p' | '720p' | '480p'

interface QualityOption {
  value: QualityKey
  label: string
  hint?: string
  /** 该选项对应的 qn 值（auto 没有具体 qn） */
  qn?: number
}

const QUALITY_OPTIONS: ReadonlyArray<QualityOption> = [
  { value: 'auto',       label: '自动',   hint: '账号最高' },
  { value: '4k',         label: '4K',     hint: 'qn=120', qn: 120 },
  { value: '1080p_plus', label: '1080P+', hint: 'qn=112', qn: 112 },
  { value: '1080p',      label: '1080P',  hint: 'qn=80',  qn: 80  },
  { value: '720p',       label: '720P',   hint: 'qn=64',  qn: 64  },
  { value: '480p',       label: '480P',   hint: 'qn=32',  qn: 32  },
]

/** qn → QualityKey；找不到精确匹配时返回 null（让上层退回到 quality_request 字段） */
function qnToQualityKey(qn: number | null | undefined): QualityKey | null {
  if (qn == null) return null
  const opt = QUALITY_OPTIONS.find((o) => o.qn === qn)
  return opt ? opt.value : null
}

interface Props {
  span: BiliSpan
}

type DlStage =
  | 'idle'
  | 'queued'
  | 'fetching_meta'
  | 'downloading_video'
  | 'downloading_audio'
  | 'merging'
  | 'done'
  | 'error'

interface DlProgress {
  bvid: string
  stage: DlStage
  percent: number
  message: string | null
  output_path: string | null
  queue_position: number | null
}

// 后端 BiliVideoAsset 序列化结构（snake_case 字段直出）
interface BiliVideoAsset {
  id: string
  bvid: string
  download_status: string  // queued | downloading | done | error
  download_path: string | null
  quality_request: string | null
  quality_id: number | null
  file_size: number | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

const STAGE_LABEL: Record<DlStage, string> = {
  idle: '下载',
  queued: '排队中',
  fetching_meta: '解析流',
  downloading_video: '视频流',
  downloading_audio: '音频流',
  merging: '合并',
  done: '已保存',
  error: '失败',
}

const BILI_COLOR = '#FB7299'

function fmt(dt: string) {
  return dt.split(' ')[1]?.slice(0, 5) ?? dt
}

function fmtDuration(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function openBili(bvid: string) {
  invoke('open_url_in_browser', { url: `https://www.bilibili.com/video/${bvid}` }).catch(() => {})
}

function openInExplorer(filePath: string) {
  // 用资源管理器打开并选中文件
  invoke('open_url_in_browser', { url: `file:///${filePath.replace(/\\/g, '/')}` }).catch(() => {})
}

export default function BiliVideoPanel({ span }: Props) {
  const progressPct = span.duration > 0
    ? Math.min(100, Math.round((span.progress / span.duration) * 100))
    : 0

  // ── 下载状态 ──
  const [dl, setDl] = useState<DlProgress>({
    bvid: span.bvid, stage: 'idle', percent: 0, message: null, output_path: null, queue_position: null,
  })

  // 每个按钮独立的画质选择（默认取全局配置；切换 span 时重新读取）
  const defaultQuality = useMemo<QualityKey>(
    () => (loadConfig().biliDownloadQuality as QualityKey) || 'auto',
    [span.bvid],
  )
  const [quality, setQuality] = useState<QualityKey>(defaultQuality)
  useEffect(() => { setQuality(defaultQuality) }, [defaultQuality])

  // 该视频实际可用的 qn 列表；null = 探测中或失败（失败时显示全部）
  const [availableQns, setAvailableQns] = useState<number[] | null>(null)

  // 实际下拉展示的选项：'auto' 总是保留；其余按 availableQns 过滤
  const visibleOptions = useMemo<ReadonlyArray<QualityOption>>(() => {
    if (!availableQns || availableQns.length === 0) return QUALITY_OPTIONS
    return QUALITY_OPTIONS.filter((o) => o.qn === undefined || availableQns.includes(o.qn))
  }, [availableQns])

  // 切换 span / 拿到可用 qn 后：若当前选项不在列表里，回退到 auto
  useEffect(() => {
    if (!visibleOptions.some((o) => o.value === quality)) {
      setQuality('auto')
    }
  }, [visibleOptions, quality])

  // 切换 span 时：重置 idle + 查 DB 恢复已下载状态 + 探测可用清晰度
  useEffect(() => {
    setDl({ bvid: span.bvid, stage: 'idle', percent: 0, message: null, output_path: null, queue_position: null })
    setAvailableQns(null)
    let cancelled = false

    invoke<BiliVideoAsset[]>('get_bili_assets_by_bvid', { bvid: span.bvid })
      .then((assets) => {
        if (cancelled) return
        const done = assets.find((a) => a.download_status === 'done' && a.download_path)
        if (done && done.download_path) {
          setDl((prev) => {
            if (prev.stage !== 'idle') return prev
            return {
              bvid: span.bvid, stage: 'done', percent: 100,
              message: '已保存', output_path: done.download_path,
              queue_position: null,
            }
          })
          // 恢复上次下载使用的画质：优先 quality_id（精确 qn），
          // 回退到 quality_request（'auto' / '480p' 等字符串）
          const restored = qnToQualityKey(done.quality_id) ?? (done.quality_request as QualityKey | null)
          if (restored && QUALITY_OPTIONS.some((o) => o.value === restored)) {
            setQuality(restored)
          }
        }
      })
      .catch(() => {})

    // 探测当前账号能拿到哪些清晰度（失败保持 null = 显示全部）
    invoke<number[]>('probe_bili_qualities', { bvid: span.bvid })
      .then((qns) => { if (!cancelled) setAvailableQns(qns) })
      .catch(() => {})

    return () => { cancelled = true }
  }, [span.bvid])

  // 监听全局下载进度事件
  useEffect(() => {
    const unlisten = listen<DlProgress>('bili-download-progress', (e) => {
      if (e.payload.bvid === span.bvid) setDl(e.payload)
    })
    return () => { unlisten.then(fn => fn()).catch(() => {}) }
  }, [span.bvid])

  const handleDownload = async () => {
    const cfg = loadConfig()
    const saveDir = cfg.biliDownloadPath || 'E:\\BiliDownloads'
    setDl({ bvid: span.bvid, stage: 'queued', percent: 0, message: '入队中...', output_path: null, queue_position: null })
    try {
      await invoke('enqueue_bili_download', { bvid: span.bvid, saveDir, quality })
    } catch (err) {
      setDl({
        bvid: span.bvid, stage: 'error', percent: 0,
        message: String(err), output_path: null, queue_position: null,
      })
    }
  }

  const isWorking = dl.stage !== 'idle' && dl.stage !== 'done' && dl.stage !== 'error'

  return (
    <div style={{
      padding: 12,
      borderBottom: `1px solid ${theme.divider}`,
      fontFamily: theme.fontBody,
    }}>
      {/* 标题栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        marginBottom: 8,
      }}>
        {/* 哔哩哔哩图标 */}
        <svg width="16" height="16" viewBox="0 0 1024 1024" style={{ flexShrink: 0 }}>
          <path d="M0 0m184.32 0l655.36 0q184.32 0 184.32 184.32l0 655.36q0 184.32-184.32 184.32l-655.36 0q-184.32 0-184.32-184.32l0-655.36q0-184.32 184.32-184.32Z" fill="#EC5D85" />
          <path d="M512 241.96096h52.224l65.06496-96.31744c49.63328-50.31936 89.64096 0.43008 63.85664 45.71136l-34.31424 51.5072c257.64864 5.02784 257.64864 43.008 257.64864 325.03808 0 325.94944 0 336.46592-404.48 336.46592S107.52 893.8496 107.52 567.90016c0-277.69856 0-318.80192 253.14304-324.95616l-39.43424-58.368c-31.26272-54.90688 37.33504-90.40896 64.68608-42.37312l60.416 99.80928c18.18624-0.0512 41.18528-0.0512 65.66912-0.0512z" fill="#EF85A7" />
          <path d="M512 338.5856c332.8 0 332.8 0 332.8 240.64s0 248.39168-332.8 248.39168-332.8-7.75168-332.8-248.39168 0-240.64 332.8-240.64z" fill="#EC5D85" />
          <path d="M281.6 558.08a30.72 30.72 0 0 1-27.47392-16.97792 30.72 30.72 0 0 1 13.73184-41.216l122.88-61.44a30.72 30.72 0 0 1 41.216 13.74208 30.72 30.72 0 0 1-13.74208 41.216l-122.88 61.44a30.59712 30.59712 0 0 1-13.73184 3.23584zM752.64 558.08a30.60736 30.60736 0 0 1-12.8512-2.83648l-133.12-61.44a30.72 30.72 0 0 1-15.04256-40.7552 30.72 30.72 0 0 1 40.76544-15.02208l133.12 61.44A30.72 30.72 0 0 1 752.64 558.08zM454.656 666.88a15.36 15.36 0 0 1-12.288-6.1952 15.36 15.36 0 0 1 3.072-21.49376l68.5056-50.91328 50.35008 52.62336a15.36 15.36 0 0 1-22.20032 21.23776l-31.5904-33.024-46.71488 34.72384a15.28832 15.28832 0 0 1-9.13408 3.04128z" fill="#EF85A7" />
          <path d="M65.536 369.31584c15.03232 101.90848 32.84992 147.17952 44.544 355.328 14.63296 2.18112 177.70496 10.04544 204.05248-74.62912a16.14848 16.14848 0 0 0 1.64864-10.87488c-30.60736-80.3328-169.216-60.416-169.216-60.416s-10.36288-146.50368-11.49952-238.83776zM362.25024 383.03744l34.816 303.17568h34.64192L405.23776 381.1328zM309.52448 536.28928h45.48608l16.09728 158.6176-31.82592 1.85344zM446.86336 542.98624h45.80352V705.3312h-33.87392zM296.6016 457.97376h21.39136l5.2736 58.99264-18.91328 2.26304zM326.99392 457.97376h21.39136l2.53952 55.808-17.408 1.61792zM470.62016 459.88864h19.456v62.27968h-19.456zM440.23808 459.88864h22.20032v62.27968h-16.62976z" fill="#FFFFFF" />
          <path d="M243.56864 645.51936a275.456 275.456 0 0 1-28.4672 23.74656 242.688 242.688 0 0 1-29.53216 17.52064 2.70336 2.70336 0 0 1-4.4032-1.95584 258.60096 258.60096 0 0 1-5.12-29.57312c-1.41312-12.1856-1.95584-25.68192-2.16064-36.36224 0-0.3072 0-2.5088 3.01056-1.90464a245.92384 245.92384 0 0 1 34.22208 9.5744 257.024 257.024 0 0 1 32.3584 15.17568c0.52224 0.256 2.51904 1.4848 0.09216 3.77856z" fill="#EB5480" />
          <path d="M513.29024 369.31584c15.03232 101.90848 32.84992 147.17952 44.544 355.328 14.63296 2.18112 177.70496 10.04544 204.05248-74.62912a16.14848 16.14848 0 0 0 1.64864-10.87488c-30.60736-80.3328-169.216-60.416-169.216-60.416s-10.36288-146.50368-11.49952-238.83776zM810.00448 383.03744l34.816 303.17568h34.64192L852.992 381.1328zM757.27872 536.28928h45.48608l16.09728 158.6176-31.82592 1.85344zM894.6176 542.98624h45.80352V705.3312H906.5472zM744.35584 457.97376h21.39136l5.2736 58.99264-18.91328 2.26304zM774.74816 457.97376h21.39136l2.53952 55.808-17.408 1.61792zM918.3744 459.88864h19.456v62.27968h-19.456zM887.99232 459.88864h22.20032v62.27968h-16.62976z" fill="#FFFFFF" />
          <path d="M691.32288 645.51936a275.456 275.456 0 0 1-28.4672 23.74656 242.688 242.688 0 0 1-29.53216 17.52064 2.70336 2.70336 0 0 1-4.4032-1.95584 258.60096 258.60096 0 0 1-5.12-29.57312c-1.41312-12.1856-1.95584-25.68192-2.16064-36.36224 0-0.3072 0-2.5088 3.01056-1.90464a245.92384 245.92384 0 0 1 34.22208 9.5744 257.024 257.024 0 0 1 32.3584 15.17568c0.52224 0.256 2.51904 1.4848 0.09216 3.77856z" fill="#EB5480" />
        </svg>
        <span style={{
          fontSize: 11, fontWeight: 700,
          fontFamily: theme.fontBody,
          color: BILI_COLOR,
          letterSpacing: 1,
        }}>
          哔哩哔哩
        </span>
      </div>

      {/* 封面（点击打开浏览器） */}
      {span.cover && (
        <div
          onClick={() => openBili(span.bvid)}
          style={{
            marginBottom: 8, borderRadius: 4, overflow: 'hidden',
            border: `1px solid ${theme.divider}`,
            cursor: 'pointer', position: 'relative',
          }}
        >
          <img
            src={`http://localhost:3000/api/bilibili/cover?url=${encodeURIComponent(span.cover)}`}
            alt={span.title}
            style={{
              width: '100%', display: 'block',
              aspectRatio: '16/9', objectFit: 'cover',
              background: 'rgba(20,20,30,0.5)',
            }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
          {/* 播放按钮蒙层 */}
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0)',
            transition: 'background 0.15s',
          }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(0,0,0,0.35)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(0,0,0,0)' }}
          >
            <svg width="36" height="36" viewBox="0 0 36 36" style={{ opacity: 0.85 }}>
              <circle cx="18" cy="18" r="18" fill="rgba(0,0,0,0.5)" />
              <polygon points="14,11 28,18 14,25" fill="white" />
            </svg>
          </div>
        </div>
      )}

      {/* 视频标题（点击打开浏览器） */}
      <div
        onClick={() => openBili(span.bvid)}
        style={{
          fontSize: 13, fontWeight: 600,
          color: theme.textPrimary,
          lineHeight: 1.4,
          marginBottom: 6,
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.color = BILI_COLOR }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.color = theme.textPrimary }}
      >
        {span.title}
      </div>

      {/* UP主 */}
      {span.author_name && (
        <div style={{
          fontSize: 11,
          color: theme.textSecondary,
          marginBottom: 8,
        }}>
          UP: {span.author_name}
        </div>
      )}

      {/* 时间信息 */}
      <div style={{
        display: 'flex', gap: 12, fontSize: 11,
        fontFamily: theme.fontMono,
        color: theme.textSecondary,
        marginBottom: 6,
      }}>
        <span>{fmt(span.start_at)} — {fmt(span.end_at)}</span>
      </div>

      {/* 时长 / 进度 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11, fontFamily: theme.fontMono,
        color: theme.textSecondary,
      }}>
        <span>时长 {fmtDuration(span.duration)}</span>
        {span.progress > 0 && (
          <>
            <span style={{ color: theme.textMuted }}>·</span>
            <span>观看 {fmtDuration(span.progress)} ({progressPct}%)</span>
          </>
        )}
      </div>

      {/* 进度条 */}
      {span.duration > 0 && (
        <div style={{
          marginTop: 6, height: 3, borderRadius: 2,
          background: 'rgba(255,255,255,0.08)',
          overflow: 'hidden',
        }}>
          <div style={{
            width: `${progressPct}%`,
            height: '100%',
            background: BILI_COLOR,
            borderRadius: 2,
            transition: 'width 0.2s',
          }} />
        </div>
      )}

      {/* BV号 */}
      <div style={{
        marginTop: 6, fontSize: 9,
        fontFamily: theme.fontMono,
        color: theme.textMuted,
      }}>
        {span.bvid}
      </div>

      {/* ── 下载控制 ── */}
      <div style={{ marginTop: 10 }}>
        <DownloadControl
          dl={dl}
          isWorking={isWorking}
          biliColor={BILI_COLOR}
          quality={quality}
          qualityOptions={visibleOptions}
          onQualityChange={setQuality}
          onDownload={handleDownload}
          onOpenFile={() => dl.output_path && openInExplorer(dl.output_path)}
        />
      </div>
    </div>
  )
}

// ── 下载控件 ──

function DownloadControl({
  dl, isWorking, biliColor, quality, qualityOptions, onQualityChange, onDownload, onOpenFile,
}: {
  dl: DlProgress
  isWorking: boolean
  biliColor: string
  quality: QualityKey
  qualityOptions: ReadonlyArray<QualityOption>
  onQualityChange: (q: QualityKey) => void
  onDownload: () => void
  onOpenFile: () => void
}) {
  // 进度态
  if (isWorking) {
    return (
      <div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 11, color: theme.textPrimary,
          fontFamily: theme.fontMono, marginBottom: 4,
        }}>
          <Loader2 size={11} style={{ animation: 'spin 1.4s linear infinite', color: biliColor }} />
          <span>{STAGE_LABEL[dl.stage]}</span>
          <span style={{ color: theme.textSecondary, marginLeft: 'auto' }}>
            {dl.percent > 0 ? `${dl.percent.toFixed(0)}%` : ''}
          </span>
        </div>
        <div style={{
          height: 4, borderRadius: 2,
          background: 'rgba(255,255,255,0.08)',
          overflow: 'hidden',
        }}>
          <div style={{
            width: `${Math.max(2, dl.percent)}%`,
            height: '100%',
            background: biliColor,
            transition: 'width 0.2s',
          }} />
        </div>
        {dl.message && (
          <div style={{
            marginTop: 4, fontSize: 10,
            color: theme.textMuted, fontFamily: theme.fontMono,
            wordBreak: 'break-all',
          }}>
            {dl.message}
          </div>
        )}
      </div>
    )
  }

  // 完成态
  if (dl.stage === 'done') {
    return (
      <div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            onClick={onDownload}
            style={btnStyle(biliColor, 'rgba(251,114,153,0.10)')}
          >
            <Download size={12} /> 重新下载
          </button>
          <HudSelect inline value={quality} options={qualityOptions} onChange={onQualityChange} />
          <Tooltip content={dl.output_path || '打开'}>
            <button
              onClick={onOpenFile}
              style={btnStyle(theme.expGreen, 'rgba(110,255,140,0.10)')}
            >
              <FolderOpen size={12} /> 打开
            </button>
          </Tooltip>
          <span style={{
            marginLeft: 'auto', fontSize: 10,
            color: theme.expGreen, display: 'flex',
            alignItems: 'center', gap: 3,
          }}>
            <Check size={11} /> 已保存
          </span>
        </div>
      </div>
    )
  }

  // 错误态
  if (dl.stage === 'error') {
    return (
      <div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            onClick={onDownload}
            style={btnStyle(biliColor, 'rgba(251,114,153,0.10)')}
          >
            <Download size={12} /> 重试下载
          </button>
          <HudSelect inline value={quality} options={qualityOptions} onChange={onQualityChange} />
        </div>
        <div style={{
          marginTop: 4, fontSize: 10,
          color: theme.dangerRed, display: 'flex',
          alignItems: 'flex-start', gap: 4,
          wordBreak: 'break-all',
        }}>
          <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{dl.message || '未知错误'}</span>
        </div>
      </div>
    )
  }

  // idle
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <button
        onClick={onDownload}
        style={btnStyle(biliColor, 'rgba(251,114,153,0.10)')}
      >
        <Download size={12} /> 下载视频
      </button>
      <HudSelect inline value={quality} options={qualityOptions} onChange={onQualityChange} />
    </div>
  )
}

function btnStyle(color: string, bg: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '4px 10px', fontSize: 11, fontWeight: 600,
    fontFamily: theme.fontBody,
    color, background: bg,
    border: `1px solid ${color}`, borderRadius: 3,
    cursor: 'pointer', letterSpacing: 0.5,
  }
}
