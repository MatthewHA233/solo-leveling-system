// 「距离某个时刻还剩几秒」：只在 active 时每秒走一次。
// 倒计时类数字别放进 App 的状态里每秒 set——那会让整棵树每秒重渲染（2026-10-06 查出的空闲 CPU 大户）；
// 外面只存「下次的时刻」（一分钟才变一次），要显示的地方自己用这个钩子算剩余秒数。

import { useEffect, useState } from 'react'

export function useSecondsUntil(target: number | null | undefined, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || target == null) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, target])
  if (target == null) return null
  return Math.max(0, Math.ceil((target - now) / 1000))
}
