// ══════════════════════════════════════════════
// 数据层 — 局域网 HTTP 客户端 + mock 回退
//
// 设计目标：接口形状对齐 desktop 的本地 API（49733 端口），
// 以后把 LAN host 指向局域网共享数据库服务即可直连；
// 在 host 未配置或请求失败时，自动回退到 mock 数据。
// ══════════════════════════════════════════════

import type {
  ActivityBlock,
  ActivityCategory,
  ActivityPalette,
  ActivityTag,
  AiMode,
} from '../types'
import { toLocalDateStr } from './time'
import {
  mockApplyErase,
  mockApplyPaint,
  mockBlocks,
  mockCreateTag,
  mockPalette,
  mockReply,
} from './mock'

// ── LAN host 配置 ──
// 例：'http://192.168.1.20:49733'。null = 仅用 mock。
let lanHost: string | null = null

export function setLanHost(host: string | null): void {
  lanHost = host && host.trim() ? host.trim().replace(/\/+$/, '') : null
}

export function getLanHost(): string | null {
  return lanHost
}

const REQUEST_TIMEOUT_MS = 2500

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

/** 带超时的 LAN 请求；host 未配置或失败时抛错，由调用方回退 mock */
async function lanFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!lanHost) throw new Error('LAN host 未配置')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${lanHost}${path}`, { ...init, signal: controller.signal })
    const json = (await res.json()) as ApiResponse<T>
    if (!json.success || json.data === undefined) {
      throw new Error(json.error || '请求失败')
    }
    return json.data
  } finally {
    clearTimeout(timer)
  }
}

// ── HTTP 原始结构 → 前端类型映射（对齐 desktop local-api.ts）──

interface RawCategory {
  id: number
  name: string
  color: string
  sort_order: number
  created_at: string
  last_used_at: string
}

interface RawTag {
  id: number
  category_id: number
  full_path: string
  leaf_name: string
  depth: number
  created_at: string
  last_used_at: string
}

interface RawBlock {
  date: string
  minute: number
  tag_id: number
  note: string | null
  created_at: string
}

function mapCategory(r: RawCategory): ActivityCategory {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }
}

function mapTag(r: RawTag): ActivityTag {
  return {
    id: r.id,
    categoryId: r.category_id,
    fullPath: r.full_path,
    leafName: r.leaf_name,
    depth: r.depth,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }
}

function mapBlock(r: RawBlock): ActivityBlock {
  return {
    date: r.date,
    minute: r.minute,
    tagId: r.tag_id,
    note: r.note,
    createdAt: r.created_at,
  }
}

// ── 活动记录 API ──

export async function fetchPalette(): Promise<ActivityPalette> {
  try {
    const data = await lanFetch<{ categories: RawCategory[]; tags: RawTag[] }>(
      '/api/activities/palette',
    )
    return {
      categories: data.categories.map(mapCategory),
      tags: data.tags.map(mapTag),
    }
  } catch {
    return mockPalette()
  }
}

/**
 * 创建新 tag（fullPath 形如 "工作,日常,新事项"）。
 * 首段未匹配现有 category 时自动新建 category（desktop 尚不支持，手机端先做）。
 * 返回更新后的完整 palette 方便前端 setState 不需要二次 fetch。
 */
export async function createTag(fullPath: string): Promise<ActivityPalette> {
  try {
    await lanFetch<unknown>('/api/activities/tag/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullPath }),
    })
    return await fetchPalette()
  } catch {
    mockCreateTag(fullPath)
    return mockPalette()
  }
}

export async function fetchBlocks(date: Date): Promise<ActivityBlock[]> {
  const dateStr = toLocalDateStr(date)
  try {
    const data = await lanFetch<RawBlock[]>(`/api/activities/blocks?date=${dateStr}`)
    return data.map(mapBlock)
  } catch {
    return mockBlocks(dateStr)
  }
}

export async function paintBlocks(
  date: Date,
  minutes: number[],
  tagId: number,
): Promise<void> {
  const dateStr = toLocalDateStr(date)
  try {
    await lanFetch<number>('/api/activities/blocks/paint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: dateStr, minutes, tag_id: tagId }),
    })
  } catch {
    mockApplyPaint(dateStr, minutes, tagId)
  }
}

export async function eraseBlocks(date: Date, minutes: number[]): Promise<void> {
  const dateStr = toLocalDateStr(date)
  try {
    await lanFetch<number>('/api/activities/blocks/erase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: dateStr, minutes }),
    })
  } catch {
    mockApplyErase(dateStr, minutes)
  }
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
