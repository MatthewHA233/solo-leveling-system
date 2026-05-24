// ══════════════════════════════════════════════
// MotivationDashboard — 今日/当日协议面板
//
//   文件名暂时沿用旧的 MotivationDashboard，避免牵动 App 的视图枚举。
//   可见语义已经切换为「Fairy 生成的当前协议简报」：
//   不再展示一组动机卡，而是展示裁决、证据、边界、下一步和可回收记忆。
// ══════════════════════════════════════════════

import type { CSSProperties, ReactNode } from 'react'
import { hud, theme } from '../theme'
import { HudFrameSkeleton, CornerArt } from './hud'

const TABS_HEIGHT = 30
const FRAME_LEFT_PAD = 24

interface Props {
  readonly protocolLabel: string
  readonly isTodayProtocol: boolean
}

type ProtocolKind = 'resilience' | 'execution' | 'discovery' | 'recovery' | 'protection'

interface ProtocolPhase {
  readonly id: ProtocolKind
  readonly label: string
  readonly range: string
  readonly accent: string
  readonly active: boolean
}

const phases: readonly ProtocolPhase[] = [
  { id: 'resilience', label: '韧性', range: '07:00', accent: theme.expGreen, active: false },
  { id: 'execution', label: '执行', range: '10:00', accent: theme.electricBlue, active: false },
  { id: 'discovery', label: '发现', range: '15:00', accent: '#f1c40f', active: false },
  { id: 'recovery', label: '回收', range: '21:00', accent: theme.warningOrange, active: true },
  { id: 'protection', label: '保护', range: '23:30', accent: theme.dangerRed, active: false },
]

const evidenceItems = [
  '最近对项目有回避感，说明任务入口已经变得过重。',
  'EverMind / EverMe 触发了参照焦虑，但也提供了主体性记忆的清晰样本。',
  '今天开始重新切前端，说明行动窗口还在，但需要降低启动成本。',
  '今晚已经接近休息时段，继续扩展设计会让明天更难回来。',
]

const memoryBubbles = [
  { title: 'EverMind FAQ', type: '外部认知源', accent: '#f1c40f' },
  { title: '主体性记忆', type: '核心概念', accent: theme.flameTeal },
  { title: '回避项目', type: '状态样本', accent: theme.warningOrange },
  { title: '今日协议 UI', type: '界面锚点', accent: theme.electricBlue },
]

const actionQueue = [
  { label: '洗澡', note: '身体先退出项目状态', done: false },
  { label: '停止竞品搜索', note: '今晚不再打开 EverMind / 招聘 / 投资页', done: false },
  { label: '睡前留一句话', note: '明天回来只看“下一步”，不重新翻全部文档', done: false },
]

export default function MotivationDashboard({ protocolLabel, isTodayProtocol }: Props) {
  const subtitle = isTodayProtocol
    ? 'Fairy 正在把今天压缩成一个可执行协议'
    : '回看这一天 Fairy 当时如何判断、限制和回收'

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: theme.background,
      position: 'relative',
      paddingLeft: FRAME_LEFT_PAD,
      fontFamily: theme.fontBody,
      color: theme.textPrimary,
      overflow: 'hidden',
    }}>
      <div style={{
        height: TABS_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'flex-end',
        paddingLeft: 12,
        paddingBottom: 4,
        gap: 10,
      }}>
        <span style={{
          fontFamily: theme.fontBody,
          fontSize: 12,
          fontWeight: 700,
          color: theme.textPrimary,
          letterSpacing: 0.6,
          paddingLeft: 12,
        }}>
          {protocolLabel}
        </span>
        <span style={{ fontSize: 11, color: theme.textMuted }}>
          {subtitle}
        </span>
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
            <ProtocolVerdict isTodayProtocol={isTodayProtocol} />
            <PhaseRail />
            <BoundaryGrid />
          </section>

          <section style={styles.centerColumn}>
            <NextAction />
            <EvidenceStream />
          </section>

          <section style={styles.rightColumn}>
            <NightQueue />
            <MemoryBubbles />
          </section>
        </main>
      </div>
    </div>
  )
}

function ProtocolVerdict({ isTodayProtocol }: { readonly isTodayProtocol: boolean }) {
  return (
    <Panel accent={theme.warningOrange} style={{ minHeight: 260 }}>
      <div style={styles.verdictHeader}>
        <div>
          <Kicker>FAIRY VERDICT</Kicker>
          <h1 style={styles.protocolTitle}>
            {isTodayProtocol ? '回收协议' : '当日回放'}
          </h1>
        </div>
        <StatusPill tone="warn">收束中</StatusPill>
      </div>

      <p style={styles.verdictSentence}>
        今晚不再扩大项目范围。你已经完成了重新靠近项目的动作，现在最重要的是把系统压力降下来，让明天还能继续回来。
      </p>

      <div style={styles.fairyLine}>
        <span style={styles.fairyAvatar}>F</span>
        <span>
          我不会要求你今晚解决“整个产品”。我只保留一条明天能接上的线：今日协议界面先成为一个温柔但明确的收束台。
        </span>
      </div>

      <div style={styles.metricRow}>
        <Metric label="启动成本" value="降低" tone={theme.expGreen} />
        <Metric label="认知负载" value="偏高" tone={theme.warningOrange} />
        <Metric label="继续探索" value="冻结" tone={theme.dangerRed} />
      </div>
    </Panel>
  )
}

function NextAction() {
  return (
    <Panel accent={theme.electricBlue} style={{ minHeight: 210 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>NEXT ACTION</Kicker>
          <h2 style={styles.sectionTitle}>下一步只剩一件事</h2>
        </div>
        <span style={styles.minuteChip}>15 MIN</span>
      </div>

      <div style={styles.actionCard}>
        <div style={styles.actionIndex}>01</div>
        <div style={{ minWidth: 0 }}>
          <div style={styles.actionTitle}>洗澡，然后结束今晚的项目线程</div>
          <div style={styles.actionText}>
            不再继续查竞品、不再继续扩写架构、不再打开新的资料页。今天的成果是“回到前端设计”，不是“证明自己配得上”。
          </div>
        </div>
      </div>

      <div style={styles.commandStrip}>
        <CommandButton label="接受协议" active />
        <CommandButton label="推迟 10 分钟" />
        <CommandButton label="明日继续" />
      </div>
    </Panel>
  )
}

function EvidenceStream() {
  return (
    <Panel accent={theme.flameTeal} style={{ flex: 1, minHeight: 250 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>EVIDENCE STREAM</Kicker>
          <h2 style={styles.sectionTitle}>Fairy 为什么这样判定</h2>
        </div>
      </div>

      <div style={styles.evidenceList}>
        {evidenceItems.map((item, index) => (
          <div key={item} style={styles.evidenceItem}>
            <span style={styles.evidenceIndex}>{String(index + 1).padStart(2, '0')}</span>
            <span>{item}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function PhaseRail() {
  return (
    <Panel accent={theme.hudFrame} style={{ minHeight: 126 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>DAY PHASE</Kicker>
          <h2 style={styles.sectionTitle}>日内协议轨道</h2>
        </div>
      </div>
      <div style={styles.phaseRail}>
        {phases.map((phase) => (
          <div key={phase.id} style={styles.phaseCell}>
            <div style={{
              ...styles.phaseDot,
              borderColor: phase.accent,
              background: phase.active ? `${phase.accent}44` : 'rgba(0,0,0,0.35)',
              boxShadow: phase.active ? `0 0 18px ${phase.accent}88` : 'none',
            }} />
            <span style={{ ...styles.phaseLabel, color: phase.active ? phase.accent : theme.textMuted }}>
              {phase.label}
            </span>
            <span style={styles.phaseTime}>{phase.range}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function BoundaryGrid() {
  return (
    <Panel accent={theme.dangerRed} style={{ flex: 1, minHeight: 210 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>BOUNDARY</Kicker>
          <h2 style={styles.sectionTitle}>今晚允许 / 限制</h2>
        </div>
      </div>
      <div style={styles.boundaryGrid}>
        <BoundaryBlock title="允许" tone={theme.expGreen} items={['保存当前界面进度', '洗澡', '睡前留一句明日入口']} />
        <BoundaryBlock title="限制" tone={theme.dangerRed} items={['继续搜竞品', '翻招聘要求', '重开宏大架构设计']} />
      </div>
    </Panel>
  )
}

function NightQueue() {
  return (
    <Panel accent={theme.warningOrange} style={{ minHeight: 260 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>CLOSE SEQUENCE</Kicker>
          <h2 style={styles.sectionTitle}>晚间收束队列</h2>
        </div>
      </div>
      <div style={styles.queueList}>
        {actionQueue.map((item, index) => (
          <div key={item.label} style={styles.queueItem}>
            <span style={styles.checkBox}>{item.done ? '✓' : ''}</span>
            <div>
              <div style={styles.queueTitle}>{String(index + 1).padStart(2, '0')} · {item.label}</div>
              <div style={styles.queueNote}>{item.note}</div>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function MemoryBubbles() {
  return (
    <Panel accent={theme.shadowPurple} style={{ flex: 1, minHeight: 250 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>CONTEXT BUBBLES</Kicker>
          <h2 style={styles.sectionTitle}>可回收语境</h2>
        </div>
      </div>
      <div style={styles.bubbleField}>
        {memoryBubbles.map((bubble, index) => (
          <div
            key={bubble.title}
            style={{
              ...styles.memoryBubble,
              marginLeft: index % 2 === 0 ? 0 : 26,
              borderColor: `${bubble.accent}88`,
              boxShadow: `0 0 22px ${bubble.accent}22, inset 0 0 18px ${bubble.accent}12`,
            }}
          >
            <span style={{ ...styles.bubbleOrb, background: bubble.accent }} />
            <div>
              <div style={styles.bubbleTitle}>{bubble.title}</div>
              <div style={styles.bubbleType}>{bubble.type}</div>
            </div>
          </div>
        ))}
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

function StatusPill({ children, tone }: { readonly children: ReactNode; readonly tone: 'warn' | 'safe' }) {
  const color = tone === 'warn' ? theme.warningOrange : theme.expGreen
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

function CommandButton({ label, active = false }: { readonly label: string; readonly active?: boolean }) {
  return (
    <button type="button" style={{
      ...styles.commandButton,
      color: active ? theme.background : theme.textSecondary,
      background: active ? theme.textPrimary : 'transparent',
      borderColor: active ? theme.textPrimary : theme.hudFrameSoft,
    }}>
      {label}
    </button>
  )
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: 'absolute',
    inset: 0,
    background: `
      radial-gradient(circle at 18% 22%, rgba(255,153,51,0.13), transparent 30%),
      radial-gradient(circle at 78% 12%, rgba(0,229,255,0.10), transparent 26%),
      radial-gradient(circle at 82% 82%, rgba(112,0,255,0.14), transparent 34%),
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
    gridTemplateColumns: '1.02fr 1.36fr 0.92fr',
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
    fontSize: 34,
    lineHeight: 1,
    letterSpacing: 2,
    color: theme.textPrimary,
    textShadow: `0 0 18px ${theme.warningOrange}44`,
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
    lineHeight: 1.7,
    fontWeight: 700,
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
    background: theme.textPrimary,
    color: theme.background,
    fontFamily: theme.fontMono,
    fontWeight: 800,
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
    fontWeight: 800,
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
    fontWeight: 800,
    color: theme.electricBlue,
    textShadow: `0 0 12px ${theme.electricBlue}66`,
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
    color: theme.electricBlue,
    opacity: 0.8,
  },
  actionTitle: {
    fontSize: 18,
    fontWeight: 800,
    color: theme.textPrimary,
    marginBottom: 8,
  },
  actionText: {
    fontSize: 12.5,
    color: theme.textSecondary,
    lineHeight: 1.65,
  },
  commandStrip: {
    display: 'flex',
    gap: 8,
    marginTop: 14,
    flexWrap: 'wrap',
  },
  commandButton: {
    height: 30,
    padding: '0 12px',
    border: '1px solid',
    fontFamily: theme.fontBody,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.4,
    cursor: 'default',
    clipPath: hud.chamfer8,
  },
  evidenceList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  evidenceItem: {
    display: 'grid',
    gridTemplateColumns: '42px 1fr',
    gap: 12,
    alignItems: 'baseline',
    fontSize: 12.5,
    lineHeight: 1.6,
    color: theme.textSecondary,
    padding: '10px 0',
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
    fontWeight: 800,
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
    fontWeight: 800,
    marginBottom: 10,
    letterSpacing: 1,
  },
  boundaryItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    fontSize: 11.5,
    lineHeight: 1.45,
    color: theme.textSecondary,
    marginTop: 7,
  },
  smallMark: {
    width: 5,
    height: 5,
    flexShrink: 0,
  },
  queueList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  queueItem: {
    display: 'grid',
    gridTemplateColumns: '24px 1fr',
    gap: 10,
    alignItems: 'start',
    paddingBottom: 12,
    borderBottom: `1px solid ${theme.hudFrameSoft}`,
  },
  checkBox: {
    width: 18,
    height: 18,
    border: `1px solid ${theme.warningOrange}88`,
    color: theme.warningOrange,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
  },
  queueTitle: {
    fontFamily: theme.fontMono,
    fontSize: 12,
    fontWeight: 800,
    color: theme.textPrimary,
    letterSpacing: 0.4,
  },
  queueNote: {
    marginTop: 4,
    fontSize: 11.5,
    lineHeight: 1.5,
    color: theme.textMuted,
  },
  bubbleField: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  memoryBubble: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: 'calc(100% - 26px)',
    border: '1px solid',
    padding: '10px 12px',
    borderRadius: 999,
    background: 'rgba(0,0,0,0.26)',
  },
  bubbleOrb: {
    width: 15,
    height: 15,
    borderRadius: '50%',
    flexShrink: 0,
    boxShadow: '0 0 14px currentColor',
  },
  bubbleTitle: {
    fontSize: 12.5,
    fontWeight: 800,
    color: theme.textPrimary,
  },
  bubbleType: {
    marginTop: 2,
    fontFamily: theme.fontMono,
    fontSize: 10,
    color: theme.textMuted,
    letterSpacing: 0.8,
  },
}
