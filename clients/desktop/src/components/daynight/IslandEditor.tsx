// 浮岛 / 日程的编辑表单（新建和修改共用）。只收集输入，校验交给 normalizeRule

import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Plus, X } from 'lucide-react'
import type { ActivityPalette } from '../../types'
import { DAY_MINUTES, minuteToHHmm, newItemId, normalizeRule, parseHHmm } from '../../lib/islands/island-model'
import type { IslandItem, IslandKind, IslandLock, IslandRule } from '../../lib/islands/island-model'
import IslandLockEditor from './IslandLockEditor'
import { theme, ti, tiInput, tiSurface } from '../../theme'

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
const TIME_STEP_SECONDS = 300

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
  const [lock, setLock] = useState<IslandLock | null>(initial?.lock ?? null)
  const [error, setError] = useState<string | null>(null)

  const anchorTag = palette.tags.find((t) => t.id === anchorTagId) ?? null
  const tagResults = useMemo(() => {
    const q = tagQuery.trim().toLowerCase()
    const sorted = [...palette.tags].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    return (q ? sorted.filter((t) => t.fullPath.toLowerCase().includes(q)) : sorted).slice(0, TAG_RESULT_LIMIT)
  }, [tagQuery, palette.tags])

  const submit = () => {
    try {
      const rule = normalizeRule({
        name,
        kind,
        anchorTagId,
        windowStart: parseHHmm(windowStart) ?? 0,
        windowEnd: parseHHmm(windowEnd) ?? DAY_MINUTES,
        offsetMin,
        latestStart: parseHHmm(latestStart),
        startMinute: parseHHmm(startTime) ?? 0,
        durationMin,
        items,
        color: initial?.color ?? null,
        enabled,
        lock,
      })
      setError(null)
      onSave(rule)
    } catch (err) {
      setError(err instanceof Error ? err.message : '这条规则填得不对')
    }
  }

  const setItemTitle = (id: string, title: string) => setItems((list) => list.map((item) => (item.id === id ? { ...item, title } : item)))

  return (
    <div style={styles.root}>
      <div style={styles.kindRow}>
        <button type="button" className="ti-key" data-active={kind === 'after' ? '1' : undefined} onClick={() => setKind('after')} style={styles.kindKey}>
          浮岛 · 跟在某件事后面
        </button>
        <button type="button" className="ti-key" data-active={kind === 'fixed' ? '1' : undefined} onClick={() => setKind('fixed')} style={styles.kindKey}>
          日程 · 钉在钟点
        </button>
      </div>

      <Field label="名字">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'after' ? '例如：起床后' : '例如：早睡'} style={styles.input} />
      </Field>

      {kind === 'after' ? (
        <>
          <Field label="跟在哪个标签后面">
            {anchorTag ? (
              <button type="button" className="ti-key" onClick={() => setAnchorTagId(null)} style={styles.tagChosen}>
                <span style={styles.ellipsis}>{anchorTag.fullPath}</span>
                <X size={12} />
              </button>
            ) : (
              <div style={styles.tagPicker}>
                <input value={tagQuery} onChange={(e) => setTagQuery(e.target.value)} placeholder="搜标签，例如 睡眠 / 吃饭" style={styles.input} />
                <div style={styles.tagResults}>
                  {tagResults.length === 0 ? (
                    <div style={styles.hint}>没有匹配的标签</div>
                  ) : tagResults.map((tag) => (
                    <button key={tag.id} type="button" className="ti-key" onClick={() => { setAnchorTagId(tag.id); setTagQuery('') }} style={styles.tagResult}>
                      <span style={styles.ellipsis}>{tag.fullPath}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Field>
          <Field label="只认这个时段里结束的那一次" hint="同一个标签一天出现好几次时用，比如只认 11:00–17:00 吃完的那顿。结束留空 = 到午夜">
            <div style={styles.pair}>
              <TimeInput value={windowStart} onChange={setWindowStart} />
              <span style={styles.dash}>–</span>
              <TimeInput value={windowEnd} onChange={setWindowEnd} />
            </div>
          </Field>
          <div style={styles.cols}>
            <Field label="结束后隔多久（分钟）">
              <input value={offsetMin} inputMode="numeric" onChange={(e) => setOffsetMin(e.target.value)} style={styles.input} />
            </Field>
            <Field label="最晚开始" hint="留空 = 一直跟着漂">
              <TimeInput value={latestStart} onChange={setLatestStart} />
            </Field>
          </div>
        </>
      ) : (
        <Field label="几点开始">
          <TimeInput value={startTime} onChange={setStartTime} />
        </Field>
      )}

      <Field label="占多久（分钟）">
        <input value={durationMin} inputMode="numeric" onChange={(e) => setDurationMin(e.target.value)} style={styles.input} />
      </Field>

      <Field label="里面要做的事" hint="全勾完算这块做完；不列 = 整块勾一次">
        <div style={styles.items}>
          {items.map((item) => (
            <div key={item.id} style={styles.itemRow}>
              <input value={item.title} onChange={(e) => setItemTitle(item.id, e.target.value)} placeholder="例如：烧水" style={styles.input} />
              <button type="button" className="ti-key" onClick={() => setItems((list) => list.filter((i) => i.id !== item.id))} style={styles.iconKey} aria-label="去掉这件事">
                <X size={12} />
              </button>
            </div>
          ))}
          <button type="button" className="ti-key" onClick={() => setItems((list) => [...list, { id: newItemId(), title: '' }])} style={styles.addItem}>
            <Plus size={12} />
            加一件事
          </button>
        </div>
      </Field>

      <div style={styles.field}>
        <span style={styles.label}>这段时间锁住</span>
        <span style={styles.hint}>可不填。到了这一条的时间自动锁上名单里的应用和网站，做完或到点解开</span>
        <IslandLockEditor lock={lock} onChange={setLock} />
      </div>

      {initial && (
        <button type="button" className="ti-key" data-active={enabled ? '1' : undefined} onClick={() => setEnabled((v) => !v)} style={styles.enableKey}>
          {enabled ? '启用中' : '已停用（不出现在昼夜表上）'}
        </button>
      )}

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.actions}>
        <button type="button" className="ti-key" onClick={onCancel} disabled={busy} style={styles.actionKey}>取消</button>
        <button type="button" className="ti-key ti-key-primary" onClick={submit} disabled={busy} style={styles.actionKey}>保存</button>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: React.ReactNode }) {
  return (
    <label style={styles.field}>
      <span style={styles.label}>{label}</span>
      {children}
      {hint && <span style={styles.hint}>{hint}</span>}
    </label>
  )
}

function TimeInput({ value, onChange }: { readonly value: string; readonly onChange: (v: string) => void }) {
  return <input type="time" step={TIME_STEP_SECONDS} value={value} onChange={(e) => onChange(e.target.value)} style={styles.time} />
}

const inputBase: CSSProperties = {
  ...tiInput,
  width: '100%',
  boxSizing: 'border-box',
  height: 28,
  fontSize: 12,
  fontFamily: theme.fontBody,
  padding: '0 8px',
}

const styles: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 10 },
  kindRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
  kindKey: { height: 28, fontSize: 11, padding: '0 6px' },
  field: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 },
  label: { fontSize: 10.5, fontWeight: 700, letterSpacing: 1, color: theme.textMuted },
  hint: { fontSize: 10.5, lineHeight: 1.5, color: ti.textFaint },
  input: inputBase,
  time: { ...inputBase, fontFamily: theme.fontMono, colorScheme: 'dark' },
  pair: { display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 6 },
  dash: { color: theme.textMuted, fontSize: 12 },
  cols: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  tagPicker: { display: 'flex', flexDirection: 'column', gap: 6 },
  tagResults: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    maxHeight: 132,
    overflow: 'auto',
    padding: 5,
    borderRadius: 6,
    background: tiSurface.plate,
    boxShadow: tiSurface.popShadow,
  },
  tagResult: { minHeight: 24, justifyContent: 'flex-start', padding: '2px 8px', fontSize: 11.5, color: theme.textSecondary, textAlign: 'left' },
  tagChosen: { minHeight: 28, display: 'grid', gridTemplateColumns: '1fr 14px', alignItems: 'center', gap: 6, padding: '4px 8px', fontSize: 11.5, color: theme.textPrimary, textAlign: 'left' },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  items: { display: 'flex', flexDirection: 'column', gap: 6 },
  itemRow: { display: 'grid', gridTemplateColumns: '1fr 28px', gap: 6 },
  iconKey: { width: 28, height: 28, padding: 0, color: theme.textMuted },
  addItem: { height: 26, gap: 4, fontSize: 11.5, color: theme.textSecondary },
  enableKey: { height: 28, fontSize: 11.5 },
  error: { fontSize: 11, color: theme.dangerRed },
  actions: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 2 },
  actionKey: { height: 30, fontSize: 12.5 },
}
