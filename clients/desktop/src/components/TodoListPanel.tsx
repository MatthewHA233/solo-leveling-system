import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Check, Circle, DatabaseZap, FolderSearch, GitBranch, ListTodo, Plus, Search, Target, Trash2, X } from 'lucide-react'
import type { ActivityPalette, ActivityTag, PlanNode } from '../types'
import { addPlanNode, deletePlanNode, updatePlanNode } from '../lib/local-api'
import { hud, theme } from '../theme'
import { HudFrame } from './hud'

interface Props {
  readonly selectedDate: Date
  readonly palette: ActivityPalette
  readonly nodes: PlanNode[]
  readonly selectedProjectTagId: number | null
  readonly selectedPlanNodeId: number | null
  readonly onSelectProject: (id: number) => void
  readonly onSelectNode: (id: number | null) => void
  readonly onNodesChange: (projectTagId?: number) => void
}

type PlanStatus = PlanNode['status']

interface TreeEntry {
  readonly node: PlanNode
  readonly depth: number
}

const STATUS_LABELS: Record<PlanStatus, string> = {
  active: '待安排',
  done: '已完成',
  archived: '已归档',
}

const STATUS_ORDER: readonly PlanStatus[] = ['active', 'done', 'archived']

function toDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[，、/\\|>:_-]+/g, ' ')
}

function splitTagPath(tag: ActivityTag): string[] {
  return tag.fullPath
    .split(/[，,、/\\|>]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function scoreTag(tag: ActivityTag, query: string, selectedProjectTagId: number | null): number {
  const q = query.trim()
  let score = tag.id === selectedProjectTagId ? 1 : 0
  if (!q) {
    const touchedAt = Date.parse(tag.lastUsedAt || tag.createdAt || '')
    return score + (Number.isFinite(touchedAt) ? touchedAt / 10000000000000 : 0)
  }

  const normalizedQuery = normalize(q)
  const normalizedPath = normalize(`${tag.fullPath} ${tag.leafName}`)
  const terms = normalizedQuery.split(/\s+/).filter((term) => term.length >= 2)
  for (const term of terms) {
    if (normalizedPath.includes(term)) score += term.length * 8
  }
  for (const segment of splitTagPath(tag)) {
    const normalizedSegment = normalize(segment).trim()
    if (!normalizedSegment) continue
    if (normalizedQuery.includes(normalizedSegment)) score += normalizedSegment.length * 10
    if (normalizedSegment.includes(normalizedQuery) && normalizedQuery.length >= 2) score += normalizedQuery.length * 5
  }
  if (normalize(tag.leafName).includes(normalizedQuery) && normalizedQuery.length >= 2) score += 16
  return score
}

function rankProjectTags(
  tags: readonly ActivityTag[],
  query: string,
  selectedProjectTagId: number | null,
  limit = 6,
): ActivityTag[] {
  const hasQuery = query.trim().length > 0
  return [...tags]
    .map((tag) => ({ tag, score: scoreTag(tag, query, selectedProjectTagId) }))
    .filter(({ tag, score }) => hasQuery ? score > (tag.id === selectedProjectTagId ? 1 : 0) : true)
    .sort((a, b) => {
      const aTouched = Date.parse(a.tag.lastUsedAt || a.tag.createdAt || '')
      const bTouched = Date.parse(b.tag.lastUsedAt || b.tag.createdAt || '')
      return b.score - a.score
        || (Number.isFinite(bTouched) ? bTouched : 0) - (Number.isFinite(aTouched) ? aTouched : 0)
    })
    .slice(0, limit)
    .map(({ tag }) => tag)
}

function flattenPlanTree(nodes: readonly PlanNode[]): TreeEntry[] {
  const byId = new Set(nodes.map((node) => node.id))
  const children = new Map<number | null, PlanNode[]>()
  for (const node of nodes) {
    const parentId = node.parentId != null && byId.has(node.parentId) ? node.parentId : null
    const bucket = children.get(parentId) ?? []
    bucket.push(node)
    children.set(parentId, bucket)
  }

  for (const bucket of children.values()) {
    bucket.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
  }

  const result: TreeEntry[] = []
  const visit = (parentId: number | null, depth: number) => {
    for (const node of children.get(parentId) ?? []) {
      result.push({ node, depth })
      visit(node.id, depth + 1)
    }
  }
  visit(null, 0)
  return result
}

export default function TodoListPanel({
  selectedDate,
  palette,
  nodes,
  selectedProjectTagId,
  selectedPlanNodeId,
  onSelectProject,
  onSelectNode,
  onNodesChange,
}: Props) {
  const dateKey = toDateKey(selectedDate)
  const [draft, setDraft] = useState('')
  const [projectSearchOpen, setProjectSearchOpen] = useState(false)
  const [projectQuery, setProjectQuery] = useState('')
  const [subtaskParentId, setSubtaskParentId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedProject = useMemo(
    () => palette.tags.find((tag) => tag.id === selectedProjectTagId) ?? null,
    [palette.tags, selectedProjectTagId],
  )
  const draftSuggestions = useMemo(
    () => rankProjectTags(palette.tags, draft, selectedProjectTagId, 5),
    [palette.tags, draft, selectedProjectTagId],
  )
  const searchResults = useMemo(
    () => rankProjectTags(palette.tags, projectQuery, selectedProjectTagId, 8),
    [palette.tags, projectQuery, selectedProjectTagId],
  )
  const subtaskParent = nodes.find((node) => node.id === subtaskParentId) ?? null
  const subtaskProject = subtaskParent
    ? palette.tags.find((tag) => tag.id === subtaskParent.projectTagId) ?? null
    : null
  const targetProject = subtaskProject ?? (draft.trim() && draftSuggestions[0] ? draftSuggestions[0] : selectedProject ?? palette.tags[0] ?? null)
  const tree = useMemo(() => flattenPlanTree(nodes), [nodes])
  const grouped = useMemo(() => {
    const map = new Map<PlanStatus, TreeEntry[]>()
    for (const status of STATUS_ORDER) map.set(status, [])
    for (const entry of tree) map.get(entry.node.status)?.push(entry)
    return map
  }, [tree])
  const stats = useMemo(() => {
    const total = nodes.length
    const done = nodes.filter((node) => node.status === 'done').length
    const active = nodes.filter((node) => node.status === 'active').length
    return { total, done, active }
  }, [nodes])

  const selectProject = (id: number) => {
    onSelectProject(id)
    onSelectNode(null)
    onNodesChange(id)
    setProjectSearchOpen(false)
    setProjectQuery('')
  }

  const createNode = async () => {
    const title = draft.trim()
    if (!title || !targetProject || busy) return
    setBusy(true)
    setError(null)
    try {
      const node = await addPlanNode(targetProject.id, title, subtaskParent?.id ?? null)
      onSelectProject(targetProject.id)
      onSelectNode(node.id)
      onNodesChange(targetProject.id)
      setDraft('')
      setSubtaskParentId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '新增计划失败')
    } finally {
      setBusy(false)
    }
  }

  const patchNode = async (node: PlanNode, status: PlanStatus) => {
    setBusy(true)
    setError(null)
    try {
      await updatePlanNode(node.id, { status })
      onNodesChange(node.projectTagId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新计划失败')
    } finally {
      setBusy(false)
    }
  }

  const removeNode = async (node: PlanNode) => {
    setBusy(true)
    setError(null)
    try {
      await deletePlanNode(node.id)
      if (selectedPlanNodeId === node.id) onSelectNode(null)
      onNodesChange(node.projectTagId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除计划失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={styles.root}>
      <HudFrame
        color={theme.warningOrange}
        accent={theme.electricBlue}
        topLabel="PLAN · 计划安排"
        showNotchTop
        showNotchBottom={false}
        notchWidth={86}
        notchDepth={7}
        cornerSize={14}
        intensity="soft"
      />

      <div style={styles.inner}>
        <header style={styles.header}>
          <div>
            <div style={styles.kicker}>DAY PLAN DOCK</div>
            <div style={styles.titleRow}>
              <DatabaseZap size={17} color={theme.warningOrange} />
              <h2 style={styles.title}>计划安排</h2>
            </div>
          </div>
          <div style={styles.dateBadge}>{dateKey}</div>
        </header>

        <div style={styles.statsRow}>
          <Stat label="节点" value={String(stats.total)} />
          <Stat label="待安排" value={String(stats.active)} />
          <Stat label="完成" value={`${stats.done}/${stats.total || 0}`} />
        </div>

        <section style={styles.projectBox}>
          <div style={styles.projectLabel}>当前项目</div>
          <button type="button" onClick={() => setProjectSearchOpen((v) => !v)} style={styles.projectChip}>
            <FolderSearch size={13} />
            <span style={styles.projectChipText}>{selectedProject?.fullPath ?? '选择一个项目标签'}</span>
            {projectSearchOpen ? <X size={12} /> : <Search size={12} />}
          </button>
          {draft.trim() && targetProject && targetProject.id !== selectedProject?.id && (
            <button type="button" onClick={() => selectProject(targetProject.id)} style={styles.recommendButton}>
              推荐绑定：{targetProject.fullPath}
            </button>
          )}
          {projectSearchOpen && (
            <div style={styles.searchPanel}>
              <input
                value={projectQuery}
                placeholder="搜索项目标签，例如 solo / 前端 / 写作"
                onChange={(e) => setProjectQuery(e.target.value)}
                style={styles.searchInput}
              />
              <div style={styles.searchResults}>
                {searchResults.length === 0 ? (
                  <div style={styles.emptyLine}>没有匹配项目标签</div>
                ) : searchResults.map((tag) => (
                  <button key={tag.id} type="button" onClick={() => selectProject(tag.id)} style={styles.searchItem}>
                    <Target size={12} color={tag.id === selectedProjectTagId ? theme.warningOrange : theme.textMuted} />
                    <span>{tag.fullPath}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <section style={styles.composer}>
          {subtaskParent && (
            <div style={styles.subtaskBar}>
              <GitBranch size={12} />
              <span>作为子任务添加到：{subtaskParent.title}</span>
              <button type="button" onClick={() => setSubtaskParentId(null)} style={styles.clearSubtaskButton}>
                <X size={11} />
              </button>
            </div>
          )}
          <textarea
            value={draft}
            rows={2}
            placeholder="输入计划，例如：把右侧 TodoList 接到真实计划节点"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') createNode()
            }}
            style={styles.textarea}
          />
          <div style={styles.composerBar}>
            <div style={styles.targetHint}>
              <ListTodo size={12} />
              <span>{targetProject ? `将写入：${targetProject.fullPath}` : '还没有可绑定的项目标签'}</span>
            </div>
            <button type="button" onClick={createNode} disabled={!draft.trim() || !targetProject || busy} style={{
              ...styles.addButton,
              opacity: !draft.trim() || !targetProject || busy ? 0.55 : 1,
            }}>
              <Plus size={13} />
              新增
            </button>
          </div>
          {error && <div style={styles.errorLine}>{error}</div>}
        </section>

        <section style={styles.list}>
          {STATUS_ORDER.map((status) => {
            const items = grouped.get(status) ?? []
            if (status === 'archived' && items.length === 0) return null
            return (
              <div key={status} style={styles.group}>
                <div style={styles.groupHeader}>
                  <span>{STATUS_LABELS[status]}</span>
                  <span style={styles.groupCount}>{items.length}</span>
                </div>
                {items.length === 0 ? (
                  <div style={styles.emptyLine}>暂无计划节点</div>
                ) : items.map(({ node, depth }) => (
                  <PlanNodeCard
                    key={node.id}
                    node={node}
                    depth={depth}
                    selected={node.id === selectedPlanNodeId}
                    disabled={busy}
                    onSelect={() => onSelectNode(node.id)}
                    onToggleDone={() => patchNode(node, node.status === 'done' ? 'active' : 'done')}
                    onAddChild={() => {
                      setSubtaskParentId(node.id)
                      setDraft('')
                    }}
                    onDelete={() => removeNode(node)}
                  />
                ))}
              </div>
            )
          })}
        </section>
      </div>
    </div>
  )
}

function PlanNodeCard({
  node,
  depth,
  selected,
  disabled,
  onSelect,
  onToggleDone,
  onAddChild,
  onDelete,
}: {
  readonly node: PlanNode
  readonly depth: number
  readonly selected: boolean
  readonly disabled: boolean
  readonly onSelect: () => void
  readonly onToggleDone: () => void
  readonly onAddChild: () => void
  readonly onDelete: () => void
}) {
  const completed = node.status === 'done'
  const color = completed ? theme.expGreen : theme.warningOrange
  return (
    <article
      onClick={onSelect}
      style={{
        ...styles.card,
        marginLeft: Math.min(depth, 4) * 12,
        opacity: completed ? 0.62 : 1,
        borderColor: selected ? theme.electricBlue : `${color}66`,
        boxShadow: selected ? `0 0 12px ${theme.electricBlue}44` : 'none',
      }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); onToggleDone() }}
        style={styles.doneButton}
        title={completed ? '标记为待安排' : '标记为完成'}
      >
        {completed ? <Check size={13} /> : <Circle size={13} />}
      </button>
      <div style={styles.cardBody}>
        <div style={{
          ...styles.cardTitle,
          textDecoration: completed ? 'line-through' : 'none',
        }}>
          {node.title}
        </div>
        <div style={styles.cardMeta}>
          <span style={{ ...styles.statusPill, color, borderColor: `${color}66` }}>
            {STATUS_LABELS[node.status]}
          </span>
          {node.parentId != null && (
            <span style={styles.branchPill}>
              <GitBranch size={10} />
              子任务
            </span>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={(e) => { e.stopPropagation(); onAddChild() }}
            style={styles.inlineButton}
          >
            + 子任务
          </button>
        </div>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        style={styles.deleteButton}
        title="删除计划节点"
      >
        <Trash2 size={12} />
      </button>
    </article>
  )
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div style={styles.stat}>
      <span style={styles.statLabel}>{label}</span>
      <span style={styles.statValue}>{value}</span>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  root: {
    height: '100%',
    position: 'relative',
    padding: 4,
    fontFamily: theme.fontBody,
    color: theme.textPrimary,
  },
  inner: {
    height: '100%',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '12px 10px 10px',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    flexShrink: 0,
  },
  kicker: {
    fontFamily: theme.fontMono,
    fontSize: 9,
    letterSpacing: 1.8,
    color: theme.textMuted,
    marginBottom: 5,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
  },
  title: {
    margin: 0,
    fontSize: 16,
    letterSpacing: 0.5,
    color: theme.textPrimary,
  },
  dateBadge: {
    fontFamily: theme.fontMono,
    fontSize: 10,
    color: theme.warningOrange,
    border: `1px solid ${theme.warningOrange}66`,
    padding: '3px 7px',
    background: `${theme.warningOrange}10`,
    clipPath: hud.chamfer8,
  },
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 7,
    flexShrink: 0,
  },
  stat: {
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'rgba(0,0,0,0.22)',
    padding: '7px 8px',
    clipPath: hud.chamfer8,
  },
  statLabel: {
    display: 'block',
    fontSize: 10,
    color: theme.textMuted,
    marginBottom: 3,
  },
  statValue: {
    display: 'block',
    fontFamily: theme.fontMono,
    fontSize: 14,
    color: theme.textPrimary,
    fontWeight: 800,
  },
  projectBox: {
    flexShrink: 0,
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'rgba(0,0,0,0.18)',
    padding: 8,
    clipPath: hud.chamfer8,
  },
  projectLabel: {
    fontFamily: theme.fontMono,
    fontSize: 9,
    color: theme.textMuted,
    letterSpacing: 1.2,
    marginBottom: 5,
  },
  projectChip: {
    width: '100%',
    minHeight: 28,
    display: 'grid',
    gridTemplateColumns: '16px 1fr 16px',
    alignItems: 'center',
    gap: 6,
    border: `1px solid ${theme.warningOrange}66`,
    background: `${theme.warningOrange}10`,
    color: theme.textPrimary,
    fontSize: 11,
    textAlign: 'left',
    cursor: 'pointer',
    padding: '5px 7px',
    clipPath: hud.chamfer8,
  },
  projectChipText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  recommendButton: {
    width: '100%',
    marginTop: 7,
    border: `1px solid ${theme.electricBlue}66`,
    background: `${theme.electricBlue}10`,
    color: theme.electricBlue,
    fontSize: 11,
    textAlign: 'left',
    cursor: 'pointer',
    padding: '5px 7px',
    clipPath: hud.chamfer8,
  },
  searchPanel: {
    marginTop: 8,
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'rgba(2,6,14,0.86)',
    padding: 7,
    clipPath: hud.chamfer8,
  },
  searchInput: {
    width: '100%',
    boxSizing: 'border-box',
    height: 26,
    background: 'rgba(0,0,0,0.32)',
    border: `1px solid ${theme.hudFrameSoft}`,
    color: theme.textPrimary,
    outline: 'none',
    fontSize: 11,
    padding: '0 7px',
  },
  searchResults: {
    marginTop: 6,
    maxHeight: 140,
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  searchItem: {
    minHeight: 24,
    display: 'grid',
    gridTemplateColumns: '16px 1fr',
    alignItems: 'center',
    gap: 5,
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'rgba(255,255,255,0.025)',
    color: theme.textSecondary,
    fontSize: 11,
    textAlign: 'left',
    cursor: 'pointer',
    padding: '3px 6px',
  },
  composer: {
    flexShrink: 0,
    border: `1px solid ${theme.warningOrange}44`,
    background: 'rgba(255,153,51,0.045)',
    padding: 9,
    clipPath: hud.chamfer8,
  },
  subtaskBar: {
    display: 'grid',
    gridTemplateColumns: '14px 1fr 20px',
    alignItems: 'center',
    gap: 5,
    marginBottom: 7,
    color: theme.electricBlue,
    fontSize: 11,
  },
  clearSubtaskButton: {
    width: 18,
    height: 18,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    color: theme.textMuted,
    border: `1px solid ${theme.hudFrameSoft}`,
    cursor: 'pointer',
    padding: 0,
  },
  textarea: {
    width: '100%',
    resize: 'none',
    boxSizing: 'border-box',
    background: 'rgba(0,0,0,0.32)',
    border: `1px solid ${theme.hudFrameSoft}`,
    color: theme.textPrimary,
    outline: 'none',
    fontFamily: theme.fontBody,
    fontSize: 12,
    lineHeight: 1.45,
    padding: '8px 9px',
  },
  composerBar: {
    marginTop: 8,
    display: 'grid',
    gridTemplateColumns: '1fr 72px',
    gap: 7,
    alignItems: 'center',
  },
  targetHint: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    color: theme.textMuted,
    fontSize: 10,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  addButton: {
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    background: theme.warningOrange,
    color: theme.background,
    border: `1px solid ${theme.warningOrange}`,
    fontWeight: 900,
    fontSize: 12,
    cursor: 'pointer',
    clipPath: hud.chamfer8,
  },
  errorLine: {
    marginTop: 7,
    color: theme.dangerRed,
    fontSize: 11,
  },
  list: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    paddingRight: 2,
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
  },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontFamily: theme.fontMono,
    fontSize: 10,
    letterSpacing: 1.2,
    color: theme.textMuted,
    borderBottom: `1px solid ${theme.hudFrameSoft}`,
    paddingBottom: 5,
  },
  groupCount: {
    color: theme.warningOrange,
  },
  emptyLine: {
    fontSize: 11,
    color: theme.textMuted,
    opacity: 0.68,
    padding: '4px 0 7px',
  },
  card: {
    display: 'grid',
    gridTemplateColumns: '22px 1fr 22px',
    gap: 8,
    alignItems: 'start',
    border: '1px solid',
    background: 'linear-gradient(180deg, rgba(4,10,26,0.65), rgba(0,0,0,0.28))',
    padding: '9px 8px',
    clipPath: hud.chamfer8,
    cursor: 'pointer',
  },
  doneButton: {
    width: 20,
    height: 20,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: theme.expGreen,
    background: 'transparent',
    border: `1px solid ${theme.expGreen}66`,
    cursor: 'pointer',
    padding: 0,
  },
  cardBody: {
    minWidth: 0,
  },
  cardTitle: {
    fontSize: 12.5,
    color: theme.textPrimary,
    lineHeight: 1.45,
    fontWeight: 700,
    overflowWrap: 'anywhere',
  },
  cardMeta: {
    marginTop: 7,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  statusPill: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 18,
    padding: '0 5px',
    border: '1px solid',
    fontSize: 10,
    fontWeight: 800,
  },
  branchPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    height: 18,
    padding: '0 5px',
    border: `1px solid ${theme.hudFrameSoft}`,
    color: theme.textMuted,
    fontSize: 10,
  },
  inlineButton: {
    height: 18,
    padding: '0 6px',
    background: 'transparent',
    color: theme.electricBlue,
    border: `1px solid ${theme.electricBlue}66`,
    fontSize: 10,
    cursor: 'pointer',
  },
  deleteButton: {
    width: 20,
    height: 20,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: theme.textMuted,
    background: 'transparent',
    border: `1px solid ${theme.hudFrameSoft}`,
    cursor: 'pointer',
    padding: 0,
  },
}
