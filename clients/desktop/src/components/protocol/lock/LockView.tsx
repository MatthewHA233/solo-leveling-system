// ══════════════════════════════════════════════
// 协议志 · 协议：每份协议 = 一份白名单（应用 + 网站）+ 强度 + 每日目标；开局后只放行名单里的东西
//   左栏协议列表；右边：有局在进行且选的是它 → 「这一局」面板，否则 → 编辑这份协议
//   一份协议都还没有时，右边默认是「开局」（两份清单 → 照一遍 → 以终为始 → 未来年表，见 ../genesis）
//   拦截由后端执行（protocol_watch.rs + Chrome 扩展），这里只管编辑、开局、结束、看今天
// ══════════════════════════════════════════════

import { useState } from 'react'
import { X } from 'lucide-react'
import JevSettings from './JevSettings'
import GenesisView from '../genesis/GenesisView'
import AwakenFilm from '../AwakenFilm'
import { useAwakenFilmAvailable } from '../use-awaken-film'
import type { ToolPanel } from './ProtocolList'
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
  /** 右边换成的工具面板：开局 / 灰色地带的 AI 判断设置 */
  const [pickedTool, setPickedTool] = useState<ToolPanel | null>(null)
  const filmAvailable = useAwakenFilmAvailable()
  const [filmOpen, setFilmOpen] = useState(false)
  // 一份协议都还没有、也没手动选别的：默认就是开局
  const tool: ToolPanel | null = pickedTool ?? (!data.loading && protocols.length === 0 && !session ? 'genesis' : null)
  const toolOpen = tool !== null

  // 没手动选过：有局在进行就看这一局，否则看第一份协议
  const selectedId = pickedId ?? session?.protocolId ?? protocols[0]?.id ?? null
  const selected = protocols.find((p) => p.id === selectedId) ?? null
  const showSession = !toolOpen && session !== null && !editLive && (selectedId === session.protocolId || selected === null)

  const select = (id: string) => {
    setPickedId(id)
    setEditLive(false)
    setPickedTool(null)
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
        tool={tool}
        onOpenTool={setPickedTool}
      />
      <div className="pl-main">
        {data.error && (
          <div className="pl-error">
            <span style={{ flex: 1 }}>{data.error}</span>
            <button type="button" className="pl-chip-btn" aria-label="关闭提示" onClick={data.clearError}><X size={12} /></button>
          </div>
        )}
        {tool === 'genesis' ? (
          <GenesisView filmAvailable={filmAvailable} onOpenFilm={() => setFilmOpen(true)} />
        ) : tool === 'jev' ? (
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
      {filmOpen && <AwakenFilm onClose={() => setFilmOpen(false)} />}
    </div>
  )
}
