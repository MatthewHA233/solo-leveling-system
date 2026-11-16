// 计划弹窗几个面板共用的小件：语义色、表单字段、按键（浅色克制，和 Fairy 设置 / 模型中心一个样子）

import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { StyleProp, ViewStyle } from 'react-native'
import { theme } from '../../theme'

/** 做完绿 / 计划橙 / 过了没做的灰（同 models/model-utils 的 tone，灰取 desktop ISLAND_MISSED_COLOR） */
export const planTone = {
  ok: '#2F8F5B',
  plan: '#C2772E',
  missed: '#8E8982',
}

export function Field({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  )
}

interface KeyProps {
  readonly label: string
  readonly onPress: () => void
  readonly active?: boolean
  readonly primary?: boolean
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly style?: StyleProp<ViewStyle>
}

/** 普通按键：凹底灰字；active 浅蓝底蓝字；primary 蓝底白字；danger 红字 */
export function Key({ label, onPress, active, primary, danger, disabled, style }: KeyProps) {
  const color = primary ? '#FFFFFF' : danger ? theme.danger : active ? theme.accent : theme.ink
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.key,
        active && styles.keyActive,
        primary && styles.keyPrimary,
        disabled && styles.keyDisabled,
        pressed && !disabled && styles.keyPressed,
        style,
      ]}
    >
      <Text style={[styles.keyText, { color }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

export const planStyles = StyleSheet.create({
  input: {
    height: 40, paddingHorizontal: 12, paddingVertical: 0, borderRadius: 10,
    backgroundColor: theme.sunk, fontSize: 13, color: theme.ink,
  },
  error: { fontSize: 12, color: theme.danger, marginTop: 4 },
  groupHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingBottom: 6, marginBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line,
  },
  groupTitle: { fontSize: 12, fontWeight: '600', color: theme.inkSoft },
  groupCount: { fontSize: 12, color: theme.inkFaint },
  empty: { fontSize: 12, lineHeight: 18, color: theme.inkSoft, paddingVertical: 6 },
  card: {
    backgroundColor: theme.surface, borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line,
    paddingHorizontal: 12, paddingVertical: 10,
  },
})

const styles = StyleSheet.create({
  field: { marginBottom: 12 },
  label: { fontSize: 12, color: theme.inkSoft, marginBottom: 6 },
  hint: { fontSize: 11, lineHeight: 16, color: theme.inkFaint, marginTop: 5 },
  key: {
    minHeight: 36, paddingHorizontal: 12, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', backgroundColor: theme.sunk,
  },
  keyActive: { backgroundColor: theme.accentSoft },
  keyPrimary: { backgroundColor: theme.accent },
  keyDisabled: { opacity: 0.45 },
  keyPressed: { opacity: 0.7 },
  keyText: { fontSize: 13, fontWeight: '600' },
})
