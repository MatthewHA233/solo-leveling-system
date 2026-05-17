// ══════════════════════════════════════════════
// Mock 数据 — LAN/共享数据库就绪前的本地兜底
// 昼夜表活动记录按日期确定性生成，聊天回复本地合成
// ══════════════════════════════════════════════

import type {
  ActivityBlock,
  ActivityPalette,
  AiMode,
} from '../types'
import { categoryColors } from '../theme'

const NOW_ISO = '2026-05-16T00:00:00'

// ── 标签库 ──

export function mockPalette(): ActivityPalette {
  return {
    categories: [
      cat(1, '编程', categoryColors.coding, 0),
      cat(2, '学习', categoryColors.learning, 1),
      cat(3, '阅读', categoryColors.reading, 2),
      cat(4, '写作', categoryColors.writing, 3),
      cat(5, '媒体', categoryColors.media, 4),
      cat(6, '沟通', categoryColors.communication, 5),
    ],
    tags: [
      tag(1, 1, '编程,Solo Leveling,手机端'),
      tag(2, 1, '编程,Solo Leveling,昼夜表'),
      tag(3, 2, '学习,Rust'),
      tag(4, 2, '学习,React Native'),
      tag(5, 3, '阅读,技术书'),
      tag(6, 4, '写作,毕业论文'),
      tag(7, 5, '媒体,B站'),
      tag(8, 6, '沟通,会议'),
    ],
  }
}

function cat(id: number, name: string, color: string, sortOrder: number) {
  return { id, name, color, sortOrder, createdAt: NOW_ISO, lastUsedAt: NOW_ISO }
}

function tag(id: number, categoryId: number, fullPath: string) {
  const parts = fullPath.split(',')
  return {
    id,
    categoryId,
    fullPath,
    leafName: parts[parts.length - 1],
    depth: parts.length,
    createdAt: NOW_ISO,
    lastUsedAt: NOW_ISO,
  }
}

// ── 活动块：按日期确定性生成 + 内存编辑覆盖层 ──

interface Span {
  start: number
  end: number
  tagId: number
  note?: string
}

const BASE_SPANS: Span[] = [
  { start: 450, end: 540,  tagId: 5, note: '《重构》第 6 章' },
  { start: 540, end: 705,  tagId: 1, note: '手机端昼夜表 + 多模态聊天' },
  { start: 780, end: 930,  tagId: 2 },
  { start: 930, end: 1020, tagId: 4 },
  { start: 1020, end: 1080, tagId: 7, note: 'RN 性能优化合集' },
  { start: 1140, end: 1260, tagId: 6, note: 'DPO 章节初稿' },
  { start: 1260, end: 1350, tagId: 3 },
  { start: 1350, end: 1380, tagId: 8 },
]

/** 日期字符串 → 稳定小整数 */
function hashDate(dateStr: string): number {
  let h = 0
  for (let i = 0; i < dateStr.length; i++) {
    h = (h * 31 + dateStr.charCodeAt(i)) % 2147483647
  }
  return h
}

// 内存编辑覆盖层：minute → tagId（0 表示擦除）
const overrides = new Map<string, Map<number, number>>()

function overrideFor(dateStr: string): Map<number, number> {
  let m = overrides.get(dateStr)
  if (!m) {
    m = new Map()
    overrides.set(dateStr, m)
  }
  return m
}

export function mockApplyPaint(dateStr: string, minutes: number[], tagId: number): void {
  const m = overrideFor(dateStr)
  for (const min of minutes) m.set(min, tagId)
}

export function mockApplyErase(dateStr: string, minutes: number[]): void {
  const m = overrideFor(dateStr)
  for (const min of minutes) m.set(min, 0)
}

export function mockBlocks(dateStr: string): ActivityBlock[] {
  const h = hashDate(dateStr)
  // 按日期轻微抖动：整体偏移 -10..+10 分钟（5min 对齐），偶数 hash 跳过媒体段
  const shift = ((h % 5) - 2) * 5
  const skipMedia = h % 2 === 0

  const byMinute = new Map<number, number>()
  const noteByMinute = new Map<number, string>()

  for (const sp of BASE_SPANS) {
    if (skipMedia && sp.tagId === 7) continue
    const start = clampMin(sp.start + shift)
    const end = clampMin(sp.end + shift)
    for (let m = start; m < end; m += 5) {
      byMinute.set(m, sp.tagId)
      if (sp.note) noteByMinute.set(m, sp.note)
    }
  }

  // 叠加编辑覆盖层
  const ov = overrides.get(dateStr)
  if (ov) {
    for (const [min, tagId] of ov) {
      if (tagId === 0) {
        byMinute.delete(min)
        noteByMinute.delete(min)
      } else {
        byMinute.set(min, tagId)
      }
    }
  }

  const blocks: ActivityBlock[] = []
  for (const [minute, tagId] of byMinute) {
    blocks.push({
      date: dateStr,
      minute,
      tagId,
      note: noteByMinute.get(minute) ?? null,
      createdAt: NOW_ISO,
    })
  }
  blocks.sort((a, b) => a.minute - b.minute)
  return blocks
}

function clampMin(m: number): number {
  return Math.max(0, Math.min(1435, m))
}

// ── 聊天回复合成 ──

const GENERIC = [
  '收到。我会把这件事拆成几个可执行的小步骤，先从最关键的一步开始。',
  '明白了。结合你今天的活动节奏，现在是推进它的合适窗口。',
  '好的，这个方向没问题。建议先锁定一个 25 分钟的专注块来启动。',
]

const ACTIVITY = [
  '我看了一下昼夜表：今天编程占了将近 5 小时，是投入最大的一块。',
  '上午的阅读和编程衔接得不错，下午的学习段稍微碎了一点，可以合并。',
  '建议把晚上的写作往前挪半小时，给睡前留出缓冲。',
]

const GOAL = [
  '这个目标我先记下了。要不要拆成本周可以验收的三个里程碑？',
  '目标已对齐。最近的活动记录显示你在这条线上是有持续投入的，保持节奏。',
]

/** 合成一条助手回复（mock，接入后端后由真实流式替换） */
export function mockReply(
  text: string,
  opts: { hasImages: boolean; hasAudio: boolean; imageCount: number; mode: AiMode },
): string {
  const parts: string[] = []

  if (opts.hasAudio) {
    parts.push('我听到你的语音了，转写后的大意已经收到。')
  }
  if (opts.hasImages) {
    parts.push(
      `收到你发来的 ${opts.imageCount} 张图片。从画面内容看，这和你正在推进的任务是相关的。`,
    )
  }

  const t = text || ''
  if (/昼夜|活动|今天|时间/.test(t)) {
    parts.push(pick(ACTIVITY))
  } else if (/目标|计划|任务|想做/.test(t)) {
    parts.push(pick(GOAL))
  } else if (t.trim().length > 0) {
    parts.push(pick(GENERIC))
  } else if (parts.length === 0) {
    parts.push(pick(GENERIC))
  }

  if (opts.mode === 'omni') {
    parts.push('（Omni 全模态：文字、图像、语音我都能一起理解。）')
  }

  return parts.join('')
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** 合成一段语音波形（0..1） */
export function mockWaveform(bars = 32): number[] {
  return Array.from({ length: bars }, () => 0.25 + Math.random() * 0.75)
}
