// ══════════════════════════════════════════════
// ActivityTagPalette — 活动记录标签库（编辑模式右栏）
// 树形折叠展开 + 叶子可选 = 画笔；任意节点支持重命名 + 颜色编辑（仅分类）
// ══════════════════════════════════════════════

import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { Plus, Trash2, ChevronRight, ChevronDown, Folder, Tag as TagIcon, X, Pencil, Check } from 'lucide-react'
import type { ActivityCategory, ActivityTag, ActivityPalette } from '../types'
import {
  addActivityCategory, deleteActivityCategory, updateActivityCategory,
  addActivityTag, deleteActivityTag, renameActivityPath,
} from '../lib/local-api'
import { theme } from '../theme'
import Tooltip from './Tooltip'
import { HudFrame } from './hud'

interface Props {
  palette: ActivityPalette
  selectedTagId: number | null
  onSelectTag: (id: number | null) => void
  onPaletteChange: () => void
}

interface PathNode {
  segment: string
  children: Map<string, PathNode>
  tag?: ActivityTag       // 仅叶子节点持有
  fullPath: string        // 当前累计路径
  depth: number
}

const COLOR_PALETTE = [
  '#22C55E', '#38BDF8', '#F97316', '#E879F9', '#FACC15', '#14B8A6',
  '#FB7185', '#A78BFA', '#84CC16', '#60A5FA', '#F472B6', '#2DD4BF',
] as const

function buildTree(category: ActivityCategory, tags: ActivityTag[]): PathNode {
  const root: PathNode = {
    segment: category.name,
    children: new Map(),
    fullPath: category.name,
    depth: 1,
  }
  for (const tag of tags) {
    if (tag.categoryId !== category.id) continue
    const segments = tag.fullPath.split(',')
    if (segments[0] !== category.name) continue
    let node = root
    for (let i = 1; i < segments.length; i++) {
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

export default function ActivityTagPalette({
  palette, selectedTagId, onSelectTag, onPaletteChange,
}: Props) {
  // 反向状态：默认全部展开，只记录用户主动折叠的路径
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [addingCat, setAddingCat] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [newCatColor, setNewCatColor] = useState<string>(COLOR_PALETTE[0])
  const [addingTagFor, setAddingTagFor] = useState<{ categoryId: number; parentPath: string } | null>(null)
  const [newTagSegment, setNewTagSegment] = useState('')
  // 编辑某个节点 / 分类（旧路径作为 key）
  const [editingPath, setEditingPath] = useState<{ categoryId: number; fullPath: string; isCategory: boolean } | null>(null)
  const [editingValue, setEditingValue] = useState('')

  const trees = useMemo(() => {
    const sorted = [...palette.categories].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    return sorted.map((cat) => ({ category: cat, root: buildTree(cat, palette.tags) }))
  }, [palette])

  const toggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const expandPath = useCallback((path: string) => {
    setCollapsed((prev) => {
      if (!prev.has(path)) return prev
      const next = new Set(prev)
      next.delete(path)
      return next
    })
  }, [])

  // 任何右栏管理动作（编辑/添加/删除/改色/启动新建）都先清除画笔高亮
  const clearSelection = useCallback(() => onSelectTag(null), [onSelectTag])

  const startAddTag = useCallback((categoryId: number, parentPath: string) => {
    clearSelection()
    setAddingTagFor({ categoryId, parentPath })
    setNewTagSegment('')
    expandPath(parentPath)
  }, [expandPath, clearSelection])

  const cancelAddTag = useCallback(() => {
    setAddingTagFor(null)
    setNewTagSegment('')
  }, [])

  const startAddCategory = useCallback(() => {
    clearSelection()
    setAddingCat(true)
  }, [clearSelection])

  const handleAddCategory = useCallback(async () => {
    const name = newCatName.trim()
    if (!name) return
    try {
      await addActivityCategory(name, newCatColor)
      setNewCatName('')
      setAddingCat(false)
      clearSelection()
      onPaletteChange()
    } catch (e) {
      alert(`添加分类失败: ${e}`)
    }
  }, [newCatName, newCatColor, onPaletteChange, clearSelection])

  const handleDeleteCategory = useCallback(async (id: number, name: string) => {
    clearSelection()
    if (!window.confirm(`删除分类「${name}」及其所有标签？已涂的时间块也会一并清除。`)) return
    try {
      await deleteActivityCategory(id)
      onPaletteChange()
    } catch (e) {
      alert(`删除失败: ${e}`)
    }
  }, [onPaletteChange, clearSelection])

  const handleAddTag = useCallback(async () => {
    if (!addingTagFor) return
    const seg = newTagSegment.trim()
    if (!seg) return
    if (seg.includes(',')) {
      alert('段名不能包含逗号')
      return
    }
    const fullPath = `${addingTagFor.parentPath},${seg}`
    try {
      await addActivityTag(addingTagFor.categoryId, fullPath)
      setNewTagSegment('')
      setCollapsed((prev) => {
        if (!prev.has(addingTagFor.parentPath) && !prev.has(fullPath)) return prev
        const next = new Set(prev)
        next.delete(addingTagFor.parentPath)
        next.delete(fullPath)
        return next
      })
      setAddingTagFor(null)
      clearSelection()
      onPaletteChange()
    } catch (e) {
      alert(`添加标签失败: ${e}`)
    }
  }, [addingTagFor, newTagSegment, onPaletteChange, clearSelection])

  const handleDeleteTag = useCallback(async (tag: ActivityTag) => {
    clearSelection()
    if (!window.confirm(`删除标签「${tag.fullPath}」？已涂的时间块会一并清除。`)) return
    try {
      await deleteActivityTag(tag.id)
      onPaletteChange()
    } catch (e) {
      alert(`删除失败: ${e}`)
    }
  }, [onPaletteChange, clearSelection])

  const startEdit = useCallback((categoryId: number, fullPath: string, currentSegment: string, isCategory: boolean) => {
    clearSelection()
    setEditingPath({ categoryId, fullPath, isCategory })
    setEditingValue(currentSegment)
  }, [clearSelection])

  const cancelEdit = useCallback(() => {
    setEditingPath(null)
    setEditingValue('')
  }, [])

  const handleConfirmEdit = useCallback(async () => {
    if (!editingPath) return
    const v = editingValue.trim()
    if (!v) return
    if (v.includes(',')) {
      alert('段名不能包含逗号')
      return
    }
    try {
      if (editingPath.isCategory) {
        await updateActivityCategory(editingPath.categoryId, { name: v })
      } else {
        await renameActivityPath(editingPath.categoryId, editingPath.fullPath, v)
      }
      setEditingPath(null)
      setEditingValue('')
      clearSelection()
      onPaletteChange()
    } catch (e) {
      alert(`重命名失败: ${e}`)
    }
  }, [editingPath, editingValue, onPaletteChange, clearSelection])

  const handleChangeCategoryColor = useCallback(async (categoryId: number, color: string) => {
    clearSelection()
    try {
      await updateActivityCategory(categoryId, { color })
      onPaletteChange()
    } catch (e) {
      alert(`改颜色失败: ${e}`)
    }
  }, [onPaletteChange, clearSelection])

  return (
    <div style={{
      height: '100%', position: 'relative',
      padding: '4px 4px',
      fontFamily: theme.fontBody,
    }}>
      <HudFrame
        color={theme.expGreen}
        accent={theme.warningOrange}
        topLabel="ACTIVITY · PALETTE"
        showNotchTop
        showNotchBottom={false}
        notchWidth={84}
        notchDepth={7}
        cornerSize={16}
      />

      <div style={{
        height: '100%', overflow: 'auto',
        display: 'flex', flexDirection: 'column',
        padding: '24px 8px 8px 8px',
        gap: 6,
      }}>
        {/* 顶部：新建分类（折叠为按钮 / 展开为输入条） */}
        {addingCat ? (
          <div style={{
            border: `1px solid ${theme.expGreen}66`,
            background: 'rgba(34,197,94,0.06)',
            padding: '8px',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            <input
              autoFocus
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              placeholder="分类名（如 工作 / 学习）"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddCategory()
                else if (e.key === 'Escape') { setAddingCat(false); setNewCatName('') }
              }}
              style={inputStyle}
            />
            <ColorSwatchRow
              colors={COLOR_PALETTE as unknown as readonly string[]}
              value={newCatColor}
              onChange={setNewCatColor}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={handleAddCategory}
                disabled={!newCatName.trim()}
                style={{
                  flex: 1,
                  background: theme.expGreen,
                  color: '#071216',
                  border: 'none', padding: '4px 0',
                  cursor: 'pointer', fontSize: 11, fontWeight: 600,
                  opacity: newCatName.trim() ? 1 : 0.4,
                }}
              >确定</button>
              <button
                onClick={() => { setAddingCat(false); setNewCatName('') }}
                style={{
                  background: 'transparent',
                  color: theme.textSecondary,
                  border: `1px solid ${theme.glassBorder}`,
                  padding: '4px 8px',
                  cursor: 'pointer', fontSize: 11,
                }}
              >取消</button>
            </div>
          </div>
        ) : (
          <button
            onClick={startAddCategory}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 6,
              background: 'rgba(34,197,94,0.06)',
              border: `1px dashed ${theme.expGreen}55`,
              color: theme.expGreen,
              padding: '7px 0',
              cursor: 'pointer', fontSize: 11,
            }}
          >
            <Plus size={12} /> 新建分类
          </button>
        )}

        {trees.length === 0 && !addingCat && (
          <div style={{
            color: theme.textMuted, fontSize: 11, textAlign: 'center',
            marginTop: 18, lineHeight: 1.6,
          }}>
            还没有分类。<br />点上方 + 新建一个开始记录。
          </div>
        )}

        {trees.map(({ category, root }) => (
          <CategoryBlock
            key={category.id}
            category={category}
            root={root}
            collapsed={collapsed}
            onToggle={toggle}
            selectedTagId={selectedTagId}
            onSelectTag={onSelectTag}
            onDeleteCategory={() => handleDeleteCategory(category.id, category.name)}
            onAddTag={(parentPath) => startAddTag(category.id, parentPath)}
            onDeleteTag={handleDeleteTag}
            addingTagFor={addingTagFor}
            newTagSegment={newTagSegment}
            setNewTagSegment={setNewTagSegment}
            onConfirmAddTag={handleAddTag}
            onCancelAddTag={cancelAddTag}
            editingPath={editingPath}
            editingValue={editingValue}
            setEditingValue={setEditingValue}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onConfirmEdit={handleConfirmEdit}
            onChangeCategoryColor={handleChangeCategoryColor}
          />
        ))}
      </div>
    </div>
  )
}

// ── 分类块 ──

interface SharedNodeHandlers {
  collapsed: Set<string>
  onToggle: (path: string) => void
  selectedTagId: number | null
  onSelectTag: (id: number | null) => void
  onAddTag: (parentPath: string) => void
  onDeleteTag: (tag: ActivityTag) => void
  addingTagFor: { categoryId: number; parentPath: string } | null
  newTagSegment: string
  setNewTagSegment: (v: string) => void
  onConfirmAddTag: () => void
  onCancelAddTag: () => void
  editingPath: { categoryId: number; fullPath: string; isCategory: boolean } | null
  editingValue: string
  setEditingValue: (v: string) => void
  onStartEdit: (categoryId: number, fullPath: string, currentSegment: string, isCategory: boolean) => void
  onCancelEdit: () => void
  onConfirmEdit: () => void
}

function CategoryBlock({
  category, root, onDeleteCategory, onChangeCategoryColor, ...rest
}: {
  category: ActivityCategory
  root: PathNode
  onDeleteCategory: () => void
  onChangeCategoryColor: (categoryId: number, color: string) => void
} & SharedNodeHandlers) {
  const isOpen = !rest.collapsed.has(root.fullPath)
  const isEditingCategory = rest.editingPath?.isCategory && rest.editingPath?.categoryId === category.id
  const [showColorMenu, setShowColorMenu] = useState(false)
  const colorBtnRef = useRef<HTMLButtonElement | null>(null)

  // 关菜单：点击外面
  useEffect(() => {
    if (!showColorMenu) return
    const onDoc = (e: MouseEvent) => {
      if (!colorBtnRef.current?.contains(e.target as Node)) setShowColorMenu(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [showColorMenu])

  return (
    <div style={{
      border: `1px solid ${category.color}55`,
      background: `${category.color}0D`,
      padding: '4px 6px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button
          onClick={() => rest.onToggle(root.fullPath)}
          style={chevronBtn}
        >
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>

        {/* 颜色按钮 = 文件夹图标 */}
        <button
          ref={colorBtnRef}
          onClick={(e) => { e.stopPropagation(); setShowColorMenu((v) => !v) }}
          style={{
            display: 'flex', alignItems: 'center',
            background: 'transparent', border: 'none',
            cursor: 'pointer', padding: 0,
            position: 'relative',
          }}
          title="改颜色"
        >
          <Folder size={12} color={category.color} />
          {showColorMenu && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute', top: '100%', left: 0,
                marginTop: 4, zIndex: 50,
                background: 'rgba(2,8,20,0.96)',
                border: `1px solid ${theme.glassBorder}`,
                padding: 6,
                boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
              }}
            >
              <ColorSwatchRow
                colors={COLOR_PALETTE as unknown as readonly string[]}
                value={category.color}
                onChange={(c) => { onChangeCategoryColor(category.id, c); setShowColorMenu(false) }}
              />
            </div>
          )}
        </button>

        {isEditingCategory ? (
          <InlineRenameInput
            value={rest.editingValue}
            onChange={rest.setEditingValue}
            onConfirm={rest.onConfirmEdit}
            onCancel={rest.onCancelEdit}
          />
        ) : (
          <span style={{
            fontSize: 12, fontWeight: 600, color: theme.textPrimary,
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {category.name}
          </span>
        )}

        {!isEditingCategory && (
          <>
            <Tooltip content="重命名">
            <button onClick={(e) => { e.stopPropagation(); rest.onStartEdit(category.id, root.fullPath, category.name, true) }} style={iconBtn}>
              <Pencil size={10} />
            </button>
            </Tooltip>
            <Tooltip content="添加子标签">
            <button onClick={(e) => { e.stopPropagation(); rest.onAddTag(root.fullPath) }} style={iconBtn}>
              <Plus size={11} />
            </button>
            </Tooltip>
            <Tooltip content="删除分类">
            <button onClick={onDeleteCategory} style={{ ...iconBtn, color: theme.dangerRed }}>
              <Trash2 size={11} />
            </button>
            </Tooltip>
          </>
        )}
      </div>

      {isOpen && (
        <div style={{ marginTop: 4, paddingLeft: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TreeChildren
            node={root}
            color={category.color}
            categoryId={category.id}
            {...rest}
          />
          {/* 在分类层加子标签的输入条 */}
          {rest.addingTagFor && rest.addingTagFor.parentPath === root.fullPath && (
            <InlineAddTag
              parentPath={root.fullPath}
              value={rest.newTagSegment}
              onChange={rest.setNewTagSegment}
              onConfirm={rest.onConfirmAddTag}
              onCancel={rest.onCancelAddTag}
            />
          )}
        </div>
      )}
    </div>
  )
}

function TreeChildren({
  node, color, categoryId, ...rest
}: {
  node: PathNode
  color: string
  categoryId: number
} & SharedNodeHandlers) {
  const sortedChildren = useMemo(() => {
    return [...node.children.values()].sort((a, b) => {
      // 叶子按 last_used_at 倒序，非叶子按 segment
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
          categoryId={categoryId}
          {...rest}
        />
      ))}
    </>
  )
}

function TreeNode({
  node, color, categoryId, ...rest
}: {
  node: PathNode
  color: string
  categoryId: number
} & SharedNodeHandlers) {
  const hasChildren = node.children.size > 0
  const isOpen = !rest.collapsed.has(node.fullPath)
  const isLeafSelectable = !!node.tag
  const selected = isLeafSelectable && rest.selectedTagId === node.tag!.id
  const canAddDeeper = node.depth < 4
  const isEditingThisNode =
    !rest.editingPath?.isCategory &&
    rest.editingPath?.categoryId === categoryId &&
    rest.editingPath?.fullPath === node.fullPath

  const isAddingHere = rest.addingTagFor?.parentPath === node.fullPath

  return (
    <div>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 3,
          padding: '3px 4px',
          background: selected ? `${color}33` : 'transparent',
          border: `1px solid ${selected ? color : 'transparent'}`,
          cursor: isLeafSelectable && !isEditingThisNode ? 'pointer' : 'default',
          boxShadow: selected ? `0 0 8px ${color}55, inset 0 0 6px ${color}22` : undefined,
        }}
        onClick={(e) => {
          e.stopPropagation()
          if (isEditingThisNode) return
          if (isLeafSelectable) {
            rest.onSelectTag(selected ? null : node.tag!.id)
          }
        }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); rest.onToggle(node.fullPath) }}
            style={chevronBtn}
          >
            {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        ) : (
          <span style={{ width: 11, display: 'inline-block' }} />
        )}
        <TagIcon size={10} color={color} />

        {isEditingThisNode ? (
          <InlineRenameInput
            value={rest.editingValue}
            onChange={rest.setEditingValue}
            onConfirm={rest.onConfirmEdit}
            onCancel={rest.onCancelEdit}
          />
        ) : (
          <span style={{
            fontSize: 11.5, color: theme.textPrimary,
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {node.segment}
          </span>
        )}

        {!isEditingThisNode && (
          <>
            <Tooltip content="重命名">
            <button onClick={(e) => { e.stopPropagation(); rest.onStartEdit(categoryId, node.fullPath, node.segment, false) }} style={iconBtn}>
              <Pencil size={10} />
            </button>
            </Tooltip>
            {canAddDeeper && (
              <Tooltip content="添加更深层标签">
              <button onClick={(e) => { e.stopPropagation(); rest.onAddTag(node.fullPath) }} style={iconBtn}>
                <Plus size={10} />
              </button>
              </Tooltip>
            )}
            {isLeafSelectable && (
              <Tooltip content="删除标签">
              <button onClick={(e) => { e.stopPropagation(); rest.onDeleteTag(node.tag!) }} style={{ ...iconBtn, color: theme.dangerRed }}>
                <Trash2 size={10} />
              </button>
              </Tooltip>
            )}
          </>
        )}
      </div>

      {(hasChildren && isOpen) || isAddingHere ? (
        <div style={{ marginLeft: 10, borderLeft: `1px dashed ${color}33`, paddingLeft: 4, marginTop: 2 }}>
          {hasChildren && isOpen && (
            <TreeChildren
              node={node}
              color={color}
              categoryId={categoryId}
              {...rest}
            />
          )}
          {isAddingHere && (
            <InlineAddTag
              parentPath={node.fullPath}
              value={rest.newTagSegment}
              onChange={rest.setNewTagSegment}
              onConfirm={rest.onConfirmAddTag}
              onCancel={rest.onCancelAddTag}
            />
          )}
        </div>
      ) : null}
    </div>
  )
}

// ── 子组件：内联输入条 ──

function InlineRenameInput({
  value, onChange, onConfirm, onCancel,
}: {
  value: string
  onChange: (v: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }} onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onConfirm()
          else if (e.key === 'Escape') onCancel()
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

function InlineAddTag({
  parentPath, value, onChange, onConfirm, onCancel,
}: {
  parentPath: string
  value: string
  onChange: (v: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '4px 6px', marginTop: 2,
      border: `1px dashed ${theme.electricBlue}66`,
      background: 'rgba(0,229,255,0.06)',
    }}>
      <span style={{ fontSize: 10, color: theme.textMuted, whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {parentPath} /
      </span>
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="子标签名"
        onKeyDown={(e) => {
          if (e.key === 'Enter') onConfirm()
          else if (e.key === 'Escape') onCancel()
        }}
        style={{ ...inputStyle, flex: 1, padding: '3px 5px', fontSize: 11 }}
      />
      <button onClick={onConfirm} style={{ ...iconBtn, color: theme.expGreen }}>
        <Check size={11} />
      </button>
      <button onClick={onCancel} style={iconBtn}>
        <X size={11} />
      </button>
    </div>
  )
}

function ColorSwatchRow({
  colors, value, onChange,
}: {
  colors: readonly string[]
  value: string
  onChange: (color: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {colors.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          style={{
            width: 18, height: 18,
            background: c,
            border: `1.5px solid ${value === c ? theme.textPrimary : 'transparent'}`,
            cursor: 'pointer',
            boxShadow: value === c ? `0 0 6px ${c}` : undefined,
          }}
        />
      ))}
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center',
  background: 'transparent', border: 'none',
  color: theme.textSecondary, cursor: 'pointer', padding: 2,
}

const chevronBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center',
  background: 'transparent', border: 'none',
  color: theme.textSecondary, cursor: 'pointer', padding: 0,
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.4)',
  border: `1px solid ${theme.glassBorder}`,
  color: theme.textPrimary,
  padding: '5px 7px',
  fontSize: 12,
  outline: 'none',
}
