// ══════════════════════════════════════════════
// 昼夜表右侧栏 · 浮岛与日程：这一天各条的落点、里面的事勾没勾，新建 / 修改 / 删除规则
// ══════════════════════════════════════════════

import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Check, Circle, Pencil, Plus, Trash2 } from 'lucide-react'
import type { ActivityPalette } from '../../types'
import { createIsland, deleteIsland, setIslandCheck, updateIsland } from '../../lib/islands/island-api'
import { WHOLE_ITEM_ID, describeLock, describePlacementTime, describeRule, islandColor, toDateKey } from '../../lib/islands/island-model'
import type { Island, IslandKind, IslandPlacement, IslandRule, PlacementStatus } from '../../lib/islands/island-model'
import { useConfirm } from '../../hooks/useConfirm'
import { tone } from '../../lib/color/harmonize'
import { theme, ti, tiSurface, tiTitle } from '../../theme'
import Tooltip from '../Tooltip'
import IslandEditor from './IslandEditor'

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
  if (status === 'done') return ti.ok
  if (status === 'active') return ti.led
  if (status === 'missed') return ti.textFaint
  return theme.textMuted
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
  const [confirm, confirmDialog] = useConfirm()

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

  const remove = async (island: Island) => {
    const ok = await confirm({ title: '删除这条规则', question: `删掉「${island.rule.name}」？以后的昼夜表上不再出现。`, danger: true })
    if (ok) await run(() => deleteIsland(island.id), '删除失败')
  }

  const toggle = (p: IslandPlacement, itemId: string) => run(
    () => setIslandCheck(selectedDate, p.island.id, itemId, !p.doneItemIds.includes(itemId)),
    '勾选失败',
  )

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <div style={styles.titleRow}>
          <span className="ti-diamond" aria-hidden />
          <h2 style={styles.title}>主线浮岛日程</h2>
        </div>
        <div className="ti-well" style={styles.dateBadge}>
          <span className="ti-led" style={{ fontSize: 11 }}>{toDateKey(selectedDate)}</span>
        </div>
      </header>

      {editing ? (
        <div style={styles.scroll}>
          <IslandEditor
            key={editing.mode === 'edit' ? editing.island.id : `new-${editing.kind}`}
            palette={palette}
            initial={editing.mode === 'edit' ? editing.island.rule : undefined}
            initialKind={editing.mode === 'edit' ? editing.island.rule.kind : editing.kind}
            busy={busy}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
          {error && <div style={styles.error}>{error}</div>}
        </div>
      ) : (
        <>
          <div style={styles.newRow}>
            <button type="button" className="ti-key" onClick={() => setEditing({ mode: 'new', kind: 'after' })} style={styles.newKey}>
              <Plus size={12} strokeWidth={2.6} />
              浮岛
            </button>
            <button type="button" className="ti-key" onClick={() => setEditing({ mode: 'new', kind: 'fixed' })} style={styles.newKey}>
              <Plus size={12} strokeWidth={2.6} />
              日程
            </button>
          </div>
          {(error ?? loadError) && <div style={styles.error}>{error ?? loadError}</div>}

          <div style={styles.scroll}>
            {placements.length === 0 && disabled.length === 0 && (
              <div style={styles.empty}>
                还没有规则。浮岛跟在某件事后面，比如「睡醒后」「吃完饭两小时后」；日程钉在钟点上，比如「23:30 早睡」。
              </div>
            )}
            {placements.map((p) => (
              <PlacementCard
                key={p.island.id}
                placement={p}
                palette={palette}
                busy={busy}
                onToggle={(itemId) => toggle(p, itemId)}
                onEdit={() => setEditing({ mode: 'edit', island: p.island })}
                onDelete={() => remove(p.island)}
              />
            ))}
            {disabled.length > 0 && (
              <div style={styles.disabledGroup}>
                <div style={styles.groupHeader}>已停用</div>
                {disabled.map((island) => (
                  <button key={island.id} type="button" className="ti-key" onClick={() => setEditing({ mode: 'edit', island })} style={styles.disabledRow}>
                    <span style={styles.ellipsis}>{island.rule.name}</span>
                    <Pencil size={11} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      {confirmDialog}
    </div>
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
  const color = tone(islandColor(rule, palette, theme.warningOrange))
  const note = basisNote(p)
  const faded = p.status === 'done' || p.status === 'missed'
  const rows = rule.items.length > 0 ? rule.items : [{ id: WHOLE_ITEM_ID, title: '做完了' }]

  return (
    <article style={{ ...styles.card, opacity: faded ? 0.72 : 1 }}>
      <div style={styles.cardHead}>
        <span style={{ ...styles.swatch, borderColor: color, borderStyle: p.basis === 'estimated' ? 'dashed' : 'solid', background: p.status === 'active' ? color : 'transparent' }} aria-hidden />
        <span style={styles.cardName}>{rule.name}</span>
        <span style={{ ...styles.statusText, color: statusColor(p.status) }}>{STATUS_TEXT[p.status]}</span>
      </div>
      <div style={styles.timeRow}>
        <span className="ti-led" style={styles.time}>{describePlacementTime(p)}</span>
        <span style={styles.kindText}>{rule.kind === 'fixed' ? '日程' : '浮岛'}</span>
        <span style={styles.cardTools}>
          <Tooltip content="修改规则">
            <button type="button" className="ti-key" disabled={busy} onClick={onEdit} style={styles.toolKey} aria-label="修改规则"><Pencil size={11} /></button>
          </Tooltip>
          <Tooltip content="删除规则">
            <button type="button" className="ti-key ti-key-danger" disabled={busy} onClick={onDelete} style={styles.toolKey} aria-label="删除规则"><Trash2 size={11} /></button>
          </Tooltip>
        </span>
      </div>
      <div style={styles.ruleText}>{describeRule(rule, palette)}</div>
      {rule.lock && <div style={styles.ruleText}>{describeLock(rule.lock)}</div>}
      {note && <div style={styles.noteText}>{note}</div>}
      <div style={styles.itemList}>
        {rows.map((item) => {
          const checked = p.doneItemIds.includes(item.id)
          return (
            <button key={item.id} type="button" className="ti-key" disabled={busy} onClick={() => onToggle(item.id)} style={styles.itemRow}>
              {checked ? <Check size={13} color={ti.ok} /> : <Circle size={13} color={theme.textMuted} />}
              <span style={{ ...styles.itemTitle, color: checked ? theme.textMuted : theme.textPrimary, textDecoration: checked ? 'line-through' : 'none' }}>
                {item.title}
              </span>
            </button>
          )
        })}
      </div>
    </article>
  )
}

const styles: Record<string, CSSProperties> = {
  root: {
    height: '100%',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '16px 14px 14px',
    boxSizing: 'border-box',
    fontFamily: theme.fontBody,
    color: theme.textPrimary,
    overflow: 'hidden',
  },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingRight: 34, flexShrink: 0 },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8 },
  title: { ...tiTitle, margin: 0, fontSize: 15 },
  dateBadge: { padding: '3px 8px', borderRadius: 4 },
  newRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, flexShrink: 0 },
  newKey: { height: 28, gap: 4, fontSize: 12 },
  scroll: { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 9, padding: '2px 2px 4px' },
  empty: { fontSize: 11.5, lineHeight: 1.7, color: theme.textMuted, padding: '6px 2px' },
  error: { fontSize: 11, color: theme.dangerRed, flexShrink: 0 },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    background: 'linear-gradient(180deg, rgba(255,255,255,0.045), rgba(0,0,0,0.12)), #1F1D1A',
    borderRadius: 6,
    boxShadow: '0 0 0 1px #080807, inset 0 1px 0 rgba(255,255,255,0.08), 0 2px 5px rgba(0,0,0,0.5)',
    padding: '10px 9px 9px',
  },
  cardHead: { display: 'grid', gridTemplateColumns: '12px 1fr auto', alignItems: 'center', gap: 7 },
  swatch: { width: 10, height: 10, borderRadius: 3, borderWidth: 1.5, boxSizing: 'border-box' },
  cardName: { fontSize: 13, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  statusText: { fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5 },
  timeRow: { display: 'grid', gridTemplateColumns: 'auto auto 1fr', alignItems: 'center', gap: 8 },
  time: { fontSize: 13 },
  kindText: { fontSize: 10.5, color: theme.textMuted },
  cardTools: { display: 'flex', justifyContent: 'flex-end', gap: 5 },
  toolKey: { width: 22, height: 22, padding: 0, color: theme.textMuted },
  ruleText: { fontSize: 11, lineHeight: 1.55, color: theme.textSecondary },
  noteText: { fontSize: 10.5, lineHeight: 1.5, color: ti.textFaint },
  itemList: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 },
  itemRow: { minHeight: 26, display: 'grid', gridTemplateColumns: '16px 1fr', alignItems: 'center', justifyContent: 'stretch', gap: 6, padding: '3px 8px', textAlign: 'left' },
  itemTitle: { fontSize: 12, overflowWrap: 'anywhere' },
  disabledGroup: { display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 },
  groupHeader: {
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: 1,
    color: theme.textSecondary,
    borderBottom: '1px solid rgba(0,0,0,0.88)',
    boxShadow: '0 1px 0 rgba(255,255,255,0.1)',
    paddingBottom: 5,
  },
  disabledRow: { minHeight: 26, display: 'grid', gridTemplateColumns: '1fr 14px', alignItems: 'center', gap: 6, padding: '3px 8px', fontSize: 11.5, color: theme.textMuted, textAlign: 'left', background: tiSurface.well },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
}
