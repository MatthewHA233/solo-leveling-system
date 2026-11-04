// 今日动机云的数据：云里的动机（sense_motives）+ 今天的立约 / 推进时长（use-today）+ 系统此刻觉得你在推进哪一颗
//   每次感知广播都顺手重拉动机：你在系统窗口里答「是」收下的那颗，几秒内就飘进来

import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  addMotive, dropMotive, fetchMotives, fetchSense, mapSense, SENSE_EVENT,
  type SenseMotive, type SenseState,
} from '../../lib/system-api'
import { useToday } from '../motive-cloud/use-today'

const MOTIVES_DEBOUNCE_MS = 1_500

type RawSense = Parameters<typeof mapSense>[0]

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function useTodayCloud() {
  const { today, toggleDeclared } = useToday()
  const [motives, setMotives] = useState<readonly SenseMotive[]>([])
  const [loaded, setLoaded] = useState(false)
  const [sense, setSense] = useState<SenseState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const debounce = useRef<number | undefined>(undefined)

  const pullMotives = useCallback(() => {
    fetchMotives()
      .then((list) => { setMotives(list); setLoaded(true) })
      .catch((e: unknown) => setError(errorText(e)))
  }, [])

  useEffect(() => {
    let alive = true
    let unlisten: (() => void) | undefined
    fetchMotives()
      .then((list) => { if (alive) { setMotives(list); setLoaded(true) } })
      .catch((e: unknown) => { if (alive) setError(errorText(e)) })
    fetchSense()
      .then((s) => { if (alive) setSense(s) })
      .catch(() => { /* 后端还没起来：等广播 */ })
    listen<RawSense>(SENSE_EVENT, (e) => {
      setSense(mapSense(e.payload))
      window.clearTimeout(debounce.current)
      debounce.current = window.setTimeout(pullMotives, MOTIVES_DEBOUNCE_MS)
    })
      .then((u) => { if (alive) unlisten = u; else u() })
      .catch(() => { /* 不在 Tauri 里：只靠手动操作刷新 */ })
    return () => { alive = false; unlisten?.(); window.clearTimeout(debounce.current) }
  }, [pullMotives])

  const add = useCallback(async (text: string): Promise<boolean> => {
    try {
      const m = await addMotive(text)
      if (m) setMotives((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
      setError(null)
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    }
  }, [])

  const drop = useCallback(async (id: string) => {
    setMotives((prev) => prev.filter((m) => m.id !== id))
    try {
      await dropMotive(id)
    } catch (e) {
      setError(errorText(e))
      pullMotives()
    }
  }, [pullMotives])

  return { motives, loaded, today, sense, error, add, drop, toggleDeclared, clearError: () => setError(null) }
}
