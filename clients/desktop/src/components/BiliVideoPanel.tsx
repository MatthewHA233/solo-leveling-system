/**
 * BiliVideoPanel — B站视频轨道悬浮/固定时，右侧栏展示的面板
 * 显示：封面缩略图、标题、UP主、时长/进度
 */

import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Download, Check, AlertTriangle, Loader2, FolderOpen, ScanText, Trash2 } from 'lucide-react'
import type { BiliSpan } from '../lib/local-api'
import { theme } from '../theme'
import { loadConfig } from '../lib/agent/agent-config'
import Tooltip from './Tooltip'
import HudSelect from './HudSelect'
import ConfirmDialog from './ConfirmDialog'

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
  /** 是否已开启转录面板（决定按钮态） */
  transcribeOpen?: boolean
  /** 请求打开/关闭转录面板（由父组件决定面板挂载位置） */
  onToggleTranscribe?: (filePath: string) => void
  /** 有本地视频时，点击封面/播放按钮调用此回调（让父级进 theater） */
  onPlayLocal?: () => void
  /** 影院模式生效中：父级已挂载真实视频，封面应该隐去 */
  theaterActive?: boolean
  /** 提供时，点击标题不再跳浏览器，而是让父级打开"视频详情"（如 BiliHistoryDialog 的 overlay） */
  onOpenDetail?: () => void
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

export default function BiliVideoPanel({ span, transcribeOpen, onToggleTranscribe, onPlayLocal, theaterActive, onOpenDetail }: Props) {
  const progressPct = span.duration > 0
    ? Math.min(100, Math.round((span.progress / span.duration) * 100))
    : 0

  // ── 下载状态 ──
  const [dl, setDl] = useState<DlProgress>({
    bvid: span.bvid, stage: 'idle', percent: 0, message: null, output_path: null, queue_position: null,
  })
  const [doneFileSize, setDoneFileSize] = useState<number | null>(null)

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
    setDoneFileSize(null)
    setAvailableQns(null)
    let cancelled = false

    invoke<BiliVideoAsset[]>('get_bili_assets_by_bvid', { bvid: span.bvid })
      .then((assets) => {
        if (cancelled) return
        const done = assets.find((a) => a.download_status === 'done' && a.download_path)
        if (done && done.download_path) {
          setDoneFileSize(done.file_size)
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

  // 同一 bvid 在别处（如详情浮层）被删除 → 本面板也复位为"未下载"
  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ bvid?: string; reason?: string }>).detail
      if (detail?.reason !== 'deleted' || detail.bvid !== span.bvid) return
      setDl({ bvid: span.bvid, stage: 'idle', percent: 0, message: null, output_path: null, queue_position: null })
      setDoneFileSize(null)
    }
    window.addEventListener('solevup:bili-assets-changed', onChanged)
    return () => window.removeEventListener('solevup:bili-assets-changed', onChanged)
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

  // ── 删除已下载内容（文件 + 衍生 + 转录记录） ──
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await invoke('delete_bili_download', { bvid: span.bvid })
      // 复位本地态：回到"未下载"
      setDl({ bvid: span.bvid, stage: 'idle', percent: 0, message: null, output_path: null, queue_position: null })
      setDoneFileSize(null)
      // 广播「B站资产已变更」：历史列表绿标/计数、详情浮层、日历计数等即时刷新
      window.dispatchEvent(new CustomEvent('solevup:bili-assets-changed', {
        detail: { bvid: span.bvid, reason: 'deleted' },
      }))
    } catch (err) {
      setDl((prev) => ({ ...prev, stage: 'error', message: `删除失败: ${String(err)}` }))
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

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

      {/* 封面（有本地视频→点击进入影院/外部详情；否则打开浏览器；影院模式下隐藏） */}
      {span.cover && !theaterActive && (() => {
        // 只有当本面板内部已确认下载完成,且父级提供了 onPlayLocal,才走"本地播放"路径
        const canPlayLocal = dl.stage === 'done' && !!onPlayLocal
        return (
        <Tooltip content={canPlayLocal ? '播放本地视频' : '在浏览器打开'}>
        <div
          onClick={() => { if (canPlayLocal) onPlayLocal!(); else openBili(span.bvid) }}
          style={{
            marginBottom: 8, borderRadius: 4, overflow: 'hidden',
            border: `1px solid ${canPlayLocal ? theme.shadowPurple : theme.divider}`,
            cursor: 'pointer', position: 'relative',
          }}
        >
          <img
            src={`http://localhost:49733/api/bilibili/cover?url=${encodeURIComponent(span.cover)}`}
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
        </Tooltip>
        )
      })()}

      {/* 视频标题（父级提供 onOpenDetail 时 → 打开视频详情；否则 → 打开浏览器） */}
      <Tooltip content={onOpenDetail ? '查看视频详情' : '在浏览器打开'}>
      <div
        onClick={() => { if (onOpenDetail) onOpenDetail(); else openBili(span.bvid) }}
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
      </Tooltip>

      {/* UP主 + 观看时间（右对齐） */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 8,
        fontSize: 11,
        color: theme.textSecondary,
      }}>
        {span.author_name && (
          <span style={{
            flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            UP: {span.author_name}
          </span>
        )}
        <span style={{
          flexShrink: 0, marginLeft: 'auto',
          letterSpacing: 0.3,
        }}>
          在 <span style={{ fontFamily: theme.fontMono, color: theme.textPrimary }}>{fmt(span.end_at)}</span> 观看
        </span>
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

      {/* BV号 + 主操作（清晰度 + 下载）—— 下载进行中让位给进度行 */}
      <div style={{
        marginTop: 8,
        display: 'flex', alignItems: 'center', gap: 8,
        minHeight: 24,
      }}>
        <span style={{
          fontFamily: theme.fontMono,
          fontSize: 11, fontWeight: 600,
          color: theme.textSecondary, letterSpacing: 0.5,
        }}>
          {span.bvid}
        </span>
        <span style={{ flex: 1 }} />
        {!isWorking && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <HudSelect inline value={quality} options={visibleOptions} onChange={setQuality} />
            <button onClick={handleDownload} style={primaryBtnStyle(BILI_COLOR)}>
              <Download size={12} />
              {dl.stage === 'done' ? '重新下载' : dl.stage === 'error' ? '重试' : '下载'}
            </button>
          </div>
        )}
      </div>

      {/* 状态行：下载中 → 进度条；完成 → [删除/打开/转录]；失败 → 错误 */}
      {isWorking && <DownloadProgress dl={dl} biliColor={BILI_COLOR} />}

      {dl.stage === 'done' && (
        <div style={{
          marginTop: 8,
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        }}>
          <DeleteChip size={doneFileSize} disabled={deleting} onClick={() => setConfirmDelete(true)} />
          <span style={{ flex: 1 }} />
          <Tooltip content={dl.output_path || '打开文件位置'}>
            <button onClick={() => dl.output_path && openInExplorer(dl.output_path)} style={ghostBtnStyle()}>
              <FolderOpen size={12} /> 打开
            </button>
          </Tooltip>
          {dl.output_path && onToggleTranscribe && (
            <TranscribeButton
              active={!!transcribeOpen}
              onClick={() => onToggleTranscribe(dl.output_path!)}
            />
          )}
        </div>
      )}

      {dl.stage === 'error' && (
        <div style={{
          marginTop: 6, fontSize: 10,
          color: theme.dangerRed, display: 'flex',
          alignItems: 'flex-start', gap: 4,
          fontFamily: theme.fontMono, wordBreak: 'break-all',
        }}>
          <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{dl.message || '未知错误'}</span>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="DELETE DOWNLOAD"
        titleColor={theme.dangerRed}
        question="删除该视频的全部本地内容？"
        details={[
          <>下载文件、转码副本（_h264）与抽取的音轨（_audio）将从磁盘移除。</>,
          <>已转录的文本（视觉 / 音频 / 合并）记录也会一并清除。</>,
          <span style={{ color: theme.textMuted }}>B 站观看历史不受影响，可随时重新下载。</span>,
        ]}
        danger
        confirmLabel={deleting ? '删除中…' : '删除'}
        cancelLabel="取消"
        onConfirm={handleDelete}
        onCancel={() => { if (!deleting) setConfirmDelete(false) }}
      />
    </div>
  )
}

// ── 文件大小格式化 ──

function fmtFileSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return ''
  const KB = 1024, MB = KB * 1024, GB = MB * 1024
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)}GB`
  if (bytes >= MB) return `${Math.round(bytes / MB)}MB`
  if (bytes >= KB) return `${Math.round(bytes / KB)}KB`
  return `${bytes}B`
}

// ── 下载进度行（仅下载进行中显示） ──

function DownloadProgress({ dl, biliColor }: { dl: DlProgress; biliColor: string }) {
  return (
    <div style={{ marginTop: 8 }}>
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
        height: 3, borderRadius: 2,
        background: 'rgba(255,255,255,0.07)',
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

// ── 转录按钮（颜色/图标对齐转录面板本身：青色 + ScanText） ──

function TranscribeButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const C = '#00d7e8' // 与转录面板同源（TRACE）
  return (
    <Tooltip content={active ? '关闭转录面板' : '打开转录面板'}>
      <button
        onClick={onClick}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '4px 9px',
          fontFamily: theme.fontBody, fontSize: 11,
          fontWeight: active ? 600 : 500,
          color: C,
          background: active ? `${C}1f` : 'transparent',
          border: `1px solid ${active ? C : `${C}55`}`,
          borderRadius: 4,
          cursor: 'pointer',
          transition: 'background 0.14s, border-color 0.14s',
        }}
      >
        <ScanText size={12} />
        转录
      </button>
    </Tooltip>
  )
}

// ── 已保存徽标（hover 翻转为"删除下载"红色态） ──

function DeleteChip({ size, disabled, onClick }: {
  size: number | null
  disabled?: boolean
  onClick: () => void
}) {
  const green = theme.expGreen
  const red = theme.dangerRed
  return (
    <>
      <style>{`
        .bvp-del {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 4px 9px;
          font-family: ${theme.fontMono}; font-size: 10.5px; font-weight: 600;
          letter-spacing: 0.3px;
          color: ${green};
          background: transparent;
          border: 1px solid ${green}40;
          border-radius: 4px;
          cursor: pointer;
          transition: color .14s, border-color .14s, background .14s;
        }
        .bvp-del[disabled] { opacity: .5; cursor: default; }
        .bvp-del .bvp-del-x  { display: none; }
        .bvp-del .bvp-del-ok { display: inline-flex; align-items: center; gap: 4px; }
        .bvp-del:not([disabled]):hover {
          color: ${red};
          border-color: ${red}66;
          background: ${red}12;
        }
        .bvp-del:not([disabled]):hover .bvp-del-x  { display: inline-flex; align-items: center; gap: 4px; }
        .bvp-del:not([disabled]):hover .bvp-del-ok { display: none; }
      `}</style>
      <Tooltip content="删除下载（含转录文件与记录）">
        <button className="bvp-del" disabled={disabled} onClick={onClick}>
          <span className="bvp-del-ok"><Check size={11} /> 已保存{size ? ` · ${fmtFileSize(size)}` : ''}</span>
          <span className="bvp-del-x"><Trash2 size={11} /> 删除下载</span>
        </button>
      </Tooltip>
    </>
  )
}

// ── 按钮样式：主操作（品牌强调）/ 次操作（中性幽灵） ──

function primaryBtnStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '4px 11px', fontSize: 11, fontWeight: 600,
    fontFamily: theme.fontBody,
    color, background: `${color}1a`,
    border: `1px solid ${color}`, borderRadius: 4,
    cursor: 'pointer', letterSpacing: 0.3,
  }
}

function ghostBtnStyle(): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '4px 9px', fontSize: 11, fontWeight: 500,
    fontFamily: theme.fontBody,
    color: theme.textSecondary, background: 'transparent',
    border: `1px solid ${theme.divider}`, borderRadius: 4,
    cursor: 'pointer', letterSpacing: 0.3,
  }
}
