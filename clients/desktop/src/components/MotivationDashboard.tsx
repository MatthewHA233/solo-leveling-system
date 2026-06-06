// ══════════════════════════════════════════════
// MotivationDashboard — 今日/当日协议面板
//
//   文件名暂时沿用旧的 MotivationDashboard，避免牵动 App 的视图枚举。
//   这一版开始把协议页接回真实数据：活跃目标、计划块、实际记录、
//   当前已加载的计划树。后续 Fairy 生成 brief 时，也应该消费同一份
//   ProtocolContext，而不是再开一套孤立的 UI 数据。
// ══════════════════════════════════════════════

import type { CSSProperties, ReactNode } from 'react'
import type { Goal } from '../lib/local-api'
import { parseGoalTags } from '../lib/local-api'
import type { ActivityBlock, ActivityPalette, ActivityTag, PlanNode, PlannedBlock } from '../types'
import { hud, theme } from '../theme'
import { HudFrameSkeleton, CornerArt } from './hud'

const TABS_HEIGHT = 30
const FRAME_LEFT_PAD = 24
const BLOCK_MINUTES = 5

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

type ProtocolKind = 'resilience' | 'execution' | 'discovery' | 'recovery' | 'protection'

interface ProtocolPhase {
  readonly id: ProtocolKind
  readonly label: string
  readonly shortLabel: string
  readonly range: string
  readonly startMinute: number
  readonly endMinute: number
  readonly accent: string
}

interface GoalAttempt {
  readonly id: string
  readonly title: string
  readonly tags: readonly string[]
  readonly matchedTags: readonly ActivityTag[]
  readonly activeNodes: readonly PlanNode[]
  readonly plannedMinutes: number
  readonly actualMinutes: number
  readonly actionLabel: string
  readonly statusLabel: string
  readonly accent: string
}

interface ScheduleSegment {
  readonly key: string
  readonly startMinute: number
  readonly endMinute: number
  readonly title: string
  readonly projectPath: string
  readonly accent: string
}

const phases: readonly ProtocolPhase[] = [
  {
    id: 'resilience',
    label: '韧性协议',
    shortLabel: '韧性',
    range: '07:00',
    startMinute: 7 * 60,
    endMinute: 10 * 60,
    accent: theme.expGreen,
  },
  {
    id: 'execution',
    label: '执行协议',
    shortLabel: '执行',
    range: '10:00',
    startMinute: 10 * 60,
    endMinute: 15 * 60,
    accent: theme.electricBlue,
  },
  {
    id: 'discovery',
    label: '发现协议',
    shortLabel: '发现',
    range: '15:00',
    startMinute: 15 * 60,
    endMinute: 19 * 60,
    accent: '#f1c40f',
  },
  {
    id: 'recovery',
    label: '回收协议',
    shortLabel: '回收',
    range: '19:00',
    startMinute: 19 * 60,
    endMinute: 23 * 60,
    accent: theme.warningOrange,
  },
  {
    id: 'protection',
    label: '保护协议',
    shortLabel: '保护',
    range: '23:00',
    startMinute: 23 * 60,
    endMinute: 31 * 60,
    accent: theme.dangerRed,
  },
]

function toDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

function hhmm(minute: number): string {
  const m = ((Math.floor(minute) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function formatDuration(minutes: number): string {
  if (minutes <= 0) return '0m'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h <= 0) return `${m}m`
  return m > 0 ? `${h}h${m}m` : `${h}h`
}

function phaseForMinute(minute: number): ProtocolPhase {
  const normalized = minute < 7 * 60 ? minute + 24 * 60 : minute
  return phases.find((phase) => normalized >= phase.startMinute && normalized < phase.endMinute)
    ?? phases[phases.length - 1]
}

function inferArchiveMinute(activityBlocks: readonly ActivityBlock[], plannedBlocks: readonly PlannedBlock[]): number {
  const lastActual = activityBlocks.reduce((max, block) => Math.max(max, block.minute), -1)
  const lastPlan = plannedBlocks.reduce((max, block) => Math.max(max, block.minute), -1)
  const last = Math.max(lastActual, lastPlan)
  return last >= 0 ? last : 21 * 60
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s，,、/\\|>:_\-()[\]{}]+/g, '')
}

function containsAny(text: string, words: readonly string[]): boolean {
  const n = normalize(text)
  return words.some((word) => n.includes(normalize(word)))
}

function buildGoalTerms(goal: Goal): string[] {
  const tags = parseGoalTags(goal)
  const terms = [goal.title, ...tags]
  const joined = terms.join(' ')
  if (containsAny(joined, ['减肥', '运动', '体重', '健身', '健康', '脂肪'])) {
    terms.push('运动', '健身', '锻炼', '步行', '跑步', '健康', '身体')
  }
  if (containsAny(joined, ['代码', '审核', '审查', 'review', '编程', '开发', '仓库'])) {
    terms.push('代码', '审核', '审查', 'review', '编程', '开发', '项目')
  }
  return [...new Set(terms.map(normalize).filter((term) => term.length >= 2))]
}

function tagMatchesTerms(tag: ActivityTag, terms: readonly string[]): boolean {
  const target = normalize(`${tag.fullPath} ${tag.leafName}`)
  return terms.some((term) => target.includes(term) || term.includes(target))
}

function nodeMatchesTerms(node: PlanNode, terms: readonly string[], relatedTagIds: ReadonlySet<number>): boolean {
  if (relatedTagIds.has(node.projectTagId)) return true
  const title = normalize(node.title)
  return terms.some((term) => title.includes(term) || term.includes(title))
}

function categoryColorForTag(tag: ActivityTag | null, palette: ActivityPalette, fallback: string): string {
  if (!tag) return fallback
  return palette.categories.find((category) => category.id === tag.categoryId)?.color ?? fallback
}

function actionForGoal(goal: Goal, plannedMinutes: number, actualMinutes: number, activeNodes: readonly PlanNode[]): string {
  const terms = `${goal.title} ${parseGoalTags(goal).join(' ')}`
  if (actualMinutes > 0) return '保留今天的行动证据，晚间回收成经验'
  if (plannedMinutes > 0) return '按昼夜表计划启动第一段，不再重新设计'
  if (activeNodes.length > 0) return `给「${activeNodes[0].title}」拖入一个 25 分钟行动块`
  if (containsAny(terms, ['减肥', '运动', '体重', '健身', '健康'])) return '今天至少安排 20 分钟低门槛运动'
  if (containsAny(terms, ['代码', '审核', '审查', 'review', '编程'])) return '今天安排 30 分钟代码审核/复盘训练'
  return '把目标压成一个 20 分钟可执行动作'
}

function statusForGoal(plannedMinutes: number, actualMinutes: number, activeNodes: readonly PlanNode[]): string {
  if (actualMinutes > 0) return '已行动'
  if (plannedMinutes > 0) return '已排程'
  if (activeNodes.length > 0) return '待拖入'
  return '待拆解'
}

function buildGoalAttempts(
  goals: readonly Goal[],
  palette: ActivityPalette,
  activityBlocks: readonly ActivityBlock[],
  plannedBlocks: readonly PlannedBlock[],
  planNodes: readonly PlanNode[],
): GoalAttempt[] {
  const nodeById = new Map(planNodes.map((node) => [node.id, node]))

  return goals.map((goal, index) => {
    const terms = buildGoalTerms(goal)
    const matchedTags = palette.tags.filter((tag) => tagMatchesTerms(tag, terms)).slice(0, 6)
    const tagIds = new Set(matchedTags.map((tag) => tag.id))
    const activeNodes = planNodes.filter((node) => node.status !== 'archived' && nodeMatchesTerms(node, terms, tagIds))
    const activeNodeIds = new Set(activeNodes.map((node) => node.id))
    const actualMinutes = activityBlocks.filter((block) => tagIds.has(block.tagId)).length * BLOCK_MINUTES
    const plannedMinutes = plannedBlocks.filter((block) => {
      if (activeNodeIds.has(block.planNodeId)) return true
      const node = nodeById.get(block.planNodeId)
      return node ? nodeMatchesTerms(node, terms, tagIds) : false
    }).length * BLOCK_MINUTES
    const accentSource = matchedTags[0] ?? (activeNodes[0] ? palette.tags.find((tag) => tag.id === activeNodes[0].projectTagId) ?? null : null)

    return {
      id: goal.id,
      title: goal.title,
      tags: parseGoalTags(goal),
      matchedTags,
      activeNodes,
      plannedMinutes,
      actualMinutes,
      actionLabel: actionForGoal(goal, plannedMinutes, actualMinutes, activeNodes),
      statusLabel: statusForGoal(plannedMinutes, actualMinutes, activeNodes),
      accent: categoryColorForTag(accentSource, palette, index % 2 === 0 ? theme.electricBlue : theme.warningOrange),
    }
  }).sort((a, b) => {
    const scoreA = a.actualMinutes * 4 + a.plannedMinutes * 2 + a.activeNodes.length
    const scoreB = b.actualMinutes * 4 + b.plannedMinutes * 2 + b.activeNodes.length
    return scoreB - scoreA
  })
}

function buildSchedule(
  plannedBlocks: readonly PlannedBlock[],
  planNodes: readonly PlanNode[],
  palette: ActivityPalette,
): ScheduleSegment[] {
  const nodeById = new Map(planNodes.map((node) => [node.id, node]))
  const sorted = [...plannedBlocks].sort((a, b) => a.minute - b.minute)
  const segments: ScheduleSegment[] = []

  for (const block of sorted) {
    const last = segments[segments.length - 1]
    if (last && last.key === String(block.planNodeId) && last.endMinute === block.minute) {
      segments[segments.length - 1] = { ...last, endMinute: block.minute + BLOCK_MINUTES }
      continue
    }

    const node = nodeById.get(block.planNodeId)
    const projectTag = node ? palette.tags.find((tag) => tag.id === node.projectTagId) ?? null : null
    const color = categoryColorForTag(projectTag, palette, theme.warningOrange)
    segments.push({
      key: String(block.planNodeId),
      startMinute: block.minute,
      endMinute: block.minute + BLOCK_MINUTES,
      title: node?.title ?? `计划节点 #${block.planNodeId}`,
      projectPath: projectTag?.fullPath ?? '当前计划树尚未加载该项目',
      accent: color,
    })
  }

  return segments
}

function pickNextAction(attempts: readonly GoalAttempt[]): GoalAttempt | null {
  return attempts.find((attempt) => attempt.plannedMinutes > 0 && attempt.actualMinutes === 0)
    ?? attempts.find((attempt) => attempt.activeNodes.length > 0 && attempt.actualMinutes === 0)
    ?? attempts.find((attempt) => attempt.actualMinutes === 0)
    ?? attempts[0]
    ?? null
}

function boundaryForPhase(phase: ProtocolPhase): { allowed: string[]; restricted: string[] } {
  switch (phase.id) {
    case 'resilience':
      return {
        allowed: ['身体启动', '低门槛运动', '晨间整理', '必要通信'],
        restricted: ['短视频发现流', '竞品焦虑搜索', '宏大架构重开'],
      }
    case 'execution':
      return {
        allowed: ['代码审核训练', '计划块执行', '项目推进', '低刺激音乐'],
        restricted: ['无限资料搜索', '临时换方向', '情绪性刷屏'],
      }
    case 'discovery':
      return {
        allowed: ['带目的输入', 'B 站/文章采样', '语境锚点收集', '灵感记录'],
        restricted: ['无目标滑动', '连续开新坑', '把参照焦虑当结论'],
      }
    case 'recovery':
      return {
        allowed: ['整理今日证据', '回收语境', '轻量复盘', '安排明日入口'],
        restricted: ['继续开新输入', '深夜重构系统', '用焦虑证明价值'],
      }
    case 'protection':
      return {
        allowed: ['保存现场', '睡前收束', '明日安心卡', '必要消息'],
        restricted: ['高刺激内容', '临睡前计划爆炸', '继续证明自己'],
      }
  }
}

export default function MotivationDashboard({
  protocolLabel,
  isTodayProtocol,
  selectedDate,
  goals,
  activityPalette,
  activityBlocks,
  plannedBlocks,
  planNodes,
  onOpenPlanLayer,
}: Props) {
  const dateKey = toDateKey(selectedDate)
  const displayMinute = isTodayProtocol
    ? minuteOfDay(new Date())
    : inferArchiveMinute(activityBlocks, plannedBlocks)
  const activePhase = phaseForMinute(displayMinute)
  const attempts = buildGoalAttempts(goals, activityPalette, activityBlocks, plannedBlocks, planNodes)
  const schedule = buildSchedule(plannedBlocks, planNodes, activityPalette)
  const nextAction = pickNextAction(attempts)
  const boundary = boundaryForPhase(activePhase)
  const totalPlannedMinutes = plannedBlocks.length * BLOCK_MINUTES
  const totalActualMinutes = activityBlocks.length * BLOCK_MINUTES
  const goalsWithEvidence = attempts.filter((attempt) => attempt.actualMinutes > 0 || attempt.plannedMinutes > 0).length
  const subtitle = isTodayProtocol
    ? '把长期目标压成今天能执行、能记录、能复盘的行动协议'
    : '回看这一天目标如何被计划、执行、偏离或回收'

  return (
    <div style={styles.root}>
      <div style={styles.tabBar}>
        <span style={styles.tabTitle}>{protocolLabel}</span>
        <span style={styles.tabSubtitle}>{subtitle}</span>
      </div>

      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <HudFrameSkeleton />
        <CornerArt position="tl" />
        <CornerArt position="tr" />
        <CornerArt position="bl" />
        <CornerArt position="br" />

        <div style={styles.backdrop} />
        <div style={styles.scanline} />

        <main style={styles.content}>
          <section style={styles.leftColumn}>
            <ProtocolVerdict
              phase={activePhase}
              dateKey={dateKey}
              isTodayProtocol={isTodayProtocol}
              goalCount={goals.length}
              goalsWithEvidence={goalsWithEvidence}
              totalPlannedMinutes={totalPlannedMinutes}
              totalActualMinutes={totalActualMinutes}
              onOpenPlanLayer={onOpenPlanLayer}
            />
            <PhaseRail activePhase={activePhase} isTodayProtocol={isTodayProtocol} />
            <BoundaryGrid boundary={boundary} />
          </section>

          <section style={styles.centerColumn}>
            <NextAction attempt={nextAction} phase={activePhase} onOpenPlanLayer={onOpenPlanLayer} />
            <GoalAttemptPanel attempts={attempts} />
          </section>

          <section style={styles.rightColumn}>
            <SchedulePanel schedule={schedule} />
            <EvidencePanel
              attempts={attempts}
              planNodes={planNodes}
              totalPlannedMinutes={totalPlannedMinutes}
              totalActualMinutes={totalActualMinutes}
            />
          </section>
        </main>
      </div>
    </div>
  )
}

function ProtocolVerdict({
  phase,
  dateKey,
  isTodayProtocol,
  goalCount,
  goalsWithEvidence,
  totalPlannedMinutes,
  totalActualMinutes,
  onOpenPlanLayer,
}: {
  readonly phase: ProtocolPhase
  readonly dateKey: string
  readonly isTodayProtocol: boolean
  readonly goalCount: number
  readonly goalsWithEvidence: number
  readonly totalPlannedMinutes: number
  readonly totalActualMinutes: number
  readonly onOpenPlanLayer?: () => void
}) {
  const headline = isTodayProtocol
    ? '今天先让目标变成行动槽'
    : '这一天需要被解释，而不是继续管制'
  const fairyLine = goalCount > 0
    ? `我会盯住 ${goalCount} 个活跃目标：先看有没有排进昼夜表，再看有没有留下实际记录。`
    : '目标库还没有活跃目标。协议页会先退成启动台：把一个长期方向写入目标库，再把它拆成今天的行动。'

  return (
    <Panel accent={phase.accent} style={{ minHeight: 260 }}>
      <div style={styles.verdictHeader}>
        <div>
          <Kicker>{isTodayProtocol ? 'LIVE PROTOCOL' : 'ARCHIVE PROTOCOL'} · {dateKey}</Kicker>
          <h1 style={{ ...styles.protocolTitle, textShadow: `0 0 18px ${phase.accent}55` }}>
            {isTodayProtocol ? phase.label : '当日协议档案'}
          </h1>
        </div>
        <StatusPill color={isTodayProtocol ? phase.accent : theme.textMuted}>
          {isTodayProtocol ? '运行中' : '回看'}
        </StatusPill>
      </div>

      <p style={styles.verdictSentence}>{headline}</p>

      <div style={styles.fairyLine}>
        <span style={{ ...styles.fairyAvatar, background: phase.accent }}>F</span>
        <span>{fairyLine}</span>
      </div>

      <div style={styles.metricRow}>
        <Metric label="活跃目标" value={`${goalsWithEvidence}/${goalCount || 0}`} tone={phase.accent} />
        <Metric label="今日计划" value={formatDuration(totalPlannedMinutes)} tone={theme.warningOrange} />
        <Metric label="实际记录" value={formatDuration(totalActualMinutes)} tone={theme.expGreen} />
      </div>

      {onOpenPlanLayer && (
        <button type="button" onClick={onOpenPlanLayer} style={styles.primaryButton}>
          进入昼夜表计划层
        </button>
      )}
    </Panel>
  )
}

function NextAction({
  attempt,
  phase,
  onOpenPlanLayer,
}: {
  readonly attempt: GoalAttempt | null
  readonly phase: ProtocolPhase
  readonly onOpenPlanLayer?: () => void
}) {
  return (
    <Panel accent={theme.electricBlue} style={{ minHeight: 220 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>NEXT ACTION</Kicker>
          <h2 style={styles.sectionTitle}>协议下一步</h2>
        </div>
        <span style={styles.minuteChip}>NOW</span>
      </div>

      {attempt ? (
        <div style={styles.actionCard}>
          <div style={{ ...styles.actionIndex, color: attempt.accent }}>01</div>
          <div style={{ minWidth: 0 }}>
            <div style={styles.actionTitle}>{attempt.title}</div>
            <div style={styles.actionText}>{attempt.actionLabel}</div>
            <div style={styles.actionMetaRow}>
              <SmallBadge color={attempt.accent}>{attempt.statusLabel}</SmallBadge>
              <SmallBadge color={theme.warningOrange}>计划 {formatDuration(attempt.plannedMinutes)}</SmallBadge>
              <SmallBadge color={theme.expGreen}>记录 {formatDuration(attempt.actualMinutes)}</SmallBadge>
            </div>
          </div>
        </div>
      ) : (
        <div style={styles.emptyPanel}>
          还没有活跃目标。先把“减肥”“研磨审核代码”这类长期方向写入目标库，协议页才有东西可以每天盯住。
        </div>
      )}

      <div style={styles.commandStrip}>
        <span style={styles.protocolHint}>当前相位：{phase.shortLabel} · 先做能被 5 分钟格记录的动作</span>
        {onOpenPlanLayer && (
          <button type="button" onClick={onOpenPlanLayer} style={styles.secondaryButton}>
            安排到昼夜表
          </button>
        )}
      </div>
    </Panel>
  )
}

function GoalAttemptPanel({ attempts }: { readonly attempts: readonly GoalAttempt[] }) {
  return (
    <Panel accent={theme.flameTeal} style={{ flex: 1, minHeight: 300 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>GOAL ATTEMPTS</Kicker>
          <h2 style={styles.sectionTitle}>正在尝试行动的目标</h2>
        </div>
        <span style={styles.countBadge}>{attempts.length}</span>
      </div>

      {attempts.length === 0 ? (
        <div style={styles.emptyPanel}>
          协议不是“又一个 Todo 列表”。这里会显示目标如何在今天长出计划块、实际记录和复盘证据。
        </div>
      ) : (
        <div style={styles.attemptList}>
          {attempts.slice(0, 6).map((attempt) => (
            <article key={attempt.id} style={{ ...styles.attemptCard, borderColor: `${attempt.accent}66` }}>
              <div style={styles.attemptTopLine}>
                <span style={{ ...styles.signalDot, background: attempt.accent }} />
                <strong style={styles.attemptTitle}>{attempt.title}</strong>
                <SmallBadge color={attempt.accent}>{attempt.statusLabel}</SmallBadge>
              </div>
              <div style={styles.attemptAction}>{attempt.actionLabel}</div>
              <div style={styles.attemptStats}>
                <span>计划 {formatDuration(attempt.plannedMinutes)}</span>
                <span>记录 {formatDuration(attempt.actualMinutes)}</span>
                <span>节点 {attempt.activeNodes.length}</span>
              </div>
              <div style={styles.tagCloud}>
                {(attempt.tags.length > 0 ? attempt.tags : attempt.matchedTags.map((tag) => tag.leafName)).slice(0, 4).map((tag) => (
                  <span key={tag} style={styles.tagChip}>{tag}</span>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </Panel>
  )
}

function SchedulePanel({ schedule }: { readonly schedule: readonly ScheduleSegment[] }) {
  return (
    <Panel accent={theme.warningOrange} style={{ minHeight: 260 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>DAY SCHEDULE</Kicker>
          <h2 style={styles.sectionTitle}>今日计划队列</h2>
        </div>
        <span style={styles.countBadge}>{schedule.length}</span>
      </div>

      {schedule.length === 0 ? (
        <div style={styles.emptyPanel}>
          今天还没有计划块。进入昼夜表的“计划安排”层，把目标拖进 5 分钟格，协议才会开始真正运行。
        </div>
      ) : (
        <div style={styles.scheduleList}>
          {schedule.slice(0, 8).map((segment, index) => (
            <div key={`${segment.key}-${segment.startMinute}`} style={styles.scheduleItem}>
              <span style={{ ...styles.scheduleIndex, color: segment.accent }}>{String(index + 1).padStart(2, '0')}</span>
              <div style={styles.scheduleBody}>
                <div style={styles.scheduleTitle}>{segment.title}</div>
                <div style={styles.scheduleMeta}>
                  {hhmm(segment.startMinute)} - {hhmm(segment.endMinute)} · {segment.projectPath}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

function EvidencePanel({
  attempts,
  planNodes,
  totalPlannedMinutes,
  totalActualMinutes,
}: {
  readonly attempts: readonly GoalAttempt[]
  readonly planNodes: readonly PlanNode[]
  readonly totalPlannedMinutes: number
  readonly totalActualMinutes: number
}) {
  const evidence = [
    `目标证据：${attempts.filter((attempt) => attempt.actualMinutes > 0).length} 个目标今天已有实际记录。`,
    `计划证据：今日计划层已有 ${formatDuration(totalPlannedMinutes)}，实际记录层已有 ${formatDuration(totalActualMinutes)}。`,
    `拆解证据：当前计划树加载了 ${planNodes.length} 个节点，可作为今日协议的行动候选。`,
    '边界提醒：跨项目计划节点暂时只识别当前已加载计划树，后续需要后端提供全局协议快照接口。',
  ]

  return (
    <Panel accent={theme.shadowPurple} style={{ flex: 1, minHeight: 260 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>EVIDENCE STREAM</Kicker>
          <h2 style={styles.sectionTitle}>Fairy 判定依据</h2>
        </div>
      </div>
      <div style={styles.evidenceList}>
        {evidence.map((item, index) => (
          <div key={item} style={styles.evidenceItem}>
            <span style={styles.evidenceIndex}>{String(index + 1).padStart(2, '0')}</span>
            <span>{item}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function PhaseRail({
  activePhase,
  isTodayProtocol,
}: {
  readonly activePhase: ProtocolPhase
  readonly isTodayProtocol: boolean
}) {
  return (
    <Panel accent={theme.hudFrame} style={{ minHeight: 132 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>DAY PHASE</Kicker>
          <h2 style={styles.sectionTitle}>{isTodayProtocol ? '日内协议轨道' : '当日协议回放锚点'}</h2>
        </div>
      </div>
      <div style={styles.phaseRail}>
        {phases.map((phase) => {
          const active = phase.id === activePhase.id
          return (
            <div key={phase.id} style={styles.phaseCell}>
              <div style={{
                ...styles.phaseDot,
                borderColor: phase.accent,
                background: active ? `${phase.accent}44` : 'rgba(0,0,0,0.35)',
                boxShadow: active ? `0 0 18px ${phase.accent}88` : 'none',
              }} />
              <span style={{ ...styles.phaseLabel, color: active ? phase.accent : theme.textMuted }}>
                {phase.shortLabel}
              </span>
              <span style={styles.phaseTime}>{phase.range}</span>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

function BoundaryGrid({ boundary }: { readonly boundary: { allowed: string[]; restricted: string[] } }) {
  return (
    <Panel accent={theme.dangerRed} style={{ flex: 1, minHeight: 220 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>BOUNDARY</Kicker>
          <h2 style={styles.sectionTitle}>当前允许 / 限制</h2>
        </div>
      </div>
      <div style={styles.boundaryGrid}>
        <BoundaryBlock title="允许" tone={theme.expGreen} items={boundary.allowed} />
        <BoundaryBlock title="限制" tone={theme.dangerRed} items={boundary.restricted} />
      </div>
    </Panel>
  )
}

function BoundaryBlock({ title, tone, items }: {
  readonly title: string
  readonly tone: string
  readonly items: readonly string[]
}) {
  return (
    <div style={{ ...styles.boundaryBlock, borderColor: `${tone}66` }}>
      <div style={{ ...styles.boundaryTitle, color: tone }}>{title}</div>
      {items.map((item) => (
        <div key={item} style={styles.boundaryItem}>
          <span style={{ ...styles.smallMark, background: tone }} />
          <span>{item}</span>
        </div>
      ))}
    </div>
  )
}

function Panel({ accent, children, style }: {
  readonly accent: string
  readonly children: ReactNode
  readonly style?: CSSProperties
}) {
  return (
    <div style={{
      ...styles.panel,
      borderColor: `${accent}66`,
      boxShadow: `inset 0 0 28px ${accent}10, 0 0 24px ${accent}08`,
      ...style,
    }}>
      <span style={{ ...styles.panelNotch, background: accent }} />
      {children}
    </div>
  )
}

function Kicker({ children }: { readonly children: ReactNode }) {
  return <div style={styles.kicker}>{children}</div>
}

function StatusPill({ children, color }: { readonly children: ReactNode; readonly color: string }) {
  return (
    <span style={{
      ...styles.statusPill,
      color,
      borderColor: `${color}88`,
      background: `${color}12`,
    }}>
      {children}
    </span>
  )
}

function SmallBadge({ children, color }: { readonly children: ReactNode; readonly color: string }) {
  return (
    <span style={{
      ...styles.smallBadge,
      color,
      borderColor: `${color}66`,
      background: `${color}10`,
    }}>
      {children}
    </span>
  )
}

function Metric({ label, value, tone }: {
  readonly label: string
  readonly value: string
  readonly tone: string
}) {
  return (
    <div style={styles.metric}>
      <span style={styles.metricLabel}>{label}</span>
      <span style={{ ...styles.metricValue, color: tone }}>{value}</span>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: theme.background,
    position: 'relative',
    paddingLeft: FRAME_LEFT_PAD,
    fontFamily: theme.fontBody,
    color: theme.textPrimary,
    overflow: 'hidden',
  },
  tabBar: {
    height: TABS_HEIGHT,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'flex-end',
    paddingLeft: 12,
    paddingBottom: 4,
    gap: 10,
  },
  tabTitle: {
    fontFamily: theme.fontBody,
    fontSize: 12,
    fontWeight: 700,
    color: theme.textPrimary,
    letterSpacing: 0.6,
    paddingLeft: 12,
  },
  tabSubtitle: {
    fontSize: 11,
    color: theme.textMuted,
  },
  backdrop: {
    position: 'absolute',
    inset: 0,
    background: `
      radial-gradient(circle at 18% 22%, rgba(0,255,153,0.10), transparent 30%),
      radial-gradient(circle at 78% 12%, rgba(0,229,255,0.11), transparent 26%),
      radial-gradient(circle at 82% 82%, rgba(255,153,51,0.12), transparent 34%),
      ${hud.grid},
      linear-gradient(180deg, rgba(2,8,18,0.72), rgba(0,0,0,0.92))
    `,
    pointerEvents: 'none',
  },
  scanline: {
    position: 'absolute',
    inset: 0,
    background: hud.scanlines,
    opacity: 0.5,
    pointerEvents: 'none',
    mixBlendMode: 'screen',
  },
  content: {
    position: 'absolute',
    inset: 0,
    padding: '26px 30px 30px',
    display: 'grid',
    gridTemplateColumns: '1.02fr 1.34fr 0.94fr',
    gap: 18,
    overflow: 'auto',
  },
  leftColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    minWidth: 0,
  },
  centerColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    minWidth: 0,
  },
  rightColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    minWidth: 0,
  },
  panel: {
    position: 'relative',
    padding: 18,
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'linear-gradient(180deg, rgba(4,10,26,0.74), rgba(1,5,12,0.84))',
    clipPath: hud.chamfer12,
    overflow: 'hidden',
  },
  panelNotch: {
    position: 'absolute',
    left: 16,
    top: 0,
    width: 56,
    height: 2,
    opacity: 0.9,
    boxShadow: '0 0 12px currentColor',
  },
  verdictHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 14,
    marginBottom: 16,
  },
  kicker: {
    fontFamily: theme.fontMono,
    fontSize: 10,
    letterSpacing: 2,
    color: theme.textMuted,
    marginBottom: 6,
  },
  protocolTitle: {
    margin: 0,
    fontFamily: theme.fontDisplay,
    fontSize: 32,
    lineHeight: 1,
    letterSpacing: 2,
    color: theme.textPrimary,
  },
  statusPill: {
    flexShrink: 0,
    padding: '4px 9px',
    border: '1px solid',
    fontFamily: theme.fontMono,
    fontSize: 11,
    letterSpacing: 1,
    clipPath: hud.chamfer8,
  },
  verdictSentence: {
    margin: 0,
    fontSize: 18,
    lineHeight: 1.65,
    fontWeight: 800,
    color: theme.textPrimary,
  },
  fairyLine: {
    marginTop: 18,
    display: 'flex',
    gap: 10,
    fontSize: 12.5,
    lineHeight: 1.65,
    color: theme.textSecondary,
    padding: 12,
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'rgba(0,229,255,0.035)',
    clipPath: hud.chamfer8,
  },
  fairyAvatar: {
    width: 22,
    height: 22,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    color: theme.background,
    fontFamily: theme.fontMono,
    fontWeight: 900,
    fontSize: 12,
  },
  metricRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8,
    marginTop: 18,
  },
  metric: {
    border: `1px solid ${theme.hudFrameSoft}`,
    padding: '9px 10px',
    background: 'rgba(0,0,0,0.28)',
  },
  metricLabel: {
    display: 'block',
    fontSize: 10,
    color: theme.textMuted,
    marginBottom: 5,
  },
  metricValue: {
    display: 'block',
    fontFamily: theme.fontMono,
    fontSize: 15,
    fontWeight: 900,
  },
  primaryButton: {
    width: '100%',
    marginTop: 14,
    height: 34,
    border: `1px solid ${theme.warningOrange}`,
    background: `${theme.warningOrange}22`,
    color: theme.warningOrange,
    fontFamily: theme.fontBody,
    fontWeight: 900,
    letterSpacing: 0.6,
    cursor: 'pointer',
    clipPath: hud.chamfer8,
  },
  secondaryButton: {
    height: 28,
    padding: '0 11px',
    border: `1px solid ${theme.electricBlue}88`,
    background: `${theme.electricBlue}12`,
    color: theme.electricBlue,
    fontFamily: theme.fontBody,
    fontSize: 12,
    fontWeight: 800,
    cursor: 'pointer',
    clipPath: hud.chamfer8,
  },
  panelTitleRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 14,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 16,
    letterSpacing: 0.4,
    color: theme.textPrimary,
  },
  minuteChip: {
    fontFamily: theme.fontMono,
    fontSize: 20,
    fontWeight: 900,
    color: theme.electricBlue,
    textShadow: `0 0 12px ${theme.electricBlue}66`,
  },
  countBadge: {
    minWidth: 28,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1px solid ${theme.hudFrameSoft}`,
    color: theme.textSecondary,
    fontFamily: theme.fontMono,
    fontSize: 12,
    fontWeight: 900,
    background: 'rgba(0,0,0,0.28)',
  },
  actionCard: {
    display: 'flex',
    gap: 14,
    padding: 16,
    border: `1px solid ${theme.electricBlue}55`,
    background: 'rgba(0,229,255,0.055)',
    clipPath: hud.chamfer8,
  },
  actionIndex: {
    fontFamily: theme.fontMono,
    fontSize: 28,
    fontWeight: 900,
    lineHeight: 1,
    opacity: 0.88,
  },
  actionTitle: {
    fontSize: 18,
    fontWeight: 900,
    color: theme.textPrimary,
    marginBottom: 8,
  },
  actionText: {
    fontSize: 12.5,
    color: theme.textSecondary,
    lineHeight: 1.65,
  },
  actionMetaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 11,
  },
  smallBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 20,
    padding: '0 7px',
    border: '1px solid',
    fontFamily: theme.fontMono,
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: 0.5,
    clipPath: hud.chamfer8,
  },
  commandStrip: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 14,
    flexWrap: 'wrap',
  },
  protocolHint: {
    fontSize: 12,
    color: theme.textMuted,
  },
  attemptList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  attemptCard: {
    border: '1px solid',
    background: 'rgba(0,0,0,0.22)',
    padding: 12,
    clipPath: hud.chamfer8,
  },
  attemptTopLine: {
    display: 'grid',
    gridTemplateColumns: '12px 1fr auto',
    alignItems: 'center',
    gap: 8,
  },
  signalDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    boxShadow: '0 0 12px currentColor',
  },
  attemptTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 14,
    color: theme.textPrimary,
  },
  attemptAction: {
    marginTop: 8,
    color: theme.textSecondary,
    fontSize: 12.5,
    lineHeight: 1.55,
  },
  attemptStats: {
    display: 'flex',
    gap: 12,
    marginTop: 9,
    color: theme.textMuted,
    fontFamily: theme.fontMono,
    fontSize: 10,
  },
  tagCloud: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 9,
  },
  tagChip: {
    maxWidth: 110,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    border: `1px solid ${theme.hudFrameSoft}`,
    color: theme.textMuted,
    background: 'rgba(255,255,255,0.025)',
    padding: '2px 6px',
    fontSize: 10,
  },
  scheduleList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  scheduleItem: {
    display: 'grid',
    gridTemplateColumns: '34px 1fr',
    gap: 10,
    alignItems: 'center',
    borderBottom: `1px solid ${theme.hudFrameSoft}`,
    paddingBottom: 9,
  },
  scheduleIndex: {
    fontFamily: theme.fontMono,
    fontSize: 13,
    fontWeight: 900,
  },
  scheduleBody: {
    minWidth: 0,
  },
  scheduleTitle: {
    fontSize: 13,
    fontWeight: 800,
    color: theme.textPrimary,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  scheduleMeta: {
    marginTop: 4,
    fontSize: 10,
    color: theme.textMuted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  evidenceList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  evidenceItem: {
    display: 'grid',
    gridTemplateColumns: '42px 1fr',
    gap: 12,
    alignItems: 'baseline',
    fontSize: 12.5,
    lineHeight: 1.6,
    color: theme.textSecondary,
    padding: '9px 0',
    borderBottom: `1px solid ${theme.hudFrameSoft}`,
  },
  evidenceIndex: {
    fontFamily: theme.fontMono,
    color: theme.flameTeal,
    letterSpacing: 1.2,
  },
  phaseRail: {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: 8,
  },
  phaseCell: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
  },
  phaseDot: {
    width: 18,
    height: 18,
    border: '1px solid',
    borderRadius: '50%',
  },
  phaseLabel: {
    fontSize: 12,
    fontWeight: 900,
  },
  phaseTime: {
    fontFamily: theme.fontMono,
    fontSize: 10,
    color: theme.textMuted,
  },
  boundaryGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 10,
  },
  boundaryBlock: {
    border: '1px solid',
    padding: 12,
    background: 'rgba(0,0,0,0.22)',
    minWidth: 0,
  },
  boundaryTitle: {
    fontFamily: theme.fontMono,
    fontSize: 12,
    fontWeight: 900,
    marginBottom: 10,
    letterSpacing: 1,
  },
  boundaryItem: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 7,
    fontSize: 12,
    lineHeight: 1.55,
    color: theme.textSecondary,
    marginBottom: 7,
  },
  smallMark: {
    width: 5,
    height: 5,
    borderRadius: '50%',
    flexShrink: 0,
  },
  emptyPanel: {
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'rgba(0,0,0,0.22)',
    color: theme.textMuted,
    fontSize: 12.5,
    lineHeight: 1.65,
    padding: 14,
    clipPath: hud.chamfer8,
  },
}
