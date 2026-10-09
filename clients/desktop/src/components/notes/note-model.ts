// ══════════════════════════════════════════════
// 洪流域 · 笔记的纯函数（不碰界面、不碰网络）：页面树索引、祖先链、拖放落点、正文抽纯文本
// ══════════════════════════════════════════════

import type { NotePageMeta } from '../../lib/notes-api'

export interface PageIndex {
  readonly byId: ReadonlyMap<string, NotePageMeta>
  /** 父 id → 有序子页面；顶层的 key 是 null */
  readonly children: ReadonlyMap<string | null, readonly NotePageMeta[]>
}

const bySortOrder = (a: NotePageMeta, b: NotePageMeta) =>
  a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)

export function indexPages(pages: readonly NotePageMeta[]): PageIndex {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const children = new Map<string | null, NotePageMeta[]>()
  for (const p of pages) {
    // 父页面不在列表里（数据异常）就挂到顶层，至少别丢
    const key = p.parentId != null && byId.has(p.parentId) ? p.parentId : null
    const list = children.get(key)
    if (list) list.push(p)
    else children.set(key, [p])
  }
  for (const list of children.values()) list.sort(bySortOrder)
  return { byId, children }
}

export function pageTitle(meta: Pick<NotePageMeta, 'title'> | null | undefined): string {
  return meta?.title.trim() || '无标题'
}

/** 从顶层到父页面的祖先链（不含自己） */
export function ancestorsOf(id: string, byId: ReadonlyMap<string, NotePageMeta>): NotePageMeta[] {
  const out: NotePageMeta[] = []
  const seen = new Set<string>([id])
  let cur = byId.get(id)?.parentId ?? null
  while (cur != null && !seen.has(cur)) {
    const meta = byId.get(cur)
    if (!meta) break
    out.unshift(meta)
    seen.add(cur)
    cur = meta.parentId
  }
  return out
}

/** candidate 是不是 ancestor 自己或它的子孙 */
export function isInSubtree(candidateId: string, ancestorId: string, byId: ReadonlyMap<string, NotePageMeta>): boolean {
  if (candidateId === ancestorId) return true
  return ancestorsOf(candidateId, byId).some((a) => a.id === ancestorId)
}

/** 某页面的整棵子树 id（含自己） */
export function subtreeIds(id: string, index: PageIndex): Set<string> {
  const out = new Set<string>()
  const walk = (pid: string) => {
    if (out.has(pid)) return
    out.add(pid)
    for (const c of index.children.get(pid) ?? []) walk(c.id)
  }
  walk(id)
  return out
}

// ── 拖放 ──

export type DropZone = 'before' | 'after' | 'inside'

/** 行内纵向位置 → 落点：上 1/4 插到前面、下 1/4 插到后面、中间放进去当子页面 */
export function zoneFromOffset(offsetY: number, height: number): DropZone {
  if (offsetY < height * 0.27) return 'before'
  if (offsetY > height * 0.73) return 'after'
  return 'inside'
}

/** 拖放落点 → 后端 move 需要的（新父页面, 序号）；不合法（拖进自己子树）返回 null */
export function resolveDrop(
  dragId: string,
  target: NotePageMeta,
  zone: DropZone,
  index: PageIndex,
): { parentId: string | null; index: number } | null {
  if (isInSubtree(target.id, dragId, index.byId)) return null
  if (zone === 'inside') {
    const kids = (index.children.get(target.id) ?? []).filter((c) => c.id !== dragId)
    return { parentId: target.id, index: kids.length }
  }
  const parentKey = target.parentId != null && index.byId.has(target.parentId) ? target.parentId : null
  const siblings = (index.children.get(parentKey) ?? []).filter((c) => c.id !== dragId)
  const at = siblings.findIndex((c) => c.id === target.id)
  return { parentId: parentKey, index: zone === 'before' ? at : at + 1 }
}

/** 本地先把移动做掉（界面立刻有反应）：换父页面 + 新兄弟从 0 重编号 */
export function applyMove(
  pages: readonly NotePageMeta[],
  id: string,
  parentId: string | null,
  at: number,
): NotePageMeta[] {
  const moving = pages.find((p) => p.id === id)
  if (!moving) return [...pages]
  const siblings = pages
    .filter((p) => p.id !== id && (p.parentId ?? null) === parentId)
    .sort(bySortOrder)
  const ordered = [...siblings]
  ordered.splice(Math.min(Math.max(at, 0), ordered.length), 0, { ...moving, parentId })
  const newOrder = new Map(ordered.map((p, i) => [p.id, i]))
  return pages.map((p) => {
    const order = newOrder.get(p.id)
    if (order === undefined) return p
    return { ...p, parentId: p.id === id ? parentId : p.parentId, sortOrder: order }
  })
}

// ── 正文 → 纯文本（给搜索用）──

type Loose = Record<string, unknown>

const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null

function inlineText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((item) => {
    if (typeof item === 'string') return item
    if (!isObj(item)) return ''
    if (item.type === 'text' && typeof item.text === 'string') return item.text
    if (item.type === 'link') return inlineText(item.content)
    return ''
  }).join('')
}

function tableText(content: Loose): string {
  const rows = Array.isArray(content.rows) ? content.rows : []
  return rows.map((row) => {
    const cells = isObj(row) && Array.isArray(row.cells) ? row.cells : []
    // 单元格两种形态：直接是行内数组，或 { type: 'tableCell', content: [...] }
    return cells.map((cell) => inlineText(isObj(cell) && !Array.isArray(cell) ? cell.content : cell)).join(' | ')
  }).join('\n')
}

export function blocksToText(blocks: readonly unknown[]): string {
  const lines: string[] = []
  const walk = (list: readonly unknown[]) => {
    for (const b of list) {
      if (!isObj(b)) continue
      const content = b.content
      const line = isObj(content) && !Array.isArray(content) && content.type === 'tableContent'
        ? tableText(content)
        : inlineText(content)
      if (line.trim()) lines.push(line)
      if (Array.isArray(b.children)) walk(b.children)
    }
  }
  walk(blocks)
  return lines.join('\n')
}

// ── 时间 ──

/** 后端时间「2026-10-09 12:30:00」（本地时间）→ 「10月9日 12:30」/「今天 12:30」 */
export function formatNoteTime(s: string | null): string {
  if (!s) return ''
  const d = new Date(s.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return s
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `今天 ${hm}`
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}年${md}`
}
