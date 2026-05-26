// ══════════════════════════════════════════════
// 底部 Tab 栏 — 三 Tab + lucide SVG 图标
// ══════════════════════════════════════════════

import type { ReactElement } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle, Path, Rect } from 'react-native-svg'
import { theme } from '../theme'

export type TabKey = 'daynight' | 'chat' | 'protocol' | 'torrent' | 'perception'

interface TabDef {
  key: TabKey
  label: string
  Icon: (props: IconProps) => ReactElement
}

interface IconProps {
  color: string
  size?: number
}

// ── lucide 图标内联（path 直接抄自 lucide-static，保持 viewBox 0 0 24 24） ──

/** lucide Calendar —— "时间方格" 隐喻昼夜表 */
function IconCalendar({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M8 2v4" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M16 2v4" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Rect x={3} y={4} width={18} height={18} rx={2} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M3 10h18" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  )
}

/** lucide MessageCircle —— 经典聊天气泡 */
function IconMessage({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

/** lucide Eye —— "感知 / 观察" */
function IconEye({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={12} r={3} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  )
}

/** lucide Waves —— "洪流" */
function IconWaves({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  )
}

/** lucide Scroll —— "协议志"（卷轴/档案隐喻） */
function IconScroll({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M19 17V5a2 2 0 0 0-2-2H4" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  )
}

const TABS: TabDef[] = [
  { key: 'daynight', label: '昼夜表', Icon: IconCalendar },
  { key: 'torrent', label: '洪流域', Icon: IconWaves },
  { key: 'perception', label: '感知层', Icon: IconEye },
  { key: 'chat', label: '暗影体', Icon: IconMessage },
  { key: 'protocol', label: '协议志', Icon: IconScroll },
]

export default function TabBar({
  active,
  onChange,
}: {
  active: TabKey
  onChange: (key: TabKey) => void
}) {
  return (
    <View style={styles.bar}>
      {TABS.map((tab) => {
        const on = tab.key === active
        const tint = on ? theme.accent : theme.inkFaint
        return (
          <Pressable key={tab.key} style={styles.tab} onPress={() => onChange(tab.key)}>
            <tab.Icon color={tint} size={22} />
            <Text
              style={[
                styles.label,
                { color: tint, fontWeight: on ? '600' : '500' },
              ]}
            >
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: theme.surface,
    borderTopWidth: 1,
    borderTopColor: theme.line,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 6,
    paddingBottom: 8,
    gap: 3,
  },
  label: {
    fontSize: 11,
    letterSpacing: 0.2,
  },
})
