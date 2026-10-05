// 面板标题：粗斜体钛白字（替换掉原来手绘 HUD 框顶上那行英文 label）

import { tiTitle } from '../../theme'

export default function PanelTitle({ children, right }: {
  children: React.ReactNode
  /** 标题行右侧（计数、按钮等） */
  right?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px 8px', flexShrink: 0 }}>
      <span className="ti-diamond" aria-hidden />
      <span style={{ ...tiTitle, fontSize: 13.5 }}>{children}</span>
      {right && <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>{right}</span>}
    </div>
  )
}
