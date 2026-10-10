// ══════════════════════════════════════════════
// 顶栏当标题栏用：整条顶栏任何地方按住都能拖动窗口
//
// Tauri 自带的 data-tauri-drag-region 只认"按下的正好是这个元素本身"，顶栏里装满了
// 按键、读数、文字，能按到空白的地方没几处。这里改成挂在顶栏上统一处理：
//   · 空白 / 文字 / 读数：和系统标题栏一样，按下即拖，双击最大化 / 还原
//   · 按键（含视图键位）：按住挪动超过几像素才拖窗口，没挪就照常是一次点击
//   · 输入框、可拖拽的元素：它们自己的手势优先，不拖窗口
// ══════════════════════════════════════════════

import type { MouseEvent as ReactMouseEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

/** 按在按键上时，挪过这么远才算拖窗口 */
const DRAG_THRESHOLD_PX = 4

/** 按下去有自己的手势：打字、HTML5 拖拽 */
const OWN_GESTURE = 'input, textarea, select, [contenteditable="true"], [draggable="true"]'

/** 按下去是"点一下"的东西 */
const PRESSABLE = 'button, a[href], [role="button"], [role="tab"], label'

function reportFailure(e: unknown): void {
  console.error('[window-drag] 窗口拖动 / 最大化失败', e)
}

export function handleTitleBarMouseDown(e: ReactMouseEvent<HTMLElement>): void {
  if (e.button !== 0 || !(e.target instanceof Element)) return
  const target = e.target
  // React 事件会顺着组件树从 portal 冒上来：顶栏里挂着的日期弹层、同步弹窗等，按在它们上面不算按在顶栏上
  if (!e.currentTarget.contains(target)) return
  if (target.closest(OWN_GESTURE)) return

  const win = getCurrentWindow()

  if (!target.closest(PRESSABLE)) {
    // 不 preventDefault 的话按住拖会选中文字 / 抢走输入框焦点
    e.preventDefault()
    if (e.detail === 2) win.toggleMaximize().catch(reportFailure)
    else if (e.detail === 1) win.startDragging().catch(reportFailure)
    return
  }

  const x0 = e.clientX
  const y0 = e.clientY
  const stop = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', stop)
  }
  const onMove = (ev: MouseEvent) => {
    if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < DRAG_THRESHOLD_PX) return
    stop()
    // 系统接管拖动后这次松开不会再回到页面，按键也就不会收到 click
    win.startDragging().catch(reportFailure)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', stop)
}
