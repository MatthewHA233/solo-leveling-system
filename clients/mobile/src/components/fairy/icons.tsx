// ══════════════════════════════════════════════
// 聊天面板用的线条小图标（路径取自桌面端在用的 lucide，react-native-svg 已是现有依赖）
// ══════════════════════════════════════════════

import Svg, { Circle, Line, Path, Polygon, Rect } from 'react-native-svg'

interface IconProps {
  readonly size?: number
  readonly color: string
}

function Base({ size = 15, color, children }: IconProps & { children: React.ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </Svg>
  )
}

export function IconVolume(p: IconProps) {
  return (
    <Base {...p}>
      <Polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <Path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <Path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </Base>
  )
}

export function IconVolumeOff(p: IconProps) {
  return (
    <Base {...p}>
      <Polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <Line x1={22} y1={9} x2={16} y2={15} />
      <Line x1={16} y1={9} x2={22} y2={15} />
    </Base>
  )
}

export function IconSettings(p: IconProps) {
  return (
    <Base {...p}>
      <Path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <Circle cx={12} cy={12} r={3} />
    </Base>
  )
}

export function IconHistory(p: IconProps) {
  return (
    <Base {...p}>
      <Path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <Path d="M3 3v5h5" />
      <Path d="M12 7v5l4 2" />
    </Base>
  )
}

export function IconClose(p: IconProps) {
  return (
    <Base {...p}>
      <Line x1={18} y1={6} x2={6} y2={18} />
      <Line x1={6} y1={6} x2={18} y2={18} />
    </Base>
  )
}

export function IconBug(p: IconProps) {
  return (
    <Base {...p}>
      <Rect x={8} y={6} width={8} height={14} rx={4} />
      <Path d="m19 7-3 2" />
      <Path d="m5 7 3 2" />
      <Path d="m19 19-3-2" />
      <Path d="m5 19 3-2" />
      <Path d="M20 13h-4" />
      <Path d="M4 13h4" />
      <Path d="m10 4 1 2" />
      <Path d="m14 4-1 2" />
    </Base>
  )
}

export function IconRadio(p: IconProps) {
  return (
    <Base {...p}>
      <Path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
      <Path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
      <Circle cx={12} cy={12} r={2} />
      <Path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
      <Path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
    </Base>
  )
}

export function IconMessage(p: IconProps) {
  return (
    <Base {...p}>
      <Path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Base>
  )
}

export function IconEye(p: IconProps) {
  return (
    <Base {...p}>
      <Path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <Circle cx={12} cy={12} r={3} />
    </Base>
  )
}

export function IconChevronLeft(p: IconProps) {
  return (
    <Base {...p}>
      <Path d="m15 18-6-6 6-6" />
    </Base>
  )
}

export function IconChevronRight(p: IconProps) {
  return (
    <Base {...p}>
      <Path d="m9 18 6-6-6-6" />
    </Base>
  )
}

export function IconChevronDown(p: IconProps) {
  return (
    <Base {...p}>
      <Path d="m6 9 6 6 6-6" />
    </Base>
  )
}

export function IconChevronUp(p: IconProps) {
  return (
    <Base {...p}>
      <Path d="m18 15-6-6-6 6" />
    </Base>
  )
}

export function IconWrench(p: IconProps) {
  return (
    <Base {...p}>
      <Path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </Base>
  )
}

export function IconCopy(p: IconProps) {
  return (
    <Base {...p}>
      <Rect width={14} height={14} x={8} y={8} rx={2} ry={2} />
      <Path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Base>
  )
}

/** 播放 / 暂停是实心的 */
export function IconPlay({ size = 11, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <Polygon points="6 3 20 12 6 21 6 3" />
    </Svg>
  )
}

export function IconStop({ size = 11, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <Rect x={5} y={5} width={14} height={14} rx={2} />
    </Svg>
  )
}
