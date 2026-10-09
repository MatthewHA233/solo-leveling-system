// 倒计时文字：只有这一小段每秒重渲染（外面只传「截止时刻」，一个周期才变一次）。
// 挂载即开始走、卸载即停——放在弹窗里，弹窗关着就完全不算。

import { useSecondsUntil } from '../../hooks/useSecondsUntil'

export default function CountdownText({ target }: { target: number | null | undefined }) {
  const seconds = useSecondsUntil(target, true)
  return <>{seconds ?? 0}</>
}
