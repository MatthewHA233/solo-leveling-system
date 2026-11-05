// ══════════════════════════════════════════════
// 录音的实时音量（对应 desktop ChatPanel useVoiceLevels；事件 voice://level 由 VoiceModule 发）
// 只在 active 时订阅
// ══════════════════════════════════════════════

import { useEffect, useState } from 'react'
import { DeviceEventEmitter } from 'react-native'
import { mapVoiceLevel } from './fairy-format'

export function useVoiceLevels(active: boolean, keep: number): number[] {
  const [levels, setLevels] = useState<number[]>(() => Array(keep).fill(0))
  useEffect(() => {
    if (!active) {
      setLevels(Array(keep).fill(0))
      return
    }
    const sub = DeviceEventEmitter.addListener('voice://level', (payload: { level?: number }) => {
      if (typeof payload?.level !== 'number') return
      const v = mapVoiceLevel(payload.level)
      setLevels((prev) => [...prev.slice(1), v])
    })
    return () => sub.remove()
  }, [active, keep])
  return levels
}
