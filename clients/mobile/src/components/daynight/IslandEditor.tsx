// 浮岛 / 日程的编辑表单（新建和修改共用，对应 desktop components/daynight/IslandEditor.tsx）。
// 只收集输入，校验交给 normalizeRule；时刻是手打的 HH:mm，写错的在这里先拦下（desktop 用时间控件，写不错）

import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { ActivityPalette } from '../../types'
import { DAY_MINUTES, minuteToHHmm, newItemId, normalizeRule, parseHHmm } from '../../lib/islands/island-model'
import type { IslandItem, IslandKind, IslandRule } from '../../lib/islands/island-model'
import { fonts, theme } from '../../theme'
import { Field, Key, planStyles } from './plan-ui'

interface Props {
  readonly palette: ActivityPalette
  /** 修改时传原规则；新建时不传 */
  readonly initial?: IslandRule
  readonly initialKind: IslandKind
  readonly busy: boolean
  readonly onSave: (rule: IslandRule) => void
  readonly onCancel: () => void
}

const TAG_RESULT_LIMIT = 8
const DEFAULT_DURATION = 30

/** 时刻：留空 = null；写了但读不出来就报错，免得悄悄变成 00:00 */
function timeValue(text: string, label: string): number | null {
  if (!text.trim()) return null
  const minute = parseHHmm(text)
  if (minute == null) throw new Error(`「${label}」要写成 HH:mm，例如 07:30`)
  return minute
}

export default function IslandEditor({ palette, initial, initialKind, busy, onSave, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const [kind, setKind] = useState<IslandKind>(initial?.kind ?? initialKind)
  const [anchorTagId, setAnchorTagId] = useState<number | null>(initial?.anchorTagId ?? null)
  const [tagQuery, setTagQuery] = useState('')
  const [windowStart, setWindowStart] = useState(minuteToHHmm(initial?.windowStart ?? 0))
  const [windowEnd, setWindowEnd] = useState(initial && initial.windowEnd < DAY_MINUTES ? minuteToHHmm(initial.windowEnd) : '')
  const [offsetMin, setOffsetMin] = useState(String(initial?.offsetMin ?? 0))
  const [latestStart, setLatestStart] = useState(initial?.latestStart != null ? minuteToHHmm(initial.latestStart) : '')
  const [startTime, setStartTime] = useState(minuteToHHmm(initial?.startMinute ?? 23 * 60))
  const [durationMin, setDurationMin] = useState(String(initial?.durationMin ?? DEFAULT_DURATION))
  const [items, setItems] = useState<readonly IslandItem[]>(initial?.items ?? [])
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [error, setError] = useState<string | null>(null)

  const anchorTag = palette.tags.find((t) => t.id === anchorTagId) ?? null
  const tagResults = useMemo(() => {
    const q = tagQuery.trim().toLowerCase()
    const sorted = [...palette.tags].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    return (q ? sorted.filter((t) => t.fullPath.toLowerCase().includes(q)) : sorted).slice(0, TAG_RESULT_LIMIT)
  }, [tagQuery, palette.tags])

  const submit = () => {
    try {
      const isAfter = kind === 'after'
      const rule = normalizeRule({
        name,
        kind,
        anchorTagId,
        windowStart: (isAfter ? timeValue(windowStart, '时段开始') : null) ?? 0,
        windowEnd: (isAfter ? timeValue(windowEnd, '时段结束') : null) ?? DAY_MINUTES,
        offsetMin,
        latestStart: isAfter ? timeValue(latestStart, '最晚开始') : null,
        startMinute: (isAfter ? null : timeValue(startTime, '几点开始')) ?? 0,
        durationMin,
        items,
        color: initial?.color ?? null,
        enabled,
        // 锁名单现在只在桌面端编辑；这里原样带回去，免得在手机上改一下就丢了
        lock: initial?.lock ?? null,
      })
      setError(null)
      onSave(rule)
    } catch (err) {
      setError(err instanceof Error ? err.message : '这条规则填得不对')
    }
  }

  const setItemTitle = (id: string, title: string) => setItems((list) => list.map((item) => (item.id === id ? { ...item, title } : item)))

  return (
    <View>
      <View style={styles.kindRow}>
        <Key label="浮岛 · 跟在某件事后面" active={kind === 'after'} onPress={() => setKind('after')} style={styles.flex} />
        <Key label="日程 · 钉在钟点" active={kind === 'fixed'} onPress={() => setKind('fixed')} style={styles.flex} />
      </View>

      <Field label="名字">
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={kind === 'after' ? '例如：起床后' : '例如：早睡'}
          placeholderTextColor={theme.inkFaint}
          style={planStyles.input}
        />
      </Field>

      {kind === 'after' ? (
        <>
          <Field label="跟在哪个标签后面">
            {anchorTag ? (
              <Pressable onPress={() => setAnchorTagId(null)} style={styles.tagChosen}>
                <Text style={styles.tagChosenText} numberOfLines={1}>{anchorTag.fullPath}</Text>
                <Text style={styles.clearMark}>×</Text>
              </Pressable>
            ) : (
              <View>
                <TextInput
                  value={tagQuery}
                  onChangeText={setTagQuery}
                  placeholder="搜标签，例如 睡眠 / 吃饭"
                  placeholderTextColor={theme.inkFaint}
                  style={planStyles.input}
                />
                <View style={styles.tagResults}>
                  {tagResults.length === 0 ? (
                    <Text style={styles.hintLine}>没有匹配的标签</Text>
                  ) : tagResults.map((tag) => (
                    <Pressable
                      key={tag.id}
                      onPress={() => { setAnchorTagId(tag.id); setTagQuery('') }}
                      style={({ pressed }) => [styles.tagResult, pressed && styles.pressed]}
                    >
                      <Text style={styles.tagResultText} numberOfLines={1}>{tag.fullPath}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}
          </Field>
          <Field label="只认这个时段里结束的那一次" hint="同一个标签一天出现好几次时用，比如只认 11:00–17:00 吃完的那顿。结束留空 = 到午夜">
            <View style={styles.pair}>
              <View style={styles.flex}><TimeInput value={windowStart} onChange={setWindowStart} /></View>
              <Text style={styles.dash}>–</Text>
              <View style={styles.flex}><TimeInput value={windowEnd} onChange={setWindowEnd} placeholder="24:00" /></View>
            </View>
          </Field>
          <View style={styles.cols}>
            <View style={styles.flex}>
              <Field label="结束后隔多久（分钟）">
                <TextInput value={offsetMin} onChangeText={setOffsetMin} keyboardType="number-pad" style={planStyles.input} />
              </Field>
            </View>
            <View style={styles.flex}>
              <Field label="最晚开始" hint="留空 = 一直跟着漂">
                <TimeInput value={latestStart} onChange={setLatestStart} placeholder="不限" />
              </Field>
            </View>
          </View>
        </>
      ) : (
        <Field label="几点开始">
          <TimeInput value={startTime} onChange={setStartTime} />
        </Field>
      )}

      <Field label="占多久（分钟）">
        <TextInput value={durationMin} onChangeText={setDurationMin} keyboardType="number-pad" style={planStyles.input} />
      </Field>

      <Field label="里面要做的事" hint="全勾完算这块做完；不列 = 整块勾一次">
        <View style={styles.items}>
          {items.map((item) => (
            <View key={item.id} style={styles.itemRow}>
              <TextInput
                value={item.title}
                onChangeText={(v) => setItemTitle(item.id, v)}
                placeholder="例如：烧水"
                placeholderTextColor={theme.inkFaint}
                style={[planStyles.input, styles.flex]}
              />
              <Pressable
                onPress={() => setItems((list) => list.filter((i) => i.id !== item.id))}
                style={styles.removeItem}
                accessibilityLabel="去掉这件事"
              >
                <Text style={styles.clearMark}>×</Text>
              </Pressable>
            </View>
          ))}
          <Key label="＋ 加一件事" onPress={() => setItems((list) => [...list, { id: newItemId(), title: '' }])} />
        </View>
      </Field>

      {initial && (
        <Key
          label={enabled ? '启用中' : '已停用（不出现在昼夜表上）'}
          active={enabled}
          onPress={() => setEnabled((v) => !v)}
          style={styles.enableKey}
        />
      )}

      {error && <Text style={planStyles.error}>{error}</Text>}

      <View style={styles.actions}>
        <Key label="取消" onPress={onCancel} disabled={busy} style={styles.flex} />
        <Key label="保存" primary onPress={submit} disabled={busy} style={styles.flex} />
      </View>
    </View>
  )
}

function TimeInput({ value, onChange, placeholder = 'HH:mm' }: { readonly value: string; readonly onChange: (v: string) => void; readonly placeholder?: string }) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={theme.inkFaint}
      keyboardType="numbers-and-punctuation"
      maxLength={5}
      style={[planStyles.input, styles.time]}
    />
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  kindRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  tagChosen: {
    minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, borderRadius: 10, backgroundColor: theme.accentSoft,
  },
  tagChosenText: { flex: 1, fontSize: 13, color: theme.accent, fontWeight: '600' },
  clearMark: { fontSize: 16, color: theme.inkSoft, lineHeight: 18 },
  tagResults: {
    marginTop: 6, borderRadius: 10, overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line,
  },
  tagResult: {
    paddingHorizontal: 12, paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.lineSoft,
  },
  tagResultText: { fontSize: 13, color: theme.ink },
  pressed: { backgroundColor: theme.bg },
  hintLine: { fontSize: 12, color: theme.inkFaint, padding: 10 },
  pair: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dash: { fontSize: 13, color: theme.inkSoft },
  cols: { flexDirection: 'row', gap: 10 },
  time: { fontFamily: fonts.mono },
  items: { gap: 6 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  removeItem: {
    width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: theme.sunk,
  },
  enableKey: { marginBottom: 12 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
})
