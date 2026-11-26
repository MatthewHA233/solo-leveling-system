// 语境页的正文怎么从来源生成：现在只有一种，B 站视频的逐句转录 → 一段一个「转录行」块

import type { TranscriptSentence } from '../../lib/bili-transcript'

/** 转录拼成段落：攒到这么多字、又正好在句末，就另起一段；一直没有句末标点也不超过上限 */
const PARAGRAPH_SOFT_CHARS = 90
const PARAGRAPH_HARD_CHARS = 260
const SENTENCE_END = /[。！？!?…]$/

/** 逐句转录 → 一段一个「转录行」块，每段记着它第一句的时间 */
export function transcriptToBlocks(sentences: readonly TranscriptSentence[]): { blocks: unknown[]; text: string } {
  const blocks: unknown[] = []
  const lines: string[] = []
  let buffer = ''
  let start: number | null = null
  const flush = () => {
    const line = buffer.trim()
    if (line) {
      blocks.push({
        type: 'transcriptLine',
        props: { start: start ?? -1 },
        content: [{ type: 'text', text: line, styles: {} }],
        children: [],
      })
      lines.push(line)
    }
    buffer = ''
    start = null
  }
  for (const s of sentences) {
    if (!buffer) start = s.start
    buffer += s.text
    const atEnd = SENTENCE_END.test(s.text.trim())
    if ((buffer.length >= PARAGRAPH_SOFT_CHARS && atEnd) || buffer.length >= PARAGRAPH_HARD_CHARS) flush()
  }
  flush()
  return { blocks, text: lines.join('\n') }
}
