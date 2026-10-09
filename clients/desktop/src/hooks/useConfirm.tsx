// 应用内确认框（替代 window.confirm / window.alert 那个 Windows 系统对话框——和钛合金界面完全不搭，还会卡住整个页面）。
//   const [confirm, confirmDialog, notify] = useConfirm()
//   if (!(await confirm({ title: '删除标签', question: '确定删除？', danger: true }))) return
//   notify('删除失败', String(e))        // 只有一个「知道了」键
//   ...渲染里放 {confirmDialog}

import { useCallback, useRef, useState, type ReactNode } from 'react'
import ConfirmDialog from '../components/ConfirmDialog'

export interface ConfirmOptions {
  readonly title: string
  readonly question: string
  readonly details?: ReactNode[]
  readonly confirmLabel?: string
  readonly danger?: boolean
  /** 只留一个键（notify 用） */
  readonly single?: boolean
}

export function useConfirm(): [
  (opts: ConfirmOptions) => Promise<boolean>,
  ReactNode,
  (title: string, message: string) => void,
] {
  const [pending, setPending] = useState<ConfirmOptions | null>(null)
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
    // 上一个还没答就又来一个：旧的按取消处理
    resolveRef.current?.(false)
    resolveRef.current = resolve
    setPending(opts)
  }), [])

  /** 报错 / 通知：一个「知道了」键，不用等结果 */
  const notify = useCallback((title: string, message: string) => {
    void confirm({ title, question: message, confirmLabel: '知道了', danger: true, single: true })
  }, [confirm])

  const settle = (ok: boolean) => {
    resolveRef.current?.(ok)
    resolveRef.current = null
    setPending(null)
  }

  const dialog = (
    <ConfirmDialog
      open={pending != null}
      title={pending?.title ?? ''}
      question={pending?.question ?? ''}
      details={pending?.details}
      confirmLabel={pending?.confirmLabel}
      danger={pending?.danger}
      hideCancel={pending?.single}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  )
  return [confirm, dialog, notify]
}
