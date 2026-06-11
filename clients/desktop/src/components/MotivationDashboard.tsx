// ══════════════════════════════════════════════
// MotivationDashboard — 今日/当日协议面板（v1：相位 + 动机云）
//
//   v0 用固定 5 阶段（韧性/执行/发现/回收/保护）+ 三列资讯流，
//   白板新方向：按 plannedBlocks 5min 颗粒度切相位，每段一个独立协议快照。
//   左边动机云从当前相位的 planNode 放射出子计划，右边双层卡：AI 理智 + 用户动机锚点。
//   文件名沿用 MotivationDashboard，避免动 App 视图枚举。
// ══════════════════════════════════════════════

import { useMemo, useState, type CSSProperties } from 'react'
import type { Goal } from '../lib/local-api'
import { parseGoalTags } from '../lib/local-api'
import type { ActivityBlock, ActivityPalette, PlanNode, PlannedBlock } from '../types'
import { hud, theme } from '../theme'
import { HudFrameSkeleton, CornerArt } from './hud'
import Tooltip from './Tooltip'

const BLOCK_MINUTES = 5
const SLOTS_PER_DAY = 1440 / BLOCK_MINUTES   // 288

interface Props {
  readonly protocolLabel: string
  readonly isTodayProtocol: boolean
  readonly selectedDate: Date
  readonly goals: readonly Goal[]
  readonly activityPalette: ActivityPalette
  readonly activityBlocks: readonly ActivityBlock[]
  readonly plannedBlocks: readonly PlannedBlock[]
  readonly planNodes: readonly PlanNode[]
  readonly onOpenPlanLayer?: () => void
}

// ── 相位（Phase）：连续相同 planNodeId 的时段（含留白） ──────────
interface Phase {
  readonly key: string
  readonly startMinute: number         // 含
  readonly endMinute: number           // 不含
  readonly planNodeId: number | null   // null = 留白
  readonly planNode: PlanNode | null
  readonly rootNode: PlanNode | null   // 根计划（用于配色 + 关联 goal）
}

// ── 工具 ────────────────────────────────────────────────────────
function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

function hhmm(minute: number): string {
  const m = ((Math.floor(minute) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function findRoot(node: PlanNode, all: readonly PlanNode[]): PlanNode {
  let cur = node
  // 防御环：最多上溯 16 层
  for (let i = 0; i < 16; i++) {
    if (cur.parentId == null) return cur
    const parent = all.find((n) => n.id === cur.parentId)
    if (!parent) return cur
    cur = parent
  }
  return cur
}

function buildPhases(
  plannedBlocks: readonly PlannedBlock[],
  planNodes: readonly PlanNode[],
): Phase[] {
  const minToNode = new Map<number, number>()  // minute → planNodeId
  plannedBlocks.forEach((b) => { minToNode.set(b.minute, b.planNodeId) })

  const out: Phase[] = []
  let cur: { startMinute: number; endMinute: number; planNodeId: number | null } | null = null

  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    const m = i * BLOCK_MINUTES
    const pid = minToNode.has(m) ? minToNode.get(m)! : null

    if (cur === null || cur.planNodeId !== pid) {
      if (cur) {
        const node = cur.planNodeId != null ? planNodes.find((n) => n.id === cur!.planNodeId) ?? null : null
        out.push({
          key: `${cur.startMinute}-${cur.endMinute}-${cur.planNodeId ?? 'gap'}`,
          startMinute: cur.startMinute,
          endMinute: cur.endMinute,
          planNodeId: cur.planNodeId,
          planNode: node,
          rootNode: node ? findRoot(node, planNodes) : null,
        })
      }
      cur = { startMinute: m, endMinute: m + BLOCK_MINUTES, planNodeId: pid }
    } else {
      cur.endMinute = m + BLOCK_MINUTES
    }
  }
  if (cur) {
    const node = cur.planNodeId != null ? planNodes.find((n) => n.id === cur!.planNodeId) ?? null : null
    out.push({
      key: `${cur.startMinute}-${cur.endMinute}-${cur.planNodeId ?? 'gap'}`,
      startMinute: cur.startMinute,
      endMinute: cur.endMinute,
      planNodeId: cur.planNodeId,
      planNode: node,
      rootNode: node ? findRoot(node, planNodes) : null,
    })
  }

  return out
}

function inferDisplayMinute(
  isToday: boolean,
  activityBlocks: readonly ActivityBlock[],
  plannedBlocks: readonly PlannedBlock[],
): number {
  if (isToday) return minuteOfDay(new Date())
  const lastA = activityBlocks.reduce((max, b) => Math.max(max, b.minute), -1)
  const lastP = plannedBlocks.reduce((max, b) => Math.max(max, b.minute), -1)
  const last = Math.max(lastA, lastP)
  return last >= 0 ? last : 12 * 60
}

function rootAccent(root: PlanNode | null, palette: ActivityPalette): string {
  if (!root) return theme.electricBlue
  const tag = palette.tags.find((t) => t.id === root.projectTagId)
  const cat = tag ? palette.categories.find((c) => c.id === tag.categoryId) : null
  return cat?.color ?? theme.electricBlue
}

function rootTagPath(root: PlanNode | null, palette: ActivityPalette): string | null {
  if (!root) return null
  const tag = palette.tags.find((t) => t.id === root.projectTagId)
  return tag?.fullPath ?? null
}

// 找跟当前相位相关的 goals：goal.tags 包含 rootTag fullPath 任一段
function relatedGoals(phase: Phase, palette: ActivityPalette, goals: readonly Goal[]): readonly Goal[] {
  const path = rootTagPath(phase.rootNode, palette)
  if (!path) return []
  const parts = path.split(',').map((s) => s.trim()).filter(Boolean)
  return goals.filter((g) => {
    const gt = parseGoalTags(g)
    return gt.some((t) => parts.includes(t))
  })
}

// 实际 vs 计划对齐度（决定心理状态标签）
function alignmentLabel(phase: Phase, activityBlocks: readonly ActivityBlock[]): {
  label: string
  detail: string
  accent: string
} {
  if (phase.planNodeId == null) {
    return { label: '留白', detail: '没有计划占用，可自主选择', accent: theme.textMuted }
  }
  const planMinutes = phase.endMinute - phase.startMinute
  if (planMinutes <= 0) {
    return { label: '—', detail: '', accent: theme.textMuted }
  }
  const actualInPhase = activityBlocks.filter((b) => b.minute >= phase.startMinute && b.minute < phase.endMinute)
  if (actualInPhase.length === 0) {
    return { label: '空段', detail: '未有任何实际记录', accent: theme.warningOrange }
  }
  // 简化：实际/计划 ≥ 0.5 视为执行中
  const ratio = (actualInPhase.length * BLOCK_MINUTES) / planMinutes
  if (ratio >= 0.5) {
    return { label: '执行中', detail: `实际 ${actualInPhase.length * BLOCK_MINUTES}m / 计划 ${planMinutes}m`, accent: theme.expGreen }
  }
  return {
    label: '偏离',
    detail: `实际仅 ${actualInPhase.length * BLOCK_MINUTES}m / 计划 ${planMinutes}m`,
    accent: theme.dangerRed,
  }
}

// AI 理智（简化版）：根据 plan node title 关键字 + 根分类给出"做/不做"
function aiRestraint(phase: Phase, palette: ActivityPalette): { allow: readonly string[]; deny: readonly string[] } {
  if (phase.planNodeId == null) {
    return {
      allow: ['观察现在被什么牵引', '写一句锚点 / 想法', '判断要不要切入计划'],
      deny: ['无目标滑短视频', '把空白当焦虑证据'],
    }
  }
  const path = rootTagPath(phase.rootNode, palette) ?? ''
  const isLearn = /学习|论文|阅读|课题|研究|项目/.test(path) || /(学|读|写|研|论)/.test(phase.planNode?.title ?? '')
  const isRest = /休息|睡|放松|健身|运动/.test(path) || /(休|睡|歇|健身|运动)/.test(phase.planNode?.title ?? '')
  const isSocial = /社交|聊|玩|游戏/.test(path) || /(社交|玩|游戏)/.test(phase.planNode?.title ?? '')

  if (isLearn) {
    return {
      allow: ['专注本步骤', '到点小息 2 分钟', '记录卡点'],
      deny: ['切去查无关资料', '同时开新坑', '情绪性刷屏'],
    }
  }
  if (isRest) {
    return {
      allow: ['真正离开屏幕', '走动 / 喝水 / 看远处', '不规划下一件'],
      deny: ['打开高刺激内容', '处理待办', '强行 deep work'],
    }
  }
  if (isSocial) {
    return {
      allow: ['只回必要消息', '15 分钟为上限'],
      deny: ['刷推荐 feed', '陷入回忆性焦虑'],
    }
  }
  return {
    allow: ['按计划块完成本段', '到点切相位'],
    deny: ['临时换方向', '把疲劳当无动力'],
  }
}

// ── 视觉常量 ──────────────────────────────────────────────
const styles: Record<string, CSSProperties> = {
  root: {
    width: '100%', height: '100%',
    display: 'flex', flexDirection: 'column',
    background: theme.background, color: theme.textPrimary,
    fontFamily: theme.fontBody,
  },
  tabBar: {
    height: 30, padding: '0 16px',
    display: 'flex', alignItems: 'center', gap: 12,
    borderBottom: `1px solid ${theme.glassBorder}`,
    background: theme.glass,
    flexShrink: 0,
  },
  tabTitle: {
    fontSize: 12, letterSpacing: '0.18em',
    color: theme.textPrimary, fontWeight: 600,
  },
  tabSubtitle: {
    fontSize: 11, color: theme.textMuted,
  },
  body: {
    flex: 1, position: 'relative', minHeight: 0,
  },
  backdrop: {
    position: 'absolute', inset: 0,
    background: hud.backdrop,
    pointerEvents: 'none',
  },
  scanline: {
    position: 'absolute', inset: 0,
    background: hud.scanlines,
    opacity: 0.05,
    pointerEvents: 'none',
  },
  content: {
    position: 'absolute', inset: 0,
    padding: '20px 22px 18px',
    display: 'flex', flexDirection: 'column',
    gap: 14,
    minHeight: 0,
  },
  phaseAxis: {
    display: 'flex', flexDirection: 'column', gap: 6,
    flexShrink: 0,
  },
  phaseAxisLabel: {
    fontSize: 10, letterSpacing: '0.3em',
    color: theme.textMuted,
  },
  phaseTrack: {
    position: 'relative',
    height: 36,
    border: `1px solid ${theme.glassBorder}`,
    background: theme.background,
    overflow: 'hidden',
  },
  phaseSegment: {
    position: 'absolute', top: 0, bottom: 0,
    borderRight: `1px solid ${theme.glassBorder}`,
    cursor: 'pointer',
    transition: 'background 0.15s, opacity 0.15s',
  },
  phaseSegmentLabel: {
    position: 'absolute', left: 4, top: 4,
    fontSize: 9, color: theme.textPrimary,
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'clip',
    width: 'calc(100% - 8px)',
  },
  nowMarker: {
    position: 'absolute', top: -4, bottom: -4,
    width: 2,
    background: theme.dangerRed,
    pointerEvents: 'none',
    boxShadow: `0 0 6px ${theme.dangerRed}`,
  },
  main: {
    flex: 1, display: 'grid',
    gridTemplateColumns: '1.4fr 1fr',
    gap: 14,
    minHeight: 0,
  },
  cloudCard: {
    border: `1px solid ${theme.glassBorder}`,
    background: theme.background,
    display: 'flex', flexDirection: 'column',
    minHeight: 0,
  },
  cardHeader: {
    height: 26, padding: '0 12px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    borderBottom: `1px solid ${theme.glassBorder}`,
    background: theme.glass,
    flexShrink: 0,
  },
  cardLabel: {
    fontSize: 10, letterSpacing: '0.25em', color: theme.textMuted, fontWeight: 600,
  },
  cardMeta: {
    fontSize: 10, color: theme.textMuted,
  },
  cloudSvg: {
    width: '100%', flex: 1, minHeight: 0,
    display: 'block',
  },
  rightColumn: {
    display: 'flex', flexDirection: 'column',
    gap: 14, minHeight: 0,
  },
  panelCard: {
    border: `1px solid ${theme.glassBorder}`,
    background: theme.background,
    display: 'flex', flexDirection: 'column',
    minHeight: 0,
    flex: 1,
  },
  panelBody: {
    padding: '10px 14px 12px',
    overflow: 'auto',
    flex: 1,
    minHeight: 0,
  },
  bulletAllow: {
    display: 'flex', alignItems: 'baseline', gap: 8,
    fontSize: 12, color: theme.textPrimary,
    lineHeight: 1.55,
    marginBottom: 4,
  },
  bulletDeny: {
    display: 'flex', alignItems: 'baseline', gap: 8,
    fontSize: 12, color: theme.textMuted,
    lineHeight: 1.55,
    marginBottom: 4,
    textDecoration: 'line-through',
    textDecorationColor: theme.dangerRed,
    textDecorationThickness: '1px',
  },
  bulletDot: {
    fontSize: 8,
    flexShrink: 0,
    marginTop: 2,
  },
  goalRow: {
    padding: '6px 0',
    borderBottom: `1px dashed ${theme.glassBorder}`,
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8,
  },
  goalTitle: {
    fontSize: 12, color: theme.textPrimary,
  },
  goalTags: {
    fontSize: 10, color: theme.textMuted,
  },
  alignChip: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '3px 8px', fontSize: 10, letterSpacing: '0.1em',
    border: `1px solid currentColor`,
  },
  noteEmpty: {
    fontSize: 11, color: theme.textMuted, fontStyle: 'italic',
    padding: '6px 0',
  },
  phaseHeaderRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    flexWrap: 'wrap',
  },
  phaseRange: {
    fontSize: 12, color: theme.textPrimary, fontWeight: 600,
    letterSpacing: '0.05em',
  },
  phaseTitle: {
    fontSize: 13, color: theme.textPrimary,
  },
  pathHint: {
    fontSize: 10, color: theme.textMuted,
  },
  navBtn: {
    background: 'transparent',
    border: `1px solid ${theme.glassBorder}`,
    color: theme.textPrimary,
    padding: '4px 10px',
    fontSize: 11, letterSpacing: '0.15em',
    cursor: 'pointer',
    fontFamily: theme.fontBody,
  },
  navBtnDim: { opacity: 0.4, cursor: 'not-allowed' },
  ctaBtn: {
    background: theme.electricBlue,
    border: 'none',
    color: theme.background,
    padding: '5px 12px',
    fontSize: 11, letterSpacing: '0.2em',
    cursor: 'pointer',
    fontFamily: theme.fontBody,
    fontWeight: 600,
  },
}

// ── 动机云（简版）─────────────────────────────────────────
//   中心节点 = 当前相位 plan node（或留白）
//   一圈子节点 = 同一 projectTagId 下的子节点（先取直接 children，不够再拉同级）
//   涟漪 = SVG circle + animate
// ─────────────────────────────────────────────────────────
function MotivationCloud({
  phase,
  planNodes,
  accent,
}: {
  phase: Phase
  planNodes: readonly PlanNode[]
  accent: string
}) {
  const center = phase.planNode
  const subnodes: readonly PlanNode[] = useMemo(() => {
    if (!center) return []
    // 优先取直接子节点
    const direct = planNodes.filter((n) => n.parentId === center.id && n.status === 'active')
    if (direct.length > 0) return direct.slice(0, 6)
    // 否则取同级兄弟
    if (center.parentId != null) {
      const siblings = planNodes.filter((n) => n.parentId === center.parentId && n.id !== center.id && n.status === 'active')
      if (siblings.length > 0) return siblings.slice(0, 6)
    }
    return []
  }, [center, planNodes])

  const cx = 50, cy = 50          // viewBox 100x100, 中心
  const ringR = 36                // 子节点到中心的距离
  const centerR = 14              // 中心圆半径

  const angleStep = subnodes.length > 0 ? (Math.PI * 2) / subnodes.length : 0
  const positions = subnodes.map((_, i) => ({
    x: cx + ringR * Math.cos(-Math.PI / 2 + i * angleStep),
    y: cy + ringR * Math.sin(-Math.PI / 2 + i * angleStep),
  }))

  const centerLabel = center ? center.title : '留白'
  const isBlank = center === null

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style={styles.cloudSvg}>
      <defs>
        <radialGradient id="centerGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={accent} stopOpacity={0.55} />
          <stop offset="100%" stopColor={accent} stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* 涟漪：3 圈逐渐扩大消逝 */}
      {!isBlank && [0, 1, 2].map((i) => (
        <circle
          key={i}
          cx={cx} cy={cy} r={centerR}
          fill="none"
          stroke={accent}
          strokeWidth={0.3}
          opacity={0.6}
        >
          <animate
            attributeName="r"
            from={centerR}
            to={ringR + 4}
            dur="3.6s"
            begin={`${i * 1.2}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            from={0.55}
            to={0}
            dur="3.6s"
            begin={`${i * 1.2}s`}
            repeatCount="indefinite"
          />
        </circle>
      ))}

      {/* 连线 */}
      {positions.map((p, i) => (
        <line
          key={`l-${i}`}
          x1={cx} y1={cy}
          x2={p.x} y2={p.y}
          stroke={accent}
          strokeWidth={0.4}
          opacity={0.6}
          strokeDasharray="1 1.5"
        />
      ))}

      {/* 中心晕染 */}
      <circle cx={cx} cy={cy} r={centerR + 8} fill="url(#centerGrad)" />

      {/* 中心节点 */}
      <circle
        cx={cx} cy={cy} r={centerR}
        fill={theme.background}
        stroke={accent}
        strokeWidth={isBlank ? 0.6 : 1.2}
        strokeDasharray={isBlank ? '1.5 1.5' : ''}
      />
      <text
        x={cx} y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={4.2}
        fill={theme.textPrimary}
        style={{ fontWeight: 600 }}
      >
        {clipText(centerLabel, 12)}
      </text>

      {/* 子节点 */}
      {subnodes.map((node, i) => (
        <g key={node.id}>
          <circle
            cx={positions[i].x} cy={positions[i].y} r={6}
            fill={theme.background}
            stroke={accent}
            strokeWidth={0.8}
            opacity={0.9}
          />
          <text
            x={positions[i].x} y={positions[i].y}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={3.2}
            fill={theme.textPrimary}
          >
            {clipText(node.title, 8)}
          </text>
        </g>
      ))}

      {/* 留白态：中心额外提示 */}
      {isBlank && (
        <text
          x={cx} y={cy + centerR + 8}
          textAnchor="middle"
          fontSize={3.5}
          fill={theme.textMuted}
        >
          无计划占用 · 自主时段
        </text>
      )}
    </svg>
  )
}

function clipText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

// ── 主组件 ─────────────────────────────────────────────────
export default function MotivationDashboard({
  protocolLabel,
  isTodayProtocol,
  selectedDate: _selectedDate,
  goals,
  activityPalette,
  activityBlocks,
  plannedBlocks,
  planNodes,
  onOpenPlanLayer,
}: Props) {
  const phases = useMemo(() => buildPhases(plannedBlocks, planNodes), [plannedBlocks, planNodes])
  const displayMinute = inferDisplayMinute(isTodayProtocol, activityBlocks, plannedBlocks)
  const currentPhaseIdx = useMemo(() => {
    const idx = phases.findIndex((p) => displayMinute >= p.startMinute && displayMinute < p.endMinute)
    return idx >= 0 ? idx : Math.min(Math.floor(displayMinute / 60) % phases.length, phases.length - 1)
  }, [phases, displayMinute])

  // 用户可手动选另一个相位（默认跟当前同步）
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const focusIdx = selectedIdx ?? currentPhaseIdx
  const phase = phases[focusIdx] ?? phases[0]

  const accent = rootAccent(phase?.rootNode ?? null, activityPalette)
  const rootPath = rootTagPath(phase?.rootNode ?? null, activityPalette)
  const align = phase ? alignmentLabel(phase, activityBlocks) : { label: '—', detail: '', accent: theme.textMuted }
  const restraint = phase ? aiRestraint(phase, activityPalette) : { allow: [], deny: [] }
  const linkedGoals = phase ? relatedGoals(phase, activityPalette, goals) : []

  const totalPlannedMinutes = plannedBlocks.length * BLOCK_MINUTES
  const subtitle = isTodayProtocol
    ? `相位 ${focusIdx + 1}/${phases.length} · 当前时刻 ${hhmm(displayMinute)}`
    : `相位 ${focusIdx + 1}/${phases.length} · 回看快照`

  return (
    <div style={styles.root}>
      <div style={styles.tabBar}>
        <span style={styles.tabTitle}>{protocolLabel}</span>
        <span style={styles.tabSubtitle}>{subtitle}</span>
      </div>

      <div style={styles.body}>
        <HudFrameSkeleton />
        <CornerArt position="tl" />
        <CornerArt position="tr" />
        <CornerArt position="bl" />
        <CornerArt position="br" />
        <div style={styles.backdrop} />
        <div style={styles.scanline} />

        <div style={styles.content}>
          {/* 相位轴 */}
          <PhaseAxis
            phases={phases}
            currentMinute={displayMinute}
            focusIdx={focusIdx}
            currentPhaseIdx={currentPhaseIdx}
            palette={activityPalette}
            onSelect={(idx) => setSelectedIdx(idx === currentPhaseIdx ? null : idx)}
          />

          {/* 主区 */}
          <div style={styles.main}>
            {/* 左：动机云 */}
            <div style={styles.cloudCard}>
              <div style={styles.cardHeader}>
                <span style={{ ...styles.cardLabel, color: accent }}>动 机 云</span>
                <div style={styles.phaseHeaderRow}>
                  <span style={styles.phaseRange}>{hhmm(phase.startMinute)} ─ {hhmm(phase.endMinute)}</span>
                  <PhaseNav
                    canPrev={focusIdx > 0}
                    canNext={focusIdx < phases.length - 1}
                    onPrev={() => setSelectedIdx(Math.max(0, focusIdx - 1))}
                    onNext={() => setSelectedIdx(Math.min(phases.length - 1, focusIdx + 1))}
                    onReset={selectedIdx !== null ? () => setSelectedIdx(null) : null}
                  />
                </div>
              </div>
              <div style={{ flex: 1, minHeight: 0, padding: '8px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={styles.phaseHeaderRow}>
                  <span style={styles.phaseTitle}>{phase.planNode?.title ?? '留白时段'}</span>
                  {rootPath && <span style={styles.pathHint}>{rootPath}</span>}
                  <span style={{ ...styles.alignChip, color: align.accent }}>
                    <span style={{ fontSize: 9 }}>●</span>{align.label}
                  </span>
                </div>
                <MotivationCloud phase={phase} planNodes={planNodes} accent={accent} />
                {align.detail && (
                  <div style={{ fontSize: 10, color: theme.textMuted, textAlign: 'center' }}>{align.detail}</div>
                )}
              </div>
            </div>

            {/* 右：双层卡 */}
            <div style={styles.rightColumn}>
              <div style={styles.panelCard}>
                <div style={styles.cardHeader}>
                  <span style={styles.cardLabel}>AI 理智</span>
                  <span style={styles.cardMeta}>本相位边界</span>
                </div>
                <div style={styles.panelBody}>
                  {restraint.allow.map((s, i) => (
                    <div key={`a-${i}`} style={styles.bulletAllow}>
                      <span style={{ ...styles.bulletDot, color: theme.expGreen }}>●</span>{s}
                    </div>
                  ))}
                  {restraint.deny.map((s, i) => (
                    <div key={`d-${i}`} style={styles.bulletDeny}>
                      <span style={{ ...styles.bulletDot, color: theme.dangerRed }}>×</span>{s}
                    </div>
                  ))}
                </div>
              </div>

              <div style={styles.panelCard}>
                <div style={styles.cardHeader}>
                  <span style={styles.cardLabel}>用 户 动 机 锚 点</span>
                  <span style={styles.cardMeta}>{linkedGoals.length} / {goals.length} 关联</span>
                </div>
                <div style={styles.panelBody}>
                  {linkedGoals.length === 0 ? (
                    <div style={styles.noteEmpty}>
                      {goals.length === 0
                        ? '尚未设定任何目标。'
                        : `当前相位（${rootPath ?? '留白'}）未关联到任何活跃目标。`}
                    </div>
                  ) : linkedGoals.map((g) => (
                    <div key={g.id} style={styles.goalRow}>
                      <span style={styles.goalTitle}>{g.title}</span>
                      <span style={styles.goalTags}>{parseGoalTags(g).join(' · ')}</span>
                    </div>
                  ))}

                  {phase.planNodeId == null && onOpenPlanLayer && (
                    <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
                      <button type="button" style={styles.ctaBtn} onClick={onOpenPlanLayer}>填入计划</button>
                    </div>
                  )}
                  {phase.planNodeId == null && totalPlannedMinutes === 0 && (
                    <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 8 }}>
                      今日尚未排任何计划块 · 总计 0m
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 相位轴子组件 ───────────────────────────────────────────
function PhaseAxis({
  phases,
  currentMinute,
  focusIdx,
  currentPhaseIdx,
  palette,
  onSelect,
}: {
  phases: readonly Phase[]
  currentMinute: number
  focusIdx: number
  currentPhaseIdx: number
  palette: ActivityPalette
  onSelect: (idx: number) => void
}) {
  const totalMinutes = 1440
  return (
    <div style={styles.phaseAxis}>
      <span style={styles.phaseAxisLabel}>相 位 时 段 · 5 m i n 颗 粒 度</span>
      <div style={styles.phaseTrack}>
        {phases.map((p, i) => {
          const left = (p.startMinute / totalMinutes) * 100
          const width = ((p.endMinute - p.startMinute) / totalMinutes) * 100
          const color = rootAccent(p.rootNode ?? null, palette)
          const isFocus = i === focusIdx
          const isCurrent = i === currentPhaseIdx
          const isGap = p.planNodeId == null
          return (
            <Tooltip
              key={p.key}
              content={`${hhmm(p.startMinute)}–${hhmm(p.endMinute)} ${p.planNode?.title ?? '留白'}`}
              display="block"
              wrapStyle={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${left}%`,
                width: `${width}%`,
                zIndex: isFocus ? 2 : 1,
              }}
            >
            <div
              style={{
                ...styles.phaseSegment,
                position: 'absolute',
                inset: 0,
                left: 0,
                width: 'auto',
                background: isGap
                  ? 'transparent'
                  : (isFocus ? color : color + '55'),
                opacity: isGap ? 0.4 : 1,
                outline: isFocus ? `1px solid ${theme.textPrimary}` : 'none',
                outlineOffset: '-1px',
              }}
              onClick={() => onSelect(i)}
            >
              {!isGap && width > 4 && (
                <span style={styles.phaseSegmentLabel}>{p.planNode?.title}</span>
              )}
              {isCurrent && !isFocus && (
                <span style={{
                  position: 'absolute', bottom: 1, left: '50%',
                  width: 4, height: 4,
                  background: theme.dangerRed,
                  borderRadius: '50%',
                  transform: 'translateX(-50%)',
                }} />
              )}
            </div>
            </Tooltip>
          )
        })}
        <div style={{ ...styles.nowMarker, left: `${(currentMinute / totalMinutes) * 100}%` }} />
      </div>
    </div>
  )
}

function PhaseNav({
  canPrev, canNext, onPrev, onNext, onReset,
}: {
  canPrev: boolean
  canNext: boolean
  onPrev: () => void
  onNext: () => void
  onReset: (() => void) | null
}) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <button
        type="button"
        style={{ ...styles.navBtn, ...(canPrev ? {} : styles.navBtnDim) }}
        onClick={canPrev ? onPrev : undefined}
        disabled={!canPrev}
      >◀</button>
      <button
        type="button"
        style={{ ...styles.navBtn, ...(canNext ? {} : styles.navBtnDim) }}
        onClick={canNext ? onNext : undefined}
        disabled={!canNext}
      >▶</button>
      {onReset && (
        <button type="button" style={styles.navBtn} onClick={onReset}>当 前</button>
      )}
    </div>
  )
}
