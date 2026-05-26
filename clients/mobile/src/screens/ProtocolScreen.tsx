// ══════════════════════════════════════════════
// 协议志 — 今日协议（live）/ 当日协议（archive）
// 参考 docs/第4章_今日协议AI驱动.md
// Phase 1：静态样例页，等 desktop 协议系统落地后接真实数据
// ══════════════════════════════════════════════

import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { alpha, theme } from '../theme'

type Phase = 'resilience' | 'execution' | 'discovery' | 'recovery' | 'protection'

interface ProtocolBrief {
  phase: Phase
  phaseLabel: string
  headline: string
  reason: string
  confidence: number  // 0-1
  startedAt: string   // "08:20"
  allowed: string[]
  restricted: string[]
  nextAction: { title: string; estimatedMinutes: number; deadlineHHmm: string } | null
  unlockConditions: string[]
  fairyLine: string
}

interface ProtocolSpan {
  phase: Phase
  phaseLabel: string
  startAt: string
  endAt: string | null
}

// 样例数据（之后接 desktop 协议系统）
const MOCK_BRIEF: ProtocolBrief = {
  phase: 'resilience',
  phaseLabel: '韧性协议',
  headline: '先把身体和秩序立起来，下午再开放发现。',
  reason: '当前是早晨，基础任务未完成，昨晚回收不足，发现入口不应提前开放。',
  confidence: 0.82,
  startedAt: '08:20',
  allowed: ['洗漱', '吃饭', '晨间整理', '基础训练', '低刺激音乐'],
  restricted: ['短视频', '游戏', '发现流', '复杂动机分析'],
  nextAction: { title: '12 分钟内完成洗漱', estimatedMinutes: 12, deadlineHHmm: '11:32' },
  unlockConditions: ['完成 2 个基础任务后，下午发现协议可开放'],
  fairyLine: '别急着刷东西。先把身体启动。再慢都比开发现快。',
}

const MOCK_TIMELINE: ProtocolSpan[] = [
  { phase: 'protection', phaseLabel: '保护协议', startAt: '01:10', endAt: '08:20' },
  { phase: 'resilience', phaseLabel: '韧性协议', startAt: '08:20', endAt: null },
]

const PHASE_COLOR: Record<Phase, string> = {
  resilience: '#10B981',   // 绿 — 韧性
  execution:  '#3B82F6',   // 蓝 — 执行
  discovery:  '#F59E0B',   // 橙 — 发现
  recovery:   '#8B5CF6',   // 紫 — 回收
  protection: '#6B7280',   // 灰 — 保护
}

export default function ProtocolScreen() {
  const brief = MOCK_BRIEF
  const timeline = MOCK_TIMELINE
  const phaseColor = PHASE_COLOR[brief.phase]

  return (
    <View style={styles.root}>
      {/* 顶栏 */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>协议志</Text>
            <Text style={styles.subtitle}>今日协议 · live · 由 Fairy 生成</Text>
          </View>
          <View style={styles.devPill}>
            <Text style={styles.devPillText}>静态样例</Text>
          </View>
        </View>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {/* 当前协议卡 */}
        <View style={[styles.card, { borderLeftColor: phaseColor, borderLeftWidth: 4 }]}>
          <View style={styles.cardHead}>
            <View style={[styles.phaseDot, { backgroundColor: phaseColor }]} />
            <Text style={[styles.phaseLabel, { color: phaseColor }]}>{brief.phaseLabel}</Text>
            <Text style={styles.startedAt}>{brief.startedAt} 起</Text>
            <View style={[styles.confidence, { borderColor: alpha(phaseColor, 0.4) }]}>
              <Text style={[styles.confidenceText, { color: phaseColor }]}>
                ⌁ {(brief.confidence * 100).toFixed(0)}%
              </Text>
            </View>
          </View>
          <Text style={styles.headline}>{brief.headline}</Text>
          <Text style={styles.reason}>{brief.reason}</Text>
        </View>

        {/* 允许 / 限制 */}
        <View style={styles.dualRow}>
          <View style={[styles.card, styles.dualCol, { borderTopColor: '#10B981', borderTopWidth: 3 }]}>
            <Text style={styles.dualHead}>当前允许</Text>
            {brief.allowed.map((x) => (
              <View key={x} style={styles.chipRow}>
                <Text style={[styles.chip, styles.allowedChip]}>✓ {x}</Text>
              </View>
            ))}
          </View>
          <View style={[styles.card, styles.dualCol, { borderTopColor: '#EF4444', borderTopWidth: 3 }]}>
            <Text style={styles.dualHead}>当前限制</Text>
            {brief.restricted.map((x) => (
              <View key={x} style={styles.chipRow}>
                <Text style={[styles.chip, styles.restrictedChip]}>✕ {x}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* 下一步 */}
        {brief.nextAction && (
          <View style={[styles.card, { backgroundColor: alpha(phaseColor, 0.05), borderColor: alpha(phaseColor, 0.2), borderWidth: 1 }]}>
            <Text style={styles.sectionHead}>下一步</Text>
            <Text style={styles.nextActionTitle}>{brief.nextAction.title}</Text>
            <View style={styles.nextActionMeta}>
              <Text style={styles.nextActionMetaText}>预估 {brief.nextAction.estimatedMinutes} 分钟</Text>
              <Text style={styles.nextActionMetaDot}>·</Text>
              <Text style={styles.nextActionMetaText}>{brief.nextAction.deadlineHHmm} 前完成</Text>
            </View>
          </View>
        )}

        {/* 解锁条件 */}
        {brief.unlockConditions.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.sectionHead}>解锁条件</Text>
            {brief.unlockConditions.map((x, i) => (
              <View key={i} style={styles.unlockRow}>
                <Text style={styles.unlockDot}>◇</Text>
                <Text style={styles.unlockText}>{x}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Fairy 话术 */}
        <View style={[styles.card, styles.fairyCard]}>
          <View style={styles.fairyHead}>
            <Text style={styles.fairyTag}>FAIRY</Text>
            <Text style={styles.fairySubtag}>· 暗影体当下判断</Text>
          </View>
          <Text style={styles.fairyLine}>{brief.fairyLine}</Text>
        </View>

        {/* 今日协议时间线 */}
        <View style={styles.card}>
          <Text style={styles.sectionHead}>今日协议时间线</Text>
          {timeline.map((s, i) => {
            const color = PHASE_COLOR[s.phase]
            const isCurrent = s.endAt == null
            return (
              <View key={i} style={styles.spanRow}>
                <View style={[styles.spanDot, { backgroundColor: color }]} />
                <Text style={styles.spanTime}>{s.startAt}</Text>
                <Text style={styles.spanArrow}>→</Text>
                <Text style={styles.spanTime}>{s.endAt ?? '运行中'}</Text>
                <Text style={[styles.spanLabel, { color }]}>{s.phaseLabel}</Text>
                {isCurrent && (
                  <View style={[styles.liveBadge, { backgroundColor: color }]}>
                    <Text style={styles.liveBadgeText}>LIVE</Text>
                  </View>
                )}
              </View>
            )
          })}
        </View>

        {/* 用户动作（占位） */}
        <View style={styles.card}>
          <Text style={styles.sectionHead}>纠偏 · 仅占位</Text>
          <Text style={styles.placeholderText}>
            接受 / 推迟 / 切换协议 / 申请突破 / 纠正 Fairy / 记住规则{'\n\n'}
            待 desktop 端协议系统落地后，这里会变成可触发的纠偏入口。
          </Text>
        </View>

        <View style={styles.devNote}>
          <Text style={styles.devNoteText}>
            参考 docs/第4章_今日协议AI驱动.md{'\n'}
            当前为静态样例。等 desktop 协议判定/解释/归档三层 AI 落地后，
            mobile 这边只负责展示 + 接收用户纠偏，回传给桌面 Fairy。
          </Text>
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.line,
    backgroundColor: theme.surface,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  title: { fontSize: 18, fontWeight: '700', color: theme.ink },
  subtitle: { fontSize: 12, color: theme.inkSoft, marginTop: 4 },
  devPill: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10,
    backgroundColor: alpha(theme.accent, 0.12),
  },
  devPillText: { fontSize: 11, color: theme.accent, fontWeight: '600' },

  body: { flex: 1 },
  bodyContent: { padding: 16, gap: 12, paddingBottom: 40 },

  card: {
    backgroundColor: theme.surface,
    borderRadius: 10,
    padding: 14,
    gap: 6,
  },

  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  phaseDot: { width: 8, height: 8, borderRadius: 4 },
  phaseLabel: { fontSize: 15, fontWeight: '700' },
  startedAt: { fontSize: 11, color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  confidence: {
    marginLeft: 'auto',
    paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: 10, borderWidth: 1,
  },
  confidenceText: { fontSize: 10, fontWeight: '700', fontVariant: ['tabular-nums'] },
  headline: { fontSize: 14, color: theme.ink, fontWeight: '600', lineHeight: 20, marginTop: 4 },
  reason: { fontSize: 12, color: theme.inkSoft, lineHeight: 18 },

  dualRow: { flexDirection: 'row', gap: 8 },
  dualCol: { flex: 1, gap: 6 },
  dualHead: { fontSize: 11, color: theme.inkSoft, fontWeight: '600', letterSpacing: 0.3, marginBottom: 4 },
  chipRow: { },
  chip: {
    fontSize: 12,
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 4,
    overflow: 'hidden',
  },
  allowedChip: {
    color: '#059669',
    backgroundColor: alpha('#10B981', 0.1),
  },
  restrictedChip: {
    color: '#DC2626',
    backgroundColor: alpha('#EF4444', 0.1),
  },

  sectionHead: { fontSize: 11, color: theme.inkSoft, fontWeight: '600', letterSpacing: 0.3, marginBottom: 4 },
  nextActionTitle: { fontSize: 14, color: theme.ink, fontWeight: '600', lineHeight: 20 },
  nextActionMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  nextActionMetaText: { fontSize: 11, color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  nextActionMetaDot: { fontSize: 11, color: theme.inkFaint },

  unlockRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  unlockDot: { fontSize: 11, color: theme.inkFaint, marginTop: 1 },
  unlockText: { fontSize: 12, color: theme.ink, flex: 1, lineHeight: 18 },

  fairyCard: {
    backgroundColor: '#1F2937',
    padding: 14,
  },
  fairyHead: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginBottom: 8 },
  fairyTag: {
    fontSize: 10, color: '#10B981', fontWeight: '700',
    letterSpacing: 1.5,
  },
  fairySubtag: { fontSize: 10, color: alpha('#FFFFFF', 0.45) },
  fairyLine: { fontSize: 13, color: '#E5E7EB', lineHeight: 20, fontStyle: 'italic' },

  spanRow: {
    flexDirection: 'row', alignItems: 'center',
    gap: 8, paddingVertical: 4,
  },
  spanDot: { width: 6, height: 6, borderRadius: 3 },
  spanTime: { fontSize: 11, color: theme.inkSoft, fontVariant: ['tabular-nums'], fontWeight: '500' },
  spanArrow: { fontSize: 10, color: theme.inkFaint },
  spanLabel: { fontSize: 12, fontWeight: '600', marginLeft: 4 },
  liveBadge: {
    paddingHorizontal: 5, paddingVertical: 1,
    borderRadius: 3, marginLeft: 'auto',
  },
  liveBadgeText: { fontSize: 9, color: '#FFF', fontWeight: '700', letterSpacing: 0.5 },

  placeholderText: { fontSize: 12, color: theme.inkSoft, lineHeight: 18 },

  devNote: {
    marginTop: 4, padding: 12,
    backgroundColor: alpha(theme.inkSoft, 0.06),
    borderRadius: 8,
    borderLeftWidth: 2, borderLeftColor: theme.inkFaint,
  },
  devNoteText: { fontSize: 11, color: theme.inkSoft, lineHeight: 17 },
})
