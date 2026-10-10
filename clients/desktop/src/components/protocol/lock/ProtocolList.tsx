// 协议志 · 协议左栏：协议列表（进行中的那份亮一颗灯）+ 灰色地带的 AI 判断设置 + 新建

import { useState } from 'react'
import { Plus, ScanEye } from 'lucide-react'
import type { LockProtocol, LockSession } from '../../../lib/protocol-api'
import { STRENGTH_META } from './lock-model'

export interface ProtocolListProps {
  readonly protocols: readonly LockProtocol[]
  readonly session: LockSession | null
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
  readonly onCreate: (name: string) => Promise<void>
  /** 右边正在显示「灰色地带 · AI 判断」设置 */
  readonly jevOpen: boolean
  readonly onOpenJev: () => void
}

export default function ProtocolList({ protocols, session, selectedId, onSelect, onCreate, jevOpen, onOpenJev }: ProtocolListProps) {
  const [draft, setDraft] = useState('')

  const create = async () => {
    const name = draft.trim()
    if (!name) return
    setDraft('')
    await onCreate(name)
  }

  return (
    <div className="pl-side">
      <div className="pl-side-title">协议</div>
      <div className="pl-side-list">
        {protocols.map((p) => {
          const live = session?.protocolId === p.id
          return (
            <button
              key={p.id}
              type="button"
              className="pl-row"
              data-selected={!jevOpen && p.id === selectedId ? '1' : undefined}
              onClick={() => onSelect(p.id)}
            >
              <span className={live ? 'ti-dot ti-dot-led' : 'ti-dot ti-dot-off'} aria-hidden />
              <span className="pl-row-name">{p.name}</span>
              <span className="pl-badge">{STRENGTH_META[p.strength].label}</span>
            </button>
          )
        })}
        {protocols.length === 0 && (
          <div className="pl-hint" style={{ padding: '4px 10px', lineHeight: 1.6 }}>
            一份协议 = 一份白名单。比如「Solevup 开发」：只放行终端、编辑器和查资料的网站
          </div>
        )}
      </div>
      <div className="pl-side-foot">
        <button type="button" className="pl-row" data-selected={jevOpen ? '1' : undefined} onClick={onOpenJev} style={{ width: '100%' }}>
          <ScanEye size={14} aria-hidden />
          <span className="pl-row-name" style={{ fontWeight: 500 }}>灰色地带 · AI 判断</span>
        </button>
      </div>
      <div className="pl-new">
        <input
          className="pl-input"
          value={draft}
          placeholder="新协议名"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create() }}
        />
        <button type="button" className="ti-key" aria-label="新建协议" style={{ width: 30, height: 30, flexShrink: 0 }} onClick={create}>
          <Plus size={14} />
        </button>
      </div>
    </div>
  )
}
