// 浮岛 / 日程的锁名单：这一条进行期间要锁住的应用和网站（规则见 lib/islands/island-model.ts IslandLock）
//   应用只编辑这台设备的那几项，别的设备的原样留着；网站各端通用
//   条目点「灰」= 不直接拦，交给判断模型看这段内容算不算跑偏

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import Tooltip from '../Tooltip'
import { fetchAppUsage, type AppUsage } from '../../lib/protocol-api'
import type { IslandLock, IslandLockEntry } from '../../lib/islands/island-model'
import { LOCK_PLATFORM } from '../../lib/islands/lock-platform'
import { formatDuration, normalizeSiteInput } from '../protocol/lock/lock-model'
import '../protocol/lock/lock.css'

const USAGE_DAYS = 7
const CANDIDATE_LIMIT = 10
/** 候选里不列的：锁了会把自己或系统外壳压下去 */
const NEVER_LOCK = new Set(['solevup.exe', 'explorer.exe', 'dwm.exe', 'searchhost.exe', 'searchapp.exe', 'taskmgr.exe'])
const EMPTY: IslandLock = { apps: [], sites: [], intent: '', untilDone: false }
const PLATFORM_NAME = { windows: '这台电脑（Windows）', mac: '这台 Mac', android: '手机' } as const

interface Props {
  readonly lock: IslandLock | null
  readonly onChange: (lock: IslandLock) => void
}

export default function IslandLockEditor({ lock, onChange }: Props) {
  const value = lock ?? EMPTY
  const [appDraft, setAppDraft] = useState('')
  const [siteDraft, setSiteDraft] = useState('')
  const [usage, setUsage] = useState<readonly AppUsage[]>([])

  useEffect(() => {
    let alive = true
    fetchAppUsage(USAGE_DAYS)
      .then((list) => { if (alive) setUsage(list) })
      .catch(() => { /* 候选只是辅助，拉不到就不显示 */ })
    return () => { alive = false }
  }, [])

  const mine = value.apps.filter((e) => e.platform === LOCK_PLATFORM)
  const others = value.apps.filter((e) => e.platform !== LOCK_PLATFORM)
  const setMine = (next: readonly IslandLockEntry[]) =>
    onChange({ ...value, apps: [...others, ...next.map((e) => ({ ...e, platform: LOCK_PLATFORM }))] })
  const setSites = (sites: readonly IslandLockEntry[]) => onChange({ ...value, sites })

  const addApp = (raw: string) => {
    const rule = raw.trim()
    if (!rule || mine.some((e) => e.rule.toLowerCase() === rule.toLowerCase())) return
    setMine([...mine, { rule, gray: false }])
    setAppDraft('')
  }
  const addSite = () => {
    const rule = normalizeSiteInput(siteDraft)
    if (!rule || value.sites.some((e) => e.rule.toLowerCase() === rule.toLowerCase())) return
    setSites([...value.sites, { rule, gray: false }])
    setSiteDraft('')
  }

  const listed = new Set(mine.map((e) => e.rule.toLowerCase()))
  const candidates = usage
    .filter((u) => !listed.has(u.app.toLowerCase()) && !NEVER_LOCK.has(u.app.toLowerCase()))
    .slice(0, CANDIDATE_LIMIT)
  const hasGray = value.apps.some((e) => e.gray) || value.sites.some((e) => e.gray)
  const hasAny = value.apps.length > 0 || value.sites.length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="pl-hint">应用 · {PLATFORM_NAME[LOCK_PLATFORM]}</div>
      <Chips entries={mine} onChange={setMine} />
      <AddRow value={appDraft} onChange={setAppDraft} onAdd={() => addApp(appDraft)} placeholder="应用 exe 名，例如 steam.exe" />
      {candidates.length > 0 && (
        <div className="pl-cands" style={{ marginTop: 0 }}>
          {candidates.map((u) => (
            <button key={u.app} type="button" className="pl-cand" onClick={() => addApp(u.app)}>
              {u.app}
              <span className="pl-cand-time">{formatDuration(u.seconds)}</span>
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && <div className="pl-hint">另有 {others.length} 项是别的设备上的应用，在那台设备上改</div>}

      <div className="pl-hint" style={{ marginTop: 4 }}>网站 · 浏览器照常用，只拦这些站</div>
      <Chips entries={value.sites} onChange={setSites} />
      <AddRow value={siteDraft} onChange={setSiteDraft} onAdd={addSite} placeholder="域名，例如 bilibili.com（可带路径和 *）" />

      {hasAny && (
        <button
          type="button"
          className="ti-key"
          data-active={value.untilDone ? '1' : undefined}
          onClick={() => onChange({ ...value, untilDone: !value.untilDone })}
          style={{ height: 28, fontSize: 11.5 }}
        >
          {value.untilDone ? '里面的事全勾完才解开' : '到结束时刻自动解开（勾完也会提前解开）'}
        </button>
      )}
      {hasAny && (
        <>
          <div className="pl-hint" style={{ marginTop: 4 }}>
            判断标准 · 给 AI 看的一段话{hasGray ? '' : '（有标「灰」的条目才用得上）'}
          </div>
          <textarea
            className="pl-textarea"
            value={value.intent}
            rows={3}
            placeholder={'灰色项算不算跑偏按这段话判。自己写，或者让 Fairy 帮你写。\n例如：这段时间在健身，看动作教学、训练计划算正事，刷别的视频算跑偏。\n不填就只按这一条的名字判'}
            onChange={(e) => onChange({ ...value, intent: e.target.value })}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 12 }}
          />
        </>
      )}
    </div>
  )
}

function Chips({ entries, onChange }: { readonly entries: readonly IslandLockEntry[]; readonly onChange: (next: readonly IslandLockEntry[]) => void }) {
  if (entries.length === 0) return null
  return (
    <div className="pl-chips">
      {entries.map((e) => (
        <span key={e.rule} className="pl-chip" data-gray={e.gray ? '1' : undefined}>
          {e.rule}
          <Tooltip content={e.gray ? '灰色地带：不直接拦，算不算跑偏交给 AI 判断（点一下改回直接拦）' : '标成灰色地带：不直接拦，算不算跑偏交给 AI 判断'}>
            <button
              type="button"
              className="pl-chip-btn"
              aria-pressed={e.gray}
              onClick={() => onChange(entries.map((x) => (x.rule === e.rule ? { ...x, gray: !x.gray } : x)))}
            >
              灰
            </button>
          </Tooltip>
          <button type="button" className="pl-chip-btn" aria-label={`移除 ${e.rule}`} onClick={() => onChange(entries.filter((x) => x.rule !== e.rule))}>
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  )
}

function AddRow({ value, onChange, onAdd, placeholder }: {
  readonly value: string
  readonly onChange: (v: string) => void
  readonly onAdd: () => void
  readonly placeholder: string
}) {
  return (
    <div className="pl-add" style={{ marginTop: 0, maxWidth: 'none' }}>
      <input
        className="pl-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          // 表单里回车别顺手触发别的键
          e.preventDefault()
          onAdd()
        }}
        style={{ flex: 1, minWidth: 0 }}
      />
      <button type="button" className="ti-key" style={{ height: 30, padding: '0 12px', fontSize: 12 }} onClick={onAdd}>
        加
      </button>
    </div>
  )
}
