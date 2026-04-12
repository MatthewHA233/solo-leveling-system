// ══════════════════════════════════════════════
// usePresenceDetection — React hook，管理摄像头 + 人脸检测生命周期
// 仅在 isPeriod=true 的 15s 窗口事件时写 DB：
//   - 同状态 → upsert 同 ID（延长 end_time）
//   - 状态变化 → 创建新 span
// ══════════════════════════════════════════════

import { useEffect, useRef, useState, useCallback } from 'react'
import { PresenceDetector } from '../lib/presence/presence-detector'
import type { PresenceState, FaceBox, PresenceCallback } from '../lib/presence/presence-detector'
import { upsertPresenceSpan } from '../lib/local-api'

export interface PresenceInfo {
  readonly state: PresenceState
  readonly durationSeconds: number
  readonly ready: boolean
  readonly error: string | null
  readonly faces: readonly FaceBox[]
}

export function usePresenceDetection(enabled: boolean): {
  presence: PresenceInfo
  videoRef: React.RefObject<HTMLVideoElement>
} {
  const videoRef = useRef<HTMLVideoElement>(null!)
  const detectorRef = useRef<PresenceDetector | null>(null)

  // 当前活跃 span 的 id 和 start_time（用于 upsert 延长）
  const activeSpanIdRef    = useRef<string | null>(null)
  const activeSpanStartRef = useRef<string | null>(null)
  const activeSpanStateRef = useRef<PresenceState>('unknown')

  const [presence, setPresence] = useState<PresenceInfo>({
    state: 'unknown',
    durationSeconds: 0,
    ready: false,
    error: null,
    faces: [],
  })

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startTick = useCallback(() => {
    if (tickRef.current) return
    tickRef.current = setInterval(() => {
      const d = detectorRef.current
      if (!d) return
      setPresence(prev => ({ ...prev, durationSeconds: d.currentDurationSeconds }))
    }, 1000)
  }, [])

  const stopTick = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
  }, [])

  useEffect(() => {
    if (!enabled) {
      detectorRef.current?.stop()
      detectorRef.current = null
      stopTick()
      setPresence({ state: 'unknown', durationSeconds: 0, ready: false, error: null, faces: [] })
      return
    }

    let cancelled = false
    const nowStr = () => {
      const d = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    const makeCallback = (): PresenceCallback => (event) => {
      if (cancelled) return

      // 实时帧：只更新人脸框，不写 DB
      if (!event.isPeriod) {
        setPresence(prev => ({ ...prev, faces: event.faces }))
        return
      }

      // 15s 周期事件 → 更新状态 + 写 DB
      const newState = event.state
      const now = nowStr()
      if (newState === activeSpanStateRef.current && activeSpanIdRef.current) {
        // 同状态：延长当前 span 的 end_time
        upsertPresenceSpan({
          id: activeSpanIdRef.current,
          start_time: activeSpanStartRef.current!,
          end_time: now,
          state: newState,
        }).catch(() => {})
      } else {
        // 状态变化：先关闭旧 span（写入真实 end_time），再新建
        if (activeSpanIdRef.current) {
          upsertPresenceSpan({
            id: activeSpanIdRef.current,
            start_time: activeSpanStartRef.current!,
            end_time: now,
            state: activeSpanStateRef.current,
          }).catch(() => {})
        }
        const id = crypto.randomUUID()
        activeSpanIdRef.current    = id
        activeSpanStartRef.current = now
        activeSpanStateRef.current = newState
        upsertPresenceSpan({
          id,
          start_time: now,
          end_time: now,
          state: newState,
        }).catch(() => {})
      }

      setPresence(prev => ({
        ...prev,
        state: newState,
        durationSeconds: event.durationSeconds,
        faces: event.faces,
      }))
    }

    // 带重试的启动：camera/WASM 初始化偶发失败，最多重试 3 次
    const run = async (attempt = 0) => {
      if (cancelled) return

      // 上一次的 detector 先停掉再重建
      detectorRef.current?.stop()
      const detector = new PresenceDetector(makeCallback())
      detectorRef.current = detector

      try {
        await detector.start(videoRef.current)
        if (!cancelled) {
          setPresence(prev => ({ ...prev, ready: true, error: null }))
          startTick()
        }
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        if (attempt < 3) {
          // 等 2s 后重试，期间显示 error 但不放弃
          setPresence(prev => ({ ...prev, error: `初始化失败，重试中 (${attempt + 1}/3)…`, ready: false }))
          setTimeout(() => run(attempt + 1), 2000)
        } else {
          setPresence(prev => ({ ...prev, error: msg, ready: false }))
        }
      }
    }

    run()

    return () => {
      cancelled = true
      detectorRef.current?.stop()
      detectorRef.current = null
      stopTick()
      activeSpanIdRef.current    = null
      activeSpanStartRef.current = null
      activeSpanStateRef.current = 'unknown'
    }
  }, [enabled, startTick, stopTick])

  return { presence, videoRef }
}
