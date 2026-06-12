// ══════════════════════════════════════════════
// useStableKeyboardInset — 键盘高度 inset（移植自 PickerApp 的成熟方案）
// targetSdk 36 edge-to-edge 下 adjustResize 不生效，用 Keyboard 事件手动顶：
//   - 8px 阈值防抖（输入法候选条高度微变不抖动）
//   - Android 隐藏延迟 120ms（切输入法/表情面板时防闪）
// ══════════════════════════════════════════════

import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

export function useStableKeyboardInset(isEnabled = true): number {
  const [keyboardInset, setKeyboardInset] = useState(0)
  const insets = useSafeAreaInsets()

  useEffect(() => {
    if (!isEnabled) {
      setKeyboardInset(0)
      return undefined
    }

    let hideTimer: ReturnType<typeof setTimeout> | null = null
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      if (hideTimer) {
        clearTimeout(hideTimer)
        hideTimer = null
      }
      const nextInset = Math.max(event.endCoordinates?.height ?? 0, 0)
      setKeyboardInset((current) => (Math.abs(current - nextInset) > 8 ? nextInset : current))
    })
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        setKeyboardInset(0)
      }, Platform.OS === 'android' ? 120 : 0)
    })

    return () => {
      if (hideTimer) clearTimeout(hideTimer)
      showSubscription.remove()
      hideSubscription.remove()
    }
  }, [isEnabled])

  // edge-to-edge 下 Android 的 endCoordinates.height 不含底部手势导航区，
  // 而布局坐标系到屏幕物理底 —— 实测差值恰为 insets.bottom，须补回
  return keyboardInset > 0 ? keyboardInset + insets.bottom : 0
}
