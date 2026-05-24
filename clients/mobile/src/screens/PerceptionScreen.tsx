// ══════════════════════════════════════════════
// 感知层 - 设置、权限引导、采集状态
// Android-only；iOS 显示占位
// ══════════════════════════════════════════════

import { useEffect, useState } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { theme } from '../theme'
import {
  getSoloDbDeviceId,
  getSoloDbStats,
  isSoloDbAvailable,
  type SoloDbStats,
} from '../lib/solodb'
import {
  collectUsageStats,
  fetchDbStats,
  getLatestUsageSummary,
  getClickCounts,
  getRecentWindowEvents,
  hasUsageAccess,
  insertDbProbe,
  isAccessibilityEnabled,
  isPerceptionAvailable,
  openAccessibilitySettings,
  openUsageAccessSettings,
  pingPerception,
  resetClickCounts,
  type ClickCountSnapshot,
  type CollectUsageResult,
  type DbStats,
  type UsageSummary,
  type WindowEvent,
} from '../lib/perception'

export default function PerceptionScreen() {
  const [pingResult, setPingResult] = useState<string>('未测试')
  const [pinging, setPinging] = useState(false)

  const [dbStats, setDbStats] = useState<DbStats | null>(null)
  const [dbError, setDbError] = useState<string | null>(null)
  const [dbLoading, setDbLoading] = useState(false)
  const [lastProbe, setLastProbe] = useState<string | null>(null)

  const [usageGranted, setUsageGranted] = useState<boolean | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [lastCollect, setLastCollect] = useState<CollectUsageResult | null>(null)
  const [collectError, setCollectError] = useState<string | null>(null)

  const [summary, setSummary] = useState<UsageSummary | null>(null)

  const [a11yEnabled, setA11yEnabled] = useState<boolean | null>(null)
  const [soloStats, setSoloStats] = useState<SoloDbStats | null>(null)
  const [soloDeviceId, setSoloDeviceId] = useState<string>('')
  const [windowEvents, setWindowEvents] = useState<WindowEvent[]>([])
  const [clicks, setClicks] = useState<ClickCountSnapshot>({ total: 0, entries: [] })

  useEffect(() => {
    void runPing()
    void refreshDb()
    void refreshUsageAccess()
    void refreshSummary()
    void refreshA11y()
    void refreshWindowEvents()
    void refreshClicks()
    void refreshSoloDb()
  }, [])

  async function refreshSoloDb() {
    try {
      const [id, s] = await Promise.all([getSoloDbDeviceId(), getSoloDbStats()])
      setSoloDeviceId(id ?? '')
      setSoloStats(s)
    } catch {
      setSoloStats(null)
    }
  }

  async function refreshClicks() {
    try {
      setClicks(await getClickCounts())
    } catch {
      setClicks({ total: 0, entries: [] })
    }
  }

  async function clearClicks() {
    await resetClickCounts()
    await refreshClicks()
  }

  async function refreshA11y() {
    try {
      setA11yEnabled(await isAccessibilityEnabled())
    } catch {
      setA11yEnabled(false)
    }
  }

  async function openA11ySettings() {
    await openAccessibilitySettings()
  }

  async function refreshWindowEvents() {
    try {
      setWindowEvents(await getRecentWindowEvents(20))
    } catch {
      setWindowEvents([])
    }
  }

  async function refreshSummary() {
    try {
      setSummary(await getLatestUsageSummary())
    } catch {
      setSummary(null)
    }
  }

  async function refreshUsageAccess() {
    try {
      setUsageGranted(await hasUsageAccess())
    } catch {
      setUsageGranted(false)
    }
  }

  async function runCollect() {
    setCollecting(true)
    setCollectError(null)
    try {
      const r = await collectUsageStats()
      setLastCollect(r)
      await refreshDb()
      await refreshSummary()
    } catch (e: any) {
      setCollectError(e?.message ?? String(e))
    } finally {
      setCollecting(false)
    }
  }

  async function openSettings() {
    await openUsageAccessSettings()
  }

  async function runPing() {
    setPinging(true)
    try {
      const r = await pingPerception()
      if (r == null) {
        setPingResult('native 模块未加载（iOS 或未重装 APK）')
      } else {
        setPingResult(`ok=${r.ok}  ts=${new Date(r.ts).toLocaleTimeString()}  module=${r.module}`)
      }
    } catch (e: any) {
      setPingResult(`错误: ${e?.message ?? String(e)}`)
    } finally {
      setPinging(false)
    }
  }

  async function refreshDb() {
    setDbLoading(true)
    setDbError(null)
    try {
      const s = await fetchDbStats()
      setDbStats(s)
    } catch (e: any) {
      setDbError(e?.message ?? String(e))
    } finally {
      setDbLoading(false)
    }
  }

  async function probe() {
    setDbError(null)
    try {
      const r = await insertDbProbe()
      if (r) setLastProbe(`#${r.rowId} @ ${r.at}`)
      await refreshDb()
    } catch (e: any) {
      setDbError(e?.message ?? String(e))
    }
  }

  if (Platform.OS !== 'android') {
    return (
      <View style={styles.placeholder}>
        <Text style={styles.placeholderTitle}>感知功能 Android-only</Text>
        <Text style={styles.placeholderSub}>iOS 系统沙箱限制，暂不支持</Text>
      </View>
    )
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>感知层</Text>
      <Text style={styles.h2}>Phase 1：原生桥接 + SQLite</Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Native module 状态</Text>
        <Text style={styles.cardValue}>
          Perception: {isPerceptionAvailable() ? '已加载' : '未加载'}
          {'  ·  '}
          SoloDb: {isSoloDbAvailable() ? '已加载' : '未加载'}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>SoloDb (solo.db) · Phase 5 LAN 同步底座</Text>
        {soloStats ? (
          <>
            <Text style={styles.cardValue}>
              {Object.entries(soloStats.tables)
                .map(([k, v]) => `${k.replace('activity_', 'a_').replace('planned_', 'p_').replace('plan_nodes', 'p_nodes').replace('linked_devices', 'links').replace('sync_meta', 'meta')}=${v}`)
                .join(' · ')}
            </Text>
            <Text style={styles.cardSub} numberOfLines={1}>device_id: {soloDeviceId || '—'}</Text>
            <Text style={styles.cardSub} numberOfLines={1}>{soloStats.path}</Text>
          </>
        ) : (
          <Text style={styles.cardValue}>未连通</Text>
        )}
        <Pressable style={[styles.btn, styles.btnGhost, { marginTop: 10 }]} onPress={refreshSoloDb}>
          <Text style={[styles.btnText, styles.btnGhostText]}>刷新</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Ping 结果</Text>
        <Text style={styles.cardValue}>{pingResult}</Text>
        <Pressable style={styles.btn} onPress={runPing} disabled={pinging}>
          <Text style={styles.btnText}>{pinging ? '调用中…' : '再次 Ping'}</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>SQLite (perception.db)</Text>
        {dbLoading ? (
          <Text style={styles.cardValue}>加载中…</Text>
        ) : dbError ? (
          <Text style={[styles.cardValue, { color: '#C0392B' }]}>{dbError}</Text>
        ) : dbStats ? (
          <>
            <Text style={styles.cardValue}>
              buckets={dbStats.bucketCount}  events={dbStats.eventCount}
            </Text>
            <Text style={styles.cardSub}>{dbStats.path}</Text>
          </>
        ) : (
          <Text style={styles.cardValue}>—</Text>
        )}
        {lastProbe && <Text style={styles.cardSub}>最近写入：{lastProbe}</Text>}
        <View style={styles.btnRow}>
          <Pressable style={styles.btn} onPress={probe}>
            <Text style={styles.btnText}>写入 probe 事件</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={refreshDb}>
            <Text style={[styles.btnText, styles.btnGhostText]}>刷新</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>使用情况访问 (PACKAGE_USAGE_STATS)</Text>
        <Text style={styles.cardValue}>
          {usageGranted == null ? '检测中…' : usageGranted ? '已授权' : '未授权'}
        </Text>
        <View style={styles.btnRow}>
          <Pressable style={styles.btn} onPress={openSettings}>
            <Text style={styles.btnText}>打开系统设置</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={refreshUsageAccess}>
            <Text style={[styles.btnText, styles.btnGhostText]}>重检</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>采集最近 24h 使用统计</Text>
        {collecting ? (
          <Text style={styles.cardValue}>采集中…</Text>
        ) : lastCollect ? (
          <>
            <Text style={styles.cardValue}>
              event #{lastCollect.rowId}  app_count={lastCollect.appCount}
            </Text>
            <Text style={styles.cardSub}>
              前台总计 {Math.round(lastCollect.totalForegroundMs / 1000)} 秒 @ {lastCollect.intervalEnd}
            </Text>
          </>
        ) : (
          <Text style={styles.cardValue}>未采集</Text>
        )}
        {collectError && (
          <Text style={[styles.cardSub, { color: '#C0392B' }]}>{collectError}</Text>
        )}
        <Pressable style={styles.btn} onPress={runCollect} disabled={collecting}>
          <Text style={styles.btnText}>{collecting ? '采集中…' : '采集一次'}</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>AccessibilityService (前台窗口监听)</Text>
        <Text style={styles.cardValue}>
          {a11yEnabled == null ? '检测中…' : a11yEnabled ? '已启用' : '未启用'}
        </Text>
        <Text style={styles.cardSub}>
          手动启用路径：系统设置 → 辅助功能 → 已下载的应用 → Solo Leveling · 活动感知
        </Text>
        <View style={styles.btnRow}>
          <Pressable style={styles.btn} onPress={openA11ySettings}>
            <Text style={styles.btnText}>打开辅助功能设置</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={refreshA11y}>
            <Text style={[styles.btnText, styles.btnGhostText]}>重检</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>
          最近窗口切换 · {windowEvents.length} 条 (最多 20)
        </Text>
        {windowEvents.length === 0 ? (
          <Text style={styles.cardValue}>未捕获 — 切换 app 或打开其他应用试试</Text>
        ) : (
          windowEvents.slice(0, 20).map((ev) => (
            <View key={ev.rowId} style={styles.appRow}>
              <View style={styles.appLeft}>
                <Text style={styles.appLabel} numberOfLines={1}>
                  {ev.appLabel || ev.packageName}
                  {ev.windowTitle ? `  ·  ${ev.windowTitle}` : ''}
                </Text>
                <Text style={styles.appPkg} numberOfLines={1}>
                  {ev.packageName} / {ev.className}
                </Text>
              </View>
              <Text style={styles.appPkg}>{fmtClock(ev.eventTimeMs)}</Text>
            </View>
          ))
        )}
        <Pressable
          style={[styles.btn, styles.btnGhost, { marginTop: 10 }]}
          onPress={refreshWindowEvents}
        >
          <Text style={[styles.btnText, styles.btnGhostText]}>刷新</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>点击计数 · 进程内累计</Text>
        <Text style={styles.cardValue}>
          总计 {clicks.total} 次 · 涉及 {clicks.entries.length} 个 app
        </Text>
        <Text style={styles.cardSub}>
          Service 进程重启清零。仅内存，不写 DB。
        </Text>
        {clicks.entries.slice(0, 10).map((c) => (
          <View key={c.packageName} style={styles.appRow}>
            <View style={styles.appLeft}>
              <Text style={styles.appLabel} numberOfLines={1}>
                {c.appLabel || c.packageName}
              </Text>
              <Text style={styles.appPkg} numberOfLines={1}>
                {c.packageName}
              </Text>
            </View>
            <Text style={styles.appDur}>{c.count}</Text>
          </View>
        ))}
        <View style={styles.btnRow}>
          <Pressable style={styles.btn} onPress={refreshClicks}>
            <Text style={styles.btnText}>刷新</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={clearClicks}>
            <Text style={[styles.btnText, styles.btnGhostText]}>清零</Text>
          </Pressable>
        </View>
      </View>

      {summary && summary.apps.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>
            Top Apps · 最新采集 #{summary.rowId} @ {fmtClock(summary.intervalEndMs)}
          </Text>
          {summary.apps.slice(0, 10).map((app) => (
            <View key={app.packageName} style={styles.appRow}>
              <View style={styles.appLeft}>
                <Text style={styles.appLabel} numberOfLines={1}>
                  {app.appLabel || app.packageName}
                </Text>
                <Text style={styles.appPkg} numberOfLines={1}>
                  {app.packageName}
                </Text>
              </View>
              <View style={styles.appRight}>
                <Text style={styles.appDur}>{fmtDuration(app.totalTimeMs)}</Text>
                <Text style={styles.appPkg}>最近 {fmtClock(app.lastTimeUsed)}</Text>
              </View>
            </View>
          ))}
          {summary.apps.length > 10 && (
            <Text style={styles.cardSub}>… 还有 {summary.apps.length - 10} 个</Text>
          )}
        </View>
      )}

      <Text style={styles.note}>
        Phase 1 块 4：从 perception_events_android 读最新一条 app.usage_summary，
        UI 渲染 Top Apps + 时长 + 最近使用时刻。
      </Text>
    </ScrollView>
  )
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}秒`
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 60) return `${totalMin}分`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h}小时` : `${h}小时${m}分`
}

function fmtClock(ms: number): string {
  if (!ms || ms <= 0) return '—'
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, paddingBottom: 40 },
  h1: {
    fontSize: 22,
    fontWeight: '700',
    color: theme.ink,
    marginBottom: 4,
  },
  h2: {
    fontSize: 13,
    color: theme.inkSoft,
    marginBottom: 18,
  },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: theme.line,
  },
  cardLabel: {
    fontSize: 12,
    color: theme.inkSoft,
    marginBottom: 6,
  },
  cardValue: {
    fontSize: 14,
    color: theme.ink,
    fontWeight: '500',
  },
  cardSub: {
    fontSize: 11,
    color: theme.inkSoft,
    marginTop: 4,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  btn: {
    alignSelf: 'flex-start',
    backgroundColor: theme.accent,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  btnGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: theme.line,
  },
  btnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  btnGhostText: {
    color: theme.ink,
  },
  note: {
    fontSize: 12,
    color: theme.inkSoft,
    lineHeight: 18,
    marginTop: 8,
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: theme.bg,
  },
  placeholderTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: theme.ink,
    marginBottom: 6,
  },
  placeholderSub: {
    fontSize: 13,
    color: theme.inkSoft,
  },
  appRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: theme.line,
  },
  appLeft: {
    flex: 1,
    paddingRight: 8,
  },
  appLabel: {
    fontSize: 14,
    color: theme.ink,
    fontWeight: '600',
  },
  appPkg: {
    fontSize: 11,
    color: theme.inkSoft,
    marginTop: 2,
  },
  appRight: {
    alignItems: 'flex-end',
  },
  appDur: {
    fontSize: 14,
    color: theme.ink,
    fontWeight: '600',
  },
})
