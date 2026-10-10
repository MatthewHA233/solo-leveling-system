// ══════════════════════════════════════════════
// 协议志 · 协议：每份协议 = 一份白名单（应用 + 网站）+ 强度 + 每日目标；开局后只放行名单里的东西
//   左栏协议列表；右边：有局在进行且选的是它 → 「这一局」面板，否则 → 编辑这份协议
//   拦截由后端执行（protocol_watch.rs + Chrome 扩展），这里只管编辑、开局、结束、看今天
// ══════════════════════════════════════════════

import { useState } from 'react'
import { X } from 'lucide-react'
import JevSettings from './JevSettings'
import ProtocolEditor from './ProtocolEditor'
import ProtocolList from './ProtocolList'
import SessionPanel from './SessionPanel'
import { useProtocolLock } from './use-protocol-lock'
import './lock.css'

export default function LockView() {
  const data = useProtocolLock()
  const { protocols, session } = data
  const [pickedId, setPickedId] = useState<string | null>(null)
  /** 局进行中也想改这份协议（下一局生效）：右边换成编辑器 */
  const [editLive, setEditLive] = useState(false)
  /** 右边显示「灰色地带 · AI 判断」设置 */
  const [jevOpen, setJevOpen] = useState(false)

  // 没手动选过：有局在进行就看这一局，否则看第一份协议
  const selectedId = pickedId ?? session?.protocolId ?? protocols[0]?.id ?? null
  const selected = protocols.find((p) => p.id === selectedId) ?? null
  const showSession = !jevOpen && session !== null && !editLive && (selectedId === session.protocolId || selected === null)

  const select = (id: string) => {
    setPickedId(id)
    setEditLive(false)
    setJevOpen(false)
  }

  const create = async (name: string) => {
    const p = await data.create(name)
    if (p) select(p.id)
  }

  const remove = async (id: string) => {
    await data.remove(id)
    if (pickedId === id) setPickedId(null)
  }

  return (
    <div className="pl-root">
      <ProtocolList
        protocols={protocols}
        session={session}
        selectedId={showSession ? session.protocolId : selectedId}
        onSelect={select}
        onCreate={create}
        jevOpen={jevOpen}
        onOpenJev={() => setJevOpen(true)}
      />
      <div className="pl-main">
        {data.error && (
          <div className="pl-error">
            <span style={{ flex: 1 }}>{data.error}</span>
            <button type="button" className="pl-chip-btn" aria-label="关闭提示" onClick={data.clearError}><X size={12} /></button>
          </div>
        )}
        {jevOpen ? (
          <JevSettings />
        ) : showSession ? (
          <SessionPanel
            session={session}
            dailyTargetMin={protocols.find((p) => p.id === session.protocolId)?.dailyTargetMin ?? null}
            todaySessions={data.todaySessions}
            todaySpans={data.todaySpans}
            onStop={data.stop}
            onCancel={data.cancel}
            onEdit={() => {
              setPickedId(session.protocolId)
              setEditLive(true)
            }}
          />
        ) : selected ? (
          <ProtocolEditor
            key={selected.id}
            protocol={selected}
            session={session}
            onUpdate={data.update}
            onRemove={remove}
            onStart={data.start}
          />
        ) : (
          <div className="pl-empty">{data.loading ? '读取中…' : '左边新建一份协议'}</div>
        )}
      </div>
    </div>
  )
}
