// ══════════════════════════════════════════════
// Settings Panel — AI / 语音 / 数据库 / 隐私 配置
// 移植自 macOS SidebarSettingsView
// ══════════════════════════════════════════════

import { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronRight, ChevronUp, ChevronDown, Mic, Lock, Database, Bot, Eye, EyeOff, Copy, Check, Cpu, Camera, FolderOpen, RefreshCw, Trash2, Settings as SettingsIcon, Ban, Activity } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { theme, hud } from '../theme'
import type { AgentConfig } from '../lib/agent/agent-config'
import type { GpuPrefStatus } from '../lib/local-api'
import { MagneticButton } from './NeonUI'
import Tooltip from './Tooltip'
import HudSelect from './HudSelect'

interface Props {
  readonly open: boolean
  readonly initialSection?: string
  readonly initialSectionTick?: number
  readonly config: AgentConfig
  readonly onUpdate: (updates: Partial<AgentConfig>) => void
  readonly onClose: () => void
}

interface DbInfo {
  path: string
  size: number
}

interface ScreenshotSettings {
  enabled: boolean
  intervalSeconds: number
  captureTarget: 'active_window' | 'all_screens' | string
  format: 'jpg' | 'png' | 'webp' | string
  quality: number
  resolutionPercent: number
  saveDir: string
  retentionMode: 'days' | 'size' | string
  maxSizeMb: number
  retentionDays: number
}

interface ScreenshotStorageInfo {
  path: string
  sizeBytes: number
  fileCount: number
}

interface WindowBlacklistEntry {
  app: string
  title: string | null
  createdAt: string
}

interface TrackingSettings {
  afkAfterMinutes: number
  idleAfterSeconds: number
  minActivitySeconds: number
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export default function SettingsPanel({ open: isOpen, initialSection, initialSectionTick = 0, config, onUpdate, onClose }: Props) {
  // ── Local draft state (不实时写入，点确认才生效) ──
  const [draft, setDraft] = useState({
    aiMode: config.aiMode,
    // 常规模式
    openaiApiKey: config.openaiApiKey ?? '',
    openaiApiBase: config.openaiApiBase,
    openaiCardModel: config.openaiCardModel,
    // 全模态模式
    omniApiKey: config.omniApiKey ?? '',
    omniApiBase: config.omniApiBase,
    omniModel: config.omniModel,
    omniVoice: config.omniVoice,
    // 语音（常规模式）
    fishApiKey: config.fishApiKey ?? '',
    fishReferenceId: config.fishReferenceId,
    asrApiKey: config.asrApiKey ?? '',
    asrModel: config.asrModel,
    excludedApps: config.excludedApps.join('\n'),
    excludedTitleKeywords: config.excludedTitleKeywords.join('\n'),
    biliIntervalSeconds: config.biliIntervalSeconds,
    biliAutoCreate: config.biliAutoCreate,
    biliDownloadPath: config.biliDownloadPath,
    biliDownloadQuality: config.biliDownloadQuality,
    fairyWindowEnabled: config.fairyWindowEnabled,
    fairyWindowScale: config.fairyWindowScale,
    agentName: config.agentName,
    agentPersona: config.agentPersona,
    agentCallUser: config.agentCallUser,
    mainQuest: config.mainQuest ?? '',
  })

  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)

  // ── 数据库状态 ──
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null)
  const [migrating, setMigrating] = useState(false)

  // ── 图形偏好状态 ──
  const [gpuPref, setGpuPref] = useState<GpuPrefStatus | null>(null)
  const [gpuToggling, setGpuToggling] = useState(false)

  // ── 屏幕截图状态 ──
  const [screenshotDraft, setScreenshotDraft] = useState<ScreenshotSettings | null>(null)
  const [screenshotInfo, setScreenshotInfo] = useState<ScreenshotStorageInfo | null>(null)
  const [screenshotSaving, setScreenshotSaving] = useState(false)
  const [screenshotSaved, setScreenshotSaved] = useState(false)

  // ── 窗口忽略黑名单 ──
  const [windowBlacklist, setWindowBlacklist] = useState<WindowBlacklistEntry[]>([])

  // ── 追踪设置 ──
  const [trackingDraft, setTrackingDraft] = useState<TrackingSettings | null>(null)
  const [trackingSaving, setTrackingSaving] = useState(false)
  const [trackingSaved, setTrackingSaved] = useState(false)

  // ── 左侧栏当前选中分组 ──
  const [activeSection, setActiveSection] = useState<string>('persona')

  useEffect(() => {
    if (isOpen && initialSection) setActiveSection(initialSection)
  }, [initialSection, initialSectionTick, isOpen])

  useEffect(() => {
    if (!isOpen) return
    invoke<DbInfo>('get_db_info').then(setDbInfo).catch(console.error)
    invoke<GpuPrefStatus>('get_gpu_pref_status').then(setGpuPref).catch(() => {})
    invoke<ScreenshotSettings>('get_screenshot_settings').then(setScreenshotDraft).catch(console.error)
    invoke<ScreenshotStorageInfo>('get_screenshot_storage_info').then(setScreenshotInfo).catch(console.error)
    invoke<WindowBlacklistEntry[]>('get_window_blacklist').then(setWindowBlacklist).catch(console.error)
    invoke<TrackingSettings>('get_tracking_settings').then(setTrackingDraft).catch(console.error)
  }, [isOpen])

  const updateTrackingDraft = useCallback((field: keyof TrackingSettings, value: number) => {
    setTrackingDraft((prev) => prev ? { ...prev, [field]: value } : prev)
    setTrackingSaved(false)
  }, [])

  const saveTrackingSettings = useCallback(async () => {
    if (!trackingDraft) return
    setTrackingSaving(true)
    try {
      const next = await invoke<TrackingSettings>('update_tracking_settings', { settings: trackingDraft })
      setTrackingDraft(next)
      setTrackingSaved(true)
      setTimeout(() => setTrackingSaved(false), 1600)
    } catch (e) {
      console.error('[Tracking] save failed:', e)
      alert(`保存追踪设置失败: ${e}`)
    } finally {
      setTrackingSaving(false)
    }
  }, [trackingDraft])

  const removeBlacklistEntry = useCallback(async (entry: WindowBlacklistEntry) => {
    try {
      const next = await invoke<WindowBlacklistEntry[]>('remove_window_blacklist', {
        app: entry.app,
        title: entry.title,
      })
      setWindowBlacklist(next)
    } catch (e) {
      alert(`移除失败: ${e}`)
    }
  }, [])

  const toggleDiscreteGpu = useCallback(async (enable: boolean) => {
    setGpuToggling(true)
    try {
      const next = await invoke<GpuPrefStatus>('set_gpu_pref_high_performance', { enable })
      setGpuPref(next)
      onUpdate({ useDiscreteGpu: enable })
    } catch (e) {
      console.error('[GpuPref] toggle failed:', e)
    } finally {
      setGpuToggling(false)
    }
  }, [onUpdate])

  const refreshScreenshotInfo = useCallback(async () => {
    try {
      const info = await invoke<ScreenshotStorageInfo>('get_screenshot_storage_info')
      setScreenshotInfo(info)
    } catch (e) {
      console.error('[Screenshot] refresh failed:', e)
    }
  }, [])

  const updateScreenshotDraft = useCallback((field: keyof ScreenshotSettings, value: string | number | boolean) => {
    setScreenshotDraft((prev) => prev ? { ...prev, [field]: value } : prev)
    setScreenshotSaved(false)
  }, [])

  const saveScreenshotSettings = useCallback(async () => {
    if (!screenshotDraft) return
    setScreenshotSaving(true)
    try {
      const next = await invoke<ScreenshotSettings>('update_screenshot_settings', { settings: screenshotDraft })
      setScreenshotDraft(next)
      const info = await invoke<ScreenshotStorageInfo>('get_screenshot_storage_info')
      setScreenshotInfo(info)
      setScreenshotSaved(true)
      setTimeout(() => setScreenshotSaved(false), 1600)
    } catch (e) {
      console.error('[Screenshot] save failed:', e)
      alert(`保存截图设置失败: ${e}`)
    } finally {
      setScreenshotSaving(false)
    }
  }, [screenshotDraft])

  const openScreenshotFolder = useCallback(async () => {
    try {
      await invoke('open_screenshot_folder')
      await refreshScreenshotInfo()
    } catch (e) {
      console.error('[Screenshot] open folder failed:', e)
      alert(`打开截图目录失败: ${e}`)
    }
  }, [refreshScreenshotInfo])

  const clearScreenshotData = useCallback(async () => {
    if (!window.confirm('清空截图目录中的数据？')) return
    try {
      const info = await invoke<ScreenshotStorageInfo>('clear_screenshot_data')
      setScreenshotInfo(info)
    } catch (e) {
      console.error('[Screenshot] clear failed:', e)
      alert(`清空截图失败: ${e}`)
    }
  }, [])

  const update = useCallback((field: keyof typeof draft, value: string | number | boolean) => {
    setDraft((prev) => ({ ...prev, [field]: value }))
    setDirty(true)
    setSaved(false)
  }, [])

  const handleApply = useCallback(() => {
    onUpdate({
      aiMode: draft.aiMode,
      openaiApiKey: draft.openaiApiKey || null,
      openaiApiBase: draft.openaiApiBase,
      openaiCardModel: draft.openaiCardModel,
      omniApiKey: draft.omniApiKey || null,
      omniApiBase: draft.omniApiBase,
      omniModel: draft.omniModel || 'qwen3.5-omni-flash-realtime',
      omniVoice: draft.omniVoice,
      fishApiKey: draft.fishApiKey || null,
      fishReferenceId: draft.fishReferenceId,
      asrApiKey: draft.asrApiKey || null,
      asrModel: draft.asrModel || 'qwen3-asr-flash-realtime',
      excludedApps: draft.excludedApps.split('\n').map((s) => s.trim()).filter(Boolean),
      excludedTitleKeywords: draft.excludedTitleKeywords.split('\n').map((s) => s.trim()).filter(Boolean),
      biliIntervalSeconds: draft.biliIntervalSeconds,
      biliAutoCreate: draft.biliAutoCreate,
      biliDownloadPath: draft.biliDownloadPath || 'E:\\BiliDownloads',
      biliDownloadQuality: draft.biliDownloadQuality,
      fairyWindowEnabled: draft.fairyWindowEnabled,
      fairyWindowScale: draft.fairyWindowScale,
      agentName: draft.agentName || 'Fairy',
      agentPersona: draft.agentPersona,
      agentCallUser: draft.agentCallUser || '主人',
      mainQuest: draft.mainQuest || null,
    })
    setDirty(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [draft, onUpdate])

  const handleSelectDbPath = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择数据库存储位置',
    })

    if (selected && typeof selected === 'string') {
      setMigrating(true)
      try {
        const newPath = await invoke<string>('migrate_database', { newPath: selected })
        setDbInfo(prev => prev ? { ...prev, path: newPath } : null)
        // 重新获取大小
        const info = await invoke<DbInfo>('get_db_info')
        setDbInfo(info)
      } catch (e) {
        console.error('迁移失败:', e)
        alert(`迁移失败: ${e}`)
      }
      setMigrating(false)
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return createPortal(
    <>
      <style>{`
        @keyframes settings-dialog-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes settings-dialog-pop { from { opacity: 0; transform: translate(-50%, -50%) scale(0.98); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
        .settings-dialog-icon-btn {
          background: rgba(0,229,255,0.05);
          border: 1px solid ${theme.hudFrameSoft};
          color: ${theme.textSecondary};
          width: 24px; height: 24px;
          box-sizing: border-box;
          display: inline-flex; align-items: center; justify-content: center;
          cursor: pointer;
          clip-path: ${hud.chamfer8};
          -webkit-clip-path: ${hud.chamfer8};
          transition: all 0.15s ease;
        }
        .settings-dialog-icon-btn:hover:not(:disabled) {
          color: ${theme.electricBlue};
          border-color: ${theme.electricBlue};
          box-shadow: 0 0 8px ${theme.electricBlue}55;
        }
        .settings-dialog-scroll::-webkit-scrollbar { width: 8px; }
        .settings-dialog-scroll::-webkit-scrollbar-track { background: rgba(255,255,255,0.03); }
        .settings-dialog-scroll::-webkit-scrollbar-thumb {
          background: rgba(0,229,255,0.24);
          border: 1px solid rgba(0,229,255,0.18);
        }
      `}</style>

      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 900,
          background: 'rgba(2, 6, 16, 0.84)',
          animation: 'settings-dialog-in 0.16s ease-out',
        }}
      />

      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(960px, 94vw)',
          height: 'min(760px, 88vh)',
          zIndex: 901,
          display: 'flex',
          flexDirection: 'column',
          background: theme.hudFill,
          border: `1px solid ${theme.hudFrame}`,
          clipPath: hud.chamfer12,
          WebkitClipPath: hud.chamfer12,
          boxShadow: `0 24px 80px rgba(0,0,0,0.8), 0 0 60px ${theme.hudHalo}, inset 0 1px 0 rgba(255,255,255,0.04)`,
          overflow: 'hidden',
          animation: 'settings-dialog-pop 0.18s ease-out',
        }}
      >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '7px 16px',
        borderBottom: `1px solid ${theme.hudFrameSoft}`,
        background: 'linear-gradient(180deg, rgba(0,229,255,0.05) 0%, transparent 100%)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <SettingsIcon size={16} color={theme.electricBlue} style={{ filter: `drop-shadow(0 0 6px ${theme.electricBlue}AA)` }} />
          <span style={{
            fontFamily: theme.fontDisplay,
            fontSize: 13,
            fontWeight: 700,
            color: theme.electricBlue,
            letterSpacing: 1.6,
            textShadow: `0 0 8px ${theme.electricBlue}88`,
          }}>
            设置
          </span>
        </div>
        <Tooltip content="关闭 (Esc)">
          <button type="button" className="settings-dialog-icon-btn" onClick={onClose}>
            <X size={13} />
          </button>
        </Tooltip>
      </div>

      {/* 左侧栏 + 右侧内容 */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* 左侧栏 */}
        <div style={{
          width: 156,
          flexShrink: 0,
          borderRight: `1px solid ${theme.hudFrameSoft}`,
          background: 'rgba(0,12,28,0.45)',
          padding: '10px 6px',
          overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {SECTION_LIST.map((s) => (
            <SectionNavBtn
              key={s.id}
              label={s.label}
              icon={s.icon}
              active={activeSection === s.id}
              onClick={() => setActiveSection(s.id)}
            />
          ))}
        </div>

        {/* Scrollable content */}
        <div className="settings-dialog-scroll" style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', minWidth: 0 }}>
        {activeSection === 'persona' && (
        <Section title="AI 人设" icon={Bot}>
          <Field label="称呼用户为"
            value={draft.agentCallUser}
            onChange={(v) => update('agentCallUser', v)}
            placeholder="主人"
          />
          <Field label="名称"
            value={draft.agentName}
            onChange={(v) => update('agentName', v)}
            placeholder="Fairy"
          />
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>人设描述</label>
            <textarea
              value={draft.agentPersona}
              onChange={(e) => update('agentPersona', e.target.value)}
              rows={4}
              style={textareaStyle}
              placeholder="描述 AI 的性格、语气和行为风格..."
            />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>主线目标</label>
            <textarea
              value={draft.mainQuest}
              onChange={(e) => update('mainQuest', e.target.value)}
              rows={2}
              style={textareaStyle}
              placeholder="当前最重要的目标，会注入到 AI 上下文中..."
            />
          </div>
          <div style={{ marginTop: 4 }}>
            <MagneticButton
              onClick={handleApply}
              color={dirty ? theme.expGreen : theme.textSecondary}
              disabled={!dirty}
            >
              {saved ? '已应用 ✓' : '保存'}
            </MagneticButton>
          </div>
        </Section>
        )}

        {activeSection === 'fairy' && (
        <Section title="Fairy 窗口" icon={Eye}>
          <div style={{ display: 'grid', gap: 12 }}>
            <HudCheckbox
              checked={draft.fairyWindowEnabled}
              onChange={(checked) => update('fairyWindowEnabled', checked)}
              label="显示桌面 Fairy"
            >
              <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 2, lineHeight: 1.45 }}>
                关闭后 Fairy 子窗口会隐藏；需要重新召回时，在这里开启并保存。
              </div>
            </HudCheckbox>

            <div style={{
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid ${theme.glassBorder}`,
              borderRadius: 4,
              padding: '10px 12px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 0 }}>窗口大小</label>
                <span style={{
                  fontFamily: theme.fontMono,
                  fontSize: 12,
                  color: theme.electricBlue,
                  textShadow: `0 0 8px ${theme.electricBlue}66`,
                }}>
                  {Math.round(draft.fairyWindowScale * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={40}
                max={100}
                step={5}
                value={Math.round(draft.fairyWindowScale * 100)}
                onChange={(e) => update('fairyWindowScale', Number(e.target.value) / 100)}
                style={{
                  width: '100%',
                  accentColor: theme.electricBlue,
                  cursor: 'pointer',
                }}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                {[40, 60, 80, 100].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => update('fairyWindowScale', pct / 100)}
                    style={{
                      padding: '4px 9px',
                      background: Math.round(draft.fairyWindowScale * 100) === pct
                        ? 'rgba(0,229,255,0.14)'
                        : 'rgba(255,255,255,0.035)',
                      border: `1px solid ${Math.round(draft.fairyWindowScale * 100) === pct ? theme.electricBlue : theme.glassBorder}`,
                      color: Math.round(draft.fairyWindowScale * 100) === pct ? theme.electricBlue : theme.textSecondary,
                      borderRadius: 3,
                      cursor: 'pointer',
                      fontFamily: theme.fontMono,
                      fontSize: 11,
                    }}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 8, lineHeight: 1.5 }}>
                大小会同步调整 Fairy 的可点击圆形区域，避免视觉和交互半径错位。
              </div>
            </div>

            <div>
              <MagneticButton
                onClick={handleApply}
                color={dirty ? theme.expGreen : theme.textSecondary}
                disabled={!dirty}
              >
                {saved ? '已应用 ✓' : '保存'}
              </MagneticButton>
            </div>
          </div>
        </Section>
        )}

        {activeSection === 'voice' && (
        <Section title="语音" icon={Mic}>
          <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 10 }}>
            右 Alt 长按 &gt; 600ms 开始说话
          </div>

          {draft.aiMode === 'regular' ? (
            <>
              <div style={{ fontSize: 11, color: theme.textSecondary, marginBottom: 8 }}>
                ASR 复用顶栏「模型」里的 DashScope API Key。
              </div>
              <Field label="Fish API Key" type="password"
                value={draft.fishApiKey}
                onChange={(v) => update('fishApiKey', v)}
                placeholder="Fish Audio API Key（TTS）"
              />
              <Field label="Fish 音色 ID"
                value={draft.fishReferenceId}
                onChange={(v) => update('fishReferenceId', v)}
              />
            </>
          ) : (
            <>
              <div style={{ fontSize: 11, color: theme.textSecondary, marginBottom: 8 }}>
                全模态模式：ASR + TTS 均由 Omni WS 处理，无需额外配置
              </div>
              <Field label="输出音色 ID"
                value={draft.omniVoice}
                onChange={(v) => update('omniVoice', v)}
                placeholder="cosyvoice-v3.5-plus-bailian-..."
              />
            </>
          )}

          <div style={{ marginTop: 4 }}>
            <MagneticButton
              onClick={handleApply}
              color={dirty ? theme.expGreen : theme.textSecondary}
              disabled={!dirty}
            >
              {saved ? '已应用 ✓' : '保存'}
            </MagneticButton>
          </div>
        </Section>
        )}

        {activeSection === 'privacy' && (
        <Section title="隐私" icon={Lock}>
          <label style={labelStyle}>排除关键词（每行一个）</label>
          <textarea
            value={draft.excludedTitleKeywords}
            onChange={(e) => update('excludedTitleKeywords', e.target.value)}
            rows={4}
            style={textareaStyle}
          />
          <div style={{ marginTop: 4 }}>
            <MagneticButton
              onClick={handleApply}
              color={dirty ? theme.expGreen : theme.textSecondary}
              disabled={!dirty}
            >
              保存
            </MagneticButton>
          </div>
        </Section>
        )}

        {activeSection === 'tracking' && trackingDraft && (
        <Section title="追踪" icon={Activity}>
          <div style={{ display: 'grid', gap: 14 }}>
            <div>
              <label style={labelStyle}>未使用计算机 → 标记为离开（分钟）</label>
              <NumberStepper
                min={1}
                max={500}
                value={trackingDraft.afkAfterMinutes}
                onChange={(v) => updateTrackingDraft('afkAfterMinutes', v)}
              />
              <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                超过这个时间没有键鼠输入 → 状态轨道画"离开"
              </div>
            </div>

            <div>
              <label style={labelStyle}>无操作 → 进入空闲（秒）</label>
              <NumberStepper
                min={5}
                max={Math.max(5, trackingDraft.afkAfterMinutes * 60)}
                value={trackingDraft.idleAfterSeconds}
                onChange={(v) => updateTrackingDraft('idleAfterSeconds', v)}
              />
              <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                短暂离开（喝水/接电话）也算"空闲"，状态轨道用半宽渲染
              </div>
            </div>

            <div>
              <label style={labelStyle}>最短活动持续时间（秒）</label>
              <NumberStepper
                min={1}
                max={300}
                value={trackingDraft.minActivitySeconds}
                onChange={(v) => updateTrackingDraft('minActivitySeconds', v)}
              />
              <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                合并间隔小于此值的同状态片段（避免毛刺）
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <MagneticButton
                onClick={saveTrackingSettings}
                color={theme.expGreen}
                disabled={trackingSaving}
              >
                {trackingSaved ? '已保存 ✓' : trackingSaving ? '保存中...' : '保存'}
              </MagneticButton>
            </div>
          </div>
        </Section>
        )}

        {activeSection === 'screenshot' && (
        <Section title="屏幕截图" icon={Camera}>
          {screenshotDraft && (
            <div style={{ display: 'grid', gap: 10 }}>
              <HudCheckbox
                checked={screenshotDraft.enabled}
                onChange={(checked) => updateScreenshotDraft('enabled', checked)}
                label="启用屏幕截图"
              />

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
                <div>
                  <label style={labelStyle}>抓取间隔（秒）</label>
                  <NumberStepper
                    min={5}
                    max={3600}
                    value={screenshotDraft.intervalSeconds}
                    onChange={(v) => updateScreenshotDraft('intervalSeconds', v)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>抓取范围</label>
                  <HudSelect
                    value={screenshotDraft.captureTarget}
                    options={[
                      { value: 'active_window', label: '活动窗口' },
                      { value: 'all_screens', label: '所有屏幕' },
                    ]}
                    onChange={(v) => updateScreenshotDraft('captureTarget', v)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>格式</label>
                  <HudSelect
                    value={screenshotDraft.format}
                    options={[
                      { value: 'jpg', label: 'JPG' },
                      { value: 'png', label: 'PNG' },
                      { value: 'webp', label: 'WebP' },
                    ]}
                    onChange={(v) => updateScreenshotDraft('format', v)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>质量（%）</label>
                  <NumberStepper
                    min={1}
                    max={100}
                    value={screenshotDraft.quality}
                    onChange={(v) => updateScreenshotDraft('quality', v)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>分辨率（%）</label>
                  <NumberStepper
                    min={10}
                    max={100}
                    value={screenshotDraft.resolutionPercent}
                    onChange={(v) => updateScreenshotDraft('resolutionPercent', v)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>存储限制</label>
                  <HudSelect
                    value={screenshotDraft.retentionMode}
                    options={[
                      { value: 'days', label: '最大追踪天数' },
                      { value: 'size', label: '最大占用 MB' },
                    ]}
                    onChange={(v) => updateScreenshotDraft('retentionMode', v)}
                  />
                </div>
                {screenshotDraft.retentionMode === 'size' ? (
                  <div>
                    <label style={labelStyle}>最大占用（MB）</label>
                    <NumberStepper
                      min={10}
                      value={screenshotDraft.maxSizeMb}
                      step={100}
                      onChange={(v) => updateScreenshotDraft('maxSizeMb', v)}
                    />
                  </div>
                ) : (
                  <div>
                    <label style={labelStyle}>最大追踪天数</label>
                    <NumberStepper
                      min={1}
                      value={screenshotDraft.retentionDays}
                      onChange={(v) => updateScreenshotDraft('retentionDays', v)}
                    />
                  </div>
                )}
              </div>

              <div>
                <label style={labelStyle}>保存到</label>
                <input
                  value={screenshotDraft.saveDir}
                  onChange={(e) => updateScreenshotDraft('saveDir', e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div style={{
                background: 'rgba(255,255,255,0.03)',
                border: `1px solid ${theme.glassBorder}`,
                borderRadius: 4,
                padding: '8px 12px',
                display: 'grid',
                gap: 4,
              }}>
                <div style={{ fontSize: 12, color: theme.textSecondary }}>磁盘占用</div>
                <div style={{ fontSize: 13, color: theme.electricBlue }}>
                  {screenshotInfo ? `${formatBytes(screenshotInfo.sizeBytes)} · ${screenshotInfo.fileCount} 个文件` : '读取中...'}
                </div>
                <div style={{
                  fontSize: 11, color: theme.textPrimary,
                  fontFamily: "'Exo 2', sans-serif",
                  wordBreak: 'break-all',
                }}>
                  {screenshotInfo?.path ?? screenshotDraft.saveDir}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <MagneticButton
                  onClick={saveScreenshotSettings}
                  color={theme.expGreen}
                  disabled={screenshotSaving}
                >
                  {screenshotSaved ? '已保存 ✓' : screenshotSaving ? '保存中...' : '保存'}
                </MagneticButton>
                <IconBtn title="刷新占用" onClick={refreshScreenshotInfo}>
                  <RefreshCw size={13} />
                </IconBtn>
                <IconBtn title="打开文件夹" onClick={openScreenshotFolder}>
                  <FolderOpen size={13} />
                </IconBtn>
                <IconBtn title="清空数据" onClick={clearScreenshotData}>
                  <Trash2 size={13} />
                </IconBtn>
              </div>
            </div>
          )}
        </Section>
        )}

        {activeSection === 'ignore' && (
        <Section title="忽略窗口" icon={Ban}>
          <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 8, lineHeight: 1.55 }}>
            被忽略的窗口聚焦时，<span style={{ color: theme.textPrimary }}>不记录活动 + 不截图</span>，由前一个活动窗口继续顶替。
            <br />
            通过昼夜表里活动详情面板的 <EyeOff size={11} style={{ verticalAlign: 'middle', margin: '0 2px' }} /> 按钮添加。
          </div>
          {windowBlacklist.length === 0 ? (
            <div style={{
              fontSize: 11, color: theme.textMuted, textAlign: 'center',
              padding: '14px 0', opacity: 0.7,
            }}>
              ─ 暂无忽略项 ─
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {windowBlacklist.map((entry, idx) => (
                <div
                  key={`${entry.app}|${entry.title ?? ''}|${idx}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 8px',
                    background: 'rgba(255,80,80,0.04)',
                    border: `1px solid rgba(255,80,80,0.22)`,
                    borderRadius: 3,
                    minWidth: 0,
                  }}
                >
                  <Ban size={12} color="#ff8a8a" style={{ flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, fontWeight: 600, color: theme.textPrimary,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {entry.app}
                    </div>
                    {entry.title ? (
                      <div style={{
                        fontSize: 10.5, color: theme.textSecondary,
                        fontFamily: theme.fontMono,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        marginTop: 1,
                      }}>
                        {entry.title}
                      </div>
                    ) : (
                      <div style={{
                        fontSize: 10, color: theme.textMuted, fontStyle: 'italic',
                        marginTop: 1,
                      }}>
                        整个应用
                      </div>
                    )}
                  </div>
                  <Tooltip content="移除">
                    <button
                      type="button"
                      onClick={() => removeBlacklistEntry(entry)}
                      style={{
                        flexShrink: 0,
                        width: 22, height: 22,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        background: 'transparent',
                        border: `1px solid ${theme.glassBorder}`,
                        color: theme.textSecondary,
                        cursor: 'pointer',
                        borderRadius: 2,
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>
          )}
        </Section>
        )}

        {activeSection === 'gpu' && (
        <Section title="图形性能" icon={Cpu}>
          <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 8, lineHeight: 1.55 }}>
            笔记本独显高性能模式：写入 Windows 图形偏好（HKCU 注册表），让本应用与 WebView2 子进程默认使用独立显卡。
            <span style={{ color: theme.warningOrange }}> 修改后需要完全重启应用才能生效。</span>
          </div>

          <div style={{ marginBottom: 10 }}>
            <HudCheckbox
              checked={config.useDiscreteGpu}
              disabled={gpuToggling}
              onChange={toggleDiscreteGpu}
              label="使用独立显卡（更丝滑）"
            >
              <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 2 }}>
                台式机或仅有集显时无效；笔记本默认走集显，开启后流畅但更耗电。
              </div>
            </HudCheckbox>
          </div>

          {gpuPref && (
            <div style={{
              fontSize: 11, fontFamily: "'Exo 2', sans-serif",
              background: 'rgba(255,255,255,0.025)',
              border: `1px solid ${theme.glassBorder}`,
              borderRadius: 4, padding: '8px 12px',
              display: 'grid', gap: 6,
            }}>
              <GpuPrefRow
                label="SOLO LEVELING SYSTEM"
                path={gpuPref.self_exe_path}
                set={gpuPref.self_exe_pref_set}
              />
              <GpuPrefRow
                label={gpuPref.edge_version
                  ? `msedgewebview2.exe (v${gpuPref.edge_version})`
                  : 'msedgewebview2.exe'}
                path={gpuPref.webview2_path ?? '— 未检测到 WebView2 Runtime —'}
                set={gpuPref.webview2_pref_set}
                missing={!gpuPref.webview2_path}
              />
            </div>
          )}
        </Section>
        )}


        {activeSection === 'database' && (
        <Section title="数据库" icon={Database}>
          <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 8 }}>
            本地 SQLite 存储，支持自定义位置
          </div>

          {dbInfo && (
            <div style={{
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid ${theme.glassBorder}`,
              borderRadius: 4, padding: '8px 12px',
              marginBottom: 8,
            }}>
              <div style={{ fontSize: 12, color: theme.textSecondary }}>
                当前位置
              </div>
              <div style={{
                fontSize: 11, color: theme.textPrimary,
                fontFamily: "'Exo 2', sans-serif",
                marginTop: 4,
                wordBreak: 'break-all',
              }}>
                {dbInfo.path}
              </div>
              <div style={{
                fontSize: 12, color: theme.electricBlue,
                marginTop: 4,
              }}>
                文件大小: {formatBytes(dbInfo.size)}
              </div>
            </div>
          )}

          <MagneticButton
            onClick={handleSelectDbPath}
            disabled={migrating}
          >
            {migrating ? '迁移中...' : '更改存储位置'}
          </MagneticButton>
        </Section>
        )}
        </div>
      </div>
      </div>
    </>,
    document.body,
  )
}

// ── 设置左侧栏分组 ──

const IS_WINDOWS = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')

const SECTION_LIST: { id: string; label: string; icon: React.ElementType }[] = [
  { id: 'persona',    label: 'AI 人设',  icon: Bot },
  { id: 'fairy',      label: 'Fairy',    icon: Eye },
  { id: 'voice',      label: '语音',     icon: Mic },
  { id: 'privacy',    label: '隐私',     icon: Lock },
  { id: 'tracking',   label: '追踪',     icon: Activity },
  { id: 'screenshot', label: '屏幕截图', icon: Camera },
  { id: 'ignore',     label: '忽略窗口', icon: Ban },
  ...(IS_WINDOWS ? [{ id: 'gpu', label: '图形性能', icon: Cpu }] : []),
  { id: 'database',   label: '数据库',   icon: Database },
]

function SectionNavBtn({
  label, icon: Icon, active, onClick,
}: {
  label: string
  icon: React.ElementType
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px',
        background: active ? `${theme.electricBlue}1A` : 'transparent',
        border: `1px solid ${active ? `${theme.electricBlue}66` : 'transparent'}`,
        borderLeft: `3px solid ${active ? theme.electricBlue : 'transparent'}`,
        color: active ? theme.electricBlue : theme.textSecondary,
        fontFamily: theme.fontBody,
        fontSize: 12.5,
        fontWeight: active ? 700 : 500,
        letterSpacing: 0.4,
        cursor: 'pointer',
        textAlign: 'left',
        textShadow: active ? `0 0 6px ${theme.electricBlue}88` : undefined,
        transition: 'background 0.12s, color 0.12s, border-color 0.12s',
      }}
    >
      <Icon size={13} style={{ flexShrink: 0 }} />
      <span>{label}</span>
    </button>
  )
}

function HudCheckbox({
  checked, onChange, label, children, disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  children?: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        background: checked ? 'rgba(0,229,255,0.07)' : 'rgba(255,255,255,0.03)',
        border: `1px solid ${checked ? 'rgba(0,229,255,0.42)' : theme.glassBorder}`,
        borderRadius: 4,
        color: theme.textPrimary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        textAlign: 'left',
        transition: 'border-color 0.15s ease, background 0.15s ease',
      }}
    >
      <span style={{
        width: 16,
        height: 16,
        borderRadius: 3,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        background: checked ? theme.electricBlue : 'rgba(255,255,255,0.035)',
        border: `1px solid ${checked ? theme.electricBlue : 'rgba(0,229,255,0.24)'}`,
        boxShadow: checked ? `0 0 10px ${theme.electricBlue}55` : undefined,
      }}>
        {checked ? <Check size={12} color="#071216" strokeWidth={3} /> : null}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, color: theme.textPrimary }}>{label}</span>
        {children}
      </span>
    </button>
  )
}

function NumberStepper({
  value, onChange, min = 0, max, step = 1, disabled,
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
}) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const clamp = useCallback((n: number) => {
    const upper = max ?? Number.POSITIVE_INFINITY
    return Math.min(upper, Math.max(min, n))
  }, [max, min])

  const commit = useCallback(() => {
    const parsed = Number(draft)
    const next = Number.isFinite(parsed) ? clamp(Math.round(parsed)) : clamp(value)
    setDraft(String(next))
    onChange(next)
  }, [clamp, draft, onChange, value])

  const bump = useCallback((direction: 1 | -1) => {
    const parsed = Number(draft)
    const base = Number.isFinite(parsed) ? parsed : value
    const next = clamp(base + direction * step)
    setDraft(String(next))
    onChange(next)
  }, [clamp, draft, onChange, step, value])

  const handleRawChange = useCallback((raw: string) => {
    if (!/^\d*$/.test(raw)) return
    setDraft(raw)
    if (raw === '') return
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) {
      onChange(parsed)
    }
  }, [onChange])

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        onChange={(e) => handleRawChange(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            bump(1)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            bump(-1)
          } else if (e.key === 'Enter') {
            e.currentTarget.blur()
          }
        }}
        style={{
          ...inputStyle,
          paddingRight: 30,
          opacity: disabled ? 0.4 : 1,
        }}
      />
      <div style={{
        position: 'absolute',
        right: 3,
        top: 3,
        bottom: 3,
        width: 22,
        display: 'grid',
        gridTemplateRows: '1fr 1fr',
        gap: 2,
      }}>
        <StepperButton disabled={disabled} onClick={() => bump(1)} icon="up" />
        <StepperButton disabled={disabled} onClick={() => bump(-1)} icon="down" />
      </div>
    </div>
  )
}

function StepperButton({
  disabled, onClick, icon,
}: {
  disabled?: boolean
  onClick: () => void
  icon: 'up' | 'down'
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 0,
        width: 22,
        height: '100%',
        padding: 0,
        border: 'none',
        borderRadius: 2,
        background: 'rgba(0,229,255,0.09)',
        color: theme.textSecondary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.35 : 1,
      }}
    >
      {icon === 'up' ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
    </button>
  )
}

// ── 图形偏好状态行 ──
function GpuPrefRow({ label, path, set, missing = false }: {
  label: string
  path: string
  set: boolean
  missing?: boolean
}) {
  const statusColor = missing
    ? theme.warningOrange
    : set ? theme.expGreen : theme.textMuted
  const statusText = missing ? '未找到' : set ? '已配置' : '未配置'
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ color: theme.textSecondary, fontSize: 11 }}>{label}</span>
        <span style={{
          color: statusColor, fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
          padding: '1px 6px',
          border: `1px solid ${statusColor}66`,
          borderRadius: 2,
        }}>
          {statusText}
        </span>
      </div>
      <div style={{
        color: missing ? theme.textMuted : theme.textPrimary,
        fontSize: 10, wordBreak: 'break-all',
        opacity: missing ? 0.6 : 1,
      }}>
        {path}
      </div>
    </div>
  )
}

// ── Section 折叠区 ──

function Section({
  title, icon: Icon, children,
}: {
  title: string
  icon: React.ElementType
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)

  return (
    <div style={{ marginBottom: 16 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'transparent', border: 'none',
          color: theme.textPrimary, cursor: 'pointer',
          fontFamily: "'Exo 2', sans-serif",
          fontSize: 11, fontWeight: 'bold',
          padding: '4px 0', width: '100%', textAlign: 'left',
        }}
      >
        <Icon size={12} style={{ color: theme.electricBlue, flexShrink: 0 }} />
        <span style={{ letterSpacing: 1 }}>{title}</span>
        <ChevronRight size={12} style={{
          marginLeft: 'auto',
          color: theme.textSecondary,
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.2s ease',
          flexShrink: 0,
        }} />
      </button>

      {open && (
        <div style={{
          padding: '8px 0 0 0',
          borderLeft: `2px solid ${theme.glassBorder}`,
          paddingLeft: 12, marginLeft: 6,
        }}>
          {children}
        </div>
      )}
    </div>
  )
}

// ── Input Field ──

function Field({
  label, value, onChange, type = 'text', placeholder, disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: 'text' | 'password'
  placeholder?: string
  disabled?: boolean
}) {
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const isPassword = type === 'password'
  const effectiveType = isPassword && !revealed ? 'password' : 'text'

  const handleCopy = useCallback(async () => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }, [value])

  const ICON_BTN_W = 22
  const rightPad = isPassword ? ICON_BTN_W * 2 + 6 : 8

  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ ...labelStyle, opacity: disabled ? 0.4 : 1 }}>{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          type={effectiveType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          style={{
            ...inputStyle,
            paddingRight: rightPad,
            opacity: disabled ? 0.4 : 1,
            cursor: disabled ? 'not-allowed' : undefined,
          }}
        />
        {isPassword && (
          <div style={{
            position: 'absolute', right: 4, top: 0, bottom: 0,
            display: 'flex', alignItems: 'center', gap: 2,
          }}>
            <IconBtn
              title={revealed ? '隐藏' : '显示'}
              onClick={() => setRevealed((v) => !v)}
              disabled={disabled}
            >
              {revealed ? <Eye size={13} /> : <EyeOff size={13} />}
            </IconBtn>
            <IconBtn
              title={copied ? '已复制' : '复制'}
              onClick={handleCopy}
              disabled={disabled || !value}
              active={copied}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </IconBtn>
          </div>
        )}
      </div>
    </div>
  )
}

function IconBtn({
  children, onClick, title, disabled, active,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  disabled?: boolean
  active?: boolean
}) {
  return (
    <Tooltip content={title} disabled={disabled}>
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, padding: 0,
        background: 'transparent', border: 'none', borderRadius: 3,
        color: active ? theme.expGreen : theme.textSecondary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.35 : 1,
        transition: 'color 0.15s ease, background 0.15s ease',
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.color = active ? theme.expGreen : theme.electricBlue
          e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = active ? theme.expGreen : theme.textSecondary
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {children}
    </button>
    </Tooltip>
  )
}

// ── Shared styles ──

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11, color: theme.textSecondary,
  fontFamily: "'Exo 2', sans-serif",
  marginBottom: 3, letterSpacing: 0.5,
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: 'rgba(255,255,255,0.03)',
  border: `1px solid ${theme.glassBorder}`,
  borderRadius: 4, padding: '6px 8px',
  color: theme.textPrimary,
  fontFamily: "'Exo 2', sans-serif",
  fontSize: 12, outline: 'none',
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  lineHeight: 1.5,
}
