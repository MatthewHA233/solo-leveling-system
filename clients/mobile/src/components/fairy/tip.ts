// ══════════════════════════════════════════════
// 桌面端 Tooltip 的手机替代：手机没有 hover，长按按钮弹系统 Toast（Android 控件的标准做法）
// iOS 没有 Toast，文字仍通过 accessibilityLabel 提供
// ══════════════════════════════════════════════

import { Platform, ToastAndroid } from 'react-native'

export function showTip(text: string): void {
  if (Platform.OS === 'android' && text) ToastAndroid.show(text, ToastAndroid.SHORT)
}
