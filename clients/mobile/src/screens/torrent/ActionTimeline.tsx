import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { getTorrentCapturesInRange, type TorrentCapture } from '../../lib/perception'
import { alpha, theme } from '../../theme'
import { buildTorrentActionRanges } from '../TorrentScreen'
import type { TorrentActionRange } from './types'

type ActionTimelineProps = {
  dateRange: { startTs: number; endTs: number }
  queryRange?: { startTs: number; endTs: number }
  sortOrder: 'asc'
  source?: ActionTimelineSource
  onVisibleActionChange: (action: TorrentActionRange | null) => void
  onActionsLoaded: (actions: TorrentActionRange[]) => void
}

export type ActionTimelineSource = {
  pollMs?: number
  load: (range?: { startTs: number; endTs: number; limit: number }) => Promise<TorrentCapture[]>
}

const ACTION_CAPTURE_LIMIT = 8000
const ACTION_QUERY_PAD_MS = 8 * 60_000

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function actionLabel(a: TorrentActionRange): string {
  if (a.kind === 'video_intro') return a.isStory ? '进入视频播放界面（竖屏）' : '进入视频播放界面'
  if (a.kind === 'home') return '进入主页'
  if (a.kind === 'splash') return '开屏广告'
  if (a.kind === 'fullscreen') return '进入全屏播放'
  if (a.kind === 'comments') return '进入评论'
  return '进入评论详情'
}

const ACTION_COLORS: Record<TorrentActionRange['kind'], string> = {
  splash: '#9CA3AF',
  home: '#FB7299',
  video_intro: '#00AEEC',
  fullscreen: '#6366F1',
  comments: '#FBB04C',
  comment_detail: '#F59E0B',
}

export function ActionTimeline({
  dateRange,
  queryRange,
  sortOrder,
  source,
  onVisibleActionChange,
  onActionsLoaded,
}: ActionTimelineProps) {
  const [actions, setActions] = useState<TorrentActionRange[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const aliveRef = useRef(true)
  const refreshInFlightRef = useRef(false)

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) {
      if (aliveRef.current) setRefreshing(false)
      return
    }
    refreshInFlightRef.current = true
    try {
      let loadRange = queryRange
      if (!loadRange) {
        const latestRows = source
          ? await source.load({ ...dateRange, limit: 1 })
          : await getTorrentCapturesInRange(dateRange.startTs, dateRange.endTs, 1)
        const latestTs = latestRows[0]?.eventTimeMs ?? 0
        if (latestTs > 0) {
          loadRange = {
            startTs: Math.max(dateRange.startTs, latestTs - ACTION_QUERY_PAD_MS),
            endTs: Math.min(dateRange.endTs, latestTs + ACTION_QUERY_PAD_MS),
          }
        } else {
          loadRange = dateRange
        }
      }
      const list = source
        ? await source.load({ ...loadRange, limit: ACTION_CAPTURE_LIMIT })
        : await getTorrentCapturesInRange(loadRange.startTs, loadRange.endTs, ACTION_CAPTURE_LIMIT)
      if (!aliveRef.current) return
      const scoped = list.filter((c) => c.eventTimeMs >= dateRange.startTs && c.eventTimeMs < dateRange.endTs)
      const next = buildTorrentActionRanges(scoped)
      setActions(sortOrder === 'asc' ? next : [...next].reverse())
    } catch (e) {
      console.warn('[action timeline] refresh failed', e)
    } finally {
      if (aliveRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
      refreshInFlightRef.current = false
    }
  }, [dateRange, queryRange, sortOrder, source])

  useEffect(() => {
    aliveRef.current = true
    refresh()
    const id = source?.pollMs != null ? setInterval(refresh, source.pollMs) : null
    return () => {
      aliveRef.current = false
      if (id != null) clearInterval(id)
    }
  }, [refresh, source?.pollMs])

  useEffect(() => {
    onActionsLoaded(actions)
    if (actions.length === 0) onVisibleActionChange(null)
  }, [actions, onActionsLoaded, onVisibleActionChange])

  const visibleCbRef = useRef(onVisibleActionChange)
  useEffect(() => {
    visibleCbRef.current = onVisibleActionChange
  }, [onVisibleActionChange])
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: Array<{ item?: TorrentActionRange; index?: number | null }> }) => {
    const first = viewableItems
      .filter((v) => !!v.item)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0]?.item ?? null
    visibleCbRef.current(first)
  }).current

  if (loading) {
    return (
      <View style={styles.empty}>
        <ActivityIndicator color={theme.accent} />
      </View>
    )
  }
  if (actions.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>今天还没有可还原的动作</Text>
      </View>
    )
  }
  return (
    <FlatList
      data={actions}
      keyExtractor={(it) => it.key}
      renderItem={({ item }) => {
        const color = ACTION_COLORS[item.kind]
        const dur = Math.round((item.endTs - item.startTs) / 1000)
        return (
          <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: color }]} />
            <View style={styles.body}>
              <View style={styles.head}>
                <Text style={[styles.kind, { color }]}>{actionLabel(item)}</Text>
                {dur > 0 && <Text style={styles.duration}>停留 {dur}s</Text>}
              </View>
              <Text style={styles.time}>
                {dur > 0 ? `${fmtTime(item.startTs)} → ${fmtTime(item.endTs)}` : fmtTime(item.startTs)}
              </Text>
              {(item.title || item.upName) && (
                <Text style={styles.detail} numberOfLines={2}>
                  {item.title ? `《${item.title}》` : ''}
                  {item.upName ? ` @${item.upName}` : ''}
                </Text>
              )}
            </View>
          </View>
        )
      }}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); refresh() }} tintColor={theme.accent} />}
      onViewableItemsChanged={onViewableItemsChanged}
      viewabilityConfig={{ itemVisiblePercentThreshold: 35, minimumViewTime: 80 }}
    />
  )
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 18,
    gap: 8,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 13,
    color: theme.inkSoft,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.lineSoft,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    marginTop: 4,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  kind: {
    fontSize: 13,
    fontWeight: '800',
  },
  duration: {
    marginLeft: 'auto',
    fontSize: 11,
    color: theme.inkFaint,
  },
  time: {
    marginTop: 3,
    fontSize: 11,
    color: theme.inkSoft,
    fontVariant: ['tabular-nums'],
  },
  detail: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17,
    color: alpha(theme.ink, 0.86),
  },
})
