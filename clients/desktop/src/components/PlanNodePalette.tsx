import { useCallback, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Dumbbell,
  FileText,
  Folder,
  MessageCircle,
  Palette,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Tag as TagIcon,
  Target,
  Trash2,
  X,
} from 'lucide-react'
import type { ActivityCategory, ActivityPalette, ActivityTag, PlanNode } from '../types'
import { addPlanNode, deletePlanNode, updatePlanNode } from '../lib/local-api'
import { theme } from '../theme'
import { HudFrame } from './hud'
import Tooltip from './Tooltip'

interface Props {
  palette: ActivityPalette
  nodes: PlanNode[]
  selectedProjectTagId: number | null
  selectedPlanNodeId: number | null
  onSelectProject: (id: number) => void
  onSelectNode: (id: number | null) => void
  onNodesChange: (projectTagId?: number) => void
}

interface PathNode {
  segment: string
  children: Map<string, PathNode>
  tag?: ActivityTag
  fullPath: string
  depth: number
}

type DraftTarget = {
  projectTagId: number
  parentId: number | null
}

const EMPTY_PATH_SET: ReadonlySet<string> = new Set()

interface PlanVisualMeta {
  label: string
  color: string
  icon: ReactNode
}

const PLAN_VISUAL_RULES: Array<{ pattern: RegExp; label: string; color: string; icon: (color: string) => ReactNode }> = [
  { pattern: /代码|开发|编程|实现|修复|debug|bug|code|dev|fix/i, label: 'DEV', color: '#00E5FF', icon: (color) => <Code2 size={15} color={color} /> },
  { pattern: /写|论文|文档|文章|稿|总结|复盘|draft|write|doc/i, label: 'WRITE', color: '#B47CFF', icon: (color) => <FileText size={15} color={color} /> },
  { pattern: /学|读|阅读|课程|复习|研究|study|learn|read/i, label: 'STUDY', color: '#00FF88', icon: (color) => <BookOpen size={15} color={color} /> },
  { pattern: /设计|交互|动画|动效|视觉|ui|ux|design/i, label: 'DESIGN', color: '#2ECC71', icon: (color) => <Palette size={15} color={color} /> },
  { pattern: /会|沟通|同步|消息|回复|邮件|meeting|sync|mail|email/i, label: 'COMM', color: '#7DD3FC', icon: (color) => <MessageCircle size={15} color={color} /> },
  { pattern: /运动|健身|跑|训练|workout|run|gym/i, label: 'BODY', color: '#F59E0B', icon: (color) => <Dumbbell size={15} color={color} /> },
  { pattern: /想|规划|拆解|决策|整理|plan|think/i, label: 'THINK', color: '#F472B6', icon: (color) => <Brain size={15} color={color} /> },
]

function getPlanVisualMeta(title: string, fallbackColor: string): PlanVisualMeta {
  const trimmed = title.trim()
  const rule = PLAN_VISUAL_RULES.find((item) => item.pattern.test(trimmed))
  const color = rule?.color ?? fallbackColor
  if (rule) return { label: rule.label, color, icon: rule.icon(color) }
  return {
    label: 'TASK',
    color,
    icon: trimmed ? <Target size={15} color={color} /> : <Sparkles size={15} color={color} />,
  }
}

function buildTree(category: ActivityCategory, tags: ActivityTag[]): PathNode {
  const root: PathNode = {
    segment: category.name,
    children: new Map(),
    fullPath: category.name,
    depth: 1,
  }

  for (const tag of tags) {
    if (tag.categoryId !== category.id) continue
    const segments = tag.fullPath.split(',').map((s) => s.trim()).filter(Boolean)
    if (segments[0] !== category.name) continue

    let node = root
    for (let i = 1; i < segments.length; i += 1) {
      const seg = segments[i]
      let child = node.children.get(seg)
      if (!child) {
        child = {
          segment: seg,
          children: new Map(),
          fullPath: segments.slice(0, i + 1).join(','),
          depth: i + 1,
        }
        node.children.set(seg, child)
      }
      node = child
    }
    node.tag = tag
  }

  return root
}

function taskMatchesSubtree(
  node: PlanNode,
  childrenByParent: ReadonlyMap<number | null, PlanNode[]>,
  query: string,
): boolean {
  if (!query) return true
  if (node.title.toLowerCase().includes(query)) return true
  return (childrenByParent.get(node.id) ?? []).some((child) => taskMatchesSubtree(child, childrenByParent, query))
}

function displayPath(fullPath: string): string {
  return fullPath.split(',').filter(Boolean).join(' / ')
}

export default function PlanNodePalette({
  palette,
  nodes,
  selectedProjectTagId,
  selectedPlanNodeId,
  onSelectProject,
  onSelectNode,
  onNodesChange,
}: Props) {
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set())
  const [collapsedTasks, setCollapsedTasks] = useState<Set<number>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [draftTarget, setDraftTarget] = useState<DraftTarget | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null)
  const [editingTitle, setEditingTitle] = useState('')

  const query = searchQuery.trim().toLowerCase()
  const isSearching = query.length > 0

  const trees = useMemo(() => {
    const sorted = [...palette.categories].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    return sorted.map((category) => ({ category, root: buildTree(category, palette.tags) }))
  }, [palette.categories, palette.tags])

  const childrenByParent = useMemo(() => {
    const map = new Map<number | null, PlanNode[]>()
    for (const node of nodes) {
      const key = node.parentId ?? null
      const list = map.get(key) ?? []
      list.push(node)
      map.set(key, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    }
    return map
  }, [nodes])

  const currentTasksMatchQuery = useMemo(() => {
    if (!query) return false
    return nodes.some((node) => node.title.toLowerCase().includes(query))
  }, [nodes, query])

  const visibleTrees = useMemo(() => {
    if (!isSearching) return trees

    function filterSubtree(node: PathNode): PathNode | null {
      const selfMatch =
        node.segment.toLowerCase().includes(query) ||
        node.fullPath.toLowerCase().includes(query)
      const selectedProjectHasTaskMatch = node.tag?.id === selectedProjectTagId && currentTasksMatchQuery

      if (selfMatch) return node

      const kids = new Map<string, PathNode>()
      for (const [key, child] of node.children) {
        const filtered = filterSubtree(child)
        if (filtered) kids.set(key, filtered)
      }

      if (kids.size === 0 && !selectedProjectHasTaskMatch) return null
      return { ...node, children: kids }
    }

    return trees
      .map(({ category, root }) => {
        if (category.name.toLowerCase().includes(query)) return { category, root }
        const filtered = filterSubtree(root)
        return filtered ? { category, root: filtered } : null
      })
      .filter((item): item is { category: ActivityCategory; root: PathNode } => item !== null)
  }, [currentTasksMatchQuery, isSearching, query, selectedProjectTagId, trees])

  const effectiveCollapsed = isSearching ? EMPTY_PATH_SET : collapsedPaths

  const togglePath = useCallback((path: string) => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const toggleTask = useCallback((id: number) => {
    setCollapsedTasks((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectProject = useCallback((tagId: number) => {
    onSelectProject(tagId)
    if (selectedProjectTagId !== tagId) onSelectNode(null)
  }, [onSelectNode, onSelectProject, selectedProjectTagId])

  const startDraft = useCallback((projectTagId: number, parentId: number | null) => {
    selectProject(projectTagId)
    if (parentId != null) {
      setCollapsedTasks((prev) => {
        if (!prev.has(parentId)) return prev
        const next = new Set(prev)
        next.delete(parentId)
        return next
      })
    }
    setDraftTarget({ projectTagId, parentId })
    setDraftTitle('')
    setEditingTaskId(null)
    setEditingTitle('')
  }, [selectProject])

  const cancelDraft = useCallback(() => {
    setDraftTarget(null)
    setDraftTitle('')
  }, [])

  const submitDraft = useCallback(async () => {
    if (!draftTarget) return
    const title = draftTitle.trim()
    if (!title) return
    const created = await addPlanNode(draftTarget.projectTagId, title, draftTarget.parentId)
    setDraftTarget(null)
    setDraftTitle('')
    onSelectNode(created.id)
    onNodesChange(draftTarget.projectTagId)
  }, [draftTarget, draftTitle, onNodesChange, onSelectNode])

  const startEditTask = useCallback((node: PlanNode) => {
    onSelectNode(null)
    setDraftTarget(null)
    setDraftTitle('')
    setEditingTaskId(node.id)
    setEditingTitle(node.title)
  }, [onSelectNode])

  const cancelEditTask = useCallback(() => {
    setEditingTaskId(null)
    setEditingTitle('')
  }, [])

  const confirmEditTask = useCallback(async (node: PlanNode) => {
    const title = editingTitle.trim()
    if (!title) return
    await updatePlanNode(node.id, { title })
    setEditingTaskId(null)
    setEditingTitle('')
    onNodesChange(node.projectTagId)
  }, [editingTitle, onNodesChange])

  const toggleDone = useCallback(async (node: PlanNode) => {
    await updatePlanNode(node.id, { status: node.status === 'done' ? 'active' : 'done' })
    onNodesChange(node.projectTagId)
  }, [onNodesChange])

  const removeNode = useCallback(async (node: PlanNode) => {
    if (!window.confirm(`删除任务「${node.title}」及其子任务？已安排到昼夜表的计划块也会一起清除。`)) return
    if (selectedPlanNodeId === node.id) onSelectNode(null)
    await deletePlanNode(node.id)
    onNodesChange(node.projectTagId)
  }, [onNodesChange, onSelectNode, selectedPlanNodeId])

  return (
    <div style={{
      height: '100%',
      position: 'relative',
      padding: '4px 4px',
      fontFamily: theme.fontBody,
    }}>
      <HudFrame
        color={theme.warningOrange}
        accent={theme.expGreen}
        topLabel="PLAN · 计划项目"
        showNotchTop
        showNotchBottom={false}
        notchWidth={112}
        notchDepth={7}
        cornerSize={16}
      />

      <div style={{
        height: '100%',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        padding: '24px 8px 8px 8px',
        gap: 6,
      }}>
        <SearchBox query={searchQuery} onChange={setSearchQuery} />

        {trees.length === 0 && (
          <div style={emptyStateStyle}>
            还没有实际记录标签。先在“实际记录”里建立分类和项目名，计划会沿用同一套项目入口。
          </div>
        )}

        {trees.length > 0 && visibleTrees.length === 0 && (
          <div style={emptyStateStyle}>
            没有匹配“{searchQuery}”的项目或任务。
          </div>
        )}

        {visibleTrees.map(({ category, root }) => (
          <CategoryBlock
            key={category.id}
            category={category}
            root={root}
            collapsed={effectiveCollapsed}
            onToggle={togglePath}
            selectedProjectTagId={selectedProjectTagId}
            selectedPlanNodeId={selectedPlanNodeId}
            onSelectProject={selectProject}
            onSelectNode={onSelectNode}
            onStartDraft={startDraft}
            draftTarget={draftTarget}
            draftTitle={draftTitle}
            setDraftTitle={setDraftTitle}
            onSubmitDraft={submitDraft}
            onCancelDraft={cancelDraft}
            nodes={nodes}
            childrenByParent={childrenByParent}
            collapsedTasks={collapsedTasks}
            onToggleTask={toggleTask}
            onToggleDone={toggleDone}
            onDeleteTask={removeNode}
            editingTaskId={editingTaskId}
            editingTitle={editingTitle}
            setEditingTitle={setEditingTitle}
            onStartEditTask={startEditTask}
            onCancelEditTask={cancelEditTask}
            onConfirmEditTask={confirmEditTask}
            highlight={query}
          />
        ))}
      </div>
    </div>
  )
}

interface SharedTreeHandlers {
  collapsed: ReadonlySet<string>
  onToggle: (path: string) => void
  selectedProjectTagId: number | null
  selectedPlanNodeId: number | null
  onSelectProject: (tagId: number) => void
  onSelectNode: (id: number | null) => void
  onStartDraft: (projectTagId: number, parentId: number | null) => void
  draftTarget: DraftTarget | null
  draftTitle: string
  setDraftTitle: (value: string) => void
  onSubmitDraft: () => void
  onCancelDraft: () => void
  nodes: PlanNode[]
  childrenByParent: ReadonlyMap<number | null, PlanNode[]>
  collapsedTasks: ReadonlySet<number>
  onToggleTask: (id: number) => void
  onToggleDone: (node: PlanNode) => void
  onDeleteTask: (node: PlanNode) => void
  editingTaskId: number | null
  editingTitle: string
  setEditingTitle: (value: string) => void
  onStartEditTask: (node: PlanNode) => void
  onCancelEditTask: () => void
  onConfirmEditTask: (node: PlanNode) => void
  highlight: string
}

function CategoryBlock({
  category,
  root,
  ...rest
}: {
  category: ActivityCategory
  root: PathNode
} & SharedTreeHandlers) {
  const isOpen = !rest.collapsed.has(root.fullPath)

  return (
    <div style={{
      border: `1px solid ${category.color}55`,
      background: `${category.color}0D`,
      padding: '4px 6px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button onClick={() => rest.onToggle(root.fullPath)} style={chevronBtn}>
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <Folder size={12} color={category.color} />
        <span style={{
          fontSize: 12,
          fontWeight: 700,
          color: theme.textPrimary,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          <Highlight text={category.name} keyword={rest.highlight} />
        </span>
      </div>

      {isOpen && (
        <div style={{ marginTop: 4, paddingLeft: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TreeChildren
            node={root}
            color={category.color}
            {...rest}
          />
        </div>
      )}
    </div>
  )
}

function TreeChildren({
  node,
  color,
  ...rest
}: {
  node: PathNode
  color: string
} & SharedTreeHandlers) {
  const sortedChildren = useMemo(() => {
    return [...node.children.values()].sort((a, b) => {
      if (a.tag && b.tag) return b.tag.lastUsedAt.localeCompare(a.tag.lastUsedAt)
      return a.segment.localeCompare(b.segment)
    })
  }, [node])

  return (
    <>
      {sortedChildren.map((child) => (
        <TreeNode
          key={child.fullPath}
          node={child}
          color={color}
          {...rest}
        />
      ))}
    </>
  )
}

function TreeNode({
  node,
  color,
  ...rest
}: {
  node: PathNode
  color: string
} & SharedTreeHandlers) {
  const hasChildren = node.children.size > 0
  const isOpen = !rest.collapsed.has(node.fullPath)
  const isProject = !!node.tag
  const isSelectedProject = node.tag?.id === rest.selectedProjectTagId

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          padding: '3px 4px',
          background: isSelectedProject ? `${color}24` : 'transparent',
          border: `1px solid ${isSelectedProject ? color : 'transparent'}`,
          cursor: isProject ? 'pointer' : 'default',
          boxShadow: isSelectedProject ? `0 0 8px ${color}44, inset 0 0 6px ${color}18` : undefined,
        }}
        onClick={(event) => {
          event.stopPropagation()
          if (node.tag) rest.onSelectProject(node.tag.id)
        }}
      >
        {hasChildren ? (
          <button
            onClick={(event) => {
              event.stopPropagation()
              rest.onToggle(node.fullPath)
            }}
            style={chevronBtn}
          >
            {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        ) : (
          <span style={{ width: 11, display: 'inline-block' }} />
        )}

        <TagIcon size={10} color={color} />
        <span style={{
          fontSize: 11.5,
          color: isSelectedProject ? theme.textPrimary : theme.textSecondary,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontWeight: isSelectedProject ? 700 : 500,
        }}>
          <Highlight text={node.segment} keyword={rest.highlight} />
        </span>

        {node.tag && (
          <Tooltip content="在这个项目下新增任务">
            <button
              onClick={(event) => {
                event.stopPropagation()
                rest.onStartDraft(node.tag!.id, null)
              }}
              style={{ ...iconBtn, color: isSelectedProject ? theme.warningOrange : theme.textSecondary }}
            >
              <Plus size={10} />
            </button>
          </Tooltip>
        )}
      </div>

      {node.tag && isSelectedProject && (
        <ProjectTaskDeck
          projectTag={node.tag}
          color={color}
          {...rest}
        />
      )}

      {hasChildren && isOpen && (
        <div style={{ marginLeft: 10, borderLeft: `1px dashed ${color}33`, paddingLeft: 4, marginTop: 2 }}>
          <TreeChildren
            node={node}
            color={color}
            {...rest}
          />
        </div>
      )}
    </div>
  )
}

function ProjectTaskDeck({
  projectTag,
  color,
  nodes,
  childrenByParent,
  draftTarget,
  draftTitle,
  setDraftTitle,
  onSubmitDraft,
  onCancelDraft,
  onStartDraft,
  selectedPlanNodeId,
  onSelectNode,
  collapsedTasks,
  onToggleTask,
  onToggleDone,
  onDeleteTask,
  editingTaskId,
  editingTitle,
  setEditingTitle,
  onStartEditTask,
  onCancelEditTask,
  onConfirmEditTask,
  highlight,
}: {
  projectTag: ActivityTag
  color: string
} & SharedTreeHandlers) {
  const rootTasks = childrenByParent.get(null) ?? []
  const visibleRootTasks = highlight
    ? rootTasks.filter((node) => taskMatchesSubtree(node, childrenByParent, highlight))
    : rootTasks
  const isDraftingRoot = draftTarget?.projectTagId === projectTag.id && draftTarget.parentId == null

  return (
    <div style={{
      marginLeft: 10,
      marginTop: 3,
      marginBottom: 4,
      borderLeft: `1px solid ${color}66`,
      paddingLeft: 6,
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 5px',
        background: 'rgba(245,158,11,0.06)',
        border: `1px solid ${theme.warningOrange}33`,
        color: theme.textSecondary,
        fontSize: 10.5,
      }}>
        <span style={{
          color: theme.warningOrange,
          fontFamily: theme.fontMono,
          fontWeight: 800,
          letterSpacing: 0.8,
          whiteSpace: 'nowrap',
        }}>
          TASK STACK
        </span>
        <span style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {displayPath(projectTag.fullPath)}
        </span>
      </div>

      {isDraftingRoot && (
        <InlineTaskDraft
          value={draftTitle}
          onChange={setDraftTitle}
          onConfirm={onSubmitDraft}
          onCancel={onCancelDraft}
          depth={0}
          color={color}
        />
      )}

      {nodes.length === 0 && !isDraftingRoot && (
        <button
          onClick={() => onStartDraft(projectTag.id, null)}
          style={emptyTaskButtonStyle}
        >
          <Plus size={11} /> 还没有任务，点击拆一个目标
        </button>
      )}

      {nodes.length > 0 && visibleRootTasks.length === 0 && (
        <div style={{
          color: theme.textMuted,
          fontSize: 11,
          padding: '6px 7px',
          border: `1px dashed ${theme.warningOrange}33`,
        }}>
          当前项目里没有匹配“{highlight}”的任务。
        </div>
      )}

      {visibleRootTasks.map((node) => (
        <TaskNode
          key={node.id}
          node={node}
          depth={0}
          color={color}
          projectTagId={projectTag.id}
          childrenByParent={childrenByParent}
          selectedPlanNodeId={selectedPlanNodeId}
          onSelectNode={onSelectNode}
          collapsedTasks={collapsedTasks}
          onToggleTask={onToggleTask}
          onStartDraft={onStartDraft}
          draftTarget={draftTarget}
          draftTitle={draftTitle}
          setDraftTitle={setDraftTitle}
          onSubmitDraft={onSubmitDraft}
          onCancelDraft={onCancelDraft}
          onToggleDone={onToggleDone}
          onDeleteTask={onDeleteTask}
          editingTaskId={editingTaskId}
          editingTitle={editingTitle}
          setEditingTitle={setEditingTitle}
          onStartEditTask={onStartEditTask}
          onCancelEditTask={onCancelEditTask}
          onConfirmEditTask={onConfirmEditTask}
          highlight={highlight}
        />
      ))}
    </div>
  )
}

function TaskNode({
  node,
  depth,
  color,
  projectTagId,
  childrenByParent,
  selectedPlanNodeId,
  onSelectNode,
  collapsedTasks,
  onToggleTask,
  onStartDraft,
  draftTarget,
  draftTitle,
  setDraftTitle,
  onSubmitDraft,
  onCancelDraft,
  onToggleDone,
  onDeleteTask,
  editingTaskId,
  editingTitle,
  setEditingTitle,
  onStartEditTask,
  onCancelEditTask,
  onConfirmEditTask,
  highlight,
}: {
  node: PlanNode
  depth: number
  color: string
  projectTagId: number
  childrenByParent: ReadonlyMap<number | null, PlanNode[]>
  selectedPlanNodeId: number | null
  onSelectNode: (id: number | null) => void
  collapsedTasks: ReadonlySet<number>
  onToggleTask: (id: number) => void
  onStartDraft: (projectTagId: number, parentId: number | null) => void
  draftTarget: DraftTarget | null
  draftTitle: string
  setDraftTitle: (value: string) => void
  onSubmitDraft: () => void
  onCancelDraft: () => void
  onToggleDone: (node: PlanNode) => void
  onDeleteTask: (node: PlanNode) => void
  editingTaskId: number | null
  editingTitle: string
  setEditingTitle: (value: string) => void
  onStartEditTask: (node: PlanNode) => void
  onCancelEditTask: () => void
  onConfirmEditTask: (node: PlanNode) => void
  highlight: string
}) {
  if (highlight && !taskMatchesSubtree(node, childrenByParent, highlight)) return null

  const children = childrenByParent.get(node.id) ?? []
  const isCollapsed = collapsedTasks.has(node.id)
  const selected = selectedPlanNodeId === node.id
  const done = node.status === 'done'
  const isEditing = editingTaskId === node.id
  const isDraftingChild = draftTarget?.projectTagId === projectTagId && draftTarget.parentId === node.id
  const meta = getPlanVisualMeta(node.title, color)

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginLeft: depth * 12,
          padding: '5px 6px',
          minHeight: 34,
          background: selected
            ? `linear-gradient(90deg, ${meta.color}20 0%, rgba(255,255,255,0.035) 100%)`
            : 'rgba(255,255,255,0.025)',
          border: `1px solid ${selected ? meta.color : 'rgba(255,255,255,0.06)'}`,
          boxShadow: selected ? `0 0 12px ${meta.color}55, inset 0 0 10px ${meta.color}1A` : undefined,
          color: done ? theme.textMuted : theme.textPrimary,
          cursor: isEditing ? 'default' : 'pointer',
          transition: 'background 140ms ease, border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease',
        }}
        onClick={(event) => {
          event.stopPropagation()
          if (!isEditing) onSelectNode(selected ? null : node.id)
        }}
      >
        {children.length > 0 ? (
          <button
            onClick={(event) => {
              event.stopPropagation()
              onToggleTask(node.id)
            }}
            style={chevronBtn}
          >
            {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          </button>
        ) : (
          <span style={{ width: 11, display: 'inline-block' }} />
        )}

        {!isEditing && (
          <span style={taskMetaBadgeStyle(meta.color, selected, done)}>
            {meta.icon}
          </span>
        )}

        {isEditing ? (
          <InlineTaskEdit
            value={editingTitle}
            onChange={setEditingTitle}
            onConfirm={() => onConfirmEditTask(node)}
            onCancel={onCancelEditTask}
          />
        ) : (
          <span style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 11.5,
            textDecoration: done ? 'line-through' : undefined,
            lineHeight: 1.25,
          }}>
            <Highlight text={node.title} keyword={highlight} />
          </span>
        )}

        {!isEditing && (
          <>
            <span style={taskKindPillStyle(meta.color, selected)}>{meta.label}</span>
            <Tooltip content="重命名任务">
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  onStartEditTask(node)
                }}
                style={iconBtn}
              >
                <Pencil size={10} />
              </button>
            </Tooltip>
            <Tooltip content="新增子任务">
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  onStartDraft(projectTagId, node.id)
                }}
                style={iconBtn}
              >
                <Plus size={10} />
              </button>
            </Tooltip>
            <Tooltip content={done ? '恢复为进行中' : '标记完成'}>
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  onToggleDone(node)
                }}
                style={{ ...iconBtn, color: done ? theme.expGreen : theme.textSecondary }}
              >
                <Check size={10} />
              </button>
            </Tooltip>
            <Tooltip content="删除任务">
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  onDeleteTask(node)
                }}
                style={{ ...iconBtn, color: theme.dangerRed }}
              >
                <Trash2 size={10} />
              </button>
            </Tooltip>
          </>
        )}
      </div>

      {isDraftingChild && (
        <InlineTaskDraft
          value={draftTitle}
          onChange={setDraftTitle}
          onConfirm={onSubmitDraft}
          onCancel={onCancelDraft}
          depth={depth + 1}
          color={color}
        />
      )}

      {!isCollapsed && children.length > 0 && (
        <div style={{ marginLeft: depth * 12 + 10, borderLeft: `1px dashed ${color}33`, paddingLeft: 4, marginTop: 2 }}>
          {children.map((child) => (
            <TaskNode
              key={child.id}
              node={child}
              depth={depth + 1}
              color={color}
              projectTagId={projectTagId}
              childrenByParent={childrenByParent}
              selectedPlanNodeId={selectedPlanNodeId}
              onSelectNode={onSelectNode}
              collapsedTasks={collapsedTasks}
              onToggleTask={onToggleTask}
              onStartDraft={onStartDraft}
              draftTarget={draftTarget}
              draftTitle={draftTitle}
              setDraftTitle={setDraftTitle}
              onSubmitDraft={onSubmitDraft}
              onCancelDraft={onCancelDraft}
              onToggleDone={onToggleDone}
              onDeleteTask={onDeleteTask}
              editingTaskId={editingTaskId}
              editingTitle={editingTitle}
              setEditingTitle={setEditingTitle}
              onStartEditTask={onStartEditTask}
              onCancelEditTask={onCancelEditTask}
              onConfirmEditTask={onConfirmEditTask}
              highlight={highlight}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SearchBox({ query, onChange }: { query: string; onChange: (value: string) => void }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '5px 9px',
      border: `1px solid ${theme.hudFrameSoft}`,
      background: 'rgba(245,158,11,0.045)',
      clipPath: 'polygon(4px 0, calc(100% - 4px) 0, 100% 4px, 100% calc(100% - 4px), calc(100% - 4px) 100%, 4px 100%, 0 calc(100% - 4px), 0 4px)',
      WebkitClipPath: 'polygon(4px 0, calc(100% - 4px) 0, 100% 4px, 100% calc(100% - 4px), calc(100% - 4px) 100%, 4px 100%, 0 calc(100% - 4px), 0 4px)',
    }}>
      <Search size={11} style={{ color: theme.textPrimary, flexShrink: 0 }} />
      <input
        value={query}
        onChange={(event) => onChange(event.target.value)}
        placeholder="搜索分类、项目名、当前任务..."
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          color: theme.textPrimary,
          fontFamily: theme.fontBody,
          fontSize: 12,
          outline: 'none',
        }}
      />
      {query && (
        <Tooltip content="清空">
          <button
            onClick={() => onChange('')}
            aria-label="清空搜索"
            style={{
              flexShrink: 0,
              width: 16,
              height: 16,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              background: `${theme.textMuted}28`,
              border: 'none',
              color: theme.textPrimary,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <X size={10} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

function InlineTaskDraft({
  value,
  onChange,
  onConfirm,
  onCancel,
  depth,
  color,
}: {
  value: string
  onChange: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
  depth: number
  color: string
}) {
  const meta = getPlanVisualMeta(value, color)
  const canConfirm = value.trim().length > 0

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginLeft: depth * 12,
      padding: '7px 8px',
      minHeight: 44,
      border: `1px solid ${meta.color}88`,
      background: `linear-gradient(90deg, ${meta.color}18 0%, rgba(4,10,26,0.72) 100%)`,
      boxShadow: `0 0 16px ${meta.color}24, inset 0 0 12px ${meta.color}10`,
      clipPath: 'polygon(6px 0, calc(100% - 6px) 0, 100% 6px, 100% calc(100% - 6px), calc(100% - 6px) 100%, 6px 100%, 0 calc(100% - 6px), 0 6px)',
      WebkitClipPath: 'polygon(6px 0, calc(100% - 6px) 0, 100% 6px, 100% calc(100% - 6px), calc(100% - 6px) 100%, 6px 100%, 0 calc(100% - 6px), 0 6px)',
      transition: 'border-color 160ms ease, background 160ms ease, box-shadow 160ms ease',
    }}>
      <span style={taskMetaBadgeStyle(meta.color, true, false)}>
        {meta.icon}
      </span>
      <span style={draftKindStyle(meta.color)}>{meta.label}</span>
      <input
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={depth === 0 ? '输入一个可以安排到今天的任务' : '输入下一步'}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onConfirm()
          else if (event.key === 'Escape') onCancel()
        }}
        style={{ ...inputStyle, borderColor: `${meta.color}55`, background: 'rgba(0,0,0,0.22)' }}
      />
      <button
        onClick={onConfirm}
        disabled={!canConfirm}
        style={{ ...iconBtn, color: canConfirm ? theme.expGreen : theme.textMuted, opacity: canConfirm ? 1 : 0.45 }}
      >
        <Check size={11} />
      </button>
      <button onClick={onCancel} style={iconBtn}>
        <X size={11} />
      </button>
    </div>
  )
}

function InlineTaskEdit({
  value,
  onChange,
  onConfirm,
  onCancel,
}: {
  value: string
  onChange: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <span
      style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onConfirm()
          else if (event.key === 'Escape') onCancel()
        }}
        style={{ ...inputStyle, padding: '2px 5px', fontSize: 11 }}
      />
      <button onClick={onConfirm} style={{ ...iconBtn, color: theme.expGreen }}>
        <Check size={11} />
      </button>
      <button onClick={onCancel} style={iconBtn}>
        <X size={11} />
      </button>
    </span>
  )
}

function Highlight({ text, keyword }: { text: string; keyword: string }) {
  if (!keyword) return <>{text}</>
  const lowerText = text.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let index = lowerText.indexOf(keyword)
  let markIndex = 0

  while (index >= 0) {
    if (index > cursor) parts.push(text.slice(cursor, index))
    parts.push(
      <mark
        key={`match-${markIndex}`}
        style={{
          background: `${theme.warningOrange}40`,
          color: theme.warningOrange,
          padding: '0 1px',
          borderRadius: 2,
          fontWeight: 800,
        }}
      >
        {text.slice(index, index + keyword.length)}
      </mark>,
    )
    cursor = index + keyword.length
    index = lowerText.indexOf(keyword, cursor)
    markIndex += 1
  }

  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

function taskMetaBadgeStyle(color: string, active: boolean, muted: boolean): CSSProperties {
  return {
    width: 25,
    height: 25,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color,
    border: `1px solid ${color}${active ? 'CC' : '66'}`,
    background: active ? `${color}1F` : `${color}10`,
    boxShadow: active ? `0 0 10px ${color}44` : undefined,
    opacity: muted ? 0.45 : 1,
    clipPath: 'polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px)',
    WebkitClipPath: 'polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px)',
    transition: 'border-color 140ms ease, background 140ms ease, box-shadow 140ms ease, opacity 140ms ease',
  }
}

function taskKindPillStyle(color: string, active: boolean): CSSProperties {
  return {
    flexShrink: 0,
    minWidth: 42,
    padding: '2px 5px',
    textAlign: 'center',
    color: active ? color : theme.textMuted,
    border: `1px solid ${active ? `${color}66` : 'transparent'}`,
    background: active ? `${color}12` : 'transparent',
    fontFamily: theme.fontMono,
    fontSize: 8.5,
    fontWeight: 900,
    letterSpacing: 0.8,
  }
}

function draftKindStyle(color: string): CSSProperties {
  return {
    flexShrink: 0,
    width: 52,
    color,
    fontFamily: theme.fontMono,
    fontSize: 9,
    fontWeight: 900,
    letterSpacing: 1,
    textAlign: 'center',
    textShadow: `0 0 8px ${color}88`,
  }
}

const iconBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  color: theme.textSecondary,
  cursor: 'pointer',
  padding: 2,
  flexShrink: 0,
}

const chevronBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  color: theme.textSecondary,
  cursor: 'pointer',
  padding: 0,
}

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'rgba(0,0,0,0.4)',
  border: `1px solid ${theme.glassBorder}`,
  color: theme.textPrimary,
  padding: '3px 5px',
  fontSize: 11,
  fontFamily: theme.fontBody,
  outline: 'none',
}

const emptyStateStyle: CSSProperties = {
  color: theme.textMuted,
  fontSize: 11,
  textAlign: 'center',
  marginTop: 18,
  lineHeight: 1.6,
  padding: '0 12px',
}

const emptyTaskButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5,
  border: `1px dashed ${theme.warningOrange}44`,
  background: 'rgba(245,158,11,0.05)',
  color: theme.warningOrange,
  padding: '6px 7px',
  fontFamily: theme.fontBody,
  fontSize: 11,
  cursor: 'pointer',
}
