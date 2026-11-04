// 今日动机云的数据：今天立约了哪些动机（理想）+ 感知把今天的时间归到了哪些动机（真实）
//   感知一有变化（system:sense）就稍后重拉；另外每分钟兜底拉一次（补判会慢慢把早些时候的窗口填上）
//   立约是本地先行（界面立刻亮环），失败再拉回来

import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { toLocalDateStr } from '../../lib/local-api'
import { declareMotive, fetchToday, SENSE_EVENT, type TodayView } from '../../lib/system-api'

const REFRESH_MS = 60_000
const SENSE_DEBOUNCE_MS = 5_000

export function useToday() {
  const [today, setToday] = useState<TodayView | null>(null)
  const debounce = useRef<number | undefined>(undefined)

  const pull = useCallback(async () => {
    try {
      const view = await fetchToday(toLocalDateStr(new Date()))
      setToday(view)
    } catch {
      /* 后端没起来：下一轮再拉 */
    }
  }, [])

  // 首次拉取：在 then 回调里更新（effect 里直接调会改状态的函数，React 的规则不让）
  useEffect(() => {
    let alive = true
    fetchToday(toLocalDateStr(new Date()))
      .then((view) => { if (alive) setToday(view) })
      .catch(() => { /* 后端没起来：等定时 / 感知广播再拉 */ })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => { void pull() }, REFRESH_MS)
    let alive = true
    let unlisten: (() => void) | undefined
    listen(SENSE_EVENT, () => {
      window.clearTimeout(debounce.current)
      debounce.current = window.setTimeout(() => { void pull() }, SENSE_DEBOUNCE_MS)
    })
      .then((u) => { if (alive) unlisten = u; else u() })
      .catch(() => { /* 不在 Tauri 里：只靠定时拉 */ })
    return () => {
      alive = false
      unlisten?.()
      window.clearInterval(timer)
      window.clearTimeout(debounce.current)
    }
  }, [pull])

  const toggleDeclared = useCallback(async (anchorId: string) => {
    const date = toLocalDateStr(new Date())
    const was = today?.declared.includes(anchorId) ?? false
    setToday((t) => t && { ...t, declared: was ? t.declared.filter((id) => id !== anchorId) : [...t.declared, anchorId] })
    try {
      const declared = await declareMotive(date, anchorId, !was)
      setToday((t) => t && { ...t, declared })
    } catch {
      void pull()
    }
  }, [today, pull])

  return { today, toggleDeclared }
}
