// ══════════════════════════════════════════════
// ConfirmDialog — HUD 风格通用确认弹框
// 标题（彩色发光）+ 多段说明 + 取消 / 确认两按钮
// ══════════════════════════════════════════════

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { theme, tiSurface, tiTitle } from '../theme'

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

  const titleC = titleColor ?? (danger ? theme.dangerRed : theme.textPrimary)
  // 危险操作 = 红字实体键；其余确认 = 橙色主键；自定义色照用
  const confirmC = confirmColor ?? (danger ? theme.dangerRed : null)

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
          height: 34px;
          font-family: ${theme.fontBody};
          font-size: 13px;
          letter-spacing: 0.06em;
        }
      `}</style>

      <div
        onClick={onCancel}
        style={{
          position: 'fixed', inset: 0, zIndex: 99990,
          background: 'rgba(12,11,9,0.78)',
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
          background: tiSurface.plate,
          border: 'none',
          boxShadow: tiSurface.plateShadow,
          borderRadius: 8,
          padding: '22px 24px 20px',
          fontFamily: theme.fontBody,
          animation: 'confirm-pop 0.18s ease-out',
        }}
      >
        {/* 标题：菱形 + 粗斜体 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span className="ti-diamond" aria-hidden />
          <span style={{ ...tiTitle, fontSize: 14, color: titleC }}>{title}</span>
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
            background: tiSurface.well,
            boxShadow: tiSurface.wellShadow,
            borderRadius: 5,
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
            type="button"
            onClick={onCancel}
            className="confirm-btn ti-key"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={confirmC ? 'confirm-btn ti-key' : 'confirm-btn ti-key ti-key-primary'}
            style={confirmC ? { color: confirmC } : undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}
