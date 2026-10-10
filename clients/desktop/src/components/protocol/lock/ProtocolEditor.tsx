// 协议志 · 协议：编辑一份协议（名字 / 用意 / 强度 / 每日目标 / 应用和网站白名单）+ 开局
// 文字在失焦时才保存（打字时不一个字一个请求）；白名单条目、强度点一下就存

import { useState } from 'react'
import { Play, Trash2 } from 'lucide-react'
import { ti } from '../../../theme'
import Segmented from '../../ui/Segmented'
import type { LockProtocol, LockProtocolPatch, LockSession, LockStrength } from '../../../lib/protocol-api'
import AllowList from './AllowList'
import { DURATION_OPTIONS, STRENGTH_META } from './lock-model'

const STRENGTHS: readonly LockStrength[] = ['soft', 'firm', 'hard']
const HOUR_STEP = 0.5

export interface ProtocolEditorProps {
  readonly protocol: LockProtocol
  /** 有局在进行（不一定是这份协议）：这时只能改、不能开局 */
  readonly session: LockSession | null
  readonly onUpdate: (id: string, patch: LockProtocolPatch) => void
  readonly onRemove: (id: string) => Promise<void>
  readonly onStart: (id: string, minutes: number | null) => Promise<void>
}

export default function ProtocolEditor({ protocol, session, onUpdate, onRemove, onStart }: ProtocolEditorProps) {
  const [minutes, setMinutes] = useState<number | null>(protocol.strength === 'hard' ? 120 : null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [starting, setStarting] = useState(false)
  const patch = (p: LockProtocolPatch) => onUpdate(protocol.id, p)

  const hardNeedsTime = protocol.strength === 'hard' && minutes === null
  const blockedBySession = session !== null
  const canStart = !blockedBySession && !hardNeedsTime && !starting

  const start = async () => {
    setStarting(true)
    try {
      await onStart(protocol.id, minutes)
    } finally {
      setStarting(false)
    }
  }

  return (
    <div>
      {/* key 绑 id：切到另一份协议时输入框重新取初值 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          key={`name-${protocol.id}`}
          className="pl-title-input"
          defaultValue={protocol.name}
          aria-label="协议名"
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== protocol.name) patch({ name: v }) }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
        {confirmDelete ? (
          <>
            <button type="button" className="ti-key ti-key-danger" style={{ height: 28, padding: '0 12px', fontSize: 12 }} onClick={() => onRemove(protocol.id)}>
              确认删除
            </button>
            <button type="button" className="ti-key" style={{ height: 28, padding: '0 12px', fontSize: 12 }} onClick={() => setConfirmDelete(false)}>
              取消
            </button>
          </>
        ) : (
          <button type="button" className="ti-key" aria-label="删除协议" style={{ width: 28, height: 28 }} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={13} />
          </button>
        )}
      </div>

      <div className="pl-section">
        <div className="pl-section-head">
          <span className="pl-section-title">用意</span>
          <span className="pl-hint">这份协议为了什么。以后 AI 判断灰色地带时拿它当标准</span>
        </div>
        <textarea
          key={`intent-${protocol.id}`}
          className="pl-textarea"
          defaultValue={protocol.intent}
          placeholder="例如：推进 Solevup，写代码、看文档、和 Claude 一起改"
          onBlur={(e) => { if (e.target.value.trim() !== protocol.intent) patch({ intent: e.target.value }) }}
        />
      </div>

      <div className="pl-section" style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div>
          <div className="pl-section-head"><span className="pl-section-title">强度</span></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Segmented<LockStrength>
              value={protocol.strength}
              onChange={(s) => {
                patch({ strength: s })
                if (s === 'hard' && minutes === null) setMinutes(120)
              }}
              options={STRENGTHS.map((s) => ({ value: s, label: STRENGTH_META[s].label, led: ti.led, tip: STRENGTH_META[s].desc }))}
            />
            <span className="pl-hint">{STRENGTH_META[protocol.strength].desc}</span>
          </div>
        </div>
        <div>
          <div className="pl-section-head"><span className="pl-section-title">每日目标</span></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              key={`target-${protocol.id}`}
              className="pl-input"
              type="number"
              min={0}
              max={24}
              step={HOUR_STEP}
              style={{ width: 74 }}
              defaultValue={protocol.dailyTargetMin / 60}
              onBlur={(e) => {
                const hours = Number(e.target.value)
                if (Number.isFinite(hours)) {
                  const mins = Math.round(Math.min(24, Math.max(0, hours)) * 60)
                  if (mins !== protocol.dailyTargetMin) patch({ dailyTargetMin: mins })
                }
              }}
            />
            <span className="pl-hint">小时</span>
          </div>
        </div>
      </div>

      <div className="pl-section">
        <div className="pl-section-head">
          <span className="pl-section-title">放行的应用</span>
          <span className="pl-hint">不在这里的窗口会被最小化（Solevup 自己、桌面任务栏、任务管理器永远放行）</span>
        </div>
        <AllowList kind="app" entries={protocol.apps} onChange={(apps) => patch({ apps })} />
      </div>

      <div className="pl-section">
        <div className="pl-section-head">
          <span className="pl-section-title">放行的网站</span>
          <span className="pl-hint">Chrome 里不在这里的网站会被拦（需要专注锁扩展在线）</span>
        </div>
        <AllowList kind="site" entries={protocol.sites} onChange={(sites) => patch({ sites })} />
      </div>

      <div className="pl-rule" />
      <div className="pl-section">
        <div className="pl-section-head"><span className="pl-section-title">开局</span></div>
        <div className="pl-start">
          <Segmented<string>
            value={String(minutes)}
            onChange={(v) => setMinutes(v === 'null' ? null : Number(v))}
            options={DURATION_OPTIONS.map((o) => ({
              value: String(o.minutes), label: o.label, led: ti.led,
              tip: o.minutes === null ? '一直锁到你结束（硬锁不能选）' : `${o.label}后自动结束`,
            }))}
          />
          <button
            type="button"
            className="ti-key ti-key-primary"
            disabled={!canStart}
            style={{ height: 30, padding: '0 16px', fontSize: 13, gap: 6 }}
            onClick={start}
          >
            <Play size={13} /> 开局
          </button>
        </div>
        {blockedBySession && <div className="pl-warn" style={{ marginTop: 8 }}>「{session.protocolName}」这一局还没结束；这里的改动下一局生效</div>}
        {hardNeedsTime && <div className="pl-warn" style={{ marginTop: 8 }}>硬锁要先定好这一局多长</div>}
        {!blockedBySession && protocol.apps.length === 0 && (
          <div className="pl-warn" style={{ marginTop: 8 }}>应用白名单是空的：开局后除了 Solevup 和系统外壳，所有窗口都会被最小化</div>
        )}
      </div>
    </div>
  )
}
