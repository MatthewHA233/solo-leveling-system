// ══════════════════════════════════════════════
// Mock 数据 — LAN/共享数据库就绪前的本地兜底
// 昼夜表活动记录按日期确定性生成，聊天回复本地合成
// ══════════════════════════════════════════════

import type {
  ActivityBlock,
  ActivityCategory,
  ActivityPalette,
  ActivityTag,
  AiMode,
} from '../types'

const NOW_ISO = '2026-05-16T00:00:00'

// ── 标签库 ──

// 进程内可变 palette singleton —— 让 mockCreateTag 能改完整 chain，
// fetchPalette 总返回最新结果（LAN 接入前的本地兜底）
let palette_: ActivityPalette | null = null

export function mockPalette(): ActivityPalette {
  if (palette_) return palette_
  palette_ = buildInitialPalette()
  return palette_
}

/** 用 fullPath（如 "工作,日常,新事项"）添加 tag；首段未匹配现有 category 时自动新建 cat。 */
export function mockCreateTag(fullPath: string): {
  tag: ActivityTag
  newCategory?: ActivityCategory
} {
  const p = mockPalette()
  const segs = fullPath.split(',').map((s) => s.trim()).filter(Boolean)
  if (segs.length === 0) throw new Error('空标签路径')
  const catName = segs[0]
  let cat = p.categories.find((c) => c.name === catName)
  let newCategory: ActivityCategory | undefined
  if (!cat) {
    const usedColors = new Set(p.categories.map((c) => c.color))
    const color = CATEGORY_PALETTE_COLORS.find((c) => !usedColors.has(c)) ??
      CATEGORY_PALETTE_COLORS[p.categories.length % CATEGORY_PALETTE_COLORS.length]
    const nextId = Math.max(0, ...p.categories.map((c) => c.id)) + 1
    cat = {
      id: nextId,
      name: catName,
      color,
      sortOrder: p.categories.length + 1,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    }
    p.categories.push(cat)
    newCategory = cat
  }
  const normalized = segs.join(',')
  const existing = p.tags.find((t) => t.fullPath === normalized)
  if (existing) {
    return { tag: existing, newCategory }
  }
  const nextTagId = Math.max(0, ...p.tags.map((t) => t.id)) + 1
  const newTag: ActivityTag = {
    id: nextTagId,
    categoryId: cat.id,
    fullPath: normalized,
    leafName: segs[segs.length - 1],
    depth: segs.length,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  }
  p.tags.push(newTag)
  return { tag: newTag, newCategory }
}

// 新建 category 的预设色板（避开已有 9 个色，按光谱顺序排）
const CATEGORY_PALETTE_COLORS = [
  '#0EA5E9', '#A855F7', '#EC4899', '#EF4444', '#F59E0B',
  '#10B981', '#14B8A6', '#8B5CF6', '#6366F1', '#D946EF',
]

function buildInitialPalette(): ActivityPalette {
  return {
    // 数据快照对齐 desktop solo.db 的 9 cat + 70 tag（2026-05-23 dump），
    // 让 mobile 在 LAN sync 接入前就能感受真实标签量级的 UI 体验
    categories: [
      catRaw(1, '编程', '#38BDF8', 1),
      catRaw(2, '社交', '#E879F9', 2),
      catRaw(3, '娱乐', '#FB7185', 3),
      catRaw(4, '生活', '#F97316', 4),
      catRaw(5, '睡觉', '#84CC16', 5),
      catRaw(6, '设备杂项', '#FACC15', 6),
      catRaw(7, '身边杂项', '#F97316', 7),
      catRaw(8, '未知探索', '#2DD4BF', 8),
      catRaw(9, '工作', '#22C55E', 9),
    ],
    tags: [
      tag(1, 1, '编程,氛围编程'),
      tag(2, 1, '编程,氛围编程,solo-leveling-system项目'),
      tag(3, 1, '编程,氛围编程,solo-leveling-system项目,使用记录相关的功能'),
      tag(21, 1, '编程,氛围编程,solo-leveling-system项目,尝试美化UI界面'),
      tag(26, 1, '编程,氛围编程,solo-leveling-system项目,用工具链精细还原特色UI'),
      tag(51, 1, '编程,氛围编程,solo-leveling-system项目,移植到macos'),
      tag(55, 1, '编程,氛围编程,solo-leveling-system项目,移植到手机'),
      tag(58, 1, '编程,氛围编程,solo-leveling-system项目,编译包相关改动'),
      tag(59, 1, '编程,氛围编程,solo-leveling-system项目,局域网多端同步功能'),
      tag(60, 1, '编程,氛围编程,宝哥的转盘App'),
      tag(62, 1, '编程,氛围编程,solo-leveling-system项目,新功能探讨计划'),
      tag(63, 1, '编程,氛围编程,solo-leveling-system项目,主面板开新'),
      tag(65, 1, '编程,氛围编程,solo-leveling-system项目,动机仪表盘相关功能'),
      tag(4, 2, '社交,QQ聊天'),
      tag(5, 2, '社交,QQ聊天,和女朋友聊天'),
      tag(12, 2, '社交,QQ聊天,和朋友们聊天'),
      tag(34, 2, '社交,家里来客'),
      tag(35, 2, '社交,家里来客,招待客人'),
      tag(36, 2, '社交,家人沟通'),
      tag(37, 2, '社交,家人沟通,和家人交际'),
      tag(54, 2, '社交,QQ聊天,广告抽奖模拟器'),
      tag(67, 2, '社交,QQ聊天,和宝哥沟通'),
      tag(6, 3, '娱乐,玩手机'),
      tag(7, 3, '娱乐,玩手机,随缘玩手机'),
      tag(10, 3, '娱乐,游戏'),
      tag(11, 3, '娱乐,游戏,玩PTCG'),
      tag(13, 3, '娱乐,游戏,玩崩铁'),
      tag(14, 3, '娱乐,游戏,玩鸣潮'),
      tag(25, 3, '娱乐,人之常情...'),
      tag(27, 3, '娱乐,玩手机,看b站视频'),
      tag(40, 3, '娱乐,游戏,玩绝区零'),
      tag(8, 4, '生活,身体清洁类'),
      tag(9, 4, '生活,身体清洁类,洗澡'),
      tag(18, 4, '生活,吃喝拉撒'),
      tag(19, 4, '生活,吃喝拉撒,上厕所'),
      tag(28, 4, '生活,吃喝拉撒,做饭'),
      tag(29, 4, '生活,吃喝拉撒,煮面条'),
      tag(30, 4, '生活,吃喝拉撒,吃饭'),
      tag(31, 4, '生活,家务'),
      tag(32, 4, '生活,家务,洗碗'),
      tag(38, 4, '生活,家务,扔垃圾'),
      tag(41, 4, '生活,身体清洁类,刷牙等'),
      tag(45, 4, '生活,出门'),
      tag(46, 4, '生活,出门,出门(市内)'),
      tag(56, 4, '生活,家务,清洁厕所'),
      tag(64, 4, '生活,家常,点蚊香'),
      tag(66, 4, '生活,身体清洁类,刮胡子'),
      tag(69, 4, '生活,吃喝拉撒,泡咖啡'),
      tag(70, 4, '生活,吃喝拉撒,换衣服'),
      tag(15, 5, '睡觉,夜晚睡眠'),
      tag(33, 5, '睡觉,下午觉'),
      tag(16, 6, '设备杂项,电脑杂项'),
      tag(17, 6, '设备杂项,电脑杂项,电脑启动后杂项'),
      tag(20, 6, '设备杂项,电脑杂项,claude或codex类杂项'),
      tag(39, 6, '设备杂项,电脑杂项,折腾代理'),
      tag(71, 6, '设备杂项,电脑杂项,清理存储空间'),
      tag(22, 7, '身边杂项,踱步想问题'),
      tag(57, 7, '身边杂项,查看存款现金'),
      tag(23, 8, '未知探索,探索项目实现方案'),
      tag(24, 8, '未知探索,探索项目实现方案,探索科幻UI交互实现'),
      tag(42, 8, '未知探索,探索项目盈利'),
      tag(43, 8, '未知探索,探索项目盈利,探索营业执照挂靠'),
      tag(44, 8, '未知探索,探索项目盈利,探索OPC一人公司社区'),
      tag(50, 8, '未知探索,探索项目实现方案,复盘科幻UI实现'),
      tag(47, 9, '工作,创业'),
      tag(48, 9, '工作,创业,公共事务'),
      tag(49, 9, '工作,创业,公共事务,OPC社区申请入驻相关'),
      tag(52, 9, '工作,闲时项目'),
      tag(53, 9, '工作,闲时项目,抽奖模拟器更新配置'),
      tag(68, 9, '工作,宝哥的项目,宝哥的转盘App测试'),
    ],
  }
}

function catRaw(id: number, name: string, color: string, sortOrder: number) {
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
