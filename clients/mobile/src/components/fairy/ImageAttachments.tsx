// ══════════════════════════════════════════════
// 图片附件（桌面端聊天没有这块，来自手机端 ChatScreen，功能保留）：
//   · BubbleImages：气泡里的图片
//   · PendingImagesBar：输入框上方待发的图片，点一下移除
//   · ImagePickerSheet：选择弹层
// 真实相册需要 native 模块（Android 的 ACTION_PICK），现在还没有，
// 所以和 ChatScreen 一样带占位图 SAMPLE_IMAGES；有 uri 就显示真图。
// ══════════════════════════════════════════════

import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { theme } from '../../theme'
import type { ChatImageAttachment } from '../../types'

export const SAMPLE_IMAGES: readonly ChatImageAttachment[] = [
  { id: 's1', label: '昼夜表截图', tint: '#4C86E0' },
  { id: 's2', label: '代码片段', tint: '#3FA86A' },
  { id: 's3', label: '白板草图', tint: '#8A63C9' },
  { id: 's4', label: '日程表', tint: '#D98A3D' },
  { id: 's5', label: '书页照片', tint: '#BE8A4A' },
  { id: 's6', label: '数据图表', tint: '#D26591' },
]

function Tile({ image, labelStyle }: { image: ChatImageAttachment; labelStyle: object }) {
  if (image.uri) return <Image source={{ uri: image.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityLabel={image.label} />
  return <Text style={labelStyle}>{image.label}</Text>
}

export function BubbleImages({ images }: { images: readonly ChatImageAttachment[] }) {
  return (
    <View style={styles.bubbleImages}>
      {images.map((img) => (
        <View key={img.id} style={[styles.bubbleImage, { backgroundColor: img.tint }]}>
          <Tile image={img} labelStyle={styles.bubbleImageText} />
        </View>
      ))}
    </View>
  )
}

export function PendingImagesBar({ images, onRemove }: {
  images: readonly ChatImageAttachment[]
  onRemove: (image: ChatImageAttachment) => void
}) {
  if (images.length === 0) return null
  return (
    <View style={styles.pendingBar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {images.map((img) => (
          <Pressable
            key={img.id}
            style={[styles.pendingTile, { backgroundColor: img.tint }]}
            accessibilityRole="button"
            accessibilityLabel={`移除图片 ${img.label}`}
            onPress={() => onRemove(img)}
          >
            <Tile image={img} labelStyle={styles.pendingLabel} />
            <View style={styles.pendingRemove}>
              <Text style={styles.pendingRemoveText}>×</Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )
}

export function ImagePickerSheet({ visible, images = SAMPLE_IMAGES, selected, hint, onToggle, onClose }: {
  visible: boolean
  images?: readonly ChatImageAttachment[]
  selected: readonly ChatImageAttachment[]
  hint?: string
  onToggle: (image: ChatImageAttachment) => void
  onClose: () => void
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>选择图片</Text>
          <Text style={styles.sheetHint}>{hint ?? '演示用占位图 · 接入相册后换真实图片'}</Text>
          <View style={styles.pickerGrid}>
            {images.map((img) => {
              const on = selected.some((p) => p.id === img.id)
              return (
                <Pressable
                  key={img.id}
                  style={[styles.pickerTile, { backgroundColor: img.tint }, on && styles.pickerTileOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => onToggle(img)}
                >
                  <Tile image={img} labelStyle={styles.pickerLabel} />
                  {on && <Text style={styles.pickerCheck}>✓</Text>}
                </Pressable>
              )
            })}
          </View>
          <Pressable style={styles.sheetBtn} onPress={onClose}>
            <Text style={styles.sheetBtnText}>完成{selected.length > 0 ? ` (${selected.length})` : ''}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  bubbleImages: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  bubbleImage: {
    width: 96, height: 96, borderRadius: 12, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center', padding: 6,
  },
  bubbleImageText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600', textAlign: 'center' },
  pendingBar: { paddingTop: 6, paddingBottom: 2 },
  pendingTile: {
    width: 60, height: 60, borderRadius: 10, marginRight: 8,
    alignItems: 'center', justifyContent: 'center', padding: 4,
  },
  pendingLabel: { color: '#FFFFFF', fontSize: 9, fontWeight: '600', textAlign: 'center' },
  pendingRemove: {
    position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: 9,
    backgroundColor: theme.ink, alignItems: 'center', justifyContent: 'center',
  },
  pendingRemoveText: { color: '#FFFFFF', fontSize: 12, lineHeight: 14 },
  backdrop: { flex: 1, backgroundColor: 'rgba(20,20,24,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingTop: 10, paddingBottom: 28,
  },
  sheetHandle: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: theme.line, marginBottom: 16 },
  sheetTitle: { fontSize: 17, fontWeight: '600', color: theme.ink },
  sheetHint: { fontSize: 12, color: theme.inkFaint, marginTop: 3, marginBottom: 14 },
  pickerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pickerTile: {
    width: '31.7%', aspectRatio: 1, borderRadius: 12, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center', padding: 6,
  },
  pickerTileOn: { borderWidth: 3, borderColor: theme.accent },
  pickerLabel: { color: '#FFFFFF', fontSize: 11, fontWeight: '600', textAlign: 'center' },
  pickerCheck: { position: 'absolute', top: 5, right: 7, color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  sheetBtn: { marginTop: 18, paddingVertical: 13, borderRadius: 12, backgroundColor: theme.accent, alignItems: 'center' },
  sheetBtnText: { color: '#FFFFFF', fontSize: 14.5, fontWeight: '600' },
})
