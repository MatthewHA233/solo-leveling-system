// ══════════════════════════════════════════════
// 底部 Tab 栏 — 三 Tab + lucide SVG 图标
// ══════════════════════════════════════════════

import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle, Path, Rect } from 'react-native-svg'
import { theme } from '../theme'
import FairyOrb, { type FairyOrbState } from './FairyOrb'

export type TabKey = 'daynight' | 'protocol' | 'torrent' | 'perception'

interface TabDef {
  key: TabKey
  label: string
  Icon: (props: IconProps) => ReactElement
}

// ── lucide 图标内联（path 直接抄自 lucide-static，保持 viewBox 0 0 24 24） ──

/** lucide Calendar —— "时间方格" 隐喻昼夜表 */
// ── 多色风格化图标（每个 tab 自己的色彩身份；未选中降透明度） ──

interface IconProps {
  active: boolean
  size?: number
}

function IconCalendar({ active, size = 23 }: IconProps) {
  // 昼夜表：太极日夜 — 太阳/月亮居两个前探半圆中心（阴阳鱼眼位）
  // 几何核验：阳眼(12,7.5) 阴眼(12,16.5)；光线半径≤4.0<凸圆4.5；
  // 星(17.4,10.8)距心5.5+星径1.1<9 且距阳凸心6.3>4.5(蓝域)；小星(16.2,17)距心6.6<9
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" opacity={active ? 1 : 0.45}>
      <Circle cx="12" cy="12" r="9" fill="#2E4FC2" />
      <Path d="M12 3 A4.5 4.5 0 0 1 12 12 A4.5 4.5 0 0 0 12 21 A9 9 0 0 1 12 3 Z" fill="#FFB13D" />
      {/* 太阳：阳鱼眼 */}
      <Circle cx="12" cy="7.5" r="2.1" fill="#FFF3DC" />
      <Path d="M12 4.7 V3.6 M12 10.3 V11.4 M9.2 7.5 H8.1 M14.8 7.5 H15.9
               M10.0 5.5 L9.2 4.7 M14.0 5.5 L14.8 4.7 M10.0 9.5 L9.2 10.3 M14.0 9.5 L14.8 10.3"
        stroke="#FFF3DC" strokeWidth="1.1" strokeLinecap="round" />
      {/* 月亮：阴鱼眼（同底色圆遮挡留左下弯月） */}
      <Circle cx="12" cy="16.5" r="3.0" fill="#D6E4FF" />
      <Circle cx="13.7" cy="15.2" r="3.0" fill="#2E4FC2" />
      {/* 四角星（夜域右侧） */}
      <Path d="M18.6 9.3 L19.06 10.14 L19.9 10.6 L19.06 11.06 L18.6 11.9 L18.14 11.06 L17.3 10.6 L18.14 10.14 Z" fill="#D6E4FF" />
      <Path d="M15.9 12.3 L16.25 12.95 L16.9 13.3 L16.25 13.65 L15.9 14.3 L15.55 13.65 L14.9 13.3 L15.55 12.95 Z" fill="#D6E4FF" />
      <Path d="M19.2 13.85 L19.46 14.34 L19.95 14.6 L19.46 14.86 L19.2 15.35 L18.94 14.86 L18.45 14.6 L18.94 14.34 Z" fill="#D6E4FF" />
    </Svg>
  )
}

function IconWaves({ active, size = 23 }: IconProps) {
  // 洪流域：三层奔涌的浪 — 每段显式 Q 上凸（T 反射会交替鼓包，弃用）
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" opacity={active ? 1 : 0.45}>
      <Path d="M2 16.6 Q4.5 13.8 7 16.6 Q9.5 19.4 12 16.6 Q14.5 13.8 17 16.6 Q19.5 19.4 22 16.6 L22 21 L2 21 Z" fill="#2E4FC2" />
      <Path d="M2 12.6 Q4.5 9.8 7 12.6 Q9.5 15.4 12 12.6 Q14.5 9.8 17 12.6 Q19.5 15.4 22 12.6 L22 15.2 Q19.5 17.9 17 15.2 Q14.5 12.4 12 15.2 Q9.5 17.9 7 15.2 Q4.5 12.4 2 15.2 Z" fill="#4C86E0" />
      <Path d="M2 8.6 Q4.5 5.8 7 8.6 Q9.5 11.4 12 8.6 Q14.5 5.8 17 8.6 Q19.5 11.4 22 8.6 L22 11.2 Q19.5 13.9 17 11.2 Q14.5 8.4 12 11.2 Q9.5 13.9 7 11.2 Q4.5 8.4 2 11.2 Z" fill="#8FB9F2" />
      <Circle cx="19" cy="4.6" r="1.2" fill="#BBD4FF" />
      <Circle cx="16.2" cy="3.4" r="0.7" fill="#BBD4FF" />
    </Svg>
  )
}

function IconEye({ active, size = 23 }: IconProps) {
  // 感知层：雷达扫描盘 — 深蓝表盘 + 青色扫描扇 + 目标点
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" opacity={active ? 1 : 0.45}>
      <Circle cx="12" cy="12" r="9.2" fill="#16385E" />
      <Circle cx="12" cy="12" r="9.2" stroke="#3E63DD" strokeWidth="1.1" />
      <Circle cx="12" cy="12" r="5.8" stroke="#2E5C94" strokeWidth="0.9" />
      <Circle cx="12" cy="12" r="2.6" stroke="#2E5C94" strokeWidth="0.9" />
      {/* 扫描扇（顺时针拖尾，亮到暗两片） */}
      <Path d="M12 12 L12 2.8 A9.2 9.2 0 0 1 19.5 6.5 Z" fill="#35E0C2" fillOpacity="0.55" />
      <Path d="M12 12 L19.5 6.5 A9.2 9.2 0 0 1 21.2 12 Z" fill="#35E0C2" fillOpacity="0.22" />
      <Path d="M12 12 L12 2.8" stroke="#7FF5DE" strokeWidth="1.0" strokeLinecap="round" />
      {/* 目标点 */}
      <Circle cx="8.6" cy="15.0" r="0.95" fill="#FFB13D" />
      <Circle cx="15.6" cy="14.8" r="0.75" fill="#E5484D" />
      <Circle cx="12" cy="12" r="1" fill="#7FF5DE" />
    </Svg>
  )
}

function IconScroll({ active, size = 23 }: IconProps) {
  // 协议志：高达头 — 细锐金 V / 钢蓝盔 / 窄眼带双绿眼 / 白面罩双缝 / 小红下巴
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" opacity={active ? 1 : 0.45}>
      {/* 细锐 V 天线（两片细长三角） */}
      <Path d="M11.5 6.4 L7.0 2.6 L8.3 2.2 L12 5.2 Z" fill="#F2C14E" />
      <Path d="M12.5 6.4 L17.0 2.6 L15.7 2.2 L12 5.2 Z" fill="#F2C14E" />
      {/* 额中红饰 */}
      <Path d="M11.2 5.6 H12.8 V7.4 H11.2 Z" fill="#E5484D" />
      {/* 侧耳 */}
      <Path d="M6.6 10.2 H5.4 Q4.8 10.2 4.8 10.9 V12.9 Q4.8 13.6 5.4 13.6 H6.6 Z" fill="#33415A" />
      <Path d="M17.4 10.2 H18.6 Q19.2 10.2 19.2 10.9 V12.9 Q19.2 13.6 18.6 13.6 H17.4 Z" fill="#33415A" />
      {/* 钢蓝头盔 */}
      <Path d="M9 6.4 H15 Q17.4 6.4 17.4 8.8 V12.6 Q17.4 13.7 16.7 14.5 L14.6 16.9 H9.4 L7.3 14.5 Q6.6 13.7 6.6 12.6 V8.8 Q6.6 6.4 9 6.4 Z" fill="#4A6396" />
      {/* 盔顶中线 */}
      <Path d="M12 6.4 V8.6" stroke="#33415A" strokeWidth="0.9" />
      {/* 窄眼带 + 锐利双绿眼 */}
      <Path d="M7.6 9.6 H16.4 L15.9 11.2 H8.1 Z" fill="#141A26" />
      <Path d="M8.7 10.0 L11.2 10.15 L10.9 10.95 L9.1 10.8 Z" fill="#3DDC84" />
      <Path d="M15.3 10.0 L12.8 10.15 L13.1 10.95 L14.9 10.8 Z" fill="#3DDC84" />
      {/* 白色面罩（嘴部）+ 双竖缝 */}
      <Path d="M9.8 12.2 H14.2 L13.6 15.4 L12 16.6 L10.4 15.4 Z" fill="#E9EEF6" />
      <Path d="M11.2 12.8 L11.5 14.7 M12.8 12.8 L12.5 14.7" stroke="#9AA8BC" strokeWidth="0.8" strokeLinecap="round" />
      {/* 面颊导槽 */}
      <Path d="M8.3 12.4 L8.9 13.8 M15.7 12.4 L15.1 13.8" stroke="#33415A" strokeWidth="0.9" strokeLinecap="round" />
      {/* 小红下巴 */}
      <Path d="M10.9 16.9 H13.1 L12 18.6 Z" fill="#E5484D" />
    </Svg>
  )
}

// 暗影体升级为中央按钮（单击弹底部对话条 / 长按全局语音），两侧各两个 tab
const SIDE_TABS_LEFT: TabDef[] = [
  { key: 'daynight', label: '昼夜表', Icon: IconCalendar },
  { key: 'torrent', label: '洪流域', Icon: IconWaves },
]
const SIDE_TABS_RIGHT: TabDef[] = [
  { key: 'perception', label: '感知层', Icon: IconEye },
  { key: 'protocol', label: '协议志', Icon: IconScroll },
]

const LONG_PRESS_MS = 320

export interface VoiceGestureHandlers {
  /** 长按达阈值，开始录音手势 */
  onStart: () => void
  /** 按住期间手指移动（页面坐标） */
  onMove: (pageX: number, pageY: number) => void
  /** 松手（页面坐标），由上层按区域分发 发送/转文字/取消 */
  onEnd: (pageX: number, pageY: number) => void
  /** 手势被系统打断 */
  onCancel: () => void
}

function SideTab({ tab, active, onChange }: { tab: TabDef; active: TabKey; onChange: (k: TabKey) => void }) {
  const on = tab.key === active
  const scale = useRef(new Animated.Value(on ? 1.22 : 1)).current
  useEffect(() => {
    Animated.spring(scale, { toValue: on ? 1.22 : 1, useNativeDriver: true, speed: 48, bounciness: 7 }).start()
  }, [on, scale])
  return (
    <Pressable style={styles.tab} onPress={() => onChange(tab.key)}>
      <Animated.View style={{ transform: [{ scale }] }}>
        <tab.Icon active={on} size={23} />
      </Animated.View>
      <Text style={[styles.label, { color: on ? theme.accent : theme.inkFaint, fontWeight: on ? '600' : '500' }]}>
        {tab.label}
      </Text>
    </Pressable>
  )
}

export default function TabBar({
  active,
  onChange,
  onCenterPress,
  voice,
  orbState = 'idle',
}: {
  active: TabKey
  onChange: (key: TabKey) => void
  onCenterPress: () => void
  voice: VoiceGestureHandlers
  orbState?: FairyOrbState
}) {
  // 中央按钮：短按 = 弹出/收起底部对话条；长按(320ms) = 全局语音手势（move/release 透传给上层判区）
  const longActiveRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const activeRef = useRef(active)
  activeRef.current = active
  const onCenterPressRef = useRef(onCenterPress)
  onCenterPressRef.current = onCenterPress

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        longActiveRef.current = false
        timerRef.current = setTimeout(() => {
          longActiveRef.current = true
          voiceRef.current.onStart()
        }, LONG_PRESS_MS)
      },
      onPanResponderMove: (e) => {
        if (longActiveRef.current) {
          voiceRef.current.onMove(e.nativeEvent.pageX, e.nativeEvent.pageY)
        }
      },
      onPanResponderRelease: (e) => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
        if (longActiveRef.current) {
          longActiveRef.current = false
          voiceRef.current.onEnd(e.nativeEvent.pageX, e.nativeEvent.pageY)
        } else {
          onCenterPressRef.current()
        }
      },
      onPanResponderTerminate: () => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
        if (longActiveRef.current) {
          longActiveRef.current = false
          voiceRef.current.onCancel()
        }
      },
    }),
  ).current

  return (
    <View style={styles.bar}>
      {SIDE_TABS_LEFT.map((t) => <SideTab key={t.key} tab={t} active={active} onChange={onChange} />)}
      <View style={styles.centerSlot}>
        <View style={styles.centerBtn} {...pan.panHandlers}>
          <FairyOrb size={46} state={orbState} />
        </View>
        <Text style={[styles.label, { color: theme.inkFaint, fontWeight: '500' }]}>
          暗影体
        </Text>
      </View>
      {SIDE_TABS_RIGHT.map((t) => <SideTab key={t.key} tab={t} active={active} onChange={onChange} />)}
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
  centerSlot: {
    flex: 1,
    alignItems: 'center',
    paddingBottom: 8,
    gap: 3,
  },
  // 球外透明（desktop 为透明窗口，光晕即边界），不垫任何底色
  centerBtn: {
    width: 54,
    height: 54,
    marginTop: -18,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
