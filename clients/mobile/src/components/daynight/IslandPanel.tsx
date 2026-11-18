// ══════════════════════════════════════════════
// 计划弹窗 · 浮岛与日程：这一天各条的落点、里面的事勾没勾，新建 / 修改 / 删除规则
//   对应 desktop components/daynight/IslandPanel.tsx（结构和文案一致，样子按手机端浅色主题画）
// ══════════════════════════════════════════════

import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { ActivityPalette } from '../../types'
import { createIsland, deleteIsland, setIslandCheck, updateIsland } from '../../lib/islands/island-api'
import { WHOLE_ITEM_ID, describePlacementTime, describeRule, islandColor, toDateKey } from '../../lib/islands/island-model'
import type { Island, IslandKind, IslandPlacement, IslandRule, PlacementStatus } from '../../lib/islands/island-model'
import { alpha, fonts, theme } from '../../theme'
import ConfirmDialog from '../ConfirmDialog'
import IslandEditor from './IslandEditor'
import { Key, planStyles, planTone } from './plan-ui'

interface Props {
  readonly selectedDate: Date
  readonly palette: ActivityPalette
  readonly islands: readonly Island[]
  readonly placements: readonly IslandPlacement[]
  readonly loadError: string | null
  /** 规则或勾选变了：让上层重新取 */
  readonly onChanged: () => void
}

type Editing = { readonly mode: 'new'; readonly kind: IslandKind } | { readonly mode: 'edit'; readonly island: Island }

const STATUS_TEXT: Record<PlacementStatus, string> = {
  done: '做完了',
  active: '现在',
  upcoming: '还没到',
  missed: '没做',
}

function statusColor(status: PlacementStatus): string {
  if (status === 'done') return planTone.ok
  if (status === 'active') return theme.accent
  if (status === 'missed') return theme.inkFaint
  return theme.inkSoft
}

/** 落点下面那行小字：位置是怎么来的 */
function basisNote(p: IslandPlacement): string | null {
  if (p.basis === 'estimated') return `按近 ${p.sampleDays} 天估的，记下那件事后会挪到准确位置`
  if (p.basis === 'none' && p.island.rule.kind === 'after') return '今天还没记那件事，近几天也没有，暂时估不出'
  if (p.late) return '那件事拖晚了，已经卡在最晚开始时刻'
  return null
}

export default function IslandPanel({ selectedDate, palette, islands, placements, loadError, onChanged }: Props) {
  const [editing, setEditing] = useState<Editing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Island | null>(null)

  const disabled = islands.filter((island) => !island.rule.enabled)

  const run = async (work: () => Promise<void>, failText: string) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : failText)
    } finally {
      setBusy(false)
    }
  }

  const save = (rule: IslandRule) => run(async () => {
    if (editing?.mode === 'edit') await updateIsland(editing.island.id, rule)
    else await createIsland(rule)
    setEditing(null)
  }, '保存失败')

  const confirmDelete = () => {
    const island = pendingDelete
    setPendingDelete(null)
    if (island) void run(() => deleteIsland(island.id), '删除失败')
  }

  const toggle = (p: IslandPlacement, itemId: string) => run(
    () => setIslandCheck(selectedDate, p.island.id, itemId, !p.doneItemIds.includes(itemId)),
    '勾选失败',
  )

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>主线浮岛日程</Text>
        <Text style={styles.date}>{toDateKey(selectedDate)}</Text>
      </View>

      {editing ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <IslandEditor
            key={editing.mode === 'edit' ? editing.island.id : `new-${editing.kind}`}
            palette={palette}
            initial={editing.mode === 'edit' ? editing.island.rule : undefined}
            initialKind={editing.mode === 'edit' ? editing.island.rule.kind : editing.kind}
            busy={busy}
            onSave={(rule) => { void save(rule) }}
            onCancel={() => setEditing(null)}
          />
          {error && <Text style={planStyles.error}>{error}</Text>}
        </ScrollView>
      ) : (
        <>
          <View style={styles.newRow}>
            <Key label="＋ 浮岛" onPress={() => setEditing({ mode: 'new', kind: 'after' })} style={styles.flex} />
            <Key label="＋ 日程" onPress={() => setEditing({ mode: 'new', kind: 'fixed' })} style={styles.flex} />
          </View>
          {(error ?? loadError) && <Text style={[planStyles.error, styles.errorGap]}>{error ?? loadError}</Text>}

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            {placements.length === 0 && disabled.length === 0 && (
              <Text style={planStyles.empty}>
                还没有规则。浮岛跟在某件事后面，比如「睡醒后」「吃完饭两小时后」；日程钉在钟点上，比如「23:30 早睡」。
              </Text>
            )}
            {placements.map((p) => (
              <PlacementCard
                key={p.island.id}
                placement={p}
                palette={palette}
                busy={busy}
                onToggle={(itemId) => { void toggle(p, itemId) }}
                onEdit={() => setEditing({ mode: 'edit', island: p.island })}
                onDelete={() => setPendingDelete(p.island)}
              />
            ))}
            {disabled.length > 0 && (
              <View style={styles.disabledGroup}>
                <View style={planStyles.groupHeader}>
                  <Text style={planStyles.groupTitle}>已停用</Text>
                  <Text style={planStyles.groupCount}>{disabled.length}</Text>
                </View>
                {disabled.map((island) => (
                  <Pressable
                    key={island.id}
                    onPress={() => setEditing({ mode: 'edit', island })}
                    style={({ pressed }) => [styles.disabledRow, pressed && styles.pressed]}
                  >
                    <Text style={styles.disabledName} numberOfLines={1}>{island.rule.name}</Text>
                    <Text style={styles.linkText}>修改</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </ScrollView>
        </>
      )}

      <ConfirmDialog
        open={pendingDelete != null}
        title="删除这条规则"
        body={pendingDelete ? `删掉「${pendingDelete.rule.name}」？以后的昼夜表上不再出现。` : undefined}
        confirmText="删除"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </View>
  )
}

interface CardProps {
  readonly placement: IslandPlacement
  readonly palette: ActivityPalette
  readonly busy: boolean
  readonly onToggle: (itemId: string) => void
  readonly onEdit: () => void
  readonly onDelete: () => void
}

function PlacementCard({ placement: p, palette, busy, onToggle, onEdit, onDelete }: CardProps) {
  const { rule } = p.island
  const color = islandColor(rule, palette, planTone.plan)
  const note = basisNote(p)
  const faded = p.status === 'done' || p.status === 'missed'
  const rows = rule.items.length > 0 ? rule.items : [{ id: WHOLE_ITEM_ID, title: '做完了' }]

  return (
    <View style={[planStyles.card, styles.card, faded && styles.faded]}>
      <View style={styles.cardHead}>
        <View
          style={[
            styles.swatch,
            rule.kind === 'fixed' ? styles.swatchFixed : styles.swatchFloat,
            {
              borderColor: color,
              borderStyle: p.basis === 'estimated' ? 'dashed' : 'solid',
              backgroundColor: p.status === 'active' ? color : alpha(color, 0.12),
            },
          ]}
        />
        <Text style={styles.cardName} numberOfLines={1}>{rule.name}</Text>
        <Text style={[styles.statusText, { color: statusColor(p.status) }]}>{STATUS_TEXT[p.status]}</Text>
      </View>

      <View style={styles.timeRow}>
        <Text style={styles.time}>{describePlacementTime(p)}</Text>
        <Text style={styles.kindText}>{rule.kind === 'fixed' ? '日程' : '浮岛'}</Text>
        <View style={styles.cardTools}>
          <Pressable disabled={busy} onPress={onEdit} hitSlop={6} accessibilityLabel="修改规则">
            <Text style={styles.linkText}>修改</Text>
          </Pressable>
          <Pressable disabled={busy} onPress={onDelete} hitSlop={6} accessibilityLabel="删除规则">
            <Text style={[styles.linkText, { color: theme.danger }]}>删除</Text>
          </Pressable>
        </View>
      </View>

      <Text style={styles.ruleText}>{describeRule(rule, palette)}</Text>
      {note && <Text style={styles.noteText}>{note}</Text>}

      <View style={styles.itemList}>
        {rows.map((item) => {
          const checked = p.doneItemIds.includes(item.id)
          return (
            <Pressable
              key={item.id}
              disabled={busy}
              onPress={() => onToggle(item.id)}
              style={({ pressed }) => [styles.itemRow, pressed && styles.pressed]}
            >
              <View style={[styles.checkBox, checked && { backgroundColor: planTone.ok, borderColor: planTone.ok }]}>
                {checked && <Text style={styles.checkMark}>✓</Text>}
              </View>
              <Text style={[styles.itemTitle, checked && styles.itemDone]}>{item.title}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontSize: 15, fontWeight: '700', color: theme.ink },
  date: { fontSize: 12, color: theme.inkSoft, fontFamily: fonts.mono },
  newRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  errorGap: { marginBottom: 8 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 16 },
  pressed: { backgroundColor: theme.bg },

  card: { marginBottom: 10 },
  faded: { opacity: 0.7 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  swatch: { width: 12, height: 12, borderWidth: 1.5 },
  swatchFloat: { borderRadius: 4 },
  swatchFixed: { borderRadius: 1 },
  cardName: { flex: 1, fontSize: 14, fontWeight: '700', color: theme.ink },
  statusText: { fontSize: 12, fontWeight: '600' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  time: { fontSize: 13, color: theme.ink, fontFamily: fonts.mono },
  kindText: { fontSize: 12, color: theme.inkSoft },
  cardTools: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', gap: 16 },
  linkText: { fontSize: 12, color: theme.accent, fontWeight: '600' },
  ruleText: { fontSize: 12, lineHeight: 18, color: theme.inkSoft, marginTop: 6 },
  noteText: { fontSize: 11, lineHeight: 16, color: theme.inkFaint, marginTop: 2 },
  itemList: { marginTop: 8, gap: 2 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, paddingHorizontal: 4, borderRadius: 8 },
  checkBox: {
    width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: theme.inkFaint,
    alignItems: 'center', justifyContent: 'center',
  },
  checkMark: { fontSize: 11, lineHeight: 13, color: '#FFFFFF', fontWeight: '700' },
  itemTitle: { flex: 1, fontSize: 13, color: theme.ink },
  itemDone: { color: theme.inkSoft, textDecorationLine: 'line-through' },

  disabledGroup: { marginTop: 6 },
  disabledRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: theme.bg, marginBottom: 6,
  },
  disabledName: { flex: 1, fontSize: 13, color: theme.inkSoft },
})
