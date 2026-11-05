// ══════════════════════════════════════════════
// 聊天图片。规则两端相同，改了要同时改（手机端 lib/agent/chat-images.ts、桌面端同名文件）：
//   · 图片压缩成 JPEG，只存在发送它的设备上：<数据目录>/chat-images/<id>.jpg
//   · 不走聊天同步：一张几百 KB，增量同步的分页扛不住。消息正文开头带标记 [图片:id1,id2]，
//     标记随聊天同步，另一台设备找不到文件就显示占位
//   · 图片只在这次对话的上下文里发给模型。重新打开会话后，模型看到的是一句说明
//   · 启动时清掉没有消息引用的旧文件（删会话、选了没发），规则在 lib.rs / ChatImageModule.kt
// ══════════════════════════════════════════════

const MARKER = /^\[图片:([0-9a-f]{16}(?:,[0-9a-f]{16})*)\]\n?/

/** 落库的正文：标记 + 原话 */
export function withImageMarker(text: string, ids: readonly string[]): string {
  return ids.length > 0 ? `[图片:${ids.join(',')}]\n${text}`.trimEnd() : text
}

/** 库里的正文 → 图片 id + 原话 */
export function parseImageMarker(content: string): { ids: string[]; text: string } {
  const m = MARKER.exec(content)
  return m ? { ids: m[1].split(','), text: content.slice(m[0].length) } : { ids: [], text: content }
}

/** 重新打开会话时给模型看的正文：图片不再发，告诉它有过 */
export function describeImagesForModel(content: string): string {
  const { ids, text } = parseImageMarker(content)
  if (ids.length === 0) return content
  return `（主人发过 ${ids.length} 张图片，已经不在上下文里）${text ? `\n${text}` : ''}`
}
