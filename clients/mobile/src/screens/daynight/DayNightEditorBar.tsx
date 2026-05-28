import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { LayoutChangeEvent } from 'react-native'
import { alpha, theme } from '../../theme'

function SlidersGlyph({ color = '#FFF', size = 14 }: { color?: string; size?: number }) {
  const knob = Math.max(3, Math.round(size * 0.22))
  const lineH = Math.max(1, Math.round(size * 0.08))
  const rowGap = (size - knob * 3) / 2
  const knobPositions = [0.18, 0.62, 0.34]
  return (
    <View style={{ width: size, height: size, justifyContent: 'space-between' }}>
      {knobPositions.map((leftPct, i) => (
        <View key={i} style={{ height: knob, justifyContent: 'center', marginTop: i === 0 ? 0 : rowGap }}>
          <View
            style={{
              height: lineH,
              backgroundColor: color,
              opacity: 0.55,
              borderRadius: lineH / 2,
            }}
          />
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: `${leftPct * 100}%`,
              width: knob,
              height: knob,
              borderRadius: knob / 2,
              backgroundColor: color,
              marginLeft: -knob / 2,
            }}
          />
        </View>
      ))}
    </View>
  )
}

function CaretGlyph({
  color = '#888',
  size = 8,
  direction = 'down',
}: { color?: string; size?: number; direction?: 'down' | 'up' }) {
  const w = size
  const h = Math.round(size * 0.6)
  return (
    <View
      style={{
        width: 0,
        height: 0,
        borderLeftWidth: w / 2,
        borderRightWidth: w / 2,
        borderLeftColor: 'transparent',
        borderRightColor: 'transparent',
        ...(direction === 'down'
          ? { borderTopWidth: h, borderTopColor: color }
          : { borderBottomWidth: h, borderBottomColor: color }),
      }}
    />
  )
}

function SearchGlyph({ color = '#888', size = 14 }: { color?: string; size?: number }) {
  const ringSize = Math.round(size * 0.78)
  const handleLen = Math.round(size * 0.4)
  const handleWidth = Math.max(1, Math.round(size * 0.13))
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: ringSize,
          height: ringSize,
          borderRadius: ringSize / 2,
          borderWidth: handleWidth,
          borderColor: color,
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      />
      <View
        style={{
          width: handleLen,
          height: handleWidth,
          backgroundColor: color,
          borderRadius: handleWidth / 2,
          position: 'absolute',
          right: 0,
          bottom: 1,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  )
}

export function DayNightEditorBar({
  editMode,
  pickerMode,
  selectedTagLabel,
  undoDisabled,
  redoDisabled,
  onLayout,
  onStartEdit,
  onToggleSearch,
  onToggleBrowse,
  onUndo,
  onRedo,
  onDone,
}: {
  editMode: boolean
  pickerMode: null | 'browse' | 'search'
  selectedTagLabel: string
  undoDisabled: boolean
  redoDisabled: boolean
  onLayout: (e: LayoutChangeEvent) => void
  onStartEdit: () => void
  onToggleSearch: () => void
  onToggleBrowse: () => void
  onUndo: () => void
  onRedo: () => void
  onDone: () => void
}) {
  return (
    <View style={styles.actionSlot} onLayout={onLayout}>
      {!editMode ? (
        <Pressable onPress={onStartEdit} style={styles.editFullBtn}>
          <SlidersGlyph color="#FFF" size={15} />
          <Text style={styles.editFullText}>编辑昼夜表</Text>
        </Pressable>
      ) : (
        <View style={styles.editingChips}>
          <Pressable
            onPress={onToggleSearch}
            style={[
              styles.iconBtn,
              pickerMode === 'search' && styles.iconBtnActive,
            ]}
          >
            <SearchGlyph
              color={pickerMode === 'search' ? theme.accent : theme.ink}
              size={14}
            />
          </Pressable>
          <Pressable
            onPress={onToggleBrowse}
            style={[
              styles.currentTagBtn,
              pickerMode === 'browse' && styles.currentTagBtnActive,
            ]}
          >
            <Text style={styles.currentTagText} numberOfLines={1}>
              {selectedTagLabel}
            </Text>
            <CaretGlyph
              color={theme.inkSoft}
              size={9}
              direction={pickerMode === 'browse' ? 'up' : 'down'}
            />
          </Pressable>
          <Pressable
            onPress={onUndo}
            disabled={undoDisabled}
            style={[
              styles.iconBtn,
              { marginLeft: 'auto' },
              undoDisabled && styles.iconBtnDisabled,
            ]}
          >
            <Text style={[styles.iconBtnText, undoDisabled && styles.iconBtnTextDisabled]}>↶</Text>
          </Pressable>
          <Pressable
            onPress={onRedo}
            disabled={redoDisabled}
            style={[styles.iconBtn, redoDisabled && styles.iconBtnDisabled]}
          >
            <Text style={[styles.iconBtnText, redoDisabled && styles.iconBtnTextDisabled]}>↷</Text>
          </Pressable>
          <Pressable onPress={onDone} style={styles.donePillBtn}>
            <Text style={styles.donePillText}>完成</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  actionSlot: {
    height: 46,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  editFullBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 42,
    borderRadius: 12,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOpacity: 0.28,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  editFullText: {
    fontSize: 14.5,
    color: '#FFF',
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  editingChips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  iconBtn: {
    width: 38,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: alpha(theme.ink, 0.08),
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnActive: {
    backgroundColor: alpha(theme.accent, 0.16),
  },
  iconBtnDisabled: {
    backgroundColor: alpha(theme.ink, 0.03),
  },
  currentTagBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: alpha(theme.ink, 0.08),
    flexShrink: 1,
    minWidth: 0,
  },
  currentTagBtnActive: {
    backgroundColor: alpha(theme.accent, 0.16),
  },
  currentTagText: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '600',
    color: theme.ink,
  },
  iconBtnText: {
    fontSize: 18,
    lineHeight: 18,
    fontWeight: '700',
    color: theme.ink,
    includeFontPadding: false,
    textAlignVertical: 'center',
    transform: [{ translateY: -2 }],
  },
  iconBtnTextDisabled: {
    color: theme.inkFaint,
  },
  donePillBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  donePillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#FFF',
  },
})
