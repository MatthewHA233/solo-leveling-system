// ══════════════════════════════════════════════
// 感知层 - 设置、权限引导、采集状态
// Android-only；iOS 显示占位
// ══════════════════════════════════════════════

import { useEffect, useState } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { theme } from '../theme'
import {
  fetchDbStats,
  insertDbProbe,
  isPerceptionAvailable,
  pingPerception,
  type DbStats,
} from '../lib/perception'

export default function PerceptionScreen() {
  const [pingResult, setPingResult] = useState<string>('未测试')
  const [pinging, setPinging] = useState(false)

  const [dbStats, setDbStats] = useState<DbStats | null>(null)
  const [dbError, setDbError] = useState<string | null>(null)
  const [dbLoading, setDbLoading] = useState(false)
  const [lastProbe, setLastProbe] = useState<string | null>(null)

  useEffect(() => {
    void runPing()
    void refreshDb()
  }, [])

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
          {isPerceptionAvailable() ? '已加载' : '未加载'}
        </Text>
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

      <Text style={styles.note}>
        Phase 1 块 3：AndroidManifest 加 PACKAGE_USAGE_STATS + UsageStatsCollector，
        把 app 使用时长写进 perception_events_android。
      </Text>
    </ScrollView>
  )
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
})
