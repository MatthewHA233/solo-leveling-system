// ══════════════════════════════════════════════
// 图片附件（规则见 lib/agent/chat-images.ts）：
//   · BubbleImages：气泡里的图片，点一下看大图
//   · PendingImagesBar：输入框上方待发的图片，点一下移除
// 选图走系统选择器（lib/chatimage.ts）。别的设备发的图，文件不在这台上，显示占位
// ══════════════════════════════════════════════

import { useState } from 'react'
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { theme } from '../../theme'
import type { ChatImageAttachment } from '../../types'

function Tile({ image }: { image: ChatImageAttachment }) {
  const [missing, setMissing] = useState(false)
  if (missing || !image.uri) return <Text style={styles.missing}>图片不在这台设备上</Text>
  return (
    <Image
      source={{ uri: image.uri }}
      style={StyleSheet.absoluteFill}
      resizeMode="cover"
      accessibilityLabel="图片"
      onError={() => setMissing(true)}
    />
  )
}

export function BubbleImages({ images }: { images: readonly ChatImageAttachment[] }) {
  const [preview, setPreview] = useState<ChatImageAttachment | null>(null)
  return (
    <View style={styles.bubbleImages}>
      {images.map((img) => (
        <Pressable
          key={img.id}
          style={styles.bubbleImage}
          accessibilityRole="imagebutton"
          accessibilityLabel="查看大图"
          onPress={() => setPreview(img)}
        >
          <Tile image={img} />
        </Pressable>
      ))}
      <Modal visible={!!preview} transparent animationType="fade" onRequestClose={() => setPreview(null)}>
        <Pressable style={styles.preview} accessibilityLabel="关闭大图" onPress={() => setPreview(null)}>
          {preview && <Image source={{ uri: preview.uri }} style={styles.previewImage} resizeMode="contain" />}
        </Pressable>
      </Modal>
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
            style={styles.pendingTile}
            accessibilityRole="button"
            accessibilityLabel="移除这张图片"
            onPress={() => onRemove(img)}
          >
            <Tile image={img} />
            <View style={styles.pendingRemove}>
              <Text style={styles.pendingRemoveText}>×</Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  bubbleImages: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  bubbleImage: {
    width: 96, height: 96, borderRadius: 12, overflow: 'hidden', backgroundColor: theme.line,
    alignItems: 'center', justifyContent: 'center', padding: 6,
  },
  missing: { color: theme.inkFaint, fontSize: 11, textAlign: 'center' },
  preview: { flex: 1, backgroundColor: 'rgba(20,20,24,0.92)', alignItems: 'center', justifyContent: 'center' },
  previewImage: { width: '100%', height: '100%' },
  pendingBar: { paddingTop: 6, paddingBottom: 2 },
  pendingTile: {
    width: 60, height: 60, borderRadius: 10, marginRight: 8, overflow: 'hidden', backgroundColor: theme.line,
    alignItems: 'center', justifyContent: 'center', padding: 4,
  },
  pendingRemove: {
    position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: 9,
    backgroundColor: theme.ink, alignItems: 'center', justifyContent: 'center',
  },
  pendingRemoveText: { color: '#FFFFFF', fontSize: 12, lineHeight: 14 },
})
