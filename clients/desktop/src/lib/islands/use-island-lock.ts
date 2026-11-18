// ══════════════════════════════════════════════
// 昼夜表 · 浮岛 / 日程带的锁：盯着今天的落点，该锁的时候让后端开一局，做完 / 到点 / 不该锁了就结束
//   该锁 = 今天这一条已经开始（位置是确定的：锚已经记了，或钉在钟点）、里面的事还没全勾完、
//          并且还没到结束时刻（规则写了「做完才解开」的不看结束时刻）
//   位置只是估出来的不锁：那件事还没发生，不能凭猜测锁机
//   真正的拦截在后端（protocol.rs island_lock_sync → protocol_watch.rs），这里只负责告诉它此刻想要什么；
//   反复告诉同一件事后端不会重复开局
// ══════════════════════════════════════════════

import { useEffect, useRef } from 'react'
import type { ActivityPalette } from '../../types'
import { fetchActivityBlocks } from '../local-api'
import { syncIslandLock } from '../protocol-api'
import type { IslandLockWant } from '../protocol-api'
import { fetchIslandChecks, fetchIslands } from './island-api'
import { DAY_MINUTES, computePlacements } from './island-model'
import type { IslandPlacement, LockPlatform } from './island-model'
import { LOCK_PLATFORM } from './lock-platform'

const TICK_MS = 30_000

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 今天第 minute 分钟 → 后端的本地时间串（1440 = 明天 0 点） */
function timeOfToday(now: Date, minute: number): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, Math.min(DAY_MINUTES, minute), 0)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`
}

/** 这些落点里此刻该锁的那一条（好几条都该锁时取最晚开始的） */
export function pickLockWant(placements: readonly IslandPlacement[], now: Date, platform: LockPlatform): IslandLockWant | null {
  const nowMinute = now.getHours() * 60 + now.getMinutes()
  let want: IslandLockWant | null = null
  for (const p of placements) {
    const lock = p.island.rule.lock
    if (!lock || p.start == null || p.end == null) continue
    if (p.basis !== 'anchored' && p.basis !== 'fixed') continue
    if (p.status === 'done' || nowMinute < p.start) continue
    if (!lock.untilDone && nowMinute >= p.end) continue
    const apps = lock.apps.filter((e) => e.platform === platform).map((e) => ({ rule: e.rule, gray: e.gray }))
    if (apps.length === 0 && lock.sites.length === 0) continue
    want = {
      islandId: p.island.id,
      name: p.island.rule.name,
      rev: p.island.updatedAt,
      intent: lock.intent,
      apps,
      sites: lock.sites,
      endAt: lock.untilDone ? null : timeOfToday(now, p.end),
    }
  }
  return want
}

/** trigger 变了（浮岛规则、勾选、记录有变化）立刻对一次；平时每半分钟对一次 */
export function useIslandLock(palette: ActivityPalette, trigger: unknown): void {
  const paletteRef = useRef(palette)
  paletteRef.current = palette
  // 上一次有没有告诉后端「要锁」：没有带锁的规则、上次也没要过，就不打扰后端。
  // 启动后第一次一定对一遍：上次运行留下的锁可能已经不该锁了（规则被删、锁名单被清空）
  const wantedRef = useRef(true)
  const runningRef = useRef(false)

  useEffect(() => {
    let alive = true
    const run = async () => {
      if (runningRef.current) return
      runningRef.current = true
      try {
        const now = new Date()
        const lockable = (await fetchIslands()).filter((i) => i.rule.enabled && i.rule.lock)
        if (lockable.length === 0 && !wantedRef.current) return
        const [checks, blocks] = lockable.length > 0
          ? await Promise.all([fetchIslandChecks(now), fetchActivityBlocks(now)])
          : [new Map<string, Set<string>>(), []]
        if (!alive) return
        const placements = computePlacements({
          islands: lockable,
          palette: paletteRef.current,
          blocks,
          // 估出来的位置不锁，用不着历史
          historyByDate: new Map(),
          checks,
          dayOffset: 0,
          nowMinute: now.getHours() * 60 + now.getMinutes(),
        })
        const want = pickLockWant(placements, now, LOCK_PLATFORM)
        await syncIslandLock(want)
        wantedRef.current = want != null
      } catch (err) {
        console.warn('[IslandLock] 对齐浮岛的锁失败', err)
      } finally {
        runningRef.current = false
      }
    }
    void run()
    const timer = setInterval(() => { void run() }, TICK_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [trigger])
}
