// 协议志 · 协议：一份白名单（应用 / 网站）的编辑——条目可标灰色、可删；
// 应用这边列出最近 7 天常用的应用（感知层统计）当候选，点一下加进来；网站这边可一键加常用开发站点

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import Tooltip from '../../Tooltip'
import { fetchAppUsage, type AllowEntry, type AppUsage } from '../../../lib/protocol-api'
import { addEntry, DEV_SITE_PRESET, formatDuration, normalizeSiteInput, removeEntry, toggleGray } from './lock-model'

const USAGE_DAYS = 7
const CANDIDATE_LIMIT = 14
/** 候选里不列的：Solevup 自己和系统外壳在协议里本来就永远放行 */
const ALWAYS_ALLOWED = new Set(['solevup.exe', 'explorer.exe', 'dwm.exe', 'searchhost.exe', 'searchapp.exe', 'taskmgr.exe'])

export interface AllowListProps {
  readonly kind: 'app' | 'site'
  readonly entries: readonly AllowEntry[]
  readonly onChange: (next: readonly AllowEntry[]) => void
}

export default function AllowList({ kind, entries, onChange }: AllowListProps) {
  const [draft, setDraft] = useState('')
  const [usage, setUsage] = useState<readonly AppUsage[]>([])

  useEffect(() => {
    if (kind !== 'app') return
    let alive = true
    fetchAppUsage(USAGE_DAYS)
      .then((list) => { if (alive) setUsage(list) })
      .catch(() => { /* 候选只是辅助，拉不到就不显示 */ })
    return () => { alive = false }
  }, [kind])

  const add = () => {
    const rule = kind === 'site' ? normalizeSiteInput(draft) : draft.trim()
    if (!rule) return
    onChange(addEntry(entries, rule))
    setDraft('')
  }

  const listed = new Set(entries.map((e) => e.rule.toLowerCase()))
  const candidates = usage
    .filter((u) => !listed.has(u.app.toLowerCase()) && !ALWAYS_ALLOWED.has(u.app.toLowerCase()))
    .slice(0, CANDIDATE_LIMIT)
  const missingPreset = DEV_SITE_PRESET.filter((s) => !listed.has(s))

  return (
    <div>
      {entries.length > 0 ? (
        <div className="pl-chips">
          {entries.map((e) => (
            <span key={e.rule} className="pl-chip" data-gray={e.gray ? '1' : undefined}>
              {e.rule}
              <Tooltip content={e.gray ? '灰色地带：放行，但学习还是娱乐留给 AI 判断（点一下改回普通放行）' : '标成灰色地带：放行，但学习还是娱乐留给 AI 判断'}>
                <button type="button" className="pl-chip-btn" aria-pressed={e.gray} onClick={() => onChange(toggleGray(entries, e.rule))}>
                  灰
                </button>
              </Tooltip>
              <button type="button" className="pl-chip-btn" aria-label={`移除 ${e.rule}`} onClick={() => onChange(removeEntry(entries, e.rule))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="pl-hint">
          {kind === 'app' ? '还没有放行的应用' : '还没有放行的网站：开局后浏览器里所有网站都会被拦'}
        </div>
      )}

      <div className="pl-add">
        <input
          className="pl-input"
          value={draft}
          placeholder={kind === 'app' ? '应用 exe 名，例如 WindowsTerminal.exe' : '域名，例如 github.com（可带路径和 *）'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
        />
        <button type="button" className="ti-key" style={{ height: 30, padding: '0 14px', fontSize: 12.5 }} onClick={add}>
          添加
        </button>
      </div>

      {kind === 'app' && candidates.length > 0 && (
        <>
          <div className="pl-hint" style={{ marginTop: 10 }}>最近 {USAGE_DAYS} 天常用（点一下放行）</div>
          <div className="pl-cands">
            {candidates.map((u) => (
              <button key={u.app} type="button" className="pl-cand" onClick={() => onChange(addEntry(entries, u.app))}>
                {u.app}
                <span className="pl-cand-time">{formatDuration(u.seconds)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {kind === 'site' && missingPreset.length > 0 && (
        <div className="pl-cands">
          <Tooltip content={missingPreset.join('、')}>
            <button
              type="button"
              className="pl-cand"
              onClick={() => onChange(missingPreset.reduce<readonly AllowEntry[]>((acc, s) => addEntry(acc, s), entries))}
            >
              加入写代码常用站点（{missingPreset.length} 个）
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  )
}
