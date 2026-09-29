// ══════════════════════════════════════════════
// 蓝图层 —— 卷须（SVG）+ 可编辑的方向 / 步骤节点（HTML）
//   · 元素带 data-r / data-r0/r1：动机云的动画循环按「波前半径」逐帧点亮它们，
//     本组件只管结构与编辑，不参与逐帧动画
//   · 节点结晶：字距由宽收拢、模糊散去（CSS 过渡，由 data-on 触发）
//   · 点文字即编辑：Enter 保存、Esc 取消；悬停出现「删除」；卷须末端「＋」加一步
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { LaidDirection, Pt } from './blueprint-layout'

export const PAPER = '#E8DCCB'
const PAPER_DIM = '#BFB3A4'
const SANS = "'Exo 2', 'Microsoft YaHei', 'PingFang SC', sans-serif"

export interface BlueprintEdits {
  readonly renameDirection: (di: number, title: string) => void
  readonly editStep: (di: number, si: number, text: string) => void
  readonly removeDirection: (di: number) => void
  readonly removeStep: (di: number, si: number) => void
  readonly addStep: (di: number) => void
}

interface Props {
  readonly laid: readonly LaidDirection[]
  readonly width: number
  readonly height: number
  readonly edits: BlueprintEdits
  /** 刚新增、需要自动进入编辑的节点 key（如 "s1-3"） */
  readonly autoEditKey: string | null
  readonly onAutoEditConsumed: () => void
}

/** 可编辑文字：平时是按钮，点一下变输入框 */
function EditableText({
  text, editing, onStartEdit, onCommit, onCancel, fontSize, weight, color, maxWidth, alignRight,
}: {
  text: string
  editing: boolean
  onStartEdit: () => void
  onCommit: (value: string) => void
  onCancel: () => void
  fontSize: number
  weight: number
  color: string
  maxWidth: number
  alignRight: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  if (editing) {
    const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation()
      if (e.key === 'Enter') onCommit(e.currentTarget.value)
      else if (e.key === 'Escape') onCancel()
    }
    return (
      <input
        ref={inputRef}
        defaultValue={text}
        onKeyDown={onKey}
        onBlur={(e) => onCommit(e.currentTarget.value)}
        className="mc-edit"
        style={{ fontSize, fontWeight: weight, color, width: Math.min(maxWidth, Math.max(80, text.length * fontSize + 24)), textAlign: alignRight ? 'right' : 'left' }}
      />
    )
  }
  return (
    <button
      type="button"
      className="mc-text"
      onClick={(e) => { e.stopPropagation(); onStartEdit() }}
      title="点击修改"
      style={{ fontSize, fontWeight: weight, color, maxWidth, textAlign: alignRight ? 'right' : 'left' }}
    >
      {text}
    </button>
  )
}

function place(p: Pt): string {
  return `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`
}

export default function BlueprintLayer({ laid, width, height, edits, autoEditKey, onAutoEditConsumed }: Props) {
  const [editingKey, setEditingKey] = useState<string | null>(null)

  useEffect(() => {
    if (!autoEditKey) return
    setEditingKey(autoEditKey)
    onAutoEditConsumed()
  }, [autoEditKey, onAutoEditConsumed])

  const stop = () => setEditingKey(null)

  return (
    <>
      <svg className="mc-vines" width={width} height={height} aria-hidden="true">
        {laid.map((d, di) => (
          <g key={`v${di}`}>
            <path
              d={d.trunk}
              pathLength={1}
              data-r0={d.trunkR[0]}
              data-r1={d.trunkR[1]}
              stroke={PAPER}
              strokeOpacity={0.62}
              strokeWidth={1.25}
              fill="none"
              strokeDasharray="1"
              strokeDashoffset="1"
            />
            {d.tendril && (
              <path
                d={d.tendril}
                pathLength={1}
                data-r0={d.tendrilR[0]}
                data-r1={d.tendrilR[1]}
                stroke={PAPER}
                strokeOpacity={0.4}
                strokeWidth={1}
                fill="none"
                strokeDasharray="1"
                strokeDashoffset="1"
              />
            )}
          </g>
        ))}
      </svg>

      {laid.map((d, di) => {
        const dirKey = `d${di}`
        return (
          <div key={dirKey}>
            <div className="mc-node" data-r={d.r} data-x={d.p.x} data-y={d.p.y} data-on="0" style={{ transform: place(d.p) }}>
              <span className="mc-ring" />
              <div className={`mc-label-box mc-dir ${d.titlePos === 'above' ? 'mc-above' : d.textLeft ? 'mc-left' : ''}`}>
                <EditableText
                  text={d.title}
                  editing={editingKey === dirKey}
                  onStartEdit={() => setEditingKey(dirKey)}
                  onCommit={(v) => { stop(); if (v.trim() && v.trim() !== d.title) edits.renameDirection(di, v.trim()) }}
                  onCancel={stop}
                  fontSize={14.5}
                  weight={600}
                  color={PAPER}
                  maxWidth={220}
                  alignRight={d.titlePos === 'side' && d.textLeft}
                />
                <button type="button" className="mc-del" onClick={(e) => { e.stopPropagation(); edits.removeDirection(di) }} aria-label={`删除方向：${d.title}`}>删除</button>
              </div>
            </div>

            {d.steps.map((s, si) => {
              const key = `s${di}-${si}`
              return (
                <div key={key} className="mc-node" data-r={s.r} data-x={s.p.x} data-y={s.p.y} data-on="0" style={{ transform: place(s.p) }}>
                  <span className="mc-dot" />
                  <div className={`mc-label-box mc-step ${s.textLeft ? 'mc-left' : ''}`}>
                    <EditableText
                      text={s.text}
                      editing={editingKey === key}
                      onStartEdit={() => setEditingKey(key)}
                      onCommit={(v) => {
                        stop()
                        const next = v.trim()
                        if (!next) edits.removeStep(di, si)
                        else if (next !== s.text) edits.editStep(di, si, next)
                      }}
                      onCancel={stop}
                      fontSize={12.5}
                      weight={400}
                      color={PAPER_DIM}
                      maxWidth={210}
                      alignRight={s.textLeft}
                    />
                    <button type="button" className="mc-del" onClick={(e) => { e.stopPropagation(); edits.removeStep(di, si) }} aria-label={`删除步骤：${s.text}`}>删除</button>
                  </div>
                </div>
              )
            })}

            <div className="mc-node" data-r={d.tendrilR[1] + 1} data-x={d.addAt.x} data-y={d.addAt.y} data-on="0" data-quiet="1" style={{ transform: place(d.addAt) }}>
              <button type="button" className="mc-add" onClick={(e) => { e.stopPropagation(); edits.addStep(di) }} aria-label={`给「${d.title}」加一步`} title="加一步">＋</button>
            </div>
          </div>
        )
      })}

      <style>{`
        .mc-vines { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
        .mc-node { position: absolute; left: 0; top: 0; width: 0; height: 0; opacity: 0; transition: opacity 0.5s ease; }
        .mc-node[data-on="1"] { opacity: 1; }
        .mc-ring { position: absolute; left: -5px; top: -5px; width: 10px; height: 10px; border-radius: 50%; border: 1px solid ${PAPER}; background: #050505; }
        .mc-dot { position: absolute; left: -2px; top: -2px; width: 4px; height: 4px; border-radius: 50%; background: ${PAPER_DIM}; }
        .mc-label-box { position: absolute; top: -12px; left: 12px; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
        .mc-label-box.mc-left { left: auto; right: 12px; flex-direction: row-reverse; }
        .mc-label-box.mc-above { left: 0; top: -36px; transform: translateX(-50%); }
        .mc-text, .mc-edit {
          font-family: ${SANS}; line-height: 24px; height: 24px; padding: 0 2px;
          background: rgba(5,5,5,0.78); border: none; border-radius: 2px; cursor: text;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .mc-node .mc-text { letter-spacing: 0.42em; filter: blur(3px); transition: letter-spacing 0.9s cubic-bezier(.2,.7,.1,1), filter 0.9s ease; }
        .mc-node[data-on="1"] .mc-text { letter-spacing: 0.02em; filter: blur(0); }
        .mc-text:hover { text-decoration: underline; text-decoration-color: rgba(232,220,203,0.35); text-underline-offset: 4px; }
        .mc-text:focus-visible, .mc-add:focus-visible, .mc-del:focus-visible { outline: 1px solid ${PAPER}; outline-offset: 2px; }
        .mc-edit { background: rgba(5,5,5,0.92); border-bottom: 1px solid ${PAPER}; outline: none; }
        .mc-del {
          opacity: 0; font-family: ${SANS}; font-size: 11px; color: #8E847A; background: transparent;
          border: none; cursor: pointer; padding: 0 2px; transition: opacity 0.15s;
        }
        .mc-label-box:hover .mc-del, .mc-del:focus-visible { opacity: 1; }
        .mc-del:hover { color: #E0A07A; }
        .mc-add {
          position: absolute; left: -10px; top: -10px; width: 20px; height: 20px; border-radius: 50%;
          border: 1px dashed rgba(232,220,203,0.35); background: #050505; color: rgba(232,220,203,0.55);
          font-size: 12px; line-height: 18px; cursor: pointer; padding: 0; opacity: 0.35; transition: opacity 0.2s;
        }
        .mc-add:hover, .mc-add:focus-visible { opacity: 1; border-style: solid; color: ${PAPER}; }
      `}</style>
    </>
  )
}
