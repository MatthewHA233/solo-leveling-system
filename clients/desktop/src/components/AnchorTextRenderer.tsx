// ══════════════════════════════════════════════
// AnchorTextRenderer — 语境文本上的锚点渲染（逐项移植 LingFlow AnchorHighlightRenderer）
//   · 中文分词 → 单词锚点 = 实心渐变填充 + 白字 + 模糊光晕
//   · 短语/整句锚点 = 文字保持原样，外面画 2px 渐变描边框（borderImage，按行分组每行一框）
//   · hover 锚点弹悬浮窗（Portal 到 body、自动避让视口边界）
//   · 可框选（onSelectText），无框选则纯展示
// ══════════════════════════════════════════════

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { theme } from '../theme'
import type { AnchorBinding, AnchorCategory, AnchorRef } from '../lib/local-api'
import Tooltip from './Tooltip'

const CAT_COLOR: Record<AnchorCategory, string> = {
  motive: theme.warningOrange,
  view: theme.electricBlue,
  practice: theme.expGreen,
}

// 单词锚点的实心渐变填充（LingFlow: from-blue-500 to-purple-500；motive/practice 同形异色）
const CAT_FILL: Record<AnchorCategory, string> = {
  view: 'linear-gradient(to right, rgb(59,130,246), rgb(168,85,247))',
  motive: 'linear-gradient(to right, rgb(249,115,22), rgb(239,68,68))',
  practice: 'linear-gradient(to right, rgb(34,197,94), rgb(20,184,166))',
}

// 单词锚点背后的模糊光晕（LingFlow: from-blue-400 to-purple-400, blur-sm, opacity-30）
const CAT_FILL_GLOW: Record<AnchorCategory, string> = {
  view: 'linear-gradient(to right, rgb(96,165,250), rgb(192,132,252))',
  motive: 'linear-gradient(to right, rgb(251,146,60), rgb(248,113,113))',
  practice: 'linear-gradient(to right, rgb(74,222,128), rgb(45,212,191))',
}

// 短语锚点的渐变描边（LingFlow 原版: rgb(99 102 241) → rgb(168 85 247) 即 indigo-500 → purple-500）
const CAT_FRAME: Record<AnchorCategory, string> = {
  view: 'linear-gradient(to right, rgb(99,102,241), rgb(168,85,247))',
  motive: 'linear-gradient(to right, rgb(249,115,22), rgb(239,68,68))',
  practice: 'linear-gradient(to right, rgb(34,197,94), rgb(20,184,166))',
}

// LingFlow 计框时排除的标点/空白（不参与短语框的端点测量）
const PUNCT_OR_SPACE = /[，。！？；：""''（）【】《》、\s]/
const CAT_LABEL: Record<AnchorCategory, string> = {
  motive: '刺激·动机',
  view: '观点·看法',
  practice: '教程·实践',
}

const CAT_SHORT: Record<AnchorCategory, string> = {
  motive: '动机',
  view: '观点',
  practice: '实践',
}

/** 锚点标签：左段类别（实底）+ 右段关键词，三类语义一眼可读 */
export function AnchorChip({ anchor }: { readonly anchor: AnchorRef }) {
  const c = CAT_COLOR[anchor.category]
  return (
    <Tooltip content={CAT_LABEL[anchor.category]}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'stretch',
          maxWidth: '100%',
          borderRadius: 3,
          overflow: 'hidden',
          border: `1px solid ${c}55`,
          fontFamily: theme.fontMono,
          fontSize: 10.5,
          lineHeight: 1.5,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', background: c, color: '#051018', fontWeight: 700, padding: '1px 5px', letterSpacing: '0.08em', flexShrink: 0 }}>
          {CAT_SHORT[anchor.category]}
        </span>
        {/* 锚点句可能是完整长句，允许换行 */}
        <span style={{ background: `${c}14`, color: c, padding: '1px 7px', whiteSpace: 'normal', minWidth: 0 }}>
          {anchor.keyword}
        </span>
      </span>
    </Tooltip>
  )
}

interface Seg { text: string; start: number; end: number }

// 分词（仿 LingFlow segmentChinese）：英文词 / 数字 / 中文单字 / 标点 / 空白
function segmentText(text: string): Seg[] {
  const segs: Seg[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c)) { segs.push({ text: c, start: i, end: i + 1 }); i++; continue }
    if (/[a-zA-Z]/.test(c)) {
      const s = i
      while (i < text.length && /[a-zA-Z]/.test(text[i])) i++
      segs.push({ text: text.slice(s, i), start: s, end: i }); continue
    }
    if (/[0-9]/.test(c)) {
      const s = i
      while (i < text.length && /[0-9.]/.test(text[i])) i++
      segs.push({ text: text.slice(s, i), start: s, end: i }); continue
    }
    segs.push({ text: c, start: i, end: i + 1 }); i++
  }
  return segs
}

interface AnchorRange {
  start: number
  end: number
  binding: AnchorBinding
  color: string
}

function bindingColor(b: AnchorBinding): string {
  return b.anchors.length ? CAT_COLOR[b.anchors[0].category] : theme.textMuted
}

// 把 selection 的 (node, offset) 映射成相对整段文本的全局 offset
function globalOffset(root: Node, node: Node, offset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let acc = 0
  let n = walker.nextNode()
  while (n) {
    if (n === node) return acc + offset
    acc += n.textContent?.length ?? 0
    n = walker.nextNode()
  }
  return acc + offset
}

interface Props {
  readonly text: string
  readonly bindings: readonly AnchorBinding[]
  readonly onRemoveBinding?: (id: string) => void
  readonly onSelectText?: (start: number, end: number, selectedText: string, rect: DOMRect) => void
}

interface PhraseBox {
  key: string
  left: number
  top: number
  width: number
  height: number
  gradient: string
}

export default function AnchorTextRenderer({ text, bindings, onRemoveBinding, onSelectText }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const segmentRefs = useRef<(HTMLSpanElement | null)[]>([])
  const [tip, setTip] = useState<{ ranges: AnchorRange[]; anchorRect: DOMRect } | null>(null)
  const [phraseBoxes, setPhraseBoxes] = useState<PhraseBox[]>([])
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const segments = useMemo(() => segmentText(text), [text])
  const ranges = useMemo<AnchorRange[]>(
    () =>
      bindings
        .filter((b) => b.start_pos >= 0 && b.end_pos <= text.length && b.end_pos > b.start_pos)
        .map((b) => ({ start: b.start_pos, end: b.end_pos, binding: b, color: bindingColor(b) }))
        .sort((a, b) => a.start - b.start),
    [bindings, text],
  )

  const rangesOfSeg = (seg: Seg): AnchorRange[] =>
    ranges.filter((r) => seg.start >= r.start && seg.end <= r.end)

  // 短语锚点 = 范围内有效分词（非标点/空白）≥ 2 个（LingFlow isPhrase 判定）
  const phraseBindingIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of ranges) {
      const count = segments.filter(
        (s) => s.start >= r.start && s.end <= r.end && !PUNCT_OR_SPACE.test(s.text),
      ).length
      if (count > 1) ids.add(r.binding.id)
    }
    return ids
  }, [ranges, segments])

  // 测量短语框：每个范围取有效分词的 rect → 按行分组（top 差 >10px 即换行）→ 每行一个框
  // （LingFlow 在 render 中直接读 refs，这里改为 layout effect + ResizeObserver，换行/缩放自动重算）
  useLayoutEffect(() => {
    const measure = () => {
      const container = containerRef.current
      if (!container) return
      const containerRect = container.getBoundingClientRect()
      const boxes: PhraseBox[] = []
      ranges.forEach((range, rangeIndex) => {
        if (!phraseBindingIds.has(range.binding.id)) return
        const rects: DOMRect[] = []
        segments.forEach((seg, i) => {
          if (seg.start >= range.start && seg.end <= range.end && !PUNCT_OR_SPACE.test(seg.text)) {
            const el = segmentRefs.current[i]
            if (el) rects.push(el.getBoundingClientRect())
          }
        })
        if (rects.length === 0) return

        const lineGroups: DOMRect[][] = []
        let line: DOMRect[] = []
        let lineTop = rects[0].top
        for (const rect of rects) {
          if (Math.abs(rect.top - lineTop) > 10) {
            if (line.length) lineGroups.push(line)
            line = [rect]
            lineTop = rect.top
          } else {
            line.push(rect)
          }
        }
        if (line.length) lineGroups.push(line)

        const cat = range.binding.anchors[0]?.category ?? 'view'
        lineGroups.forEach((lineRects, lineIndex) => {
          const first = lineRects[0]
          const last = lineRects[lineRects.length - 1]
          boxes.push({
            key: `${range.binding.id}-${rangeIndex}-${lineIndex}`,
            left: first.left - containerRect.left - 4,
            width: last.right - first.left + 8,
            top: first.top - containerRect.top - 4,
            height: first.height + 8,
            gradient: CAT_FRAME[cat],
          })
        })
      })
      setPhraseBoxes(boxes)
    }

    measure()
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(measure)
    ro.observe(container)
    return () => ro.disconnect()
  }, [segments, ranges, phraseBindingIds])

  const showTip = (rs: AnchorRange[], el: HTMLElement) => {
    if (rs.length === 0) return
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setTip({ ranges: rs, anchorRect: el.getBoundingClientRect() })
  }
  const scheduleHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setTip(null), 180)
  }
  const cancelHide = () => { if (hideTimer.current) clearTimeout(hideTimer.current) }

  const handleMouseUp = () => {
    if (!onSelectText || !containerRef.current) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (!containerRef.current.contains(range.commonAncestorContainer)) return
    const a = globalOffset(containerRef.current, range.startContainer, range.startOffset)
    const b = globalOffset(containerRef.current, range.endContainer, range.endOffset)
    const start = Math.min(a, b)
    const end = Math.max(a, b)
    const selected = text.slice(start, end)
    if (!selected.trim()) return
    const rect = range.getBoundingClientRect()
    onSelectText(start, end, selected, rect)
    sel.removeAllRanges()
  }

  return (
    <div
      ref={containerRef}
      onMouseUp={handleMouseUp}
      style={{
        position: 'relative',
        whiteSpace: 'pre-wrap',
        lineHeight: 1.95,
        cursor: onSelectText ? 'text' : 'default',
      }}
    >
      {/* 短语锚点的渐变描边框（LingFlow: absolute border-2 rounded-md + borderImage 渐变） */}
      {phraseBoxes.map((box) => (
        <div
          key={box.key}
          style={{
            position: 'absolute',
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            border: '2px solid transparent',
            borderImage: `${box.gradient} 1`,
            borderRadius: 6,
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />
      ))}

      {segments.map((seg, i) => {
        const rs = rangesOfSeg(seg)
        if (rs.length === 0) {
          return (
            <span key={i} ref={(el) => { segmentRefs.current[i] = el }}>
              {seg.text}
            </span>
          )
        }
        const cat = rs[0].binding.anchors[0]?.category ?? 'view'
        const isPhrase = phraseBindingIds.has(rs[0].binding.id)

        // 短语锚点：文字保持原样（框由 phraseBoxes 画），只接 hover
        if (isPhrase) {
          return (
            <span
              key={i}
              ref={(el) => { segmentRefs.current[i] = el }}
              onMouseEnter={(e) => showTip(rs, e.currentTarget)}
              onMouseLeave={scheduleHide}
              style={{ cursor: 'pointer', transition: 'all 0.2s' }}
            >
              {seg.text}
            </span>
          )
        }

        // 单词锚点：实心渐变 + 白字 + 背后模糊光晕（LingFlow 单词样式）
        return (
          <span
            key={i}
            ref={(el) => { segmentRefs.current[i] = el }}
            onMouseEnter={(e) => showTip(rs, e.currentTarget)}
            onMouseLeave={scheduleHide}
            style={{
              position: 'relative',
              display: 'inline-block',
              padding: '0 4px',
              borderRadius: 3,
              background: CAT_FILL[cat],
              color: '#fff',
              boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {seg.text}
            <span
              aria-hidden
              style={{
                position: 'absolute',
                inset: -1,
                background: CAT_FILL_GLOW[cat],
                borderRadius: 4,
                filter: 'blur(4px)',
                zIndex: -1,
                opacity: 0.3,
                pointerEvents: 'none',
              }}
            />
          </span>
        )
      })}

      {/* Portal 到 body：脱离洪流域面板的 transform 祖先，fixed 才相对视口、不被裁剪 */}
      {tip && createPortal(
        <AnchorTooltip
          ranges={tip.ranges}
          anchorRect={tip.anchorRect}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
          onRemoveBinding={onRemoveBinding}
        />,
        document.body,
      )}
    </div>
  )
}

function AnchorTooltip({
  ranges, anchorRect, onMouseEnter, onMouseLeave, onRemoveBinding,
}: {
  readonly ranges: AnchorRange[]
  readonly anchorRect: DOMRect
  readonly onMouseEnter: () => void
  readonly onMouseLeave: () => void
  readonly onRemoveBinding?: (id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // 默认紧贴锚点字下方；测量自身尺寸后避让视口边界（下方放不下翻到上方、左右不出界）
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: anchorRect.bottom + 4, left: anchorRect.left })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let top = anchorRect.bottom + 4
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchorRect.top - h - 4)
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - w - 8))
    setPos({ top, left })
  }, [anchorRect])

  return (
    <div
      ref={ref}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        zIndex: 9999,
        maxWidth: 340,
        background: theme.hudFillDeep,
        border: `1px solid ${theme.hudFrame}`,
        borderRadius: 6,
        padding: '9px 11px',
        boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
        fontFamily: theme.fontBody,
      }}
    >
      {ranges.map((r) => (
        <div key={r.binding.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
            {r.binding.anchors.map((a) => (
              <AnchorChip key={a.id} anchor={a} />
            ))}
            {onRemoveBinding && (
              <Tooltip content="删除该锚点" wrapStyle={{ marginLeft: 'auto' }}>
                <button
                  type="button"
                  onClick={() => onRemoveBinding(r.binding.id)}
                  style={{
                    border: 'none', background: 'transparent',
                    color: theme.textMuted, cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0,
                  }}
                >
                  ×
                </button>
              </Tooltip>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: theme.textPrimary, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {r.binding.user_speech}
          </div>
        </div>
      ))}
    </div>
  )
}

export const ANCHOR_CAT_COLOR = CAT_COLOR
export const ANCHOR_CAT_LABEL = CAT_LABEL
