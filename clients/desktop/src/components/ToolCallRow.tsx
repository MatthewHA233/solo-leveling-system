// ══════════════════════════════════════════════
// 聊天里的一次工具调用：一条下沉的窄槽，状态灯 + 工具的中文名 + 参数摘要 + 耗时；
// 点开看参数和结果，各自能复制，也能整次一起复制；函数名在点开后的左下角。
// 状态灯：运行中橙色闪烁，跑完变绿，没跑成变红。
// 数据和文字规则在 lib/agent/tool-call-view.ts（两端共用）；手机端的样子在 components/fairy/ToolCallRow.tsx
//
// 上下文整理留的行也画成同样的窄槽（文字规则在 tool-call-view.ts 末尾）：
//   · CompactRow：分界处的压缩提示，点开看摘要、能复制
//   · ContextRow：当时在底部加的一行。清理工具结果点开看清了哪些；整理上下文点它跳到分界那条
// ══════════════════════════════════════════════

import { revealChatMessage } from './chat-window'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowUp, Check, ChevronRight, Copy, Eraser, FoldVertical, Wrench } from 'lucide-react'
import { theme, ti } from '../theme'
import {
  approxCount,
  clearedToolGroups,
  COMPACT_ROW_LABEL,
  COMPACT_ROW_NOTE,
  compactRowSummary,
  contextEventLabel,
  contextEventNote,
  contextEventSize,
  contextEventSummary,
  formatToolDuration,
  prettyToolArgs,
  toolArgsSummary,
  toolCallCopyText,
  toolCallStatus,
  toolLabel,
  type ContextEventView,
  type ToolCallStatus,
  type ToolCallView,
} from '../lib/agent/tool-call-view'

const STATUS_COLOR: Record<ToolCallStatus, string> = {
  running: ti.led,
  done: ti.ok,
  failed: theme.dangerRed,
}

const COPIED_MS = 1200

const monoText: CSSProperties = { fontFamily: theme.fontMono, fontSize: 11, lineHeight: 1.6 }

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])

  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), COPIED_MS)
    }).catch((e) => console.warn('[ToolCall] 复制失败:', e))
  }

  return (
    <button
      type="button"
      className="ui-icon-btn"
      onClick={copy}
      style={{
        ...monoText, fontSize: 10,
        display: 'inline-flex', alignItems: 'center', gap: 4,
        background: 'none', border: 'none', cursor: 'pointer', padding: '1px 4px', borderRadius: 4,
        color: copied ? ti.ok : theme.paperMuted,
      }}
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? '已复制' : label}
    </button>
  )
}

const noteText: CSSProperties = { ...monoText, fontSize: 10, color: ti.textFaint }

const wellBox: CSSProperties = {
  margin: 0, padding: '6px 9px', borderRadius: 4,
  background: 'rgba(255,255,255,0.035)', color: theme.paperDim,
}

/** prose：正文字体（摘要），否则等宽（参数、结果） */
function Section({ title, text, maxHeight, prose = false }: { title: string; text: string; maxHeight: number; prose?: boolean }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ ...monoText, fontSize: 10, color: ti.textFaint, letterSpacing: '0.08em' }}>{title}</span>
        <CopyButton text={text} label="复制" />
      </div>
      <pre
        style={{
          ...(prose ? { fontFamily: theme.fontBody, fontSize: 12, lineHeight: 1.7 } : monoText),
          ...wellBox, maxHeight, overflow: 'auto',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text',
        }}
      >
        {text}
      </pre>
    </div>
  )
}

/** 窄槽里的那一行：状态灯 + 图标 + 名字 + 说明 + 右边一小段 + 箭头。工具调用和上下文整理共用 */
function RowShell({ color, glow, pulse, icon, label, summary, side, sideColor, trailing, expanded, title, onClick, children }: {
  color: string
  glow: boolean
  pulse?: boolean
  icon: ReactNode
  label: string
  summary: string
  side?: string
  sideColor?: string
  /** 右端的箭头；不给就是点开收起的 › */
  trailing?: ReactNode
  expanded: boolean
  title?: string
  onClick: () => void
  children?: ReactNode
}) {
  return (
    <div className="ti-well" style={{ margin: '1px 0', borderRadius: 5, overflow: 'hidden' }}>
      <button
        type="button"
        aria-expanded={trailing ? undefined : expanded}
        title={title}
        onClick={onClick}
        style={{
          ...monoText,
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0,
          background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
          padding: '5px 9px 5px 8px', color: theme.paperMuted,
        }}
      >
        <span
          style={{
            flexShrink: 0, width: 3, height: 13, borderRadius: 2, background: color,
            boxShadow: glow ? `0 0 6px ${color}88` : undefined,
            animation: pulse ? 'glowPulse 0.9s ease-in-out infinite' : undefined,
            opacity: pulse ? undefined : 0.9,
          }}
        />
        {icon}
        <span style={{ flexShrink: 0, color: theme.paper, fontWeight: 700 }}>{label}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 }}>
          {summary}
        </span>
        {side && <span style={{ flexShrink: 0, fontSize: 10, color: sideColor ?? ti.textFaint }}>{side}</span>}
        {trailing ?? (
          <ChevronRight
            size={12}
            style={{ flexShrink: 0, color: ti.textFaint, transition: 'transform 0.15s ease', transform: expanded ? 'rotate(90deg)' : 'none' }}
          />
        )}
      </button>
      {expanded && children && (
        <div style={{ display: 'grid', gap: 8, padding: '2px 9px 9px 19px', animation: 'fadeSlideIn 0.15s ease' }}>
          {children}
        </div>
      )}
    </div>
  )
}

const rowIcon: CSSProperties = { flexShrink: 0, color: theme.paperMuted }

export default function ToolCallRow({ call }: { call: ToolCallView }) {
  const [expanded, setExpanded] = useState(false)
  const status = toolCallStatus(call)
  const color = STATUS_COLOR[status]
  const summary = toolArgsSummary(call.arguments)
  const label = toolLabel(call.name)
  const statusText = status === 'running'
    ? '运行中'
    : status === 'failed'
      ? '失败'
      : call.durationMs !== undefined ? formatToolDuration(call.durationMs) : ''

  return (
    <RowShell
      color={color}
      glow
      pulse={status === 'running'}
      icon={<Wrench size={11} style={rowIcon} />}
      label={label}
      summary={summary}
      side={statusText}
      sideColor={status === 'done' ? ti.textFaint : color}
      expanded={expanded}
      onClick={() => setExpanded(!expanded)}
    >
      <Section title="参数" text={prettyToolArgs(call.arguments)} maxHeight={180} />
      {call.result !== undefined
        ? <Section title="结果" text={call.result} maxHeight={260} />
        : <span style={noteText}>还在运行，结果出来后显示在这里</span>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={noteText}>{label === call.name ? '' : call.name}</span>
        <CopyButton text={toolCallCopyText(call)} label="复制全部" />
      </div>
    </RowShell>
  )
}

/** 分界处的压缩提示。fallback = 模型没写成摘要，用的机械摘要；timestamp 供底部那行跳过来（data-msg-ts） */
export function CompactRow({ summary, fallback, timestamp }: { summary: string; fallback: boolean; timestamp: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div data-msg-ts={timestamp}>
      <RowShell
        color={fallback ? theme.dangerRed : ti.textFaint}
        glow={fallback}
        icon={<FoldVertical size={11} style={rowIcon} />}
        label={COMPACT_ROW_LABEL}
        summary={compactRowSummary(fallback)}
        side={`${approxCount(summary.length)} 字`}
        expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <Section title="摘要" text={summary} maxHeight={280} prose />
        <span style={noteText}>{COMPACT_ROW_NOTE}</span>
      </RowShell>
    </div>
  )
}

/** 跳到分界处那条压缩提示并闪一下（和历史会话搜索命中的跳转同一个效果） */
function jumpToBoundary(timestamp: string): void {
  // 分界那条可能在聊天栏还没画出来的更早一段里：先让它画出来，下一帧再找
  revealChatMessage(timestamp)
  requestAnimationFrame(() => requestAnimationFrame(() => flashBoundary(timestamp)))
}

function flashBoundary(timestamp: string): void {
  const el = document.querySelector<HTMLElement>(`[data-msg-ts="${CSS.escape(timestamp)}"]`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.remove('msg-jump-flash')
  void el.offsetWidth // 连点时重新播放闪烁
  el.classList.add('msg-jump-flash')
  window.setTimeout(() => el.classList.remove('msg-jump-flash'), 1800)
}

/**
 * 上下文整理当时留的一行。清理工具结果：点开列出清了哪些；整理上下文：点它跳到分界那条。
 * 右边是上下文从多少降到多少（token）
 */
export function ContextRow({ event }: { event: ContextEventView }) {
  const [expanded, setExpanded] = useState(false)
  const cleared = event.kind === 'cleared'
  const fallback = event.kind === 'fallback'
  const boundary = event.boundary
  // 正在写摘要：亮着的灯，不能点开也没有可跳的地方
  if (event.kind === 'compacting') {
    return (
      <RowShell
        color={ti.led}
        glow
        pulse
        icon={<FoldVertical size={11} style={rowIcon} />}
        label={contextEventLabel(event)}
        summary={contextEventSummary(event)}
        side={`${contextEventSize(event)} token`}
        sideColor={ti.led}
        trailing={<span style={{ width: 12, flexShrink: 0 }} />}
        expanded={false}
        title={contextEventNote(event)}
        onClick={() => {}}
      />
    )
  }
  return (
    <RowShell
      color={fallback ? theme.dangerRed : ti.textFaint}
      glow={fallback}
      icon={cleared ? <Eraser size={11} style={rowIcon} /> : <FoldVertical size={11} style={rowIcon} />}
      label={contextEventLabel(event)}
      summary={contextEventSummary(event)}
      side={`${contextEventSize(event)} token`}
      trailing={cleared ? undefined : <ArrowUp size={12} style={{ flexShrink: 0, color: ti.textFaint }} />}
      expanded={cleared && expanded}
      title={cleared ? undefined : contextEventNote(event)}
      onClick={() => {
        if (cleared) setExpanded(!expanded)
        else if (boundary) jumpToBoundary(boundary)
      }}
    >
      {cleared && (
        <>
          <div style={{ ...monoText, ...wellBox, display: 'grid', gap: 2 }}>
            {clearedToolGroups(event).map((g) => (
              <div key={g.label} style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.count > 1 ? `${g.label} × ${g.count}` : g.label}
                </span>
                <span style={{ flexShrink: 0, fontSize: 10, color: ti.textFaint }}>{approxCount(g.chars)} 字</span>
              </div>
            ))}
          </div>
          <span style={noteText}>{contextEventNote(event)}</span>
        </>
      )}
    </RowShell>
  )
}
