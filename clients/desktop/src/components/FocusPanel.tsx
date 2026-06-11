// ══════════════════════════════════════════════
// 专注锁 — 屏蔽组管理面板
// 应用规则来自昼夜表的全天应用轨道，而不是现场抓取入口
// ══════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, FolderOpen, Globe, Monitor, Plus, Shield, ShieldOff, Trash2 } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import type { PerceptionSpan } from '../lib/local-api'
import { hud, theme } from '../theme'

// ── 数据类型 ──────────────────────────────────

interface FocusGroup {
  id: string
  name: string
  websites: string[]
  exceptions: string[]
  apps: string[]
  isActive: boolean
  activatedAt: number | null
  durationMins: number | null
}

interface AppUsageTitle {
  title: string
  seconds: number
  count: number
}

interface AppUsage {
  app: string
  seconds: number
  count: number
  color: string
  titles: AppUsageTitle[]
}

interface FocusLockStartResult {
  hosts_ok: boolean
  hosts_error: string | null
  block_page_ok: boolean
  block_page_error: string | null
}

interface FocusLockCapability {
  hosts_writable: boolean
}

interface FocusExtStatus {
  connected: boolean
  last_heartbeat_ms: number
}

type InnerTab = 'websites' | 'exceptions' | 'apps'

interface FocusPanelProps {
  selectedDate: Date
  perceptionSpans: PerceptionSpan[]
}

// ── 网站预设分类 ──────────────────────────────

const SITE_PRESETS: Record<string, string[]> = {
  '社交媒体': ['twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'weibo.com', 'xiaohongshu.com'],
  '短视频': ['youtube.com', 'bilibili.com', 'douyin.com', 'tiktok.com', 'kuaishou.com'],
  '游戏平台': ['store.steampowered.com', 'epicgames.com', 'battlenet.com', 'wegame.com.cn'],
  '新闻资讯': ['toutiao.com', 'zhihu.com', 'weixin.qq.com', 'sina.com.cn', 'sohu.com'],
}

// ── 持久化 ────────────────────────────────────

const STORAGE_KEY = 'slu.focusGroups.v2'

function loadGroups(): FocusGroup[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    // 兼容 v1（无 exceptions 字段）
    return (JSON.parse(raw) as Partial<FocusGroup>[]).map((g) => ({
      id: g.id ?? crypto.randomUUID(),
      name: g.name ?? '未命名',
      websites: g.websites ?? [],
      exceptions: g.exceptions ?? [],
      apps: g.apps ?? [],
      isActive: g.isActive ?? false,
      activatedAt: g.activatedAt ?? null,
      durationMins: g.durationMins ?? 60,
    }))
  } catch {
    return []
  }
}

function saveGroups(groups: FocusGroup[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(groups))
  } catch {}
}

// ── 工具函数 ──────────────────────────────────

function newGroup(name: string): FocusGroup {
  return {
    id: crypto.randomUUID(),
    name,
    websites: [],
    exceptions: [],
    apps: [],
    isActive: false,
    activatedAt: null,
    durationMins: 60,
  }
}

function fmtElapsed(startMs: number): string {
  const s = Math.floor((Date.now() - startMs) / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

function cleanDomain(raw: string): string {
  return raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase().trim()
}

function toDateStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dtToSecond(dt: string): number {
  const time = dt.split(' ')[1] ?? '00:00:00'
  const [h = 0, m = 0, s = 0] = time.split(':').map((n) => Number(n) || 0)
  return h * 3600 + m * 60 + s
}

function spanSecondsOnDate(span: PerceptionSpan, date: Date): number {
  const dateStr = toDateStr(date)
  const startDate = span.start_at.split(' ')[0] ?? dateStr
  const endDate = span.end_at.split(' ')[0] ?? dateStr
  if (endDate < dateStr || startDate > dateStr) return 0

  const start = startDate < dateStr ? 0 : dtToSecond(span.start_at)
  const end = endDate > dateStr ? 24 * 3600 : dtToSecond(span.end_at)
  return Math.max(0, Math.min(24 * 3600, end) - Math.max(0, start))
}

function fmtDuration(seconds: number): string {
  const mins = Math.max(0, Math.round(seconds / 60))
  if (mins <= 0) return '<1分'
  if (mins < 60) return `${mins}分`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h${m}m` : `${h}h`
}

function fmtPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0%'
  return value >= 99.5 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`
}

function normalizeRule(rule: string): string {
  return rule.trim().replace(/\//g, '\\').toLowerCase()
}

function windowRule(app: string, title: string): string {
  return `window|${app}|${title}`
}

function describeAppRule(rule: string): { label: string; subLabel?: string } {
  const raw = rule.trim()
  if (raw.startsWith('window|')) {
    const parts = raw.split('|')
    const app = parts[1] || '未知应用'
    const title = parts.slice(2).join('|') || '无标题窗口'
    return { label: `窗口 · ${app}`, subLabel: title }
  }
  if (raw.startsWith('title:')) {
    return { label: `标题包含 · ${raw.slice(6)}`, subLabel: '命中前台窗口标题后自动最小化' }
  }
  if (raw.includes('\\') || raw.includes('/')) {
    const parts = raw.split(/[\\/]/)
    const filename = parts[parts.length - 1] || raw
    return { label: `应用路径 · ${filename}`, subLabel: raw }
  }
  return { label: `应用 · ${raw}` }
}

function buildAppUsages(spans: PerceptionSpan[], selectedDate: Date): AppUsage[] {
  const apps = new Map<string, AppUsage>()

  spans.forEach((span) => {
    if (span.track !== 'apps') return
    const appName = span.group_name?.trim()
    if (!appName) return

    const seconds = spanSecondsOnDate(span, selectedDate)
    if (seconds <= 0) return

    const appKey = appName.toLowerCase()
    const usage = apps.get(appKey) ?? {
      app: appName,
      seconds: 0,
      count: 0,
      color: span.color ?? theme.electricBlue,
      titles: [],
    }

    usage.seconds += seconds
    usage.count += 1
    if (!usage.color && span.color) usage.color = span.color

    const title = span.title?.trim() || '无标题窗口'
    const titleUsage = usage.titles.find((item) => item.title === title)
    if (titleUsage) {
      titleUsage.seconds += seconds
      titleUsage.count += 1
    } else {
      usage.titles.push({ title, seconds, count: 1 })
    }

    apps.set(appKey, usage)
  })

  return Array.from(apps.values())
    .map((usage) => ({
      ...usage,
      titles: usage.titles.sort((a, b) => b.seconds - a.seconds).slice(0, 5),
    }))
    .sort((a, b) => b.seconds - a.seconds)
}

// ── 子组件：左栏组项 ──────────────────────────

function GroupItem({ group, selected, onClick }: { group: FocusGroup; selected: boolean; onClick: () => void }) {
  const [elapsed, setElapsed] = useState('')

  useEffect(() => {
    if (!group.isActive || !group.activatedAt) {
      setElapsed('')
      return
    }
    setElapsed(fmtElapsed(group.activatedAt))
    const t = setInterval(() => setElapsed(fmtElapsed(group.activatedAt!)), 1000)
    return () => clearInterval(t)
  }, [group.isActive, group.activatedAt])

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        textAlign: 'left',
        background: selected ? 'rgba(0,229,255,0.07)' : 'transparent',
        border: 'none',
        borderLeft: `2px solid ${selected ? theme.electricBlue : group.isActive ? theme.expGreen : 'transparent'}`,
        padding: '10px 12px',
        cursor: 'pointer',
        transition: 'background 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {group.isActive
          ? <Shield size={13} color={theme.expGreen} style={{ flexShrink: 0 }} />
          : <ShieldOff size={13} color={theme.textMuted} style={{ flexShrink: 0 }} />
        }
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12.5,
            fontWeight: selected ? 700 : 400,
            color: group.isActive ? theme.expGreen : theme.textPrimary,
            fontFamily: theme.fontBody,
          }}
        >
          {group.name}
        </span>
      </div>
      <div style={{ paddingLeft: 20, marginTop: 3, fontSize: 10.5, color: theme.textMuted, fontFamily: theme.fontMono }}>
        {group.websites.length > 0 && <span>{group.websites.length} 网站</span>}
        {group.websites.length > 0 && group.apps.length > 0 && <span style={{ margin: '0 4px' }}>·</span>}
        {group.apps.length > 0 && <span>{group.apps.length} 规则</span>}
        {group.isActive && elapsed && <span style={{ marginLeft: 8, color: theme.expGreen }}>{elapsed}</span>}
      </div>
    </button>
  )
}

// ── 子组件：列表行 ────────────────────────────

function ListRow({ label, subLabel, onRemove }: { label: string; subLabel?: string; onRemove: () => void }) {
  const [hover, setHover] = useState(false)

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '5px 10px',
        borderRadius: 3,
        background: hover ? 'rgba(0,229,255,0.05)' : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            color: theme.textPrimary,
            fontFamily: theme.fontMono,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>
        {subLabel && (
          <div
            style={{
              marginTop: 2,
              fontSize: 10.5,
              color: theme.textMuted,
              fontFamily: theme.fontMono,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {subLabel}
          </div>
        )}
      </div>
      {hover && (
        <button
          type="button"
          onClick={onRemove}
          style={{
            flexShrink: 0,
            padding: '1px 5px',
            border: `1px solid rgba(255,68,68,0.4)`,
            borderRadius: 3,
            background: 'rgba(255,68,68,0.1)',
            color: theme.dangerRed,
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: theme.fontBody,
          }}
        >
          移除
        </button>
      )}
    </div>
  )
}

// ── 子组件：预设分类下拉 ──────────────────────

function PresetDropdown({ onAdd }: { onAdd: (domains: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '5px 10px',
          border: `1px solid rgba(0,229,255,0.22)`,
          borderRadius: 4,
          background: 'transparent',
          cursor: 'pointer',
          color: theme.textSecondary,
          fontSize: 12,
          fontFamily: theme.fontBody,
        }}
      >
        预设分类 <ChevronDown size={12} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 100,
            background: theme.hudFillDeep,
            border: `1px solid ${theme.hudFrame}`,
            borderRadius: 6,
            overflow: 'hidden',
            minWidth: 140,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}
        >
          {Object.entries(SITE_PRESETS).map(([label, domains]) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                onAdd(domains)
                setOpen(false)
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 14px',
                border: 'none',
                background: 'transparent',
                color: theme.textPrimary,
                fontSize: 12.5,
                cursor: 'pointer',
                fontFamily: theme.fontBody,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,229,255,0.08)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {label}
              <span style={{ marginLeft: 8, fontSize: 11, color: theme.textMuted }}>+{domains.length}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 应用轨道候选 ──────────────────────────────

function AppUsagePicker({
  usages,
  totalSeconds,
  selectedRules,
  onAddRule,
}: {
  usages: AppUsage[]
  totalSeconds: number
  selectedRules: string[]
  onAddRule: (rule: string) => void
}) {
  const selected = new Set(selectedRules.map(normalizeRule))

  if (usages.length === 0) {
    return (
      <EmptyHint
        text="当前日期还没有应用轨道数据。等窗口活动同步进昼夜表后，这里会按应用统计时长和占比。"
        icon={<Monitor size={28} color="rgba(0,229,255,0.15)" />}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {usages.map((usage) => {
        const appRule = usage.app
        const appSelected = selected.has(normalizeRule(appRule))
        const appTrackPercent = totalSeconds > 0 ? usage.seconds / totalSeconds * 100 : 0
        const dayPercent = usage.seconds / (24 * 3600) * 100
        const barWidth = Math.max(4, Math.min(100, appTrackPercent))

        return (
          <div
            key={usage.app.toLowerCase()}
            style={{
              position: 'relative',
              border: `1px solid rgba(0,229,255,0.16)`,
              background: 'linear-gradient(135deg, rgba(0,229,255,0.055), rgba(0,0,0,0.1))',
              clipPath: hud.chamfer8,
              padding: '10px 12px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: 3,
                background: usage.color || theme.electricBlue,
                boxShadow: `0 0 14px ${usage.color || theme.electricBlue}`,
              }}
            />

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: theme.textPrimary,
                      fontFamily: theme.fontMono,
                      fontSize: 13,
                      fontWeight: 700,
                    }}
                  >
                    {usage.app}
                  </span>
                  <span style={{ flexShrink: 0, color: theme.textMuted, fontFamily: theme.fontMono, fontSize: 10.5 }}>
                    {usage.count} 段
                  </span>
                </div>

                <div style={{ marginTop: 6, height: 4, background: 'rgba(0,229,255,0.08)', borderRadius: 4, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${barWidth}%`,
                      height: '100%',
                      background: usage.color || theme.electricBlue,
                      boxShadow: `0 0 10px ${usage.color || theme.electricBlue}`,
                    }}
                  />
                </div>

                <div style={{ marginTop: 5, color: theme.textMuted, fontFamily: theme.fontMono, fontSize: 10.5 }}>
                  {fmtDuration(usage.seconds)} · 占应用轨道 {fmtPercent(appTrackPercent)} · 占全天 {fmtPercent(dayPercent)}
                </div>
              </div>

              <button
                type="button"
                disabled={appSelected}
                onClick={() => onAddRule(appRule)}
                style={{
                  flexShrink: 0,
                  padding: '5px 10px',
                  border: `1px solid ${appSelected ? 'rgba(0,255,136,0.25)' : 'rgba(0,229,255,0.28)'}`,
                  borderRadius: 4,
                  background: appSelected ? 'rgba(0,255,136,0.08)' : 'rgba(0,229,255,0.08)',
                  color: appSelected ? theme.expGreen : theme.electricBlue,
                  fontSize: 12,
                  cursor: appSelected ? 'default' : 'pointer',
                  fontFamily: theme.fontBody,
                }}
              >
                {appSelected ? '已加入' : '屏蔽应用'}
              </button>
            </div>

            {usage.titles.length > 0 && (
              <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {usage.titles.map((title) => {
                  const rule = windowRule(usage.app, title.title)
                  const windowSelected = selected.has(normalizeRule(rule))
                  const titlePercent = usage.seconds > 0 ? title.seconds / usage.seconds * 100 : 0
                  return (
                    <div
                      key={`${usage.app}-${title.title}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '5px 7px',
                        background: 'rgba(0,0,0,0.14)',
                        border: `1px solid rgba(0,229,255,0.07)`,
                        borderRadius: 4,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            color: theme.textSecondary,
                            fontFamily: theme.fontBody,
                            fontSize: 11.5,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {title.title}
                        </div>
                        <div style={{ marginTop: 2, color: theme.textMuted, fontFamily: theme.fontMono, fontSize: 10 }}>
                          {fmtDuration(title.seconds)} · {fmtPercent(titlePercent)}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={windowSelected}
                        onClick={() => onAddRule(rule)}
                        style={{
                          flexShrink: 0,
                          padding: '3px 7px',
                          border: `1px solid ${windowSelected ? 'rgba(0,255,136,0.22)' : 'rgba(0,229,255,0.18)'}`,
                          borderRadius: 3,
                          background: windowSelected ? 'rgba(0,255,136,0.06)' : 'transparent',
                          color: windowSelected ? theme.expGreen : theme.textSecondary,
                          fontSize: 11,
                          cursor: windowSelected ? 'default' : 'pointer',
                          fontFamily: theme.fontBody,
                        }}
                      >
                        {windowSelected ? '已锁定' : '锁此窗口'}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── 持续时间选项 ──────────────────────────────

const DURATION_OPTIONS: { label: string; mins: number | null }[] = [
  { label: '25 分', mins: 25 },
  { label: '1 小时', mins: 60 },
  { label: '2 小时', mins: 120 },
  { label: '永久', mins: null },
]

// ── 主面板 ─────────────────────────────────────

export default function FocusPanel({ selectedDate, perceptionSpans }: FocusPanelProps) {
  const [groups, setGroups] = useState<FocusGroup[]>(loadGroups)
  const [selectedId, setSelectedId] = useState<string | null>(() => loadGroups()[0]?.id ?? null)
  const [innerTab, setInnerTab] = useState<InnerTab>('websites')
  const [urlInput, setUrlInput] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [editName, setEditName] = useState('')
  // null = 尚未检测完成；false = hosts 不可写（通常是没有管理员权限）
  const [hostsWritable, setHostsWritable] = useState<boolean | null>(null)
  // Chrome 扩展（网站屏蔽主执行器）是否在线
  const [extConnected, setExtConnected] = useState(false)
  // 每个组最近一次开启时的降级/失败说明（不持久化）
  const [groupIssues, setGroupIssues] = useState<Record<string, string>>({})
  const nameInputRef = useRef<HTMLInputElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)

  const appUsages = buildAppUsages(perceptionSpans, selectedDate)
  const totalAppSeconds = appUsages.reduce((sum, usage) => sum + usage.seconds, 0)
  const selectedDateLabel = selectedDate.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' })

  useEffect(() => {
    saveGroups(groups)
  }, [groups])

  // 能力检测：hosts 不可写时在面板顶部常驻提示，而不是等用户开启后才静默失败
  useEffect(() => {
    invoke<FocusLockCapability>('focus_lock_check_capability')
      .then((cap) => setHostsWritable(cap.hosts_writable))
      .catch((e) => {
        console.error('[FocusLock] capability check failed:', e)
        setHostsWritable(null)
      })
  }, [])

  // 轮询扩展在线状态（nm_host 每 3s 心跳）
  useEffect(() => {
    let alive = true
    const poll = () => {
      invoke<FocusExtStatus>('focus_lock_ext_status')
        .then((s) => { if (alive) setExtConnected(s.connected) })
        .catch(() => { if (alive) setExtConnected(false) })
    }
    poll()
    const t = window.setInterval(poll, 4000)
    return () => { alive = false; window.clearInterval(t) }
  }, [])

  // 后端状态不会随 localStorage 自动恢复；启动时把 UI 里过期的“屏蔽中”状态校正掉。
  useEffect(() => {
    invoke<string[]>('focus_lock_get_active')
      .then((activeIds) => {
        const active = new Set(activeIds)
        setGroups((prev) => prev.map((g) => (
          active.has(g.id) ? g : { ...g, isActive: false, activatedAt: null }
        )))
      })
      .catch((e) => console.error('[FocusLock] sync active state failed:', e))
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const expiredIds: string[] = []
      setGroups((prev) => prev.map((g) => {
        if (!g.isActive || !g.activatedAt || g.durationMins === null) return g
        const expiresAt = g.activatedAt + g.durationMins * 60_000
        if (Date.now() < expiresAt) return g
        expiredIds.push(g.id)
        return { ...g, isActive: false, activatedAt: null }
      }))
      expiredIds.forEach((id) => invoke('focus_lock_stop', { groupId: id }).catch(console.error))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  const selectedGroup = groups.find((g) => g.id === selectedId) ?? null

  const mutate = useCallback((id: string, fn: (g: FocusGroup) => FocusGroup) => {
    setGroups((prev) => prev.map((g) => g.id === id ? fn(g) : g))
  }, [])

  // ── 组操作 ───────────────────────────────────

  const handleCreateGroup = () => {
    const g = newGroup(`屏蔽组 ${groups.length + 1}`)
    setGroups((prev) => [...prev, g])
    setSelectedId(g.id)
    setInnerTab('websites')
    setTimeout(() => {
      setEditingName(true)
      setEditName(g.name)
    }, 50)
  }

  const handleDeleteGroup = (id: string) => {
    const g = groups.find((x) => x.id === id)
    if (g?.isActive) invoke('focus_lock_stop', { groupId: id }).catch(() => {})
    setGroupIssue(id, null)
    setGroups((prev) => prev.filter((x) => x.id !== id))
    setSelectedId((prev) => {
      if (prev !== id) return prev
      return groups.filter((x) => x.id !== id)[0]?.id ?? null
    })
  }

  const setGroupIssue = useCallback((id: string, issue: string | null) => {
    setGroupIssues((prev) => {
      if (issue === null) {
        if (!(id in prev)) return prev
        const { [id]: _removed, ...rest } = prev
        return rest
      }
      return { ...prev, [id]: issue }
    })
  }, [])

  const handleToggle = async (id: string) => {
    const group = groups.find((g) => g.id === id)
    if (!group) return

    if (group.isActive) {
      mutate(id, (g) => ({ ...g, isActive: false, activatedAt: null }))
      setGroupIssue(id, null)
      invoke('focus_lock_stop', { groupId: id }).catch(console.error)
      return
    }

    // 乐观置为激活；启动失败或完全无效时回滚
    mutate(id, (g) => ({ ...g, isActive: true, activatedAt: Date.now() }))
    try {
      const result = await invoke<FocusLockStartResult>('focus_lock_start', {
        groupId: id,
        websites: group.websites,
        exceptions: group.exceptions,
        apps: group.apps,
      })

      // 网站屏蔽双通道：Chrome 扩展（主）或 hosts（兜底），任一可用即生效
      const hasWebsites = group.websites.length > 0
      const websiteBlockingWorks = extConnected || result.hosts_ok
      const issues: string[] = []

      if (hasWebsites && !websiteBlockingWorks) {
        // 扩展没连上、hosts 也写不进去 → 网站这块彻底没生效
        if (group.apps.length === 0) {
          mutate(id, (g) => ({ ...g, isActive: false, activatedAt: null }))
          invoke('focus_lock_stop', { groupId: id }).catch(() => {})
          issues.push('未开启屏蔽：Chrome 扩展未连接，且无 hosts 写入权限。请安装「Solevup 专注锁」扩展，或以管理员身份重启')
        } else {
          issues.push('网站屏蔽未生效（扩展未连接 + 无 hosts 权限），仅应用窗口屏蔽生效')
        }
      } else if (hasWebsites && !extConnected) {
        // 扩展没连上但 hosts 兜底了 → 提示降级（hosts 对 HTTPS/浏览器 DNS 缓存有局限）
        issues.push('Chrome 扩展未连接，网站屏蔽退化为 hosts 兜底：HTTPS 站点可能只显示浏览器错误页、已打开的标签页需手动关闭。安装「Solevup 专注锁」扩展可获得完整拦截')
      }

      setGroupIssue(id, issues.length > 0 ? issues.join('；') : null)
    } catch (e) {
      console.error('[FocusLock] start failed:', e)
      mutate(id, (g) => ({ ...g, isActive: false, activatedAt: null }))
      setGroupIssue(id, `开启失败：${String(e)}`)
    }
  }

  const confirmEditName = () => {
    if (!selectedId || !editName.trim()) {
      setEditingName(false)
      return
    }
    mutate(selectedId, (g) => ({ ...g, name: editName.trim() }))
    setEditingName(false)
  }

  // ── 网站操作 ─────────────────────────────────

  const handleAddUrl = (raw: string, field: 'websites' | 'exceptions') => {
    if (!selectedId || !raw.trim()) return
    const value = cleanDomain(raw)
    if (!value) return
    mutate(selectedId, (g) => {
      const list = g[field]
      return list.includes(value) ? g : { ...g, [field]: [...list, value] }
    })
    setUrlInput('')
  }

  const handleAddPreset = (domains: string[]) => {
    if (!selectedId) return
    mutate(selectedId, (g) => {
      const toAdd = domains.filter((d) => !g.websites.includes(d))
      return toAdd.length ? { ...g, websites: [...g.websites, ...toAdd] } : g
    })
  }

  const handleRemoveUrl = (field: 'websites' | 'exceptions', value: string) => {
    if (!selectedId) return
    mutate(selectedId, (g) => ({ ...g, [field]: g[field].filter((v) => v !== value) }))
  }

  // ── 应用操作 ─────────────────────────────────

  const addAppRule = (rule: string | null | undefined) => {
    if (!selectedId) return
    const trimmed = (rule ?? '').trim()
    if (!trimmed) return
    const key = normalizeRule(trimmed)
    mutate(selectedId, (g) => (
      g.apps.some((item) => normalizeRule(item) === key) ? g : { ...g, apps: [...g.apps, trimmed] }
    ))
    setUrlInput('')
  }

  const handlePickExe = async () => {
    if (!selectedId) return
    try {
      const result = await openDialog({
        title: '选择要屏蔽的应用程序',
        filters: [{ name: '可执行文件', extensions: ['exe'] }],
        multiple: true,
      })
      const files = Array.isArray(result) ? result : result ? [result] : []
      if (!files.length) return
      const rules = files.map((f) => (f as string).trim()).filter(Boolean)
      mutate(selectedId, (g) => {
        const existing = new Set(g.apps.map(normalizeRule))
        const toAdd = rules.filter((rule) => !existing.has(normalizeRule(rule)))
        return toAdd.length ? { ...g, apps: [...g.apps, ...toAdd] } : g
      })
    } catch (e) {
      console.error('[FocusLock] pickExe failed:', e)
    }
  }

  const handleRemoveApp = (name: string) => {
    if (!selectedId) return
    mutate(selectedId, (g) => ({ ...g, apps: g.apps.filter((a) => a !== name) }))
  }

  // ── 渲染 ─────────────────────────────────────

  const tabBtn = (id: InnerTab, label: string, count: number) => (
    <button
      type="button"
      key={id}
      onClick={() => setInnerTab(id)}
      style={{
        padding: '7px 16px',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        fontFamily: theme.fontBody,
        fontSize: 12.5,
        color: innerTab === id ? theme.electricBlue : theme.textMuted,
        fontWeight: innerTab === id ? 700 : 400,
        borderBottom: `2px solid ${innerTab === id ? theme.electricBlue : 'transparent'}`,
        transition: 'color 0.15s, border-color 0.15s',
      }}
    >
      {label}
      {count > 0 && (
        <span
          style={{
            marginLeft: 6,
            padding: '1px 6px',
            borderRadius: 10,
            background: innerTab === id ? 'rgba(0,229,255,0.15)' : 'rgba(255,255,255,0.06)',
            color: innerTab === id ? theme.electricBlue : theme.textMuted,
            fontSize: 10.5,
            fontFamily: theme.fontMono,
          }}
        >
          {count}
        </span>
      )}
    </button>
  )

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: theme.hudFill,
        clipPath: hud.chamfer12,
        border: `1px solid ${theme.hudFrame}`,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div style={{ position: 'absolute', inset: 0, background: hud.scanlines, pointerEvents: 'none', zIndex: 0 }} />

      {hostsWritable === false && (
        <div
          style={{
            zIndex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 14px',
            borderBottom: '1px solid rgba(255,153,51,0.3)',
            background: 'rgba(255,153,51,0.08)',
            color: theme.warningOrange,
            fontSize: 12,
            lineHeight: 1.5,
            fontFamily: theme.fontBody,
          }}
        >
          <Shield size={13} style={{ flexShrink: 0 }} />
          <span>
            未检测到 hosts 写入权限，<strong>网站屏蔽不可用</strong>（应用窗口屏蔽不受影响）。请以管理员身份重新运行 Solevup。
          </span>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', zIndex: 1 }}>

      <div
        style={{
          width: 200,
          flexShrink: 0,
          borderRight: `1px solid ${theme.hudFrameSoft}`,
          display: 'flex',
          flexDirection: 'column',
          zIndex: 1,
        }}
      >
        <div style={{ padding: '13px 14px 10px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${theme.hudFrameSoft}` }}>
          <Shield size={14} color={theme.electricBlue} />
          <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: theme.electricBlue, fontFamily: theme.fontBody, letterSpacing: '0.08em' }}>专注锁</span>
          <span
            title={extConnected ? 'Chrome 扩展已连接，网站屏蔽由扩展执行' : 'Chrome 扩展未连接，网站屏蔽退化为 hosts 兜底'}
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontFamily: theme.fontMono, color: extConnected ? theme.expGreen : theme.textMuted }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: extConnected ? theme.expGreen : theme.textMuted, boxShadow: extConnected ? `0 0 6px ${theme.expGreen}` : 'none' }} />
            扩展
          </span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {groups.length === 0 && (
            <div style={{ padding: '20px 14px', fontSize: 11.5, color: theme.textMuted, fontFamily: theme.fontBody, textAlign: 'center' }}>
              还没有屏蔽组
            </div>
          )}
          {groups.map((g) => (
            <GroupItem
              key={g.id}
              group={g}
              selected={g.id === selectedId}
              onClick={() => {
                setSelectedId(g.id)
                setInnerTab('websites')
                setUrlInput('')
                setEditingName(false)
              }}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={handleCreateGroup}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            justifyContent: 'center',
            padding: '10px 14px',
            border: 'none',
            background: 'rgba(0,229,255,0.05)',
            borderTop: `1px solid ${theme.hudFrameSoft}`,
            cursor: 'pointer',
            color: theme.textSecondary,
            fontSize: 12,
            fontFamily: theme.fontBody,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,229,255,0.1)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(0,229,255,0.05)')}
        >
          <Plus size={13} /> 新建屏蔽组
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', zIndex: 1, overflow: 'hidden', minWidth: 0 }}>
        {!selectedGroup ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textMuted, fontSize: 13, fontFamily: theme.fontBody }}>
            选择或新建一个屏蔽组
          </div>
        ) : (
          <>
            <div style={{ padding: '10px 18px', borderBottom: `1px solid ${theme.hudFrameSoft}`, display: 'flex', alignItems: 'center', gap: 10 }}>
              {editingName ? (
                <input
                  ref={nameInputRef}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={confirmEditName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmEditName()
                    if (e.key === 'Escape') setEditingName(false)
                  }}
                  style={{
                    flex: 1,
                    background: 'rgba(0,229,255,0.06)',
                    border: '1px solid rgba(0,229,255,0.3)',
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 13.5,
                    fontWeight: 700,
                    color: theme.textPrimary,
                    fontFamily: theme.fontBody,
                    outline: 'none',
                  }}
                />
              ) : (
                <span
                  onClick={() => {
                    setEditName(selectedGroup.name)
                    setEditingName(true)
                    setTimeout(() => nameInputRef.current?.focus(), 20)
                  }}
                  style={{ flex: 1, fontSize: 13.5, fontWeight: 700, color: theme.textPrimary, fontFamily: theme.fontBody, cursor: 'text' }}
                  title="点击重命名"
                >
                  {selectedGroup.name}
                </span>
              )}
              {selectedGroup.isActive && (
                <span style={{ fontSize: 11, color: theme.expGreen, padding: '2px 8px', borderRadius: 3, background: 'rgba(0,255,136,0.1)', border: '1px solid rgba(0,255,136,0.25)', fontFamily: theme.fontMono }}>
                  屏蔽中
                </span>
              )}
              <button
                type="button"
                onClick={() => handleDeleteGroup(selectedGroup.id)}
                style={{ display: 'flex', padding: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: theme.textMuted, borderRadius: 3 }}
                onMouseEnter={(e) => (e.currentTarget.style.color = theme.dangerRed)}
                onMouseLeave={(e) => (e.currentTarget.style.color = theme.textMuted)}
              >
                <Trash2 size={14} />
              </button>
            </div>

            <div style={{ display: 'flex', borderBottom: `1px solid ${theme.hudFrameSoft}`, paddingLeft: 6 }}>
              {tabBtn('websites', '网站', selectedGroup.websites.length)}
              {tabBtn('exceptions', '例外', selectedGroup.exceptions.length)}
              {tabBtn('apps', '应用轨道', selectedGroup.apps.length)}
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', borderBottom: `1px solid rgba(0,229,255,0.06)`, display: 'flex', gap: 8, alignItems: 'center', flexWrap: innerTab === 'apps' ? 'wrap' : 'nowrap' }}>
                {innerTab !== 'apps' ? (
                  <>
                    <input
                      ref={urlInputRef}
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAddUrl(urlInput, innerTab)
                      }}
                      placeholder={innerTab === 'websites' ? '输入域名，例: youtube.com' : '输入放行域名，例: music.youtube.com'}
                      style={{
                        flex: 1,
                        background: 'rgba(0,229,255,0.05)',
                        border: '1px solid rgba(0,229,255,0.2)',
                        borderRadius: 4,
                        padding: '6px 10px',
                        fontSize: 12.5,
                        color: theme.textPrimary,
                        fontFamily: theme.fontMono,
                        outline: 'none',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => handleAddUrl(urlInput, innerTab)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '6px 14px',
                        border: `1px solid rgba(0,229,255,0.3)`,
                        borderRadius: 4,
                        background: 'rgba(0,229,255,0.1)',
                        color: theme.electricBlue,
                        fontSize: 12.5,
                        cursor: 'pointer',
                        fontFamily: theme.fontBody,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <Plus size={12} /> 添加
                    </button>
                    {innerTab === 'websites' && <PresetDropdown onAdd={handleAddPreset} />}
                  </>
                ) : (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 10px',
                        border: '1px solid rgba(0,229,255,0.12)',
                        background: 'rgba(0,229,255,0.04)',
                        borderRadius: 4,
                        color: theme.textSecondary,
                        fontFamily: theme.fontMono,
                        fontSize: 11.5,
                      }}
                    >
                      <span style={{ color: theme.electricBlue }}>应用轨道</span>
                      <span>{selectedDateLabel}</span>
                      <span>{appUsages.length} 应用</span>
                      <span>{fmtDuration(totalAppSeconds)}</span>
                    </div>
                    <button
                      type="button"
                      onClick={handlePickExe}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 7,
                        padding: '6px 12px',
                        border: `1px solid rgba(0,229,255,0.24)`,
                        borderRadius: 4,
                        background: 'rgba(0,229,255,0.06)',
                        color: theme.textSecondary,
                        fontSize: 12,
                        cursor: 'pointer',
                        fontFamily: theme.fontBody,
                      }}
                    >
                      <FolderOpen size={13} /> 手动选择 .exe
                    </button>
                    <input
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || !urlInput.trim()) return
                        addAppRule(urlInput)
                      }}
                      placeholder="兜底输入：qq.exe、title:FinalShell、或程序路径"
                      style={{
                        flex: 1,
                        minWidth: 220,
                        background: 'rgba(0,229,255,0.05)',
                        border: '1px solid rgba(0,229,255,0.2)',
                        borderRadius: 4,
                        padding: '6px 10px',
                        fontSize: 12.5,
                        color: theme.textPrimary,
                        fontFamily: theme.fontMono,
                        outline: 'none',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => addAppRule(urlInput)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '6px 12px',
                        border: `1px solid rgba(0,229,255,0.3)`,
                        borderRadius: 4,
                        background: 'rgba(0,229,255,0.1)',
                        color: theme.electricBlue,
                        fontSize: 12.5,
                        cursor: 'pointer',
                        fontFamily: theme.fontBody,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <Plus size={12} /> 添加规则
                    </button>
                  </>
                )}
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: innerTab === 'apps' ? '10px 12px' : '4px 8px' }}>
                {innerTab === 'websites' && (
                  selectedGroup.websites.length === 0
                    ? <EmptyHint text="还没有屏蔽的网站" icon={<Globe size={28} color="rgba(0,229,255,0.15)" />} />
                    : selectedGroup.websites.map((w) => <ListRow key={w} label={w} onRemove={() => handleRemoveUrl('websites', w)} />)
                )}
                {innerTab === 'exceptions' && (
                  selectedGroup.exceptions.length === 0
                    ? <EmptyHint text="放行域名：即使命中上面的屏蔽规则，这里的域名（含子域）仍可访问。例：屏蔽 youtube.com 但放行 music.youtube.com" icon={<Globe size={28} color="rgba(0,229,255,0.15)" />} />
                    : selectedGroup.exceptions.map((e) => <ListRow key={e} label={e} onRemove={() => handleRemoveUrl('exceptions', e)} />)
                )}
                {innerTab === 'apps' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', gap: 12, alignItems: 'start' }}>
                    <AppUsagePicker
                      usages={appUsages}
                      totalSeconds={totalAppSeconds}
                      selectedRules={selectedGroup.apps}
                      onAddRule={addAppRule}
                    />
                    <div
                      style={{
                        border: `1px solid rgba(0,229,255,0.14)`,
                        background: 'rgba(0,0,0,0.12)',
                        clipPath: hud.chamfer8,
                        padding: '9px 8px',
                      }}
                    >
                      <div style={{ marginBottom: 6, color: theme.electricBlue, fontSize: 12, fontFamily: theme.fontBody, fontWeight: 700 }}>
                        当前屏蔽规则
                      </div>
                      {selectedGroup.apps.length === 0 ? (
                        <div style={{ padding: '18px 8px', color: theme.textMuted, fontSize: 11.5, lineHeight: 1.6, fontFamily: theme.fontBody }}>
                          从左侧应用轨道里选择“屏蔽应用”，或只锁定某个窗口标题。
                        </div>
                      ) : (
                        selectedGroup.apps.map((a) => {
                          const desc = describeAppRule(a)
                          return <ListRow key={a} label={desc.label} subLabel={desc.subLabel} onRemove={() => handleRemoveApp(a)} />
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div style={{ padding: '12px 18px', borderTop: `1px solid ${theme.hudFrameSoft}` }}>
              {groupIssues[selectedGroup.id] && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: '8px 12px',
                    border: '1px solid rgba(255,153,51,0.35)',
                    borderRadius: 4,
                    background: 'rgba(255,153,51,0.08)',
                    color: theme.warningOrange,
                    fontSize: 11.5,
                    lineHeight: 1.6,
                    fontFamily: theme.fontBody,
                  }}
                >
                  {groupIssues[selectedGroup.id]}
                </div>
              )}
              {!selectedGroup.isActive && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                  <span style={{ fontSize: 11.5, color: theme.textMuted, fontFamily: theme.fontBody, flexShrink: 0 }}>持续时间</span>
                  {DURATION_OPTIONS.map((opt) => {
                    const active = selectedGroup.durationMins === opt.mins
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => mutate(selectedId!, (g) => ({ ...g, durationMins: opt.mins }))}
                        style={{
                          padding: '3px 10px',
                          border: `1px solid ${active ? theme.electricBlue : 'rgba(0,229,255,0.18)'}`,
                          borderRadius: 4,
                          background: active ? 'rgba(0,229,255,0.12)' : 'transparent',
                          color: active ? theme.electricBlue : theme.textMuted,
                          fontSize: 12,
                          cursor: 'pointer',
                          fontFamily: theme.fontBody,
                        }}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <button
                  type="button"
                  onClick={() => handleToggle(selectedGroup.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '9px 24px',
                    border: `1px solid ${selectedGroup.isActive ? 'rgba(255,68,68,0.35)' : 'rgba(0,229,255,0.3)'}`,
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: selectedGroup.isActive ? 'rgba(255,68,68,0.15)' : 'rgba(0,229,255,0.12)',
                    color: selectedGroup.isActive ? theme.dangerRed : theme.electricBlue,
                    fontSize: 13,
                    fontWeight: 700,
                    fontFamily: theme.fontBody,
                    boxShadow: selectedGroup.isActive ? '0 0 14px rgba(255,68,68,0.18)' : '0 0 14px rgba(0,229,255,0.12)',
                    transition: 'all 0.2s',
                  }}
                >
                  {selectedGroup.isActive ? <><ShieldOff size={14} /> 停止屏蔽</> : <><Shield size={14} /> 开启专注</>}
                </button>
                {selectedGroup.isActive && selectedGroup.activatedAt && (
                  <ActiveTimer activatedAt={selectedGroup.activatedAt} durationMins={selectedGroup.durationMins} />
                )}
              </div>
            </div>
          </>
        )}
      </div>

      </div>
    </div>
  )
}

// ── 空状态提示 ─────────────────────────────────

function EmptyHint({ text, icon }: { text: string; icon: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '32px 20px', color: theme.textMuted, fontSize: 12.5, fontFamily: theme.fontBody, textAlign: 'center' }}>
      {icon}
      <span style={{ maxWidth: 280, lineHeight: 1.6 }}>{text}</span>
    </div>
  )
}

// ── 激活计时器 ────────────────────────────────

function ActiveTimer({ activatedAt, durationMins }: { activatedAt: number; durationMins: number | null }) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const elapsed = Math.floor((now - activatedAt) / 1000)
  const elapsedStr = fmtElapsed(activatedAt)

  if (durationMins === null) {
    return <span style={{ fontSize: 11.5, color: theme.expGreen, fontFamily: theme.fontMono }}>已持续 {elapsedStr}</span>
  }

  const totalSecs = durationMins * 60
  const remaining = Math.max(0, totalSecs - elapsed)
  const rm = Math.floor(remaining / 60)
  const rs = remaining % 60
  const pct = Math.min(1, elapsed / totalSecs)

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: theme.fontMono }}>已过 {elapsedStr}</span>
        <span style={{ fontSize: 11, color: theme.expGreen, fontFamily: theme.fontMono }}>剩余 {String(rm).padStart(2, '0')}:{String(rs).padStart(2, '0')}</span>
      </div>
      <div style={{ height: 3, background: 'rgba(0,229,255,0.1)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct * 100}%`, height: '100%', background: theme.expGreen, transition: 'width 1s linear' }} />
      </div>
    </div>
  )
}
