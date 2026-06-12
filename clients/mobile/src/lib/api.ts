// ══════════════════════════════════════════════
// 数据层 —— 昼夜表 / palette 走真 SQLite (SolevupDb native module)
//   全新装时 palette 为空，UI 显示"新建标签"引导；后续可手动 createTag
//   或 LAN 同步从 desktop 拉过来。
//   LAN HTTP 路径 (lanFetch / setLanHost) 暂保留壳，Phase 5 LAN 同步引擎接入。
//   聊天 streamChatReply 仍走 mock 合成（独立功能，未接入 SolevupDb）。
// ══════════════════════════════════════════════

import type {
  ActivityBlock,
  ActivityCategory,
  ActivityPalette,
  ActivityTag,
  AiMode,
} from '../types'
import { toLocalDateStr } from './time'
import { mockReply } from './mock'
import {
  solevupDeleteCategory,
  solevupDeleteTag,
  solevupRenameCategory,
  solevupRenameTagPath,
  solevupEraseBlocks,
  solevupListBlocksForDate,
  solevupListCategories,
  solevupListTags,
  solevupPaintBlocks,
  solevupUpsertCategory,
  solevupUpsertTag,
  type BlockRow,
  type CategoryRow,
  type TagRow,
} from './solevupdb'


// ── SolevupDb → 前端类型映射 ──

function categoryFromRow(r: CategoryRow): ActivityCategory {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    sortOrder: r.sortOrder,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
  }
}

function tagFromRow(r: TagRow): ActivityTag {
  return {
    id: r.id,
    categoryId: r.categoryId,
    fullPath: r.fullPath,
    leafName: r.leafName,
    depth: r.depth,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
  }
}

function blockFromRow(r: BlockRow): ActivityBlock {
  return {
    date: r.date,
    minute: r.minute,
    tagId: r.tagId,
    note: r.note ?? null,
    createdAt: r.createdAt,
  }
}

// ── 活动记录 API（主路径走 SolevupDb） ──

export async function fetchPalette(): Promise<ActivityPalette> {
  // 不再 seed 硬编码标签库 —— 等用户在 UI 里创建，或 LAN 同步从 desktop 拉过来
  const [cats, tags] = await Promise.all([solevupListCategories(), solevupListTags()])
  return {
    categories: cats.map(categoryFromRow),
    tags: tags.map(tagFromRow),
  }
}

// 与 desktop ActivityTagPalette 的 COLOR_PALETTE 保持一致。
export const CATEGORY_PALETTE_COLORS = [
  '#22C55E', '#38BDF8', '#F97316', '#E879F9', '#FACC15', '#14B8A6',
  '#FB7185', '#A78BFA', '#84CC16', '#60A5FA', '#F472B6', '#2DD4BF',
  '#EF4444', '#F59E0B', '#EAB308', '#10B981', '#06B6D4', '#0EA5E9',
  '#3B82F6', '#6366F1', '#8B5CF6', '#D946EF', '#EC4899', '#64748B',
] as const

/**
 * 创建新 tag（fullPath 形如 "工作,日常,新事项"）。
 * 首段未匹配现有 category 时自动新建 category（desktop 尚不支持，手机端先做）。
 * 返回更新后的完整 palette，方便前端 setState 不需要二次 fetch。
 */
export async function createTag(fullPath: string, categoryColor?: string): Promise<ActivityPalette> {
  const segs = fullPath.split(',').map((s) => s.trim()).filter(Boolean)
  if (segs.length === 0) return fetchPalette()
  const normalized = segs.join(',')

  // 先确保 root category 存在
  const cats = await solevupListCategories()
  let cat = cats.find((c) => c.name === segs[0])
  if (!cat) {
    const usedColors = new Set(cats.map((c) => c.color))
    const color = categoryColor ?? CATEGORY_PALETTE_COLORS.find((c) => !usedColors.has(c)) ??
      CATEGORY_PALETTE_COLORS[cats.length % CATEGORY_PALETTE_COLORS.length]
    const nextSort = (Math.max(0, ...cats.map((c) => c.sortOrder)) || 0) + 1
    const newId = await solevupUpsertCategory({
      name: segs[0],
      color,
      sortOrder: nextSort,
    })
    cat = {
      id: newId,
      syncId: '',
      name: segs[0],
      color,
      sortOrder: nextSort,
      createdAt: '',
      lastUsedAt: '',
      updatedAt: '',
    }
  }

  await solevupUpsertTag({
    categoryId: cat.id,
    fullPath: normalized,
    leafName: segs[segs.length - 1],
    depth: segs.length,
  })
  return fetchPalette()
}

export async function deleteTag(tagId: number): Promise<ActivityPalette> {
  await solevupDeleteTag(tagId)
  return fetchPalette()
}

export async function deleteCategory(categoryId: number): Promise<ActivityPalette> {
  await solevupDeleteCategory(categoryId)
  return fetchPalette()
}

export async function renameCategory(
  categoryId: number,
  newName: string | null,
  newColor: string | null,
): Promise<ActivityPalette> {
  await solevupRenameCategory(categoryId, newName, newColor)
  return fetchPalette()
}

/** newFullPath 含首段分类名，如 "学习,英语,新概念3"；首段必须等于已有分类。
 *  cascade=true：后代标签路径前缀跟随替换。 */
export async function renameTagPath(tagId: number, newFullPath: string, cascade = false): Promise<ActivityPalette> {
  await solevupRenameTagPath(tagId, newFullPath, cascade)
  return fetchPalette()
}

export async function fetchBlocks(date: Date): Promise<ActivityBlock[]> {
  const rows = await solevupListBlocksForDate(toLocalDateStr(date))
  return rows.map(blockFromRow)
}

export async function paintBlocks(
  date: Date,
  minutes: number[],
  tagId: number,
): Promise<void> {
  await solevupPaintBlocks(toLocalDateStr(date), minutes, tagId)
}

export async function eraseBlocks(date: Date, minutes: number[]): Promise<void> {
  await solevupEraseBlocks(toLocalDateStr(date), minutes)
}

// ── 聊天 API ──

export interface ChatStreamRequest {
  text: string
  hasImages: boolean
  hasAudio: boolean
  imageCount: number
  mode: AiMode
}

/**
 * 流式聊天回复。当前为 mock 合成，接入 LAN 后端后改为真实 SSE 流。
 * 返回一个取消函数（停止流式输出）。
 */
export function streamChatReply(
  req: ChatStreamRequest,
  onChunk: (delta: string) => void,
  onDone: () => void,
): () => void {
  let cancelled = false
  const timers: ReturnType<typeof setTimeout>[] = []

  // 思考延迟后逐块吐字
  const think = setTimeout(() => {
    if (cancelled) return
    const full = mockReply(req.text, {
      hasImages: req.hasImages,
      hasAudio: req.hasAudio,
      imageCount: req.imageCount,
      mode: req.mode,
    })
    const chars = [...full]
    let i = 0
    const tick = () => {
      if (cancelled) return
      if (i >= chars.length) {
        onDone()
        return
      }
      const step = 1 + Math.floor(Math.random() * 3)
      onChunk(chars.slice(i, i + step).join(''))
      i += step
      timers.push(setTimeout(tick, 26 + Math.random() * 36))
    }
    tick()
  }, 360 + Math.random() * 320)
  timers.push(think)

  return () => {
    cancelled = true
    for (const t of timers) clearTimeout(t)
  }
}
