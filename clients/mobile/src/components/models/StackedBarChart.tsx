// ══════════════════════════════════════════════
// 竖向堆叠柱状图（对齐 desktop StackedBarChart）：按天 24 根 / 按周 7 根 / 按月整月
// 指标：成本 / Token / 次数；分层：按功能 / 按模型
// 和桌面端的差异：
// - 配色在 #FFFFFF 上跑过校验器；颜色跟着 key 走（按字典序定位，换指标/筛选不重新上色）
// - 超过 7 层时把小的并进「其他」，不循环配色（循环会让两层同色，图例对不上）
// - hover tooltip 换成点柱子 → 图下方固定一块明细（手机没有 hover，手指也会挡住浮层）
// ══════════════════════════════════════════════

import { useCallback, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { theme } from '../../theme'
import { FEATURE_LABEL } from '../../lib/models/registry'
import type { ModelCallLog } from '../../lib/models/model-audit'
import { formatCny, formatTokens, viewWindow, type ViewMode } from './model-utils'
import { Empty, Segmented } from './parts'

type BarMetric = 'cost' | 'tokens' | 'calls'
type BarGroup = 'feature' | 'model'

// 校验结果：浅色 surface 下 lightness / chroma / CVD / 正常视觉全部通过，对比度有 WARN，靠图例和明细文字兜底
const BAR_PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6']
const OTHER_KEY = '__other__'
const OTHER_COLOR = '#B4B6BC'

const BAR_HEIGHT = 180
const TOP_LABEL_H = 14
const X_LABEL_H = 18
const Y_AXIS_W = 46

export default function StackedBarChart({ calls, viewMode, anchorDate }: {
  calls: readonly ModelCallLog[]
  viewMode: ViewMode
  anchorDate: Date
}) {
  const [metric, setMetric] = useState<BarMetric>('cost')
  const [group, setGroup] = useState<BarGroup>('feature')
  const [picked, setPicked] = useState<string | null>(null)

  const callValue = useCallback((c: ModelCallLog): number => {
    if (metric === 'calls') return 1
    if (metric === 'tokens') return c.prompt_text_tokens + c.prompt_image_tokens + c.prompt_video_tokens + c.prompt_audio_tokens + c.completion_text_tokens + c.completion_audio_tokens
    return c.cost_cny ?? 0
  }, [metric])

  // 生成时间桶列表（按 viewMode 生成完整序列，确保空桶也显示）
  const bucketKeys = useMemo((): string[] => {
    const pad = (n: number) => String(n).padStart(2, '0')
    const localDay = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const localHour = (d: Date) =>
      `${localDay(d)}T${pad(d.getHours())}`

    const keys: string[] = []
    if (viewMode === 'day') {
      const base = new Date(anchorDate); base.setHours(0, 0, 0, 0)
      for (let h = 0; h < 24; h++) {
        const d = new Date(base); d.setHours(h)
        keys.push(localHour(d))
      }
    } else {
      const { from, to } = viewWindow(viewMode, anchorDate)
      const cur = new Date(from)
      while (cur < new Date(to)) {
        keys.push(localDay(cur))
        cur.setDate(cur.getDate() + 1)
      }
    }
    return keys
  }, [viewMode, anchorDate])

  // bucketKey(call) → 本地时间 key，与 bucketKeys 格式一致
  const callBucketKey = useCallback((c: ModelCallLog): string => {
    const d = new Date(c.started_at)
    const pad = (n: number) => String(n).padStart(2, '0')
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    return viewMode === 'day' ? `${day}T${pad(d.getHours())}` : day
  }, [viewMode])

  const groupKey = useCallback((c: ModelCallLog) => (group === 'feature' ? c.feature : c.model_id), [group])

  // 哪几层独立上色：当前窗口内合计最大的前 7 个，其余并进「其他」
  const { layerKeys, keyColor } = useMemo(() => {
    const totals = new Map<string, number>()
    for (const c of calls) {
      const k = groupKey(c)
      totals.set(k, (totals.get(k) ?? 0) + callValue(c))
    }
    const all = Array.from(totals.keys()).sort()
    const top = all.length <= BAR_PALETTE.length
      ? all
      : [...all].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0)).slice(0, BAR_PALETTE.length).sort()
    const colors = new Map<string, string>()
    top.forEach((k, i) => colors.set(k, BAR_PALETTE[i]))
    return {
      layerKeys: all.length > top.length ? [...top, OTHER_KEY] : top,
      keyColor: colors,
    }
  }, [calls, groupKey, callValue])

  // 构建 bucketKey → layerKey → value
  const data = useMemo(() => {
    const map = new Map<string, Map<string, number>>()
    for (const bk of bucketKeys) map.set(bk, new Map())
    for (const c of calls) {
      const inner = map.get(callBucketKey(c))
      if (!inner) continue
      const raw = groupKey(c)
      const lk = keyColor.has(raw) ? raw : OTHER_KEY
      inner.set(lk, (inner.get(lk) ?? 0) + callValue(c))
    }
    return map
  }, [bucketKeys, calls, callBucketKey, callValue, groupKey, keyColor])

  const maxBarVal = useMemo(() => {
    let m = 0
    for (const inner of data.values()) {
      const sum = Array.from(inner.values()).reduce((s, v) => s + v, 0)
      if (sum > m) m = sum
    }
    return m || 1
  }, [data])

  // 图例汇总
  const legendTotals = useMemo(() => {
    const m = new Map<string, number>()
    for (const inner of data.values())
      for (const [k, v] of inner) m.set(k, (m.get(k) ?? 0) + v)
    return m
  }, [data])

  const formatVal = (v: number) => metric === 'cost' ? formatCny(v) : metric === 'tokens' ? formatTokens(v) : String(v)
  const bucketLabel = (bk: string): string => viewMode === 'day' ? bk.slice(11, 13) + 'h' : bk.slice(5)
  const layerLabel = (k: string): string => {
    if (k === OTHER_KEY) return '其他'
    return group === 'feature' ? (FEATURE_LABEL.get(k) ?? k) : k
  }
  const layerColor = (k: string): string => keyColor.get(k) ?? OTHER_COLOR

  // 纵轴刻度：4 档，25%/50%/75%/100%，外加 0
  const yTicks = [0.25, 0.5, 0.75, 1.0].map((frac) => ({
    frac,
    label: formatVal(maxBarVal * frac),
    top: Math.round((1 - frac) * BAR_HEIGHT),
  }))

  // 手机宽度放不下全部标签：按天每 4 小时一个，按月 1 号和逢 5 一个，按周全显示
  const showXLabel = (bk: string): boolean => {
    if (viewMode === 'day') return parseInt(bk.slice(11, 13), 10) % 4 === 0
    if (viewMode === 'month') {
      const day = parseInt(bk.slice(8), 10)
      return day === 1 || day % 5 === 0
    }
    return true
  }

  const pickedBucket = picked && data.has(picked) ? picked : null
  const pickedInner = pickedBucket ? data.get(pickedBucket) ?? new Map<string, number>() : null
  const pickedTotal = pickedInner ? Array.from(pickedInner.values()).reduce((s, v) => s + v, 0) : 0

  if (calls.length === 0) return <Empty text="暂无可绘制数据" tall />

  return (
    <View>
      <View style={styles.controls}>
        <Segmented value={metric} options={[
          { value: 'cost', label: '成本' },
          { value: 'tokens', label: 'Token' },
          { value: 'calls', label: '次数' },
        ]} onChange={(v) => setMetric(v as BarMetric)} />
        <Segmented value={group} options={[
          { value: 'feature', label: '按功能' },
          { value: 'model', label: '按模型' },
        ]} onChange={(v) => setGroup(v as BarGroup)} />
      </View>

      <View style={styles.chart}>
        {/* 纵轴 */}
        <View style={styles.yAxis}>
          {yTicks.map(({ frac, label, top }) => (
            <Text key={frac} style={[styles.yLabel, { top: top - 6 }]} numberOfLines={1}>{label}</Text>
          ))}
          <Text style={[styles.yLabel, { top: BAR_HEIGHT - 6 }]}>0</Text>
        </View>

        {/* 图表主体 */}
        <View style={styles.plot}>
          {yTicks.map(({ frac, top }) => (
            <View key={frac} style={[styles.grid, { top }]} />
          ))}
          <View style={[styles.axis, { top: BAR_HEIGHT }]} />

          <View style={styles.bars}>
            {bucketKeys.map((bk) => {
              const inner = data.get(bk) ?? new Map<string, number>()
              const total = Array.from(inner.values()).reduce((s, v) => s + v, 0)
              const barH = Math.round((total / maxBarVal) * (BAR_HEIGHT - TOP_LABEL_H))
              const isPicked = pickedBucket === bk
              const segments = layerKeys
                .map((k) => ({ key: k, value: inner.get(k) ?? 0 }))
                .filter((s) => s.value > 0)
              return (
                <Pressable
                  key={bk}
                  style={styles.column}
                  accessibilityLabel={`${bucketLabel(bk)} ${formatVal(total)}`}
                  onPress={() => setPicked((cur) => (cur === bk ? null : bk))}
                >
                  <View style={[styles.columnTop, isPicked && styles.columnTopOn]}>
                    {/* 根数少的按周视图才放得下柱顶数值，其余视图点柱子看明细 */}
                    {viewMode === 'week' && total > 0 && (
                      <Text style={styles.topLabel} numberOfLines={1}>{formatVal(total)}</Text>
                    )}
                    <View style={[styles.bar, { height: barH }]}>
                      {segments.map((seg, i) => (
                        <View
                          key={seg.key}
                          style={{
                            flex: seg.value / (total || 1),
                            minHeight: 1,
                            backgroundColor: layerColor(seg.key),
                            // 段间 2px 留白；data-end 只在最上面一段
                            marginTop: i === segments.length - 1 ? 0 : 2,
                            borderTopLeftRadius: i === segments.length - 1 ? 3 : 0,
                            borderTopRightRadius: i === segments.length - 1 ? 3 : 0,
                          }}
                        />
                      ))}
                    </View>
                  </View>
                  <View style={styles.xLabelBox}>
                    {showXLabel(bk) && <Text style={[styles.xLabel, isPicked && styles.xLabelOn]} numberOfLines={1}>{bucketLabel(bk)}</Text>}
                  </View>
                </Pressable>
              )
            })}
          </View>
        </View>
      </View>

      {/* 点柱子后的明细（桌面端 hover tooltip） */}
      {pickedBucket && pickedInner ? (
        <View style={styles.detail}>
          <Text style={styles.detailTitle}>{bucketLabel(pickedBucket)}</Text>
          {pickedTotal === 0 ? (
            <Text style={styles.detailEmpty}>这段时间没有调用</Text>
          ) : (
            <>
              {layerKeys.filter((k) => (pickedInner.get(k) ?? 0) > 0).map((k) => (
                <View key={k} style={styles.detailRow}>
                  <View style={[styles.swatch, { backgroundColor: layerColor(k) }]} />
                  <Text style={styles.detailLabel} numberOfLines={1}>{layerLabel(k)}</Text>
                  <Text style={styles.detailValue}>{formatVal(pickedInner.get(k) ?? 0)}</Text>
                </View>
              ))}
              <View style={styles.detailTotal}>
                <Text style={styles.detailTotalLabel}>合计</Text>
                <Text style={styles.detailValueBold}>{formatVal(pickedTotal)}</Text>
              </View>
            </>
          )}
        </View>
      ) : (
        <Text style={styles.tapHint}>点柱子查看明细</Text>
      )}

      {/* 图例 */}
      <View style={styles.legend}>
        {layerKeys.map((k) => {
          const v = legendTotals.get(k) ?? 0
          if (v === 0) return null
          return (
            <View key={k} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: layerColor(k) }]} />
              <Text style={styles.legendLabel}>{layerLabel(k)}</Text>
              <Text style={styles.legendValue}>{formatVal(v)}</Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  chart: { flexDirection: 'row', paddingTop: 8 },
  yAxis: { width: Y_AXIS_W, height: BAR_HEIGHT + X_LABEL_H },
  yLabel: { position: 'absolute', right: 6, fontSize: 10, lineHeight: 12, color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  plot: { flex: 1, minWidth: 0 },
  grid: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: theme.lineSoft },
  axis: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: theme.line },
  bars: { flexDirection: 'row', height: BAR_HEIGHT + X_LABEL_H },
  column: { flex: 1, minWidth: 0 },
  columnTop: { height: BAR_HEIGHT, justifyContent: 'flex-end', alignItems: 'stretch', paddingHorizontal: 1, borderRadius: 3 },
  columnTopOn: { backgroundColor: theme.lineSoft },
  topLabel: { fontSize: 9, lineHeight: 12, textAlign: 'center', color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  bar: { overflow: 'hidden', flexDirection: 'column-reverse' },
  xLabelBox: { height: X_LABEL_H, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  xLabel: { position: 'absolute', width: 44, textAlign: 'center', fontSize: 10, color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  xLabelOn: { color: theme.ink, fontWeight: '700' },

  detail: { marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: theme.bg, gap: 4 },
  detailTitle: { fontSize: 12, fontWeight: '700', color: theme.ink, marginBottom: 2 },
  detailEmpty: { fontSize: 12, color: theme.inkSoft },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  detailLabel: { flex: 1, fontSize: 12, color: theme.inkSoft },
  detailValue: { fontSize: 12, color: theme.ink, fontVariant: ['tabular-nums'] },
  detailValueBold: { fontSize: 12, fontWeight: '700', color: theme.ink, fontVariant: ['tabular-nums'] },
  detailTotal: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 5, marginTop: 2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line },
  detailTotalLabel: { fontSize: 12, color: theme.inkSoft },
  tapHint: { fontSize: 11, color: theme.inkFaint, marginTop: 8 },

  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 6, marginTop: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  legendLabel: { fontSize: 11, color: theme.ink, flexShrink: 1 },
  legendValue: { fontSize: 11, color: theme.inkSoft, fontVariant: ['tabular-nums'] },
})
