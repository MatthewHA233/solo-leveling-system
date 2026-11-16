// ══════════════════════════════════════════════
// 计划弹窗 · 计划安排：挂在项目标签下的任务树（对应 desktop components/TodoListPanel.tsx）
//   搜索 / 推荐项目、建任务和子任务、按状态分组、勾完成、删除（连同计划块）
//   手机端多一件事：点任务 = 选它当计划画笔（onPick），上层关掉弹窗让主人直接回昼夜表涂
// ══════════════════════════════════════════════

import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import type { ActivityPalette, ActivityTag, PlanNode } from '../../types'
import { addPlanNode, deletePlanNode, updatePlanNode } from '../../lib/api'
import { alpha, fonts, theme } from '../../theme'
import ConfirmDialog from '../ConfirmDialog'
import { Key, planStyles, planTone } from './plan-ui'

interface Props {
  readonly selectedDate: Date
  readonly palette: ActivityPalette
  readonly nodes: PlanNode[]
  readonly selectedProjectTagId: number | null
  readonly selectedPlanNodeId: number | null
  readonly onSelectProject: (id: number) => void
  readonly onSelectNode: (id: number | null) => void
  readonly onNodesChange: (projectTagId?: number) => void
  /** 删除任务后计划块也被软删了：上层要重取计划块、清计划层的撤销栈（AUDIT-022） */
  readonly onPlanBlocksMayChange?: () => void
  /** 点了一条任务：选它当画笔 */
  readonly onPick: (id: number) => void
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

/** 标签最近用过的时刻（毫秒）。库里是本地时间「YYYY-MM-DD HH:mm:ss」，Hermes 的 Date.parse 不一定认，自己拆 */
function touchedAt(tag: ActivityTag): number {
  const s = tag.lastUsedAt || tag.createdAt || ''
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)).getTime()
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

function scoreTag(tag: ActivityTag, query: string, selectedProjectTagId: number | null): number {
  const q = query.trim()
  let score = tag.id === selectedProjectTagId ? 1 : 0
  if (!q) return score + touchedAt(tag) / 10000000000000

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
    .sort((a, b) => b.score - a.score || touchedAt(b.tag) - touchedAt(a.tag))
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

export default function PlanTodoPanel({
  selectedDate,
  palette,
  nodes,
  selectedProjectTagId,
  selectedPlanNodeId,
  onSelectProject,
  onSelectNode,
  onNodesChange,
  onPlanBlocksMayChange,
  onPick,
}: Props) {
  const dateKey = toDateKey(selectedDate)
  const [draft, setDraft] = useState('')
  const [projectSearchOpen, setProjectSearchOpen] = useState(false)
  const [projectQuery, setProjectQuery] = useState('')
  const [subtaskParentId, setSubtaskParentId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PlanNode | null>(null)

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
      // 选中的是它自己或它的子孙：清空选中（AUDIT-022 b）
      if (selectedPlanNodeId != null) {
        const isSelfOrDescendant = (id: number): boolean => {
          if (id === node.id) return true
          const n = nodes.find((x) => x.id === id)
          return n?.parentId != null && isSelfOrDescendant(n.parentId)
        }
        if (isSelfOrDescendant(selectedPlanNodeId)) onSelectNode(null)
      }
      onNodesChange(node.projectTagId)
      // 计划块跟着软删了：上层重取计划块、清撤销栈（AUDIT-022 c）
      onPlanBlocksMayChange?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除计划失败')
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = () => {
    const node = pendingDelete
    setPendingDelete(null)
    if (node) void removeNode(node)
  }

  return (
    <View style={styles.root}>
      <ScrollView style={styles.flex} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.title}>计划安排</Text>
          <Text style={styles.date}>{dateKey}</Text>
        </View>

        <View style={styles.statsRow}>
          <Stat label="节点" value={String(stats.total)} />
          <Stat label="待安排" value={String(stats.active)} />
          <Stat label="完成" value={`${stats.done}/${stats.total || 0}`} />
        </View>

        <View style={styles.block}>
          <Text style={styles.label}>当前项目</Text>
          <Pressable onPress={() => setProjectSearchOpen((v) => !v)} style={styles.projectChip}>
            <Text style={[styles.projectChipText, !selectedProject && { color: theme.inkFaint }]} numberOfLines={1}>
              {selectedProject?.fullPath ?? '选择一个项目标签'}
            </Text>
            <Text style={styles.chipMark}>{projectSearchOpen ? '收起' : '换'}</Text>
          </Pressable>
          {!!draft.trim() && targetProject && targetProject.id !== selectedProject?.id && (
            <Pressable onPress={() => selectProject(targetProject.id)} style={styles.recommend}>
              <Text style={styles.recommendText} numberOfLines={1}>推荐绑定：{targetProject.fullPath}</Text>
            </Pressable>
          )}
          {projectSearchOpen && (
            <View style={styles.searchPanel}>
              <TextInput
                value={projectQuery}
                onChangeText={setProjectQuery}
                placeholder="搜索项目标签，例如 solo / 前端 / 写作"
                placeholderTextColor={theme.inkFaint}
                style={planStyles.input}
              />
              <View style={styles.searchResults}>
                {searchResults.length === 0 ? (
                  <Text style={styles.emptyLine}>没有匹配项目标签</Text>
                ) : searchResults.map((tag) => (
                  <Pressable
                    key={tag.id}
                    onPress={() => selectProject(tag.id)}
                    style={({ pressed }) => [styles.searchItem, pressed && styles.pressed]}
                  >
                    <View style={[styles.dot, { backgroundColor: tag.id === selectedProjectTagId ? planTone.plan : theme.line }]} />
                    <Text style={styles.searchItemText} numberOfLines={1}>{tag.fullPath}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </View>

        <View style={styles.block}>
          {subtaskParent && (
            <View style={styles.subtaskBar}>
              <Text style={styles.subtaskText} numberOfLines={1}>作为子任务添加到：{subtaskParent.title}</Text>
              <Pressable onPress={() => setSubtaskParentId(null)} hitSlop={8}>
                <Text style={styles.chipMark}>×</Text>
              </Pressable>
            </View>
          )}
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="输入计划，例如：把计划块接到真实任务上"
            placeholderTextColor={theme.inkFaint}
            multiline
            style={[planStyles.input, styles.textarea]}
          />
          <View style={styles.composerBar}>
            <Text style={styles.targetHint} numberOfLines={1}>
              {targetProject ? `将写入：${targetProject.fullPath}` : '还没有可绑定的项目标签'}
            </Text>
            <Key label="＋ 新增" primary onPress={() => { void createNode() }} disabled={!draft.trim() || !targetProject || busy} />
          </View>
          {error && <Text style={planStyles.error}>{error}</Text>}
        </View>

        <Text style={styles.pickHint}>点一条任务选它当画笔，回到昼夜表涂到时间上</Text>

        {STATUS_ORDER.map((status) => {
          const items = grouped.get(status) ?? []
          if (status === 'archived' && items.length === 0) return null
          return (
            <View key={status} style={styles.group}>
              <View style={planStyles.groupHeader}>
                <Text style={planStyles.groupTitle}>{STATUS_LABELS[status]}</Text>
                <Text style={planStyles.groupCount}>{items.length}</Text>
              </View>
              {items.length === 0 ? (
                <Text style={styles.emptyLine}>暂无计划节点</Text>
              ) : items.map(({ node, depth }) => (
                <PlanNodeCard
                  key={node.id}
                  node={node}
                  depth={depth}
                  selected={node.id === selectedPlanNodeId}
                  disabled={busy}
                  onPick={() => onPick(node.id)}
                  onToggleDone={() => { void patchNode(node, node.status === 'done' ? 'active' : 'done') }}
                  onAddChild={() => {
                    setSubtaskParentId(node.id)
                    setDraft('')
                  }}
                  onDelete={() => setPendingDelete(node)}
                />
              ))}
            </View>
          )
        })}
      </ScrollView>

      <ConfirmDialog
        open={pendingDelete != null}
        title="删除计划"
        body={pendingDelete ? `删除计划「${pendingDelete.title}」？已安排的计划时间块会一并清除。` : undefined}
        confirmText="删除"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </View>
  )
}

function PlanNodeCard({
  node,
  depth,
  selected,
  disabled,
  onPick,
  onToggleDone,
  onAddChild,
  onDelete,
}: {
  readonly node: PlanNode
  readonly depth: number
  readonly selected: boolean
  readonly disabled: boolean
  readonly onPick: () => void
  readonly onToggleDone: () => void
  readonly onAddChild: () => void
  readonly onDelete: () => void
}) {
  const completed = node.status === 'done'
  const color = completed ? planTone.ok : planTone.plan
  return (
    <Pressable
      onPress={onPick}
      style={({ pressed }) => [
        planStyles.card,
        styles.card,
        { marginLeft: Math.min(depth, 4) * 14 },
        completed && styles.completed,
        selected && styles.cardSelected,
        pressed && styles.pressed,
      ]}
    >
      <Pressable
        disabled={disabled}
        onPress={onToggleDone}
        hitSlop={8}
        accessibilityLabel={completed ? '标记为待安排' : '标记为完成'}
        style={[styles.checkBox, completed && { backgroundColor: planTone.ok, borderColor: planTone.ok }]}
      >
        {completed && <Text style={styles.checkMark}>✓</Text>}
      </Pressable>
      <View style={styles.cardBody}>
        <Text style={[styles.cardTitle, completed && styles.cardTitleDone]}>{node.title}</Text>
        <View style={styles.cardMeta}>
          <Text style={[styles.pill, { color, backgroundColor: alpha(color, 0.1) }]}>{STATUS_LABELS[node.status]}</Text>
          {node.parentId != null && <Text style={[styles.pill, styles.pillMuted]}>子任务</Text>}
          {selected && <Text style={[styles.pill, styles.pillBrush]}>画笔</Text>}
          <Pressable disabled={disabled} onPress={onAddChild} hitSlop={6}>
            <Text style={styles.inlineLink}>＋ 子任务</Text>
          </Pressable>
        </View>
      </View>
      <Pressable disabled={disabled} onPress={onDelete} hitSlop={8} accessibilityLabel="删除计划节点">
        <Text style={styles.deleteText}>删除</Text>
      </Pressable>
    </Pressable>
  )
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  scrollContent: { paddingBottom: 16 },
  pressed: { opacity: 0.75 },
  header: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontSize: 15, fontWeight: '700', color: theme.ink },
  date: { fontSize: 12, color: theme.inkSoft, fontFamily: fonts.mono },

  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  stat: { flex: 1, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: theme.bg },
  statLabel: { fontSize: 11, color: theme.inkSoft },
  statValue: { fontSize: 15, fontWeight: '700', color: theme.ink, fontFamily: fonts.mono, marginTop: 2 },

  block: { marginBottom: 14 },
  label: { fontSize: 12, color: theme.inkSoft, marginBottom: 6 },
  projectChip: {
    minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, borderRadius: 10, backgroundColor: theme.sunk,
  },
  projectChipText: { flex: 1, fontSize: 13, color: theme.ink, fontWeight: '600' },
  chipMark: { fontSize: 12, color: theme.accent, fontWeight: '600' },
  recommend: { marginTop: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: theme.accentSoft },
  recommendText: { fontSize: 12, color: theme.accent, fontWeight: '600' },
  searchPanel: { marginTop: 8 },
  searchResults: {
    marginTop: 6, borderRadius: 10, overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line,
  },
  searchItem: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.lineSoft,
  },
  searchItemText: { flex: 1, fontSize: 13, color: theme.ink },
  dot: { width: 8, height: 8, borderRadius: 4 },

  subtaskBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6,
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 10, backgroundColor: theme.bg,
  },
  subtaskText: { flex: 1, fontSize: 12, color: theme.inkSoft },
  textarea: { height: undefined, minHeight: 64, paddingVertical: 10, lineHeight: 20, textAlignVertical: 'top' },
  composerBar: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  targetHint: { flex: 1, fontSize: 12, color: theme.inkSoft },

  pickHint: { fontSize: 11, color: theme.inkFaint, marginBottom: 10 },
  group: { marginBottom: 12 },
  emptyLine: { fontSize: 12, color: theme.inkFaint, paddingVertical: 6 },

  card: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  completed: { opacity: 0.62 },
  cardSelected: { borderColor: theme.accent, borderWidth: 1.5, backgroundColor: alpha(theme.accent, 0.04) },
  checkBox: {
    width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: theme.inkFaint, marginTop: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  checkMark: { fontSize: 12, lineHeight: 14, color: '#FFFFFF', fontWeight: '700' },
  cardBody: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14, lineHeight: 20, color: theme.ink },
  cardTitleDone: { textDecorationLine: 'line-through', color: theme.inkSoft },
  cardMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  pill: { fontSize: 11, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  pillMuted: { color: theme.inkSoft, backgroundColor: theme.bg },
  pillBrush: { color: theme.accent, backgroundColor: theme.accentSoft, fontWeight: '600' },
  inlineLink: { fontSize: 12, color: theme.accent, fontWeight: '600' },
  deleteText: { fontSize: 12, color: theme.danger, fontWeight: '600', marginTop: 2 },
})
