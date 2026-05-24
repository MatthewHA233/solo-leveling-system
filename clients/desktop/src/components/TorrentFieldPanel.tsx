import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { hud, theme } from '../theme'
import { HudFrame } from './hud'

type SourceKind = 'article' | 'video' | 'chat' | 'flomo' | 'code' | 'image'
type SourceFilter = 'all' | SourceKind
type AnchorKind = 'motive' | 'view' | 'practice'

interface ContextAnchor {
  readonly kind: AnchorKind
  readonly label: string
  readonly note: string
}

interface ContextEvent {
  readonly id: string
  readonly time: string
  readonly source: SourceKind
  readonly title: string
  readonly excerpt: string
  readonly route: string
  readonly intensity: number
  readonly anchors: readonly ContextAnchor[]
  readonly growth: readonly string[]
}

interface PlacedEvent {
  readonly event: ContextEvent
  readonly col: number
  readonly top: number
  readonly nodeY: number
  readonly minute: number
  readonly cardsInRow: number
}

const RAIL_X = 76
const RAIL_AREA_W = 110
const BRANCH_W = 22
const CARD_W = 252
const CARD_H = 218
const CARD_GAP_X = 14
const CARD_GAP_Y = 52
const CARD_TOP_PAD = 34
const HOUR_GAP_EXTRA = 30
const MAX_COLS = 3
const GAP_DASHED_MIN = 60

const sourceMeta: Record<SourceKind, { label: string; short: string; color: string }> = {
  article: { label: '文章', short: 'ART', color: theme.warningOrange },
  video: { label: '视频', short: 'VID', color: '#FB7299' },
  chat: { label: '对话', short: 'CHAT', color: theme.electricBlue },
  flomo: { label: 'flomo', short: 'FLM', color: '#F6D365' },
  code: { label: '代码', short: 'CODE', color: theme.expGreen },
  image: { label: '截图', short: 'IMG', color: '#B378FF' },
}

const anchorMeta: Record<AnchorKind, { label: string; color: string; code: string }> = {
  motive: { label: '刺激-动机', color: theme.warningOrange, code: 'MOTIVE' },
  view: { label: '观点认识', color: theme.electricBlue, code: 'VIEW' },
  practice: { label: '技能动作', color: theme.expGreen, code: 'ACT' },
}

const filters: ReadonlyArray<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'article', label: '文章' },
  { id: 'video', label: '视频' },
  { id: 'chat', label: '对话' },
  { id: 'flomo', label: 'flomo' },
  { id: 'code', label: '代码' },
  { id: 'image', label: '截图' },
]

const sampleEvents: readonly ContextEvent[] = [
  {
    id: 'ctx-2238-evermind-blog',
    time: '22:38',
    source: 'article',
    title: 'EverMind 博客击中“主体性记忆”',
    excerpt: '记忆不是资料仓库，而是依附于主体的长期智力。这个判断把项目核心从“存储”重新拉回“个人语境”。',
    route: '主体性记忆 / Fairy 底层机制',
    intensity: 94,
    anchors: [
      { kind: 'motive', label: '灵魂震颤', note: '“这就是我真正想做的东西”的强烈确认感。' },
      { kind: 'view', label: '无状态 AI 不够', note: 'RAG 像开卷考试，不能替代一个会持续成长的主体。' },
      { kind: 'practice', label: '重写记忆模型', note: '把记忆对象从资料条目改成主体-语境-锚点。' },
    ],
    growth: ['整理 EverMind 观点卡', '补第四章：主体性记忆', '为 Fairy 设计长期记忆接口'],
  },
  {
    id: 'ctx-2206-earth-online',
    time: '22:06',
    source: 'image',
    title: 'Earth Online / 任务日志截图触发竞品雷达',
    excerpt: '地球 Online、任务日志、多智能体平台、记忆图可视化同时出现，像一面镜子照出了我们项目的野心。',
    route: '竞品雷达 / 产品边界',
    intensity: 88,
    anchors: [
      { kind: 'motive', label: '被同类击中', note: '发现有人也在做“生活游戏化 + 记忆伙伴”的方向。' },
      { kind: 'view', label: '竞品未必可怕', note: '简陋模仿反而说明核心体验仍然空缺。' },
      { kind: 'practice', label: '建立持续观察', note: '把 EverMind / Earth Online 加入外部参照源。' },
    ],
    growth: ['建立竞品档案', '列出相似点与差异点', '提炼我们的护城河假设'],
  },
  {
    id: 'ctx-2132-wechat',
    time: '21:32',
    source: 'article',
    title: '微信文章引出开源项目线索',
    excerpt: '从一篇文章跳到团队项目，再跳到开源仓库，探索路径本身成为语境证据，而不是一次普通浏览。',
    route: '探索链路 / 来源追踪',
    intensity: 76,
    anchors: [
      { kind: 'motive', label: '发现欲升高', note: '继续搜下去的冲动来自“这里可能有答案”。' },
      { kind: 'view', label: '来源比结论重要', note: '需要记录“我是怎样被带到这里的”。' },
      { kind: 'practice', label: '保留探索路径', note: '语境事件需要保存 referrer、截图、摘录和对话片段。' },
    ],
    growth: ['设计来源链字段', '给洪流域补“前后事件”关联', '探索浏览器采集入口'],
  },
  {
    id: 'ctx-2058-bili-pattern',
    time: '20:58',
    source: 'video',
    title: 'B 站历史鱼线图成为洪流域骨架',
    excerpt: '单个视频历史已经能按时间、来源、支线、详情组织信息；洪流域只是把视频扩展到所有语境来源。',
    route: '交互骨架 / 语境昼夜表',
    intensity: 72,
    anchors: [
      { kind: 'motive', label: '终于有可落地骨架', note: '不是空想界面，而是项目里已经存在的成熟形态。' },
      { kind: 'view', label: '时间轴承载语境', note: '洪流域应当先是“发生过什么”的地图。' },
      { kind: 'practice', label: '复用鱼线图', note: '主轴、支线、卡片、详情浮层先复用 B 站页逻辑。' },
    ],
    growth: ['迁移鱼线布局', '统一来源过滤', '卡片展示三类锚点'],
  },
  {
    id: 'ctx-1948-chat-reflection',
    time: '19:48',
    source: 'chat',
    title: '对话本身完成了大部分整理',
    excerpt: '真正重要的不是一个巨大的手工表单，而是 Fairy 在对话里追问、归纳、裁剪，把经验变成结构。',
    route: 'AI 交互 / Fairy 工作台',
    intensity: 82,
    anchors: [
      { kind: 'motive', label: '被理解会减压', note: '焦虑被接住后，更容易继续探索。' },
      { kind: 'view', label: '整理先于呈现', note: '先想清楚如何整理，界面才会长出来。' },
      { kind: 'practice', label: '对话转锚点', note: '从聊天中自动提取刺激、观点、动作三类锚点。' },
    ],
    growth: ['记录对话摘要', '生成今日探索档案', '把锚点回填到洪流域'],
  },
  {
    id: 'ctx-1815-flomo',
    time: '18:15',
    source: 'flomo',
    title: '计划应当从接触中慢慢长出来',
    excerpt: '不是先写一个 todo 列表逼迫自己，而是让刺激、认识、实践动作在语境里不断聚合，最后自然形成下一步。',
    route: '计划生成 / 自然生长',
    intensity: 69,
    anchors: [
      { kind: 'motive', label: '反抗硬计划', note: '硬塞计划会让人逃避，生长出来的计划更贴近真实动机。' },
      { kind: 'view', label: '计划是语境产物', note: '计划不是孤立节点，而是语境锚点的后果。' },
      { kind: 'practice', label: '生成候选动作', note: '先生成 3 个可选动作，再进入计划安排。' },
    ],
    growth: ['设计“长成计划”按钮', '锚点聚类成路线', '路线投放到当日计划'],
  },
  {
    id: 'ctx-1704-code',
    time: '17:04',
    source: 'code',
    title: '计划安排右侧栏绑定数据库',
    excerpt: '右侧栏不再是硬编码临时卡片，而是连接计划节点；昼夜表负责今日安排，洪流域负责语境来源。',
    route: '工程落实 / 数据闭环',
    intensity: 61,
    anchors: [
      { kind: 'motive', label: '减少沙盘感', note: '只改假 UI 会让项目失真，需要逐步接真实数据。' },
      { kind: 'view', label: '职责分层', note: '右侧栏是今日安排，不是计划库本体。' },
      { kind: 'practice', label: '连接 plan_nodes', note: '计划安排读取、创建、更新、删除计划节点。' },
    ],
    growth: ['补计划节点层级 UI', '昼夜表块关联 plan_node_id', '设计计划库大面板'],
  },
]

function parseMinute(time: string): number {
  const [hh = '0', mm = '0'] = time.split(':')
  return Number(hh) * 60 + Number(mm)
}

function layoutEvents(events: readonly ContextEvent[], cols: number): { placed: PlacedEvent[]; height: number } {
  const sorted = [...events].sort((a, b) => parseMinute(b.time) - parseMinute(a.time))
  const buckets: ContextEvent[][] = []

  for (const event of sorted) {
    const hour = Math.floor(parseMinute(event.time) / 60)
    const lastBucket = buckets[buckets.length - 1]
    const lastHour = lastBucket ? Math.floor(parseMinute(lastBucket[0].time) / 60) : null
    if (!lastBucket || hour !== lastHour) {
      buckets.push([event])
    } else {
      lastBucket.push(event)
    }
  }

  const placed: PlacedEvent[] = []
  let cursorY = CARD_TOP_PAD
  let hasPreviousHour = false

  for (const bucket of buckets) {
    if (hasPreviousHour) cursorY += HOUR_GAP_EXTRA
    hasPreviousHour = true

    const rowCount = Math.ceil(bucket.length / cols)
    for (let row = 0; row < rowCount; row++) {
      const rowStart = row * cols
      const rowEnd = Math.min(rowStart + cols, bucket.length)
      const cardsInRow = rowEnd - rowStart
      const top = cursorY + row * (CARD_H + CARD_GAP_Y)

      for (let index = rowStart; index < rowEnd; index++) {
        const event = bucket[index]
        const col = index - rowStart
        const nodeY = top + (CARD_H * (col + 1)) / (cardsInRow + 1)
        placed.push({ event, col, top, nodeY, minute: parseMinute(event.time), cardsInRow })
      }
    }

    cursorY = cursorY + rowCount * (CARD_H + CARD_GAP_Y) - CARD_GAP_Y
  }

  return { placed, height: placed.length > 0 ? cursorY + 16 : 160 }
}

function countAnchors(events: readonly ContextEvent[], kind: AnchorKind): number {
  return events.reduce((sum, event) => sum + event.anchors.filter((anchor) => anchor.kind === kind).length, 0)
}

export default function TorrentFieldPanel() {
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState(sampleEvents[0].id)

  const filteredEvents = useMemo(
    () => (filter === 'all' ? sampleEvents : sampleEvents.filter((event) => event.source === filter)),
    [filter],
  )
  const { placed, height } = useMemo(() => layoutEvents(filteredEvents, MAX_COLS), [filteredEvents])
  const selectedEvent = filteredEvents.find((event) => event.id === selectedId) ?? filteredEvents[0] ?? sampleEvents[0]
  const activeId = hoveredId ?? selectedEvent.id

  const motiveCount = countAnchors(filteredEvents, 'motive')
  const viewCount = countAnchors(filteredEvents, 'view')
  const practiceCount = countAnchors(filteredEvents, 'practice')

  return (
    <div style={styles.root}>
      <HudFrame
        color={theme.flameTeal}
        accent={theme.warningOrange}
        topLabel="TORRENT FIELD · 语境昼夜表"
        showNotchTop
        showNotchBottom={false}
        notchWidth={144}
        notchDepth={8}
        cornerSize={18}
        intensity="soft"
      />

      <div style={styles.backdrop} />
      <div style={styles.grid} />

      <main style={styles.content}>
        <header style={styles.header}>
          <div style={styles.headerCopy}>
            <div style={styles.kicker}>ALL-SOURCE CONTEXT STREAM</div>
            <h1 style={styles.title}>洪流域</h1>
            <p style={styles.subtitle}>
              把文章、视频、聊天、flomo、代码探索和截图都按时间接入，再提取“刺激-动机 / 观点认识 / 技能动作”三类锚点。
              计划不是凭空写出来，而是从这些锚点里自然长出来。
            </p>
          </div>
          <div style={styles.metrics}>
            <Metric label="语境事件" value={filteredEvents.length} color={theme.flameTeal} />
            <Metric label="动机" value={motiveCount} color={theme.warningOrange} />
            <Metric label="认识" value={viewCount} color={theme.electricBlue} />
            <Metric label="动作" value={practiceCount} color={theme.expGreen} />
          </div>
        </header>

        <section style={styles.toolbar}>
          <div style={styles.filterRow}>
            {filters.map((item) => {
              const active = item.id === filter
              const color = item.id === 'all' ? theme.flameTeal : sourceMeta[item.id].color
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  style={{
                    ...styles.filterButton,
                    color: active ? theme.background : color,
                    borderColor: active ? color : `${color}55`,
                    background: active ? color : `${color}12`,
                    boxShadow: active ? `0 0 18px ${color}44` : undefined,
                  }}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
          <div style={styles.captureBar}>
            <span style={styles.captureLabel}>CAPTURE PIPELINE</span>
            <span>浏览器 / B站 / 对话 / flomo / 截图 / 本地文件</span>
            <b>等待 Fairy 抽取锚点</b>
          </div>
        </section>

        <section style={styles.board}>
          <div style={styles.timelineShell}>
            <div style={styles.timelineHeader}>
              <div>
                <span style={styles.panelEyebrow}>CONTEXT FISHBONE</span>
                <strong style={styles.panelTitle}>全来源语境鱼线</strong>
              </div>
              <div style={styles.legend}>
                <LegendDot label="刺激-动机" color={theme.warningOrange} />
                <LegendDot label="观点认识" color={theme.electricBlue} />
                <LegendDot label="技能动作" color={theme.expGreen} />
              </div>
            </div>

            <div style={styles.timelineViewport}>
              <div style={{ ...styles.timelineInner, height }}>
                <TorrentRail placed={placed} height={height} activeId={activeId} />
                <TimeLabels placed={placed} activeId={activeId} />
                {placed.map((placement) => (
                  <ContextCard
                    key={placement.event.id}
                    placement={placement}
                    selected={placement.event.id === selectedEvent.id}
                    active={placement.event.id === activeId}
                    onSelect={() => setSelectedId(placement.event.id)}
                    onHover={setHoveredId}
                  />
                ))}
              </div>
            </div>
          </div>

          <ContextInspector event={selectedEvent} />
        </section>
      </main>
    </div>
  )
}

function Metric({ label, value, color }: { readonly label: string; readonly value: number; readonly color: string }) {
  return (
    <div style={{ ...styles.metric, borderColor: `${color}66`, background: `${color}10` }}>
      <span style={styles.metricLabel}>{label}</span>
      <strong style={{ ...styles.metricValue, color }}>{String(value).padStart(2, '0')}</strong>
    </div>
  )
}

function LegendDot({ label, color }: { readonly label: string; readonly color: string }) {
  return (
    <span style={styles.legendItem}>
      <i style={{ ...styles.legendDot, background: color, boxShadow: `0 0 8px ${color}` }} />
      {label}
    </span>
  )
}

function TorrentRail({
  placed,
  height,
  activeId,
}: {
  readonly placed: readonly PlacedEvent[]
  readonly height: number
  readonly activeId: string
}) {
  const cardLeftX = (col: number) => RAIL_AREA_W + BRANCH_W + col * (CARD_W + CARD_GAP_X)
  const segments: Array<{ y1: number; y2: number; dashed: boolean }> = []
  for (let index = 0; index < placed.length - 1; index++) {
    const current = placed[index]
    const next = placed[index + 1]
    segments.push({
      y1: current.nodeY,
      y2: next.nodeY,
      dashed: Math.abs(current.minute - next.minute) >= GAP_DASHED_MIN,
    })
  }

  return (
    <svg
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height,
        pointerEvents: 'none',
        zIndex: 4,
      }}
    >
      <defs>
        <linearGradient id="torrent-spine-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={theme.flameTeal} stopOpacity="0.18" />
          <stop offset="50%" stopColor={theme.flameTeal} stopOpacity="0.95" />
          <stop offset="100%" stopColor={theme.flameTeal} stopOpacity="0.18" />
        </linearGradient>
      </defs>

      <line x1={RAIL_X} y1={0} x2={RAIL_X} y2={height} stroke={theme.flameTeal} strokeWidth={9} strokeOpacity={0.1} />
      <line x1={RAIL_X} y1={0} x2={RAIL_X} y2={height} stroke="url(#torrent-spine-grad)" strokeWidth={2.4} />
      <line x1={RAIL_X - 4} y1={0} x2={RAIL_X - 4} y2={height} stroke={theme.flameTeal} strokeWidth={1} strokeOpacity={0.28} />
      <line x1={RAIL_X + 4} y1={0} x2={RAIL_X + 4} y2={height} stroke={theme.flameTeal} strokeWidth={1} strokeOpacity={0.28} />

      {segments.filter((segment) => segment.dashed).map((segment, index) => (
        <line
          key={`gap-${index}`}
          x1={RAIL_X}
          y1={segment.y1 + 6}
          x2={RAIL_X}
          y2={segment.y2 - 6}
          stroke={theme.warningOrange}
          strokeWidth={1.8}
          strokeDasharray="5 6"
          strokeOpacity={0.75}
        />
      ))}

      {placed.map((placement) => {
        const source = sourceMeta[placement.event.source]
        const isActive = activeId === placement.event.id
        const x2 = cardLeftX(placement.col) - 8
        return (
          <g key={`rail-${placement.event.id}`}>
            <line
              x1={RAIL_X + 7}
              y1={placement.nodeY}
              x2={x2}
              y2={placement.nodeY}
              stroke={source.color}
              strokeWidth={isActive ? 2.2 : 1.3}
              strokeOpacity={isActive ? 0.9 : 0.36}
            />
            <circle cx={RAIL_X} cy={placement.nodeY} r={isActive ? 8 : 6} fill="rgba(3,9,18,0.96)" stroke={source.color} strokeWidth={isActive ? 2.5 : 1.5} />
            <circle cx={RAIL_X} cy={placement.nodeY} r={isActive ? 3.2 : 2.2} fill={source.color} opacity={isActive ? 1 : 0.72} />
          </g>
        )
      })}
    </svg>
  )
}

function TimeLabels({
  placed,
  activeId,
}: {
  readonly placed: readonly PlacedEvent[]
  readonly activeId: string
}) {
  return (
    <>
      {placed.map((placement) => {
        const source = sourceMeta[placement.event.source]
        const active = activeId === placement.event.id
        return (
          <div
            key={`time-${placement.event.id}`}
            style={{
              ...styles.timeLabel,
              top: placement.nodeY - 14,
              color: source.color,
              borderColor: active ? source.color : `${source.color}66`,
              boxShadow: active ? `0 0 14px ${source.color}55` : undefined,
            }}
          >
            <strong>{placement.event.time}</strong>
            <span>{source.short}</span>
          </div>
        )
      })}
    </>
  )
}

function ContextCard({
  placement,
  selected,
  active,
  onSelect,
  onHover,
}: {
  readonly placement: PlacedEvent
  readonly selected: boolean
  readonly active: boolean
  readonly onSelect: () => void
  readonly onHover: (id: string | null) => void
}) {
  const { event } = placement
  const source = sourceMeta[event.source]
  const left = RAIL_AREA_W + BRANCH_W + placement.col * (CARD_W + CARD_GAP_X)
  const motive = event.anchors.find((anchor) => anchor.kind === 'motive')
  const view = event.anchors.find((anchor) => anchor.kind === 'view')
  const practice = event.anchors.find((anchor) => anchor.kind === 'practice')

  return (
    <article
      onClick={onSelect}
      onMouseEnter={() => onHover(event.id)}
      onMouseLeave={() => onHover(null)}
      style={{
        ...styles.card,
        left,
        top: placement.top,
        borderColor: selected ? source.color : active ? `${source.color}BB` : `${source.color}44`,
        boxShadow: selected ? `0 0 24px ${source.color}40, inset 0 0 28px ${source.color}12` : undefined,
      }}
    >
      <div style={styles.cardTop}>
        <span style={{ ...styles.sourceBadge, color: source.color, borderColor: `${source.color}88`, background: `${source.color}14` }}>
          {source.label}
        </span>
        <span style={styles.intensity}>INT {event.intensity}</span>
      </div>
      <h3 style={styles.cardTitle}>{event.title}</h3>
      <p style={styles.cardExcerpt}>{event.excerpt}</p>
      <div style={styles.anchorPreview}>
        {motive && <AnchorPill anchor={motive} compact />}
        {view && <AnchorPill anchor={view} compact />}
        {practice && <AnchorPill anchor={practice} compact />}
      </div>
    </article>
  )
}

function AnchorPill({
  anchor,
  compact = false,
}: {
  readonly anchor: ContextAnchor
  readonly compact?: boolean
}) {
  const meta = anchorMeta[anchor.kind]
  return (
    <span
      style={{
        ...styles.anchorPill,
        color: meta.color,
        borderColor: `${meta.color}66`,
        background: `${meta.color}10`,
        maxWidth: compact ? 206 : undefined,
      }}
      title={anchor.note}
    >
      <b>{meta.code}</b>
      {anchor.label}
    </span>
  )
}

function ContextInspector({ event }: { readonly event: ContextEvent }) {
  const source = sourceMeta[event.source]
  const grouped = {
    motive: event.anchors.filter((anchor) => anchor.kind === 'motive'),
    view: event.anchors.filter((anchor) => anchor.kind === 'view'),
    practice: event.anchors.filter((anchor) => anchor.kind === 'practice'),
  }

  return (
    <aside style={styles.inspector}>
      <div style={styles.inspectorHeader}>
        <span style={{ ...styles.sourceBadge, color: source.color, borderColor: `${source.color}88`, background: `${source.color}14` }}>
          {source.label} · {event.time}
        </span>
        <span style={styles.inspectorState}>已抽取 {event.anchors.length} 个锚点</span>
      </div>

      <h2 style={styles.inspectorTitle}>{event.title}</h2>
      <p style={styles.inspectorExcerpt}>{event.excerpt}</p>

      <section style={styles.inspectorSection}>
        <SectionTitle label="ANCHORS" title="三类锚点" />
        {(['motive', 'view', 'practice'] as const).map((kind) => (
          <div key={kind} style={styles.anchorGroup}>
            <div style={{ ...styles.anchorGroupTitle, color: anchorMeta[kind].color }}>
              <span>{anchorMeta[kind].label}</span>
              <b>{grouped[kind].length}</b>
            </div>
            {grouped[kind].map((anchor) => (
              <div key={`${kind}-${anchor.label}`} style={{ ...styles.anchorNote, borderLeftColor: `${anchorMeta[kind].color}33` }}>
                <strong>{anchor.label}</strong>
                <span>{anchor.note}</span>
              </div>
            ))}
          </div>
        ))}
      </section>

      <section style={styles.inspectorSection}>
        <SectionTitle label="GROWTH" title="自然长成计划" />
        <div style={styles.growthList}>
          {event.growth.map((item, index) => (
            <div key={item} style={styles.growthItem}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <strong>{item}</strong>
            </div>
          ))}
        </div>
      </section>

      <div style={styles.actionDock}>
        <div style={styles.actionButton}>出口草案 · 动机沉淀</div>
        <div style={styles.actionButtonPrimary}>出口草案 · 计划生成</div>
      </div>
    </aside>
  )
}

function SectionTitle({ label, title }: { readonly label: string; readonly title: string }) {
  return (
    <div style={styles.sectionTitle}>
      <span>{label}</span>
      <strong>{title}</strong>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  root: {
    height: '100%',
    position: 'relative',
    overflow: 'hidden',
    padding: 20,
    color: theme.textPrimary,
    fontFamily: theme.fontBody,
    background: theme.background,
  },
  backdrop: {
    position: 'absolute',
    inset: 0,
    background: `
      radial-gradient(circle at 18% 16%, rgba(0,255,224,0.13), transparent 27%),
      radial-gradient(circle at 82% 24%, rgba(255,153,51,0.11), transparent 24%),
      linear-gradient(180deg, rgba(4,10,26,0.94), rgba(0,0,0,0.97))
    `,
    pointerEvents: 'none',
  },
  grid: {
    position: 'absolute',
    inset: 0,
    background: `${hud.grid}, ${hud.scanlines}`,
    opacity: 0.72,
    pointerEvents: 'none',
  },
  content: {
    position: 'relative',
    zIndex: 1,
    height: '100%',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  header: {
    display: 'grid',
    gridTemplateColumns: 'minmax(360px, 1fr) auto',
    gap: 16,
    alignItems: 'end',
    flexShrink: 0,
  },
  headerCopy: {
    minWidth: 0,
  },
  kicker: {
    color: theme.flameTeal,
    fontFamily: theme.fontMono,
    fontSize: 10,
    letterSpacing: 2.5,
    marginBottom: 7,
  },
  title: {
    margin: 0,
    fontSize: 31,
    letterSpacing: 5,
    color: theme.textPrimary,
    textShadow: `0 0 18px ${theme.flameTeal}66`,
  },
  subtitle: {
    margin: '8px 0 0',
    maxWidth: 880,
    color: theme.textSecondary,
    fontSize: 12.5,
    lineHeight: 1.7,
  },
  metrics: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 82px)',
    gap: 7,
  },
  metric: {
    height: 54,
    borderWidth: 1,
    borderStyle: 'solid',
    clipPath: hud.chamfer8,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
  },
  metricLabel: {
    color: theme.textMuted,
    fontSize: 10,
    letterSpacing: 1,
  },
  metricValue: {
    fontFamily: theme.fontMono,
    fontSize: 18,
    letterSpacing: 1,
  },
  toolbar: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(260px, 1fr)',
    gap: 10,
    alignItems: 'center',
    flexShrink: 0,
  },
  filterRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 7,
  },
  filterButton: {
    height: 28,
    minWidth: 54,
    padding: '0 11px',
    borderWidth: 1,
    borderStyle: 'solid',
    clipPath: hud.chamfer8,
    fontSize: 12,
    fontWeight: 800,
    cursor: 'pointer',
    transition: 'background 0.14s ease, color 0.14s ease, box-shadow 0.14s ease',
  },
  captureBar: {
    minWidth: 0,
    height: 34,
    padding: '0 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'rgba(0,255,224,0.035)',
    clipPath: hud.chamfer8,
    color: theme.textSecondary,
    fontSize: 11,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  },
  captureLabel: {
    color: theme.flameTeal,
    fontFamily: theme.fontMono,
    fontSize: 9,
    letterSpacing: 1.6,
    flexShrink: 0,
  },
  board: {
    flex: 1,
    minHeight: 0,
    display: 'grid',
    gridTemplateColumns: 'minmax(680px, 1fr) 318px',
    gap: 12,
  },
  timelineShell: {
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'rgba(0,0,0,0.24)',
    clipPath: hud.chamfer12,
    overflow: 'hidden',
  },
  timelineHeader: {
    height: 46,
    flexShrink: 0,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    padding: '0 13px',
    borderBottom: `1px solid ${theme.hudFrameSoft}`,
    background: 'linear-gradient(180deg, rgba(0,255,224,0.08), transparent)',
  },
  panelEyebrow: {
    display: 'block',
    color: theme.flameTeal,
    fontFamily: theme.fontMono,
    fontSize: 9,
    letterSpacing: 1.6,
  },
  panelTitle: {
    display: 'block',
    marginTop: 2,
    color: theme.textPrimary,
    fontSize: 13,
    letterSpacing: 1.4,
  },
  legend: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    color: theme.textMuted,
    fontSize: 10.5,
    whiteSpace: 'nowrap',
  },
  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
  },
  legendDot: {
    width: 6,
    height: 6,
    borderRadius: 99,
    display: 'inline-block',
  },
  timelineViewport: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    position: 'relative',
    background: 'rgba(1,5,12,0.48)',
  },
  timelineInner: {
    position: 'relative',
    minWidth: RAIL_AREA_W + BRANCH_W + MAX_COLS * CARD_W + (MAX_COLS - 1) * CARD_GAP_X + 42,
  },
  timeLabel: {
    position: 'absolute',
    left: 9,
    width: 58,
    height: 28,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 1,
    borderWidth: 1,
    borderStyle: 'solid',
    borderRadius: 3,
    background: 'rgba(2,6,14,0.95)',
    fontFamily: theme.fontMono,
    zIndex: 6,
    pointerEvents: 'none',
  },
  card: {
    position: 'absolute',
    width: CARD_W,
    height: CARD_H,
    padding: 11,
    borderWidth: 1,
    borderStyle: 'solid',
    background: 'linear-gradient(180deg, rgba(4,13,28,0.94), rgba(0,0,0,0.72))',
    clipPath: hud.chamfer8,
    cursor: 'pointer',
    zIndex: 5,
    transition: 'border-color 0.14s ease, box-shadow 0.14s ease, transform 0.14s ease',
  },
  cardTop: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 8,
    alignItems: 'center',
    marginBottom: 8,
  },
  sourceBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 21,
    padding: '0 8px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderRadius: 3,
    fontSize: 10.5,
    fontWeight: 800,
    letterSpacing: 1,
    whiteSpace: 'nowrap',
  },
  intensity: {
    color: theme.textMuted,
    fontFamily: theme.fontMono,
    fontSize: 10,
  },
  cardTitle: {
    margin: 0,
    color: theme.textPrimary,
    fontSize: 14,
    lineHeight: 1.36,
    letterSpacing: 0.3,
  },
  cardExcerpt: {
    margin: '7px 0 9px',
    color: theme.textSecondary,
    fontSize: 11.5,
    lineHeight: 1.55,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  anchorPreview: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
  },
  anchorPill: {
    minWidth: 0,
    height: 20,
    padding: '0 7px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderRadius: 3,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10.5,
    lineHeight: 1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  inspector: {
    minHeight: 0,
    overflow: 'auto',
    border: `1px solid ${theme.warningOrange}55`,
    background: 'linear-gradient(180deg, rgba(255,153,51,0.08), rgba(0,0,0,0.32))',
    clipPath: hud.chamfer12,
    padding: 13,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  inspectorHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 8,
    alignItems: 'center',
  },
  inspectorState: {
    color: theme.textMuted,
    fontSize: 10,
    fontFamily: theme.fontMono,
  },
  inspectorTitle: {
    margin: 0,
    color: theme.textPrimary,
    fontSize: 18,
    lineHeight: 1.38,
    letterSpacing: 0.6,
  },
  inspectorExcerpt: {
    margin: 0,
    color: theme.textSecondary,
    fontSize: 12.5,
    lineHeight: 1.75,
  },
  inspectorSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sectionTitle: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    borderBottom: `1px solid ${theme.hudFrameSoft}`,
    paddingBottom: 6,
  },
  anchorGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
  },
  anchorGroupTitle: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 11,
    fontWeight: 900,
    letterSpacing: 0.8,
  },
  anchorNote: {
    borderLeftWidth: 2,
    borderLeftStyle: 'solid',
    background: 'rgba(0,0,0,0.24)',
    padding: '7px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    color: theme.textSecondary,
    fontSize: 11.5,
    lineHeight: 1.45,
  },
  growthList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
  },
  growthItem: {
    display: 'grid',
    gridTemplateColumns: '30px 1fr',
    gap: 8,
    alignItems: 'center',
    padding: '8px 9px',
    border: `1px solid ${theme.flameTeal}33`,
    background: 'rgba(0,255,224,0.035)',
    clipPath: hud.chamfer8,
    color: theme.textPrimary,
    fontSize: 12,
  },
  actionDock: {
    marginTop: 'auto',
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 8,
    paddingTop: 4,
  },
  actionButton: {
    height: 32,
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'rgba(255,255,255,0.025)',
    color: theme.textSecondary,
    clipPath: hud.chamfer8,
    fontWeight: 800,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonPrimary: {
    height: 32,
    border: `1px solid ${theme.warningOrange}`,
    background: theme.warningOrange,
    color: theme.background,
    clipPath: hud.chamfer8,
    fontWeight: 900,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
}
