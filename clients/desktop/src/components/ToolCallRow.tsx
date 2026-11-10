// ══════════════════════════════════════════════
// 聊天里的一次工具调用：一条下沉的窄槽，状态灯 + 工具的中文名 + 参数摘要 + 耗时；
// 点开看参数和结果，各自能复制，也能整次一起复制；函数名在点开后的左下角。
// 状态灯：运行中橙色闪烁，跑完变绿，没跑成变红。
// 数据和文字规则在 lib/agent/tool-call-view.ts（两端共用）；手机端的样子在 components/fairy/ToolCallRow.tsx
// ══════════════════════════════════════════════

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Check, ChevronRight, Copy, Wrench } from 'lucide-react'
import { theme, ti } from '../theme'
import {
  formatToolDuration,
  prettyToolArgs,
  toolArgsSummary,
  toolCallCopyText,
  toolCallStatus,
  toolLabel,
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

function Section({ title, text, maxHeight }: { title: string; text: string; maxHeight: number }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ ...monoText, fontSize: 10, color: ti.textFaint, letterSpacing: '0.08em' }}>{title}</span>
        <CopyButton text={text} label="复制" />
      </div>
      <pre
        style={{
          ...monoText, margin: 0, maxHeight, overflow: 'auto', padding: '6px 9px', borderRadius: 4,
          background: 'rgba(255,255,255,0.035)', color: theme.paperDim,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text',
        }}
      >
        {text}
      </pre>
    </div>
  )
}

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
    <div className="ti-well" style={{ margin: '1px 0', borderRadius: 5, overflow: 'hidden' }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
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
            boxShadow: `0 0 6px ${color}88`,
            animation: status === 'running' ? 'glowPulse 0.9s ease-in-out infinite' : undefined,
            opacity: status === 'running' ? undefined : 0.9,
          }}
        />
        <Wrench size={11} style={{ flexShrink: 0, color: theme.paperMuted }} />
        <span style={{ flexShrink: 0, color: theme.paper, fontWeight: 700 }}>{label}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 }}>
          {summary}
        </span>
        {statusText && (
          <span style={{ flexShrink: 0, fontSize: 10, color: status === 'done' ? ti.textFaint : color }}>{statusText}</span>
        )}
        <ChevronRight
          size={12}
          style={{ flexShrink: 0, color: ti.textFaint, transition: 'transform 0.15s ease', transform: expanded ? 'rotate(90deg)' : 'none' }}
        />
      </button>
      {expanded && (
        <div style={{ display: 'grid', gap: 8, padding: '2px 9px 9px 19px', animation: 'fadeSlideIn 0.15s ease' }}>
          <Section title="参数" text={prettyToolArgs(call.arguments)} maxHeight={180} />
          {call.result !== undefined
            ? <Section title="结果" text={call.result} maxHeight={260} />
            : <span style={{ ...monoText, fontSize: 10, color: ti.textFaint }}>还在运行，结果出来后显示在这里</span>}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ ...monoText, fontSize: 10, color: ti.textFaint }}>{label === call.name ? '' : call.name}</span>
            <CopyButton text={toolCallCopyText(call)} label="复制全部" />
          </div>
        </div>
      )}
    </div>
  )
}
