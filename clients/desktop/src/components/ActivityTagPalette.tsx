// ══════════════════════════════════════════════
// ActivityTagPalette — 活动记录标签库（扁平版 v2）
//   · 不再树形；tag 一行一个，按 last_used_at 倒序
//   · 顶部 category 色块条 = 过滤（点击切换；右键 = 编辑分类）
//   · 每行尾部 「…」按钮 / 右键 = 菜单 [改颜色 / 改名 / 删除]
//   · 改色作用于整个分类（同分类下所有 tag 共享色）
//   · 改名拒绝同分类下重名
//   · 新建 tag：在搜索栏里输完整路径（如 "工作,论文,DPO"），
//     如果不存在就出现「+ 新建」按钮直接创建（首段必须是已有分类）
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Check, MoreHorizontal, Palette, Pencil, Plus, Search, Tag as TagIcon, Trash2, X, Zap } from 'lucide-react'
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

const COLOR_PALETTE = [
  '#22C55E', '#38BDF8', '#F97316', '#E879F9', '#FACC15', '#14B8A6',
  '#FB7185', '#A78BFA', '#84CC16', '#60A5FA', '#F472B6', '#2DD4BF',
] as const

// 一键初始化的默认分类 + 标签（偏向通用，不预置编程 — 不是所有人都适合）
const DEFAULT_PALETTE: ReadonlyArray<{ name: string; color: string; tags: ReadonlyArray<string> }> = [
  { name: '工作', color: '#38BDF8', tags: ['会议', '写文档', '日报周报', '沟通协调'] },
  { name: '学习', color: '#2DD4BF', tags: ['看书', '看视频课', '做笔记', '复盘'] },
  { name: '生活', color: '#F97316', tags: ['做饭', '吃饭', '洗漱', '采购', '通勤'] },
  { name: '运动', color: '#14B8A6', tags: ['跑步', '健身', '散步'] },
  { name: '休息', color: '#84CC16', tags: ['睡觉', '午休', '小憩', '冥想'] },
  { name: '娱乐', color: '#FB7185', tags: ['看视频', '玩游戏', '刷手机'] },
  { name: '杂项', color: '#F97316', tags: ['临时事项', '等待', '整理'] },
]

type TagMenu = { tag: ActivityTag; x: number; y: number; mode: 'menu' | 'color' }

export default function ActivityTagPalette({
  palette, selectedTagId, onSelectTag, onPaletteChange,
}: Props) {
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null)
  // 新建标签模式：复用 searchQuery 作为输入；下面的 tag 列表作为模糊匹配提示
  const [addMode, setAddMode] = useState(false)
  // 行内重命名（只改末段）
  const [editingTagId, setEditingTagId] = useState<number | null>(null)
  const [editingTagSeg, setEditingTagSeg] = useState('')
  // 右键 / "…" 菜单
  const [tagMenu, setTagMenu] = useState<TagMenu | null>(null)
  // 分类编辑（右键 chip 触发）
  const [editingCatId, setEditingCatId] = useState<number | null>(null)
  const [editingCatName, setEditingCatName] = useState('')
  const [editingCatColor, setEditingCatColor] = useState<string>(COLOR_PALETTE[0])

  const catById = useMemo(() => new Map(palette.categories.map((c) => [c.id, c])), [palette.categories])
  const catByName = useMemo(() => new Map(palette.categories.map((c) => [c.name, c])), [palette.categories])

  const query = searchQuery.trim()
  const queryLower = query.toLowerCase()

  const visibleTags = useMemo(() => {
    let arr = [...palette.tags]
    if (categoryFilter != null) arr = arr.filter((t) => t.categoryId === categoryFilter)
    if (!queryLower) {
      return arr.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    }
    // 模糊匹配 + 相关度排序：
    //   100 精确等于 query        80 query 是某段       60 子串
    //   40 分类名匹配（路径本身不含）    其它丢弃
    const scored = arr.map((t) => {
      const path = t.fullPath.toLowerCase()
      const cat = catById.get(t.categoryId)
      const catName = (cat?.name ?? '').toLowerCase()
      let score = 0
      if (path === queryLower) score = 100
      else if (path.split(',').some((s) => s.trim() === queryLower)) score = 80
      else if (path.includes(queryLower)) score = 60
      else if (catName.includes(queryLower)) score = 40
      return { tag: t, score }
    }).filter((s) => s.score > 0)
    scored.sort((a, b) => b.score - a.score
      || b.tag.lastUsedAt.localeCompare(a.tag.lastUsedAt))
    return scored.map((s) => s.tag)
  }, [palette.tags, categoryFilter, queryLower, catById])


  const closeAllMenus = useCallback(() => setTagMenu(null), [])

  // 点空白关闭菜单
  useEffect(() => {
    if (tagMenu == null) return
    const onDown = () => setTagMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTagMenu(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [tagMenu])

  // ── tag 改名（允许改整条 full_path，包括前面的分类段） ──
  const startRenameTag = useCallback((tag: ActivityTag) => {
    onSelectTag(null)
    setEditingTagId(tag.id)
    setEditingTagSeg(tag.fullPath)
    closeAllMenus()
  }, [onSelectTag, closeAllMenus])

  const cancelRename = useCallback(() => {
    setEditingTagId(null)
    setEditingTagSeg('')
  }, [])

  const confirmRenameTag = useCallback(async (tag: ActivityTag) => {
    const v = editingTagSeg.trim().replace(/^,+|,+$/g, '')
    if (!v) return
    if (v === tag.fullPath) { cancelRename(); return }
    const segs = v.split(',').map((s) => s.trim()).filter(Boolean)
    if (segs.length < 2) { alert('路径至少要 2 段（分类名 + 子段）'); return }
    // 首段必须是已有分类
    const newCat = catByName.get(segs[0])
    if (!newCat) {
      alert(`首段「${segs[0]}」不是已有分类。可用分类：${[...catByName.keys()].join(' / ')}`)
      return
    }
    const newFullPath = segs.join(',')
    // 同分类下查重（前端先拦一道，后端也会查）
    const dup = palette.tags.some((t) => t.id !== tag.id
      && t.categoryId === newCat.id
      && t.fullPath === newFullPath)
    if (dup) {
      alert(`已存在同名标签「${newFullPath}」`)
      return
    }
    try {
      await renameActivityPath(tag.id, newFullPath)
      cancelRename()
      onPaletteChange()
    } catch (e) {
      alert(`改名失败: ${e}`)
    }
  }, [editingTagSeg, palette.tags, catByName, cancelRename, onPaletteChange])

  // ── tag 删除 ──
  const handleDeleteTag = useCallback(async (tag: ActivityTag) => {
    closeAllMenus()
    if (!window.confirm(`确定删除标签「${tag.fullPath}」？\n已涂的时间块会一并清除。`)) return
    onSelectTag(null)
    try {
      await deleteActivityTag(tag.id)
      onPaletteChange()
    } catch (e) {
      alert(`删除失败: ${e}`)
    }
  }, [onSelectTag, onPaletteChange, closeAllMenus])

  // ── 通过 tag 菜单改分类颜色 ──
  const applyCategoryColor = useCallback(async (catId: number, color: string) => {
    try {
      await updateActivityCategory(catId, { color })
      closeAllMenus()
      onPaletteChange()
    } catch (e) {
      alert(`改颜色失败: ${e}`)
    }
  }, [closeAllMenus, onPaletteChange])

  // ── 一键初始化默认分类 + 常用标签（空状态时使用） ──
  const [seeding, setSeeding] = useState(false)
  const handleSeedDefaults = useCallback(async () => {
    if (seeding) return
    setSeeding(true)
    try {
      for (const c of DEFAULT_PALETTE) {
        const cat = await addActivityCategory(c.name, c.color)
        for (const t of c.tags) {
          await addActivityTag(cat.id, `${c.name},${t}`)
        }
      }
      onPaletteChange()
    } catch (e) {
      alert(`初始化默认分类失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSeeding(false)
    }
  }, [seeding, onPaletteChange])

  // ── 显式新建模式：「+」按钮开/关 ──
  // 新建模式下复用 searchQuery 作为新标签路径输入；同一输入框，下面 tag 列表
  // 仍按 searchQuery 模糊过滤，方便参考已有标签起名（点 tag 会回填）
  const enterAddMode = useCallback(() => {
    onSelectTag(null)
    setAddMode(true)
    setSearchQuery('')
  }, [onSelectTag])

  const exitAddMode = useCallback(() => {
    setAddMode(false)
    setSearchQuery('')
  }, [])

  const handleCreateTag = useCallback(async () => {
    // 兜底再 normalize 中文逗号一次（粘贴 / 输入法快速切换可能漏过 onChange）
    const raw = searchQuery.replace(/，/g, ',').trim().replace(/^,+|,+$/g, '')
    if (!raw) return
    const segs = raw.split(',').map((s) => s.trim()).filter(Boolean)
    if (segs.length < 2) {
      alert('新标签格式：分类名,子段[,子段...]（如 "工作,论文,DPO"）')
      return
    }
    const cat = catByName.get(segs[0])
    if (!cat) {
      alert(`首段「${segs[0]}」不是已有分类。可用分类：${[...catByName.keys()].join(' / ')}`)
      return
    }
    const fullPath = segs.join(',')
    if (palette.tags.some((t) => t.categoryId === cat.id && t.fullPath === fullPath)) {
      alert(`已存在同名标签「${fullPath}」`)
      return
    }
    try {
      await addActivityTag(cat.id, fullPath)
      exitAddMode()
      onPaletteChange()
    } catch (e) {
      alert(`创建失败: ${e}`)
    }
  }, [searchQuery, catByName, palette.tags, onPaletteChange, exitAddMode])

  // ── 分类管理 ──
  const startEditCategory = useCallback((cat: ActivityCategory) => {
    onSelectTag(null)
    setEditingCatId(cat.id)
    setEditingCatName(cat.name)
    setEditingCatColor(cat.color)
  }, [onSelectTag])

  const cancelEditCategory = useCallback(() => {
    setEditingCatId(null)
    setEditingCatName('')
  }, [])

  const handleSaveCategory = useCallback(async () => {
    if (editingCatId == null) return
    const cat = catById.get(editingCatId)
    if (!cat) return
    const newName = editingCatName.trim()
    if (!newName) return
    // 同名分类查重
    if (newName !== cat.name && palette.categories.some((c) => c.id !== cat.id && c.name === newName)) {
      alert(`已存在同名分类「${newName}」`)
      return
    }
    const patch: { name?: string; color?: string } = {}
    if (newName !== cat.name) patch.name = newName
    if (editingCatColor !== cat.color) patch.color = editingCatColor
    if (Object.keys(patch).length === 0) {
      cancelEditCategory()
      return
    }
    try {
      await updateActivityCategory(editingCatId, patch)
      cancelEditCategory()
      onPaletteChange()
    } catch (e) {
      alert(`改分类失败: ${e}`)
    }
  }, [editingCatId, editingCatName, editingCatColor, catById, palette.categories, onPaletteChange, cancelEditCategory])

  const handleDeleteCategory = useCallback(async (cat: ActivityCategory) => {
    if (!window.confirm(`确定删除分类「${cat.name}」？\n它下面所有标签和已涂时间块都会被一起清掉。`)) return
    onSelectTag(null)
    try {
      await deleteActivityCategory(cat.id)
      if (categoryFilter === cat.id) setCategoryFilter(null)
      cancelEditCategory()
      onPaletteChange()
    } catch (e) {
      alert(`删除失败: ${e}`)
    }
  }, [onSelectTag, categoryFilter, cancelEditCategory, onPaletteChange])

  return (
    <div style={{
      height: '100%',
      position: 'relative',
      padding: '4px 4px',
      fontFamily: theme.fontBody,
    }}>
      <HudFrame
        color={theme.expGreen}
        accent={theme.warningOrange}
        topLabel="ACTIVITY · 活动标签"
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
        {/* 搜索栏 + "+" 按钮（左侧）= 新建模式入口；同一个输入框两种用途 */}
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 4 }}>
          <Tooltip content={addMode ? '取消新建' : '新建标签'}>
            <button
              type="button"
              onClick={addMode ? exitAddMode : enterAddMode}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 28, flexShrink: 0,
                background: addMode ? `${theme.electricBlue}1A` : 'rgba(0,229,255,0.045)',
                border: `1px solid ${addMode ? theme.electricBlue + '88' : theme.hudFrameSoft}`,
                color: addMode ? theme.electricBlue : theme.textPrimary,
                cursor: 'pointer',
              }}
            >
              {addMode ? <X size={12} /> : <Plus size={12} />}
            </button>
          </Tooltip>
          <SearchBox
            query={searchQuery}
            // 中文逗号 → 英文逗号，让用户输入法切换无烦（搜索/新建都兜底）
            onChange={(v) => setSearchQuery(v.replace(/，/g, ','))}
            addMode={addMode}
            onSubmitAdd={handleCreateTag}
            onCancelAdd={exitAddMode}
          />
        </div>

        {/* 分类色块条：点击 = 过滤；右键 = 编辑分类 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap',
          padding: '2px 0',
        }}>
          {palette.categories.map((cat) => (
            <CategoryChip
              key={cat.id}
              cat={cat}
              active={categoryFilter === cat.id}
              onToggle={() => setCategoryFilter((prev) => prev === cat.id ? null : cat.id)}
              onEdit={() => startEditCategory(cat)}
            />
          ))}
          {categoryFilter != null && (
            <button
              type="button"
              onClick={() => setCategoryFilter(null)}
              style={{
                marginLeft: 'auto',
                fontFamily: theme.fontMono,
                fontSize: 9.5,
                color: theme.textMuted,
                background: 'transparent', border: 'none',
                cursor: 'pointer',
                padding: '2px 4px',
              }}
            >
              清除筛选 ✕
            </button>
          )}
        </div>

        {/* 分类编辑（右键 chip 触发） */}
        {editingCatId != null && (() => {
          const cat = catById.get(editingCatId)
          if (!cat) return null
          return (
            <CategoryEditor
              name={editingCatName}
              color={editingCatColor}
              onNameChange={setEditingCatName}
              onColorChange={setEditingCatColor}
              onSave={handleSaveCategory}
              onCancel={cancelEditCategory}
              onDelete={() => handleDeleteCategory(cat)}
              deletable
            />
          )
        })()}

        {/* 列表标题 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 2px 2px',
          color: theme.textMuted,
          fontFamily: theme.fontMono,
          fontSize: 9.5,
          letterSpacing: 1.5,
          fontWeight: 700,
        }}>
          <TagIcon size={10} />
          <span>TAGS · {visibleTags.length}</span>
          <span style={{ opacity: 0.6 }}>· 最近用的在上</span>
        </div>

        {visibleTags.length === 0 ? (
          <EmptyHint
            hasAny={palette.tags.length > 0}
            hasCategories={palette.categories.length > 0}
            hasFilter={categoryFilter != null || queryLower.length > 0}
            seeding={seeding}
            onSeed={handleSeedDefaults}
            onEnterAddMode={enterAddMode}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {visibleTags.map((tag) => {
              const cat = catById.get(tag.categoryId)
              const isSelected = selectedTagId === tag.id
              const isEditing = editingTagId === tag.id
              return (
                <TagRow
                  key={tag.id}
                  tag={tag}
                  color={cat?.color ?? theme.textMuted}
                  selected={isSelected}
                  editing={isEditing}
                  editValue={editingTagSeg}
                  highlight={queryLower}
                  onClick={() => {
                    // 新建模式下：点击 tag = 回填路径到输入框（便于基于已有标签起名）
                    // 普通模式下：点击 tag = 选作画笔
                    if (addMode) {
                      setSearchQuery(tag.fullPath)
                    } else {
                      onSelectTag(isSelected ? null : tag.id)
                    }
                  }}
                  onConfirmRename={() => confirmRenameTag(tag)}
                  onCancelRename={cancelRename}
                  onEditChange={setEditingTagSeg}
                  onOpenMenu={(x, y) => setTagMenu({ tag, x, y, mode: 'menu' })}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* 右键/… 菜单 */}
      {tagMenu && (
        <TagContextMenu
          menu={tagMenu}
          categoryName={catById.get(tagMenu.tag.categoryId)?.name ?? ''}
          currentColor={catById.get(tagMenu.tag.categoryId)?.color ?? theme.textMuted}
          onPickColor={(c) => applyCategoryColor(tagMenu.tag.categoryId, c)}
          onSwitchMode={(mode) => setTagMenu({ ...tagMenu, mode })}
          onRename={() => startRenameTag(tagMenu.tag)}
          onDelete={() => handleDeleteTag(tagMenu.tag)}
        />
      )}
    </div>
  )
}

// ── SearchBox（兼新建入口） ──
function SearchBox({
  query, onChange, addMode, onSubmitAdd, onCancelAdd,
}: {
  query: string
  onChange: (v: string) => void
  addMode: boolean
  onSubmitAdd: () => void
  onCancelAdd: () => void
}) {
  return (
    <div style={{
      flex: 1,
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '5px 9px',
      border: addMode
        ? `1px dashed ${theme.electricBlue}88`
        : `1px solid ${theme.hudFrameSoft}`,
      background: addMode
        ? 'rgba(0,229,255,0.07)'
        : 'rgba(0,229,255,0.045)',
    }}>
      {addMode
        ? <Plus size={11} style={{ color: theme.electricBlue, flexShrink: 0 }} />
        : <Search size={11} style={{ color: theme.textPrimary, flexShrink: 0 }} />}
      <input
        // 切到 addMode 时让输入框自动 focus
        key={addMode ? 'add' : 'search'}
        autoFocus={addMode}
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder={addMode ? '新标签完整路径（工作,论文,DPO）' : '搜索...'}
        onKeyDown={(e) => {
          if (addMode) {
            if (e.key === 'Enter') onSubmitAdd()
            else if (e.key === 'Escape') onCancelAdd()
          }
        }}
        style={{
          flex: 1, minWidth: 0,
          background: 'transparent', border: 'none', outline: 'none',
          color: theme.textPrimary, fontFamily: theme.fontBody, fontSize: 12,
        }}
      />
      {addMode ? (
        query && (
          <Tooltip content="新建（Enter）">
            <button
              type="button"
              onClick={onSubmitAdd}
              style={{ ...iconBtnSmall, color: theme.expGreen }}
            >
              <Check size={12} />
            </button>
          </Tooltip>
        )
      ) : (
        query && (
          <button
            onClick={() => onChange('')}
            aria-label="清空"
            style={tinyIconBtn}
          >
            <X size={10} />
          </button>
        )
      )}
    </div>
  )
}

// ── CategoryChip ──
function CategoryChip({ cat, active, onToggle, onEdit }: {
  cat: ActivityCategory
  active: boolean
  onToggle: () => void
  onEdit: () => void
}) {
  return (
    <Tooltip content="点击过滤 · 右键编辑分类">
      <button
        type="button"
        onClick={onToggle}
        onContextMenu={(e) => { e.preventDefault(); onEdit() }}
        style={{
          ...chipBaseStyle(cat.color),
          opacity: active ? 1 : 0.78,
          boxShadow: active ? `0 0 6px ${cat.color}55, inset 0 0 6px ${cat.color}22` : undefined,
          outline: active ? `1px solid ${cat.color}` : 'none',
        }}
      >
        <span style={{
          width: 7, height: 7, background: cat.color, flexShrink: 0,
        }} />
        <span style={{
          fontSize: 10.5, color: theme.textPrimary, whiteSpace: 'nowrap',
        }}>
          {cat.name}
        </span>
      </button>
    </Tooltip>
  )
}

function CategoryEditor({
  name, color, onNameChange, onColorChange, onSave, onCancel, onDelete, deletable,
}: {
  name: string; color: string
  onNameChange: (v: string) => void
  onColorChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
  onDelete?: () => void
  deletable?: boolean
}) {
  return (
    <div style={{
      border: `1px solid ${color}55`,
      background: `${color}10`,
      padding: '6px 8px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          autoFocus
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="分类名"
          onKeyDown={(e) => { if (e.key === 'Enter') onSave(); else if (e.key === 'Escape') onCancel() }}
          style={inputStyle}
        />
        <button onClick={onSave} style={{ ...iconBtnSmall, color: theme.expGreen }}><Check size={12} /></button>
        <button onClick={onCancel} style={iconBtnSmall}><X size={12} /></button>
        {deletable && onDelete && (
          <Tooltip content="删除分类">
            <button onClick={onDelete} style={{ ...iconBtnSmall, color: theme.dangerRed }}>
              <Trash2 size={12} />
            </button>
          </Tooltip>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {COLOR_PALETTE.map((c) => (
          <button
            key={c}
            onClick={() => onColorChange(c)}
            style={{
              width: 18, height: 18, background: c,
              border: `1px solid ${color === c ? theme.textPrimary : 'transparent'}`,
              cursor: 'pointer',
            }}
          />
        ))}
      </div>
    </div>
  )
}

// ── TagRow ──
function TagRow({
  tag, color, selected, editing, editValue, highlight,
  onClick, onConfirmRename, onCancelRename, onEditChange, onOpenMenu,
}: {
  tag: ActivityTag; color: string; selected: boolean; editing: boolean
  editValue: string; highlight: string
  onClick: () => void
  onConfirmRename: () => void
  onCancelRename: () => void
  onEditChange: (v: string) => void
  onOpenMenu: (x: number, y: number) => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={editing ? undefined : onClick}
      onContextMenu={(e) => {
        e.preventDefault()
        onOpenMenu(e.clientX, e.clientY)
      }}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '4px 6px',
        background: selected ? `${color}22` : (hover ? 'rgba(255,255,255,0.03)' : 'transparent'),
        border: `1px solid ${selected ? color : 'transparent'}`,
        boxShadow: selected ? `0 0 6px ${color}55, inset 0 0 6px ${color}22` : undefined,
        cursor: editing ? 'default' : 'pointer',
      }}
    >
      <span style={{
        width: 8, height: 8, flexShrink: 0,
        background: color,
      }} />
      {editing ? (
        <>
          <input
            autoFocus
            value={editValue}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConfirmRename()
              else if (e.key === 'Escape') onCancelRename()
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder="完整路径，如 工作,论文,DPO"
            style={{ ...inputStyle, flex: 1, padding: '2px 4px' }}
          />
          <button onClick={(e) => { e.stopPropagation(); onConfirmRename() }} style={{ ...iconBtnSmall, color: theme.expGreen }}>
            <Check size={11} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onCancelRename() }} style={iconBtnSmall}>
            <X size={11} />
          </button>
        </>
      ) : (
        <>
          <span style={{
            flex: 1, minWidth: 0,
            fontSize: 11.5, color: theme.textPrimary,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            fontWeight: selected ? 700 : 500,
          }}>
            <Highlight text={tag.fullPath} keyword={highlight} />
          </span>
          {/* "…" 按钮：hover 时显示 */}
          {(hover || selected) && (
            <Tooltip content="更多操作">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                  onOpenMenu(rect.right, rect.bottom)
                }}
                style={iconBtnSmall}
              >
                <MoreHorizontal size={12} />
              </button>
            </Tooltip>
          )}
        </>
      )}
    </div>
  )
}

// ── 右键 / "…" 菜单（支持二级"改色"色板） ──
function TagContextMenu({
  menu, categoryName, currentColor, onPickColor, onSwitchMode, onRename, onDelete,
}: {
  menu: TagMenu
  categoryName: string
  currentColor: string
  onPickColor: (color: string) => void
  onSwitchMode: (mode: 'menu' | 'color') => void
  onRename: () => void
  onDelete: () => void
}) {
  // 防止菜单超出视口右下边界
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })
  useEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const vw = window.innerWidth, vh = window.innerHeight
    let x = menu.x, y = menu.y
    if (x + rect.width > vw - 4) x = vw - rect.width - 4
    if (y + rect.height > vh - 4) y = vh - rect.height - 4
    setPos({ x, y })
  }, [menu.x, menu.y, menu.mode])

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        left: pos.x, top: pos.y,
        zIndex: 9999,
        minWidth: 156,
        background: 'rgba(8,14,24,0.96)',
        border: `1px solid ${theme.hudFrameSoft}`,
        boxShadow: '0 6px 22px rgba(0,0,0,0.55)',
        padding: 4,
        fontFamily: theme.fontBody,
        fontSize: 11.5,
        color: theme.textPrimary,
      }}
    >
      {menu.mode === 'menu' ? (
        <>
          <MenuItem icon={<Palette size={12} />} label={`改颜色 (${categoryName})`} onClick={() => onSwitchMode('color')} />
          <MenuItem icon={<Pencil size={12} />} label="更改标签名" onClick={onRename} />
          <MenuItem icon={<Trash2 size={12} />} label="删除标签" onClick={onDelete} danger />
        </>
      ) : (
        <div>
          <div style={{
            padding: '4px 6px',
            color: theme.textMuted,
            fontSize: 10,
            fontFamily: theme.fontMono,
            letterSpacing: 1.2,
          }}>
            分类 {categoryName} · 共享色
          </div>
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 4,
            padding: '4px 6px',
            maxWidth: 168,
          }}>
            {COLOR_PALETTE.map((c) => (
              <button
                key={c}
                onClick={() => onPickColor(c)}
                style={{
                  width: 22, height: 22, background: c,
                  border: `1px solid ${currentColor === c ? theme.textPrimary : 'transparent'}`,
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
          <MenuItem icon={<X size={12} />} label="返回" onClick={() => onSwitchMode('menu')} />
        </div>
      )}
    </div>
  )
}

function MenuItem({
  icon, label, onClick, danger,
}: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%',
        padding: '6px 8px',
        background: hover ? (danger ? 'rgba(255,68,68,0.12)' : `${theme.electricBlue}14`) : 'transparent',
        border: 'none',
        color: danger ? theme.dangerRed : theme.textPrimary,
        cursor: 'pointer',
        fontSize: 11.5,
        textAlign: 'left',
      }}
    >
      <span style={{ color: danger ? theme.dangerRed : theme.textSecondary, display: 'inline-flex' }}>
        {icon}
      </span>
      {label}
    </button>
  )
}

function Highlight({ text, keyword }: { text: string; keyword: string }) {
  if (!keyword) return <>{text}</>
  const lower = text.toLowerCase()
  const out: React.ReactNode[] = []
  let cursor = 0
  let idx = lower.indexOf(keyword)
  let k = 0
  while (idx >= 0) {
    if (idx > cursor) out.push(text.slice(cursor, idx))
    out.push(
      <mark key={`m-${k++}`} style={{
        background: `${theme.electricBlue}40`, color: theme.electricBlue,
        padding: 0, fontWeight: 800,
      }}>
        {text.slice(idx, idx + keyword.length)}
      </mark>
    )
    cursor = idx + keyword.length
    idx = lower.indexOf(keyword, cursor)
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return <>{out}</>
}

function EmptyHint({
  hasAny, hasCategories, hasFilter, seeding, onSeed, onEnterAddMode,
}: {
  hasAny: boolean
  hasCategories: boolean
  hasFilter: boolean
  seeding: boolean
  onSeed: () => void
  onEnterAddMode: () => void
}) {
  if (hasFilter) {
    return <div style={emptyHintStyle}>没有匹配的标签</div>
  }
  if (!hasCategories || !hasAny) {
    // 三行居中布局（对齐 mobile DayNightScreen 空 palette 风格）：
    //   ① 醒目按钮  ② LAN 同步说明  ③ + 自建说明
    return (
      <div style={{
        width: '100%',
        padding: '40px 16px 28px',
        fontFamily: theme.fontBody,
        fontSize: 11.5,
        color: theme.textSecondary,
        lineHeight: 1.9,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
      }}>
        <div style={{ color: theme.textPrimary, fontWeight: 600, letterSpacing: 0.4 }}>
          还没有标签 · 以下任一方式开始
        </div>
        <SeedDefaultsButton onClick={onSeed} disabled={seeding} />
        <div>
          也可以从其他电脑端 / 手机端 <strong style={{ color: theme.electricBlue }}>局域网同步</strong> 过来
        </div>
        <div>
          或点 <InlinePlusButton onClick={onEnterAddMode} /> 自己输入 <strong style={{ color: theme.electricBlue }}>分类,标签</strong> 新建
        </div>
      </div>
    )
  }
  return null
}

/** 一键初始化按钮：HUD 风格（accent 描边 + accent 实心填充 + Zap 图标）。 */
function SeedDefaultsButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 16px',
        background: disabled ? 'rgba(0,229,255,0.18)' : theme.electricBlue,
        border: `1px solid ${theme.electricBlue}`,
        color: disabled ? theme.textSecondary : '#001018',
        fontFamily: theme.fontBody,
        fontWeight: 700,
        fontSize: 12.5,
        letterSpacing: 0.6,
        cursor: disabled ? 'wait' : 'pointer',
        boxShadow: disabled ? 'none' : `0 0 12px ${theme.electricBlue}55`,
      }}
    >
      <Zap size={13} strokeWidth={2.4} />
      <span>
        {disabled ? '初始化中…' : '一键初始化'}
        {!disabled && (
          <span style={{
            marginLeft: 8,
            fontSize: 10.5,
            fontWeight: 500,
            opacity: 0.78,
            letterSpacing: 0.2,
          }}>
            (7 分类 + 26 常用标签)
          </span>
        )}
      </span>
    </button>
  )
}

// 复用顶栏「+」按钮同款样式（缩小一档以贴合行内）
function InlinePlusButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 18,
        verticalAlign: '-4px',
        background: 'rgba(0,229,255,0.045)',
        border: `1px solid ${theme.hudFrameSoft}`,
        color: theme.textPrimary,
        cursor: 'pointer',
        margin: '0 3px',
      }}
    >
      <Plus size={11} />
    </button>
  )
}

// ── 样式常量 ──

const inputStyle: CSSProperties = {
  flex: 1, minWidth: 0,
  background: 'rgba(0,0,0,0.4)',
  border: `1px solid ${theme.glassBorder}`,
  color: theme.textPrimary,
  padding: '3px 6px',
  fontSize: 11.5,
  fontFamily: theme.fontBody,
  outline: 'none',
}

const iconBtnSmall: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent', border: 'none',
  color: theme.textSecondary,
  cursor: 'pointer',
  padding: 2, flexShrink: 0,
}

const tinyIconBtn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 16, height: 16, padding: 0,
  borderRadius: '50%',
  background: `${theme.textMuted}28`,
  border: 'none',
  color: theme.textPrimary,
  cursor: 'pointer',
  flexShrink: 0,
}

function chipBaseStyle(color: string): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 6px',
    background: `${color}1A`,
    border: `1px solid ${color}66`,
    color: theme.textPrimary,
    fontFamily: theme.fontBody,
    fontSize: 10.5,
    cursor: 'pointer',
  }
}

const emptyHintStyle: CSSProperties = {
  color: theme.textMuted,
  fontSize: 11,
  textAlign: 'center',
  padding: '12px 8px',
  lineHeight: 1.5,
}
