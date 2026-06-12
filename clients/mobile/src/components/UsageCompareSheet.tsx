// ══════════════════════════════════════════════
// UsageCompareSheet — 应用监控 × 系统 UsageStats 对照
// a11y segments 当日汇总 vs 系统 queryEvents 精确统计，按 app 并排；
// 差异 >5min 且 >20% 标红 —— 用系统账本交叉校验感知断档/聚合 bug。
// ══════════════════════════════════════════════

import { useEffect, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { theme, alpha } from '../theme'
import {
  hasUsageAccess,
  openUsageAccessSettings,
  queryUsageByEvents,
  type ForegroundUsage,
} from '../lib/perception'

export interface A11yUsageRow {
  packageName: string
  appLabel: string
  totalMs: number
}

interface Props {
  readonly visible: boolean
  readonly onClose: () => void
  readonly startMs: number
  readonly endMs: number
  readonly a11yRows: A11yUsageRow[]
}

interface CompareRow {
  packageName: string
  appLabel: string
  a11yMs: number
  sysMs: number
  suspicious: boolean
}

function fmtMin(ms: number): string {
  if (ms <= 0) return '—'
  const min = ms / 60000
  if (min < 1) return '<1分'
  if (min < 60) return `${Math.round(min)}分`
  return `${Math.floor(min / 60)}时${Math.round(min % 60)}分`
}

function buildRows(a11y: A11yUsageRow[], sys: ForegroundUsage[]): CompareRow[] {
  const map = new Map<string, CompareRow>()
  for (const r of a11y) {
    map.set(r.packageName, {
      packageName: r.packageName,
      appLabel: r.appLabel || r.packageName,
      a11yMs: r.totalMs,
      sysMs: 0,
      suspicious: false,
    })
  }
  for (const u of sys) {
    const cur = map.get(u.packageName)
    if (cur) {
      cur.sysMs = u.totalMs
      if (!cur.appLabel || cur.appLabel === cur.packageName) cur.appLabel = u.appLabel
    } else {
      map.set(u.packageName, {
        packageName: u.packageName,
        appLabel: u.appLabel || u.packageName,
        a11yMs: 0,
        sysMs: u.totalMs,
        suspicious: false,
      })
    }
  }
  const rows = [...map.values()].filter((r) => Math.max(r.a11yMs, r.sysMs) >= 60_000)
  for (const r of rows) {
    const diff = Math.abs(r.a11yMs - r.sysMs)
    r.suspicious = diff > 5 * 60_000 && diff > Math.max(r.a11yMs, r.sysMs) * 0.2
  }
  rows.sort((a, b) => Math.max(b.a11yMs, b.sysMs) - Math.max(a.a11yMs, a.sysMs))
  return rows
}

export default function UsageCompareSheet({ visible, onClose, startMs, endMs, a11yRows }: Props) {
  const [loading, setLoading] = useState(false)
  const [granted, setGranted] = useState<boolean | null>(null)
  const [rows, setRows] = useState<CompareRow[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!visible) return
    let alive = true
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const ok = await hasUsageAccess()
        if (!alive) return
        setGranted(ok)
        if (!ok) return
        const sys = await queryUsageByEvents(startMs, endMs)
        if (!alive) return
        setRows(buildRows(a11yRows, sys))
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [visible, startMs, endMs, a11yRows])

  const suspiciousCount = rows.filter((r) => r.suspicious).length

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.mask} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.head}>
          <Text style={styles.title}>系统对照</Text>
          <Pressable hitSlop={10} onPress={onClose}><Text style={styles.closeBtn}>关闭</Text></Pressable>
        </View>
        <Text style={styles.subtitle}>
          感知时间线汇总 vs 系统 UsageStats（queryEvents 精确口径）
          {suspiciousCount > 0 ? ` · ${suspiciousCount} 项差异偏大` : ''}
        </Text>

        {loading ? (
          <View style={styles.center}><ActivityIndicator color={theme.accent} /></View>
        ) : granted === false ? (
          <View style={styles.center}>
            <Text style={styles.hint}>未授予「使用情况访问」权限，无法读取系统账本</Text>
            <Pressable style={styles.grantBtn} onPress={() => { void openUsageAccessSettings() }}>
              <Text style={styles.grantBtnText}>去授权</Text>
            </Pressable>
          </View>
        ) : error ? (
          <View style={styles.center}><Text style={styles.hint}>{error}</Text></View>
        ) : (
          <>
            <View style={styles.rowHead}>
              <Text style={[styles.colApp, styles.colHeadText]}>应用</Text>
              <Text style={[styles.colNum, styles.colHeadText]}>感知</Text>
              <Text style={[styles.colNum, styles.colHeadText]}>系统</Text>
              <Text style={[styles.colNum, styles.colHeadText]}>差值</Text>
            </View>
            <ScrollView style={styles.list}>
              {rows.map((r) => {
                const diff = r.a11yMs - r.sysMs
                return (
                  <View key={r.packageName} style={[styles.row, r.suspicious && styles.rowBad]}>
                    <Text style={styles.colApp} numberOfLines={1}>{r.appLabel}</Text>
                    <Text style={styles.colNum}>{fmtMin(r.a11yMs)}</Text>
                    <Text style={styles.colNum}>{fmtMin(r.sysMs)}</Text>
                    <Text style={[styles.colNum, r.suspicious && styles.diffBad]}>
                      {diff === 0 ? '—' : `${diff > 0 ? '+' : '−'}${fmtMin(Math.abs(diff))}`}
                    </Text>
                  </View>
                )
              })}
              {rows.length === 0 && (
                <Text style={[styles.hint, { textAlign: 'center', marginTop: 24 }]}>当日双方都没有 ≥1 分钟的应用记录</Text>
              )}
              <Text style={styles.footNote}>
                差值 = 感知 − 系统。标红 = 差异 &gt;5 分钟且 &gt;20%，多半是感知服务断档或聚合异常；
                系统侧不依赖无障碍服务，可作基准。
              </Text>
            </ScrollView>
          </>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  mask: { flex: 1, backgroundColor: 'rgba(10, 12, 18, 0.35)' },
  sheet: {
    backgroundColor: theme.bg,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 24,
    maxHeight: '78%',
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 16, fontWeight: '700', color: theme.ink },
  closeBtn: { fontSize: 13, color: theme.accent },
  subtitle: { fontSize: 12, color: theme.inkFaint, marginTop: 4, marginBottom: 12 },
  center: { paddingVertical: 36, alignItems: 'center', gap: 12 },
  hint: { fontSize: 13, color: theme.inkSoft, lineHeight: 19 },
  grantBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: theme.accent,
  },
  grantBtnText: { color: '#FFF', fontSize: 13, fontWeight: '600' },
  rowHead: {
    flexDirection: 'row',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: theme.line,
  },
  colHeadText: { fontSize: 11, color: theme.inkFaint, fontWeight: '600' },
  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.line,
  },
  rowBad: { backgroundColor: alpha('#E5484D', 0.06) },
  colApp: { flex: 1.6, fontSize: 13, color: theme.ink, paddingRight: 8 },
  colNum: { flex: 1, fontSize: 13, color: theme.inkSoft, textAlign: 'right', fontVariant: ['tabular-nums'] },
  diffBad: { color: '#E5484D', fontWeight: '700' },
  footNote: { fontSize: 11, color: theme.inkFaint, lineHeight: 17, marginTop: 14 },
})
