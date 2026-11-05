// ══════════════════════════════════════════════
// 聊天图片。规则两端相同，改了要同时改（手机端 lib/agent/chat-images.ts、桌面端同名文件）：
//   · 图片压缩成 JPEG，存在 <数据目录>/chat-images/<id>.jpg
//   · 不走聊天同步：一张几百 KB，增量同步的分页扛不住。消息正文开头带标记 [图片:id1,id2]，
//     标记随聊天同步。每轮同步后发起方按标记把本机缺的文件拉过来（sync_engine.rs、SyncClient.kt），
//     拉到之前或拉不到就显示占位
//   · 重新打开会话时，最近的 MAX_RESTORED_IMAGES 张带回给模型，其余的和读不到的换成一句说明
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

/** 重新打开会话时最多带回几张旧图。每张约 2500 token，之后每次请求都要带 */
export const MAX_RESTORED_IMAGES = 8

/** 要带回给模型的图片：从最新的消息往回取，放不下就停。一条消息的图不拆开 */
export function recentImageIds(contents: readonly string[]): string[] {
  const picked: string[] = []
  for (let i = contents.length - 1; i >= 0; i--) {
    const { ids } = parseImageMarker(contents[i])
    if (picked.length + ids.length > MAX_RESTORED_IMAGES) break
    picked.push(...ids)
  }
  return picked
}

/** 重新打开会话时给模型看的正文。restored = 这条带回了几张，没带回的告诉它有过 */
export function describeImagesForModel(content: string, restored = 0): string {
  const { ids, text } = parseImageMarker(content)
  if (ids.length === 0) return content
  const gone = ids.length - restored
  if (gone === 0) return text
  return `（主人${restored > 0 ? '还' : ''}发过 ${gone} 张图片，已经不在上下文里）${text ? `\n${text}` : ''}`
}
