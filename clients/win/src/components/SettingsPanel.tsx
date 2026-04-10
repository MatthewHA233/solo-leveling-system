// ══════════════════════════════════════════════
// Settings Panel — AI / 语音 / 数据库 / 隐私 配置
// 移植自 macOS SidebarSettingsView
// ══════════════════════════════════════════════

import { useState, useCallback, useEffect } from 'react'
import { X, ChevronRight, Zap, Mic, Lock, Database, Tv2, Bot } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { theme } from '../theme'
import type { AgentConfig } from '../lib/agent/agent-config'
import { MagneticButton } from './NeonUI'

interface Props {
  readonly config: AgentConfig
  readonly onUpdate: (updates: Partial<AgentConfig>) => void
  readonly onClose: () => void
}

interface DbInfo {
  path: string
  size: number
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export default function SettingsPanel({ config, onUpdate, onClose }: Props) {
  // ── Local draft state (不实时写入，点确认才生效) ──
  const [draft, setDraft] = useState({
    openaiApiKey: config.openaiApiKey ?? '',
    openaiApiBase: config.openaiApiBase,
    openaiModel: config.openaiModel,
    openaiCardModel: config.openaiCardModel,
    fishApiKey: config.fishApiKey ?? '',
    fishReferenceId: config.fishReferenceId,
    asrApiKey: config.asrApiKey ?? '',
    asrModel: config.asrModel,
    excludedApps: config.excludedApps.join('\n'),
    excludedTitleKeywords: config.excludedTitleKeywords.join('\n'),
    biliIntervalSeconds: config.biliIntervalSeconds,
    biliAutoCreate: config.biliAutoCreate,
    agentName: config.agentName,
    agentPersona: config.agentPersona,
    agentCallUser: config.agentCallUser,
    mainQuest: config.mainQuest ?? '',
  })

  const [dirty, setDirty] = useState(false)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [saved, setSaved] = useState(false)

  // ── 数据库状态 ──
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null)
  const [migrating, setMigrating] = useState(false)

  useEffect(() => {
    invoke<DbInfo>('get_db_info').then(setDbInfo).catch(console.error)
  }, [])

  const update = useCallback((field: string, value: string) => {
    setDraft((prev) => ({ ...prev, [field]: value }))
    setDirty(true)
    setSaved(false)
  }, [])

  const handleApply = useCallback(() => {
    onUpdate({
      openaiApiKey: draft.openaiApiKey || null,
      openaiApiBase: draft.openaiApiBase,
      openaiModel: draft.openaiModel,
      openaiCardModel: draft.openaiCardModel,
      fishApiKey: draft.fishApiKey || null,
      fishReferenceId: draft.fishReferenceId,
      asrApiKey: draft.asrApiKey || null,
      asrModel: draft.asrModel || 'qwen3-asr-flash-realtime',
      excludedApps: draft.excludedApps.split('\n').map((s) => s.trim()).filter(Boolean),
      excludedTitleKeywords: draft.excludedTitleKeywords.split('\n').map((s) => s.trim()).filter(Boolean),
      biliIntervalSeconds: draft.biliIntervalSeconds,
      biliAutoCreate: draft.biliAutoCreate,
      agentName: draft.agentName || 'Fairy',
      agentPersona: draft.agentPersona,
      agentCallUser: draft.agentCallUser || '主人',
      mainQuest: draft.mainQuest || null,
    })
    setDirty(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [draft, onUpdate])

  const handleTest = useCallback(async () => {
    setTestStatus('testing')
    try {
      const base = draft.openaiApiBase.replace(/\/$/, '')
      const res = await fetch(`${base}/v1/models`, {
        headers: draft.openaiApiKey
          ? { Authorization: `Bearer ${draft.openaiApiKey}` }
          : {},
      })
      setTestStatus(res.ok ? 'ok' : 'fail')
    } catch {
      setTestStatus('fail')
    }
    setTimeout(() => setTestStatus('idle'), 3000)
  }, [draft.openaiApiBase, draft.openaiApiKey])

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

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', background: theme.background,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px',
        borderBottom: `1px solid ${theme.divider}`,
      }}>
        <span style={{
          fontSize: 11, fontWeight: 'bold',
          color: theme.electricBlue, letterSpacing: 1,
        }}>
          设置
        </span>
        <button onClick={onClose} style={{
          background: 'transparent', border: 'none',
          color: theme.textSecondary, cursor: 'pointer',
          display: 'flex', padding: '2px',
        }}>
          <X size={14} />
        </button>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        {/* ── AI 人设 ── */}
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

        {/* ── AI 模型 ── */}
        <Section title="AI 模型" icon={Zap}>
          <Field label="API Key" type="password"
            value={draft.openaiApiKey}
            onChange={(v) => update('openaiApiKey', v)}
            placeholder="sk-..."
          />
          <Field label="API Base"
            value={draft.openaiApiBase}
            onChange={(v) => update('openaiApiBase', v)}
          />
          <Field label="聊天模型"
            value={draft.openaiCardModel}
            onChange={(v) => update('openaiCardModel', v)}
          />
          <Field label="视觉模型"
            value={draft.openaiModel}
            onChange={(v) => update('openaiModel', v)}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <MagneticButton
              onClick={handleApply}
              color={dirty ? theme.expGreen : theme.textSecondary}
              disabled={!dirty}
            >
              {saved ? '已应用 ✓' : '确认并应用'}
            </MagneticButton>
            <MagneticButton
              onClick={handleTest}
              disabled={testStatus === 'testing'}
            >
              {testStatus === 'testing' ? '测试中...'
                : testStatus === 'ok' ? '连接成功 ✓'
                : testStatus === 'fail' ? '连接失败 ✗'
                : '测试连接'}
            </MagneticButton>
          </div>

          {/* 当前状态 */}
          <div style={{ marginTop: 8, fontSize: 12, color: theme.textSecondary }}>
            当前: {config.openaiApiKey ? config.openaiCardModel : '未配置'}
            {config.openaiApiKey && (
              <span style={{ color: theme.expGreen }}> ● 已启用</span>
            )}
          </div>
        </Section>

        {/* ── 语音 ── */}
        <Section title="语音" icon={Mic}>
          <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 8 }}>
            右 Alt 长按 &gt; 600ms 开始说话
          </div>
          <Field label="ASR API Key" type="password"
            value={draft.asrApiKey}
            onChange={(v) => update('asrApiKey', v)}
            placeholder="不填则复用上方 API Key"
          />
          <Field label="ASR 模型"
            value={draft.asrModel}
            onChange={(v) => update('asrModel', v)}
            placeholder="qwen3-asr-flash-realtime"
          />
          <Field label="Fish API Key" type="password"
            value={draft.fishApiKey}
            onChange={(v) => update('fishApiKey', v)}
            placeholder="Fish Audio API Key（TTS 用）"
          />
          <Field label="音色 ID"
            value={draft.fishReferenceId}
            onChange={(v) => update('fishReferenceId', v)}
          />
        </Section>

        {/* ── 隐私 ── */}
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

        {/* ── B站 ── */}
        <Section title="B站历史" icon={Tv2}>
          <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 10 }}>
            点击顶栏 B站图标打开监控面板，在面板内登录即可自动抓取历史记录。
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <label style={labelStyle}>轮询间隔（秒）</label>
            <input
              type="number"
              min={30}
              max={3600}
              value={draft.biliIntervalSeconds}
              onChange={(e) => {
                setDraft((prev) => ({ ...prev, biliIntervalSeconds: Number(e.target.value) }))
                setDirty(true)
                setSaved(false)
              }}
              style={{ ...inputStyle, width: 60 }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <input
              type="checkbox"
              id="biliAutoCreate"
              checked={draft.biliAutoCreate}
              onChange={(e) => {
                setDraft((prev) => ({ ...prev, biliAutoCreate: e.target.checked }))
                setDirty(true)
                setSaved(false)
              }}
              style={{ cursor: 'pointer' }}
            />
            <label htmlFor="biliAutoCreate" style={{ ...labelStyle, marginBottom: 0, cursor: 'pointer' }}>
              自动同步新视频为活动
            </label>
          </div>
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

        {/* ── 数据库 ── */}
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
  label, value, onChange, type = 'text', placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: 'text' | 'password'
  placeholder?: string
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={labelStyle}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={inputStyle}
      />
    </div>
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
