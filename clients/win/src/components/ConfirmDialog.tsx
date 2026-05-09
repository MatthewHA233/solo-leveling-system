// ══════════════════════════════════════════════
// ConfirmDialog — HUD 风格通用确认弹框
// 标题（彩色发光）+ 多段说明 + 取消 / 确认两按钮
// ══════════════════════════════════════════════

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { theme } from '../theme'

interface Props {
  /** 渲染开关；false 时不挂载 */
  open: boolean
  /** 顶部彩色 HUD 标题（短标题、字母数字最佳） */
  title: string
  /** 主标题色（默认电蓝） */
  titleColor?: string
  /** 大字主问题（一句话） */
  question: string
  /** 多段补充说明，依次堆叠（每段 ReactNode 可以含 <strong>、span style 等） */
  details?: React.ReactNode[]
  /** 确认按钮文案 / 颜色（默认"确认"+ 电蓝） */
  confirmLabel?: string
  confirmColor?: string
  /** 取消按钮文案（默认"取消"） */
  cancelLabel?: string
  /** 是否标记为"危险" — 确认按钮用红色调 */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open, title, titleColor, question, details = [],
  confirmLabel = '确认', confirmColor,
  cancelLabel = '取消',
  danger = false,
  onConfirm, onCancel,
}: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      else if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onConfirm, onCancel])

  if (!open) return null

  const titleC = titleColor ?? theme.electricBlue
  const confirmC = confirmColor ?? (danger ? theme.dangerRed : theme.electricBlue)

  return createPortal(
    <>
      <style>{`
        @keyframes confirm-overlay-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes confirm-pop {
          from { opacity: 0; transform: translate(-50%, -50%) scale(0.96); }
          to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        .confirm-btn {
          flex: 1;
          padding: 9px 14px;
          background: transparent;
          border: 1px solid var(--btn-color);
          color: var(--btn-color);
          font-family: ${theme.fontMono};
          font-size: 12px;
          letter-spacing: 0.08em;
          cursor: pointer;
          transition: background 0.14s, box-shadow 0.14s;
          clip-path: polygon(4px 0, calc(100% - 4px) 0, 100% 4px, 100% calc(100% - 4px), calc(100% - 4px) 100%, 4px 100%, 0 calc(100% - 4px), 0 4px);
          -webkit-clip-path: polygon(4px 0, calc(100% - 4px) 0, 100% 4px, 100% calc(100% - 4px), calc(100% - 4px) 100%, 4px 100%, 0 calc(100% - 4px), 0 4px);
        }
        .confirm-btn:hover {
          background: color-mix(in srgb, var(--btn-color) 14%, transparent);
          box-shadow: 0 0 12px color-mix(in srgb, var(--btn-color) 40%, transparent);
        }
      `}</style>

      <div
        onClick={onCancel}
        style={{
          position: 'fixed', inset: 0, zIndex: 99990,
          background: 'rgba(2, 6, 16, 0.78)',
          animation: 'confirm-overlay-in 0.15s ease-out',
        }}
      />

      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed', left: '50%', top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(440px, 90vw)',
          zIndex: 99991,
          background: theme.hudFill,
          border: `1px solid ${theme.hudFrame}`,
          boxShadow: `0 18px 60px rgba(0,0,0,0.7), 0 0 40px ${theme.hudHalo}, inset 0 1px 0 rgba(255,255,255,0.04)`,
          clipPath: 'polygon(10px 0, calc(100% - 10px) 0, 100% 10px, 100% calc(100% - 10px), calc(100% - 10px) 100%, 10px 100%, 0 calc(100% - 10px), 0 10px)',
          WebkitClipPath: 'polygon(10px 0, calc(100% - 10px) 0, 100% 10px, 100% calc(100% - 10px), calc(100% - 10px) 100%, 10px 100%, 0 calc(100% - 10px), 0 10px)',
          padding: '22px 24px 20px',
          fontFamily: theme.fontBody,
          animation: 'confirm-pop 0.18s ease-out',
        }}
      >
        {/* HUD 标题 */}
        <div style={{
          fontFamily: theme.fontDisplay,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 2,
          color: titleC,
          textShadow: `0 0 8px ${titleC}AA`,
          marginBottom: 12,
          textTransform: 'uppercase',
        }}>
          ▸ {title}
        </div>

        {/* 主问题 */}
        <div style={{
          fontSize: 14,
          fontWeight: 600,
          color: theme.textPrimary,
          marginBottom: details.length > 0 ? 12 : 18,
          lineHeight: 1.5,
        }}>
          {question}
        </div>

        {/* 详细说明（多段，缩进，弱色） */}
        {details.length > 0 && (
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 8,
            marginBottom: 18,
            padding: '10px 12px',
            background: 'rgba(0,12,28,0.5)',
            border: `1px solid ${theme.hudFrameSoft}`,
            fontSize: 12,
            color: theme.textSecondary,
            lineHeight: 1.6,
          }}>
            {details.map((d, i) => (
              <div key={i}>{d}</div>
            ))}
          </div>
        )}

        {/* 按钮 */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onCancel}
            className="confirm-btn"
            style={{ ['--btn-color' as string]: theme.textSecondary } as React.CSSProperties}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="confirm-btn"
            style={{ ['--btn-color' as string]: confirmC } as React.CSSProperties}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}
