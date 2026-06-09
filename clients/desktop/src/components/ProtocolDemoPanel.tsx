// ══════════════════════════════════════════════
// ProtocolDemoPanel — 今日协议早期静态示范
//   还原 db3015b 附近的 Fairy 简报台方向：
//   verdict / evidence / boundary / memory bubbles。
//   作为“协议志(静态示范)”长期保留，不接真实数据。
// ══════════════════════════════════════════════

import type { CSSProperties, ReactNode } from 'react'
import { hud, theme } from '../theme'
import { CornerArt, HudFrameSkeleton } from './hud'

const phases: ReadonlyArray<{ label: string; time: string; accent: string; active?: boolean }> = [
  { label: '韧性', time: '07:00', accent: theme.expGreen },
  { label: '执行', time: '10:00', accent: theme.electricBlue },
  { label: '发现', time: '15:00', accent: '#f1c40f' },
  { label: '回收', time: '21:00', accent: theme.warningOrange, active: true },
  { label: '保护', time: '23:30', accent: theme.dangerRed },
] as const

const evidenceItems = [
  '最近对项目有回避感，说明任务入口已经变得过重。',
  '外部竞品触发了参照焦虑，但也提供了主体性记忆的清晰样本。',
  '重新回到前端设计，说明行动窗口还在，但需要降低启动成本。',
  '夜间继续扩展设计会消耗明天回来的能力，所以协议应主动收束。',
] as const

const actionQueue = [
  { label: '洗澡', note: '身体先退出项目状态' },
  { label: '停止竞品搜索', note: '今晚不再打开招聘、投资、竞品页面' },
  { label: '睡前留一句话', note: '明天回来只看下一步，不重新翻全部文档' },
] as const

const memoryBubbles = [
  { title: '主体性记忆', type: '核心概念', accent: theme.flameTeal },
  { title: 'EverMind FAQ', type: '外部认知源', accent: '#f1c40f' },
  { title: '项目回避感', type: '状态样本', accent: theme.warningOrange },
  { title: '今日协议 UI', type: '界面锚点', accent: theme.electricBlue },
] as const

export default function ProtocolDemoPanel() {
  return (
    <div style={styles.root}>
      <div style={styles.tabStrip}>
        <span style={styles.tabTitle}>协议志 · 静态示范</span>
        <span style={styles.tabMeta}>早期 Fairy 简报台方向，保留为设计参照</span>
      </div>

      <div style={styles.stage}>
        <HudFrameSkeleton />
        <CornerArt position="tl" />
        <CornerArt position="tr" />
        <CornerArt position="bl" />
        <CornerArt position="br" />
        <div style={styles.backdrop} />
        <div style={styles.scanline} />

        <main style={styles.content}>
          <section style={styles.leftColumn}>
            <VerdictPanel />
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

function VerdictPanel() {
  return (
    <Panel accent={theme.warningOrange} style={{ minHeight: 256 }}>
      <div style={styles.verdictHeader}>
        <div>
          <Kicker>FAIRY VERDICT</Kicker>
          <h1 style={styles.protocolTitle}>回收协议</h1>
        </div>
        <StatusPill tone={theme.warningOrange}>收束中</StatusPill>
      </div>

      <p style={styles.verdictSentence}>
        今晚不再扩大项目范围。你已经完成了重新靠近项目的动作，现在最重要的是把系统压力降下来，让明天还能继续回来。
      </p>

      <div style={styles.fairyLine}>
        <span style={styles.fairyAvatar}>F</span>
        <span>
          我不会要求你今晚解决整个产品。我只保留一条明天能接上的线：协议页先成为一个温柔但明确的收束台。
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
    <Panel accent={theme.electricBlue} style={{ minHeight: 214 }}>
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
            不继续查竞品，不重开宏大架构，也不把焦虑当作必须继续工作的证据。今天的成果是“回到项目”，不是“证明自己配得上”。
          </div>
        </div>
      </div>

      <div style={styles.commandStrip}>
        <CommandButton active>接受协议</CommandButton>
        <CommandButton>推迟 10 分钟</CommandButton>
        <CommandButton>明日继续</CommandButton>
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
          <div key={phase.label} style={styles.phaseCell}>
            <div style={{
              ...styles.phaseDot,
              borderColor: phase.accent,
              background: phase.active ? `${phase.accent}44` : 'rgba(0,0,0,0.35)',
              boxShadow: phase.active ? `0 0 18px ${phase.accent}88` : 'none',
            }} />
            <span style={{ ...styles.phaseLabel, color: phase.active ? phase.accent : theme.textMuted }}>
              {phase.label}
            </span>
            <span style={styles.phaseTime}>{phase.time}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function EvidenceStream() {
  return (
    <Panel accent={theme.flameTeal} style={{ flex: 1, minHeight: 244 }}>
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

function BoundaryGrid() {
  return (
    <Panel accent={theme.dangerRed} style={{ flex: 1, minHeight: 204 }}>
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
    <Panel accent={theme.warningOrange} style={{ minHeight: 250 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>NIGHT QUEUE</Kicker>
          <h2 style={styles.sectionTitle}>睡前队列</h2>
        </div>
      </div>
      <div style={styles.queueList}>
        {actionQueue.map((item, index) => (
          <div key={item.label} style={styles.queueItem}>
            <span style={styles.queueIndex}>{String(index + 1).padStart(2, '0')}</span>
            <div>
              <div style={styles.queueTitle}>{item.label}</div>
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
    <Panel accent={theme.electricBlue} style={{ flex: 1, minHeight: 218 }}>
      <div style={styles.panelTitleRow}>
        <div>
          <Kicker>MEMORY BUBBLES</Kicker>
          <h2 style={styles.sectionTitle}>可回收的记忆泡</h2>
        </div>
      </div>
      <div style={styles.bubbleGrid}>
        {memoryBubbles.map((bubble) => (
          <div key={bubble.title} style={{
            ...styles.memoryBubble,
            borderColor: `${bubble.accent}88`,
            boxShadow: `0 0 16px ${bubble.accent}18`,
          }}>
            <div style={{ ...styles.bubbleOrb, background: bubble.accent }} />
            <div style={styles.bubbleTitle}>{bubble.title}</div>
            <div style={styles.bubbleType}>{bubble.type}</div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function Panel({ accent, style, children }: {
  readonly accent: string
  readonly style?: CSSProperties
  readonly children: ReactNode
}) {
  return (
    <section style={{
      ...styles.panel,
      borderColor: `${accent}66`,
      boxShadow: `inset 0 0 0 1px ${accent}18, 0 0 22px ${accent}10`,
      ...style,
    }}>
      <div style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 2,
        background: accent,
        boxShadow: `0 0 12px ${accent}`,
      }} />
      {children}
    </section>
  )
}

function Kicker({ children }: { readonly children: ReactNode }) {
  return <div style={styles.kicker}>{children}</div>
}

function StatusPill({ children, tone }: { readonly children: ReactNode; readonly tone: string }) {
  return (
    <span style={{
      ...styles.statusPill,
      color: tone,
      borderColor: `${tone}88`,
      background: `${tone}18`,
    }}>
      {children}
    </span>
  )
}

function Metric({ label, value, tone }: { readonly label: string; readonly value: string; readonly tone: string }) {
  return (
    <div style={styles.metric}>
      <span style={styles.metricLabel}>{label}</span>
      <span style={{ ...styles.metricValue, color: tone }}>{value}</span>
    </div>
  )
}

function CommandButton({ active, children }: { readonly active?: boolean; readonly children: ReactNode }) {
  return (
    <button style={{
      ...styles.commandButton,
      color: active ? theme.background : theme.textSecondary,
      background: active ? theme.electricBlue : 'rgba(255,255,255,0.025)',
      borderColor: active ? theme.electricBlue : theme.glassBorder,
      boxShadow: active ? `0 0 14px ${theme.electricBlue}55` : 'none',
    }}>
      {children}
    </button>
  )
}

function BoundaryBlock({ title, tone, items }: {
  readonly title: string
  readonly tone: string
  readonly items: readonly string[]
}) {
  return (
    <div style={{ ...styles.boundaryBlock, borderColor: `${tone}55` }}>
      <div style={{ ...styles.boundaryTitle, color: tone }}>{title}</div>
      {items.map((item) => (
        <div key={item} style={styles.boundaryItem}>
          <span style={{ color: tone }}>◆</span>
          <span>{item}</span>
        </div>
      ))}
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
    paddingLeft: 24,
    fontFamily: theme.fontBody,
    color: theme.textPrimary,
    overflow: 'hidden',
  },
  tabStrip: {
    height: 30,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'flex-end',
    gap: 10,
    paddingLeft: 12,
    paddingBottom: 4,
  },
  tabTitle: {
    fontSize: 12,
    fontWeight: 800,
    color: theme.textPrimary,
    letterSpacing: 0.6,
    paddingLeft: 12,
  },
  tabMeta: {
    fontSize: 11,
    color: theme.textMuted,
  },
  stage: {
    flex: 1,
    position: 'relative',
    minHeight: 0,
  },
  backdrop: {
    position: 'absolute',
    inset: 0,
    background: hud.backdrop,
    pointerEvents: 'none',
  },
  scanline: {
    position: 'absolute',
    inset: 0,
    background: hud.scanlines,
    opacity: 0.04,
    pointerEvents: 'none',
  },
  content: {
    position: 'absolute',
    inset: '18px 18px 18px 18px',
    display: 'grid',
    gridTemplateColumns: '1.08fr 1.14fr 0.88fr',
    gap: 14,
    minHeight: 0,
  },
  leftColumn: {
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  centerColumn: {
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  rightColumn: {
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  panel: {
    position: 'relative',
    overflow: 'hidden',
    padding: '14px 16px',
    border: `1px solid ${theme.glassBorder}`,
    background: 'linear-gradient(180deg, rgba(3,11,24,0.78), rgba(0,0,0,0.42))',
    clipPath: hud.chamfer12,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  kicker: {
    fontFamily: theme.fontMono,
    color: theme.textMuted,
    fontSize: 10,
    letterSpacing: '0.22em',
    fontWeight: 800,
  },
  verdictHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  protocolTitle: {
    margin: '4px 0 0',
    fontSize: 30,
    lineHeight: 1,
    letterSpacing: '0.08em',
    color: theme.textPrimary,
    textShadow: `0 0 14px ${theme.warningOrange}44`,
  },
  statusPill: {
    fontFamily: theme.fontMono,
    fontSize: 10,
    fontWeight: 900,
    letterSpacing: '0.14em',
    border: '1px solid currentColor',
    padding: '4px 8px',
    clipPath: hud.chamfer8,
    whiteSpace: 'nowrap',
  },
  verdictSentence: {
    margin: 0,
    color: theme.textPrimary,
    fontSize: 15,
    lineHeight: 1.72,
    fontWeight: 700,
  },
  fairyLine: {
    display: 'grid',
    gridTemplateColumns: '24px 1fr',
    gap: 10,
    padding: '10px 11px',
    border: `1px solid ${theme.flameTeal}44`,
    background: `${theme.flameTeal}08`,
    color: theme.textSecondary,
    fontSize: 12,
    lineHeight: 1.65,
  },
  fairyAvatar: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: theme.background,
    background: theme.flameTeal,
    fontFamily: theme.fontMono,
    fontWeight: 900,
  },
  metricRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8,
  },
  metric: {
    padding: '8px 8px',
    border: `1px solid ${theme.glassBorder}`,
    background: 'rgba(255,255,255,0.025)',
  },
  metricLabel: {
    display: 'block',
    color: theme.textMuted,
    fontSize: 10,
    marginBottom: 4,
  },
  metricValue: {
    fontFamily: theme.fontMono,
    fontWeight: 900,
    fontSize: 13,
  },
  panelTitleRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  sectionTitle: {
    margin: '4px 0 0',
    fontSize: 16,
    lineHeight: 1.25,
    color: theme.textPrimary,
  },
  minuteChip: {
    fontFamily: theme.fontMono,
    color: theme.electricBlue,
    border: `1px solid ${theme.electricBlue}66`,
    padding: '4px 8px',
    fontSize: 10,
    fontWeight: 900,
  },
  actionCard: {
    display: 'grid',
    gridTemplateColumns: '42px 1fr',
    gap: 12,
    padding: 12,
    border: `1px solid ${theme.electricBlue}55`,
    background: `${theme.electricBlue}08`,
  },
  actionIndex: {
    fontFamily: theme.fontMono,
    fontSize: 25,
    color: theme.electricBlue,
    fontWeight: 900,
  },
  actionTitle: {
    color: theme.textPrimary,
    fontSize: 15,
    fontWeight: 800,
    marginBottom: 6,
  },
  actionText: {
    color: theme.textSecondary,
    fontSize: 12,
    lineHeight: 1.72,
  },
  commandStrip: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8,
  },
  commandButton: {
    height: 30,
    border: '1px solid',
    clipPath: hud.chamfer8,
    cursor: 'default',
    fontFamily: theme.fontBody,
    fontSize: 12,
    fontWeight: 800,
  },
  phaseRail: {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: 8,
  },
  phaseCell: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
  },
  phaseDot: {
    width: 16,
    height: 16,
    borderRadius: '50%',
    border: '1px solid',
  },
  phaseLabel: {
    fontSize: 11,
    fontWeight: 800,
  },
  phaseTime: {
    fontFamily: theme.fontMono,
    fontSize: 9,
    color: theme.textMuted,
  },
  evidenceList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 9,
    overflow: 'auto',
  },
  evidenceItem: {
    display: 'grid',
    gridTemplateColumns: '34px 1fr',
    gap: 10,
    alignItems: 'baseline',
    color: theme.textSecondary,
    fontSize: 12,
    lineHeight: 1.62,
    paddingBottom: 9,
    borderBottom: `1px solid ${theme.glassBorder}`,
  },
  evidenceIndex: {
    fontFamily: theme.fontMono,
    color: theme.flameTeal,
    fontWeight: 900,
  },
  boundaryGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 10,
  },
  boundaryBlock: {
    border: '1px solid',
    padding: '10px 10px',
    background: 'rgba(0,0,0,0.24)',
  },
  boundaryTitle: {
    fontSize: 12,
    fontWeight: 900,
    marginBottom: 8,
  },
  boundaryItem: {
    display: 'grid',
    gridTemplateColumns: '12px 1fr',
    gap: 6,
    fontSize: 11,
    lineHeight: 1.55,
    color: theme.textSecondary,
    marginBottom: 5,
  },
  queueList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  queueItem: {
    display: 'grid',
    gridTemplateColumns: '30px 1fr',
    gap: 8,
    padding: '9px 9px',
    border: `1px solid ${theme.warningOrange}44`,
    background: `${theme.warningOrange}08`,
  },
  queueIndex: {
    fontFamily: theme.fontMono,
    color: theme.warningOrange,
    fontWeight: 900,
  },
  queueTitle: {
    color: theme.textPrimary,
    fontSize: 13,
    fontWeight: 800,
  },
  queueNote: {
    color: theme.textMuted,
    fontSize: 11,
    lineHeight: 1.55,
    marginTop: 3,
  },
  bubbleGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 10,
  },
  memoryBubble: {
    position: 'relative',
    minHeight: 84,
    border: '1px solid',
    padding: '12px 10px',
    background: 'rgba(255,255,255,0.025)',
    overflow: 'hidden',
  },
  bubbleOrb: {
    position: 'absolute',
    right: -16,
    top: -16,
    width: 54,
    height: 54,
    borderRadius: '50%',
    opacity: 0.24,
    filter: 'blur(1px)',
  },
  bubbleTitle: {
    position: 'relative',
    color: theme.textPrimary,
    fontSize: 13,
    fontWeight: 900,
    marginBottom: 7,
  },
  bubbleType: {
    position: 'relative',
    color: theme.textMuted,
    fontSize: 10,
    letterSpacing: '0.12em',
  },
}
