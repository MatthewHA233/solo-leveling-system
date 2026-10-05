// ══════════════════════════════════════════════
// 实体图标键（钛合金机体的基础件）
//   亮键体 + 深色描边 + 上沿高光，图标接近纯白——一眼看得出能点
//   开着的开关 = 整块橙色 + 黑色图标；可以带一两个字的标签（顶栏功能键），不只靠图标猜
//   样式在 styles/titanium.css（.ti-key）
// ══════════════════════════════════════════════

import Tooltip from '../Tooltip'

export default function IconButton({ tip, onClick, active, dim, disabled, size = 30, label, children, buttonRef }: {
  tip: string
  onClick: () => void
  active?: boolean
  /** 功能暂不可用但仍可点（例如摄像头未就绪）：图标更淡 */
  dim?: boolean
  disabled?: boolean
  /** 键高（无标签时也是键宽） */
  size?: number
  /** 图标旁的短标签（例如「设置」） */
  label?: string
  children: React.ReactNode
  buttonRef?: React.Ref<HTMLButtonElement>
}) {
  return (
    <Tooltip content={tip}>
      <button
        ref={buttonRef}
        type="button"
        className="ti-key"
        data-active={active ? '1' : undefined}
        onClick={onClick}
        disabled={disabled}
        aria-label={tip}
        aria-pressed={active}
        style={{
          height: size,
          width: label ? undefined : size,
          padding: label ? '0 11px 0 9px' : 0,
          fontSize: 12.5,
          opacity: dim && !disabled ? 0.55 : undefined,
        }}
      >
        {children}
        {label && <span>{label}</span>}
      </button>
    </Tooltip>
  )
}
