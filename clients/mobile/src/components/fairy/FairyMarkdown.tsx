// ══════════════════════════════════════════════
// Fairy 回复的 markdown 渲染（对应 desktop FairyMarkdown.tsx + fairy-markdown.css）
//   · 解析在 markdown-parser.ts（纯函数）；这里只负责把语法树变成 Text / View
//   · 语法范围和桌面端一致：GFM 表格 / 删除线 / 任务框 / 裸链接 / 脚注，单换行就换行，星号贴中文标点也能加粗
//   · 不执行原始 HTML，只当文字
//   · 链接交给系统浏览器（只放行 http / https）
//   · 代码块、表格太宽时横向滚动，不撑破面板
//   · 配色走浅色主题，不搬桌面端的钛合金
// ══════════════════════════════════════════════

import { memo, useMemo } from 'react'
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native'
import { alpha, fonts, theme } from '../../theme'
import { TEXT_LINE_HEIGHT, TEXT_SIZE, splitLongText } from './fairy-format'
import { parseFairyMarkdown, tableColumnWidths, type MdBlock, type MdInline } from './markdown-parser'

const SAFE_LINK = /^https?:\/\//i

function openLink(href: string) {
  if (SAFE_LINK.test(href)) Linking.openURL(href).catch(() => {})
}

// ── 行内 ──

function Inlines({ nodes }: { nodes: readonly MdInline[] }) {
  return <>{nodes.map((node, i) => <Inline key={i} node={node} />)}</>
}

function Inline({ node }: { node: MdInline }) {
  switch (node.type) {
    case 'text':
      return <>{node.text}</>
    case 'break':
      return <>{'\n'}</>
    case 'strong':
      return <Text style={styles.strong}><Inlines nodes={node.children} /></Text>
    case 'em':
      return <Text style={styles.em}><Inlines nodes={node.children} /></Text>
    case 'del':
      return <Text style={styles.del}><Inlines nodes={node.children} /></Text>
    case 'code':
      return <Text style={styles.inlineCode}>{node.text}</Text>
    case 'link': {
      // 流式时网址还没写完（href 为空）或不是 http(s)：保留链接样式，但点了没有反应，和桌面端一致
      const href = node.href
      return (
        <Text
          style={styles.link}
          accessibilityRole="link"
          onPress={href ? () => openLink(href) : undefined}
        >
          <Inlines nodes={node.children} />
        </Text>
      )
    }
    case 'image': {
      // 桌面端是 <img>；手机端先按文字链接显示：RN 的 Image 要提前知道尺寸，流式时高度跳动，也不主动联网拉图
      const src = node.src
      return (
        <Text style={styles.link} accessibilityRole="link" onPress={() => openLink(src)}>
          图片{node.alt ? `：${node.alt}` : ''}
        </Text>
      )
    }
    case 'footnoteRef':
      return <Text style={styles.footnoteRef}>[{node.index}]</Text>
  }
}

// ── 块 ──

function CodeBlock({ text, last }: { text: string; last: boolean }) {
  return (
    <View style={[styles.codeWrap, last && styles.lastBlock]}>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
        {/* 空串也占一行高度，流式刚开始不跳 */}
        <View>
          {splitLongText(text || ' ').map((part, i) => (
            <Text key={i} style={styles.codeText}>{part}</Text>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

const TABLE_FONT = 13
const TABLE_CELL_PADDING = 9

function TableBlock({ block, last }: { block: Extract<MdBlock, { type: 'table' }>; last: boolean }) {
  const widths = tableColumnWidths(block.header, block.rows, TABLE_FONT, TABLE_CELL_PADDING)
  const textAlign = (col: number) => block.align[col] ?? 'left'
  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      style={[styles.tableWrap, last && styles.lastBlock]}
    >
      <View style={styles.table}>
        <View style={[styles.tableRow, styles.tableHeaderRow]}>
          {block.header.map((cell, c) => (
            <View key={c} style={[styles.tableCell, { width: widths[c] }, c === 0 && styles.tableCellFirst]}>
              <Text style={[styles.tableText, styles.strong, { textAlign: textAlign(c) }]}><Inlines nodes={cell} /></Text>
            </View>
          ))}
        </View>
        {block.rows.map((row, r) => (
          <View key={r} style={[styles.tableRow, r % 2 === 1 && styles.tableRowEven]}>
            {row.map((cell, c) => (
              <View key={c} style={[styles.tableCell, { width: widths[c] }, c === 0 && styles.tableCellFirst]}>
                <Text style={[styles.tableText, { textAlign: textAlign(c) }]}><Inlines nodes={cell} /></Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

function TaskBox({ checked }: { checked: boolean }) {
  return (
    <View style={[styles.taskBox, checked && styles.taskBoxOn]} accessibilityLabel={checked ? '已完成' : '未完成'}>
      {checked && <Text style={styles.taskCheck}>✓</Text>}
    </View>
  )
}

function ListBlock({ block, last }: { block: Extract<MdBlock, { type: 'list' }>; last: boolean }) {
  return (
    <View style={[styles.list, last && styles.lastBlock]}>
      {block.items.map((item, i) => (
        <View key={i} style={styles.listItem}>
          {item.checked !== null ? (
            <TaskBox checked={item.checked} />
          ) : block.ordered ? (
            <Text style={[styles.listMarker, styles.listMarkerOrdered]}>{block.start + i}.</Text>
          ) : (
            <Text style={styles.listMarker}>•</Text>
          )}
          <View style={styles.listBody}>
            <Blocks blocks={item.children} tight />
          </View>
        </View>
      ))}
    </View>
  )
}

function BlockView({ block, first, last }: { block: MdBlock; first: boolean; last: boolean }) {
  switch (block.type) {
    case 'paragraph':
      return (
        <Text style={[styles.paragraph, last && styles.lastBlock]}>
          <Inlines nodes={block.children} />
        </Text>
      )
    case 'heading': {
      const size = block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3
      return (
        <Text style={[styles.heading, size, first && styles.firstBlock, last && styles.lastBlock]} accessibilityRole="header">
          <Inlines nodes={block.children} />
        </Text>
      )
    }
    case 'code':
      return <CodeBlock text={block.text} last={last} />
    case 'quote':
      return (
        <View style={[styles.quote, last && styles.lastBlock]}>
          <Blocks blocks={block.children} />
        </View>
      )
    case 'list':
      return <ListBlock block={block} last={last} />
    case 'hr':
      return <View style={[styles.hr, last && styles.lastBlock]} />
    case 'table':
      return <TableBlock block={block} last={last} />
    case 'html':
      return <Text style={[styles.paragraph, styles.html, last && styles.lastBlock]}>{block.text}</Text>
    case 'footnotes':
      return (
        <View style={[styles.footnotes, last && styles.lastBlock]}>
          {block.items.map((item) => (
            <View key={item.index} style={styles.listItem}>
              <Text style={[styles.listMarker, styles.listMarkerOrdered, styles.footnoteText]}>{item.index}.</Text>
              <View style={styles.listBody}><Blocks blocks={item.children} tight /></View>
            </View>
          ))}
        </View>
      )
  }
}

/** tight：列表项里的段落，段间距收紧（对应 CSS 的 li > p） */
function Blocks({ blocks, tight = false }: { blocks: readonly MdBlock[]; tight?: boolean }) {
  return (
    <>
      {blocks.map((block, i) => (
        <View key={i} style={tight && i < blocks.length - 1 ? styles.tightGap : undefined}>
          <BlockView block={block} first={i === 0} last={i === blocks.length - 1} />
        </View>
      ))}
    </>
  )
}

// ── 顶层块按内容记忆：流式时只有最后一块在变，前面的不重渲染，代码块 / 表格的横向滚动位置也不丢 ──

const TopBlock = memo(
  function TopBlock({ block, first, last }: { block: MdBlock; sig: string; first: boolean; last: boolean }) {
    return <BlockView block={block} first={first} last={last} />
  },
  (a, b) => a.sig === b.sig && a.first === b.first && a.last === b.last,
)

function safeParse(text: string, streaming: boolean): MdBlock[] {
  try {
    return parseFairyMarkdown(text, { streaming })
  } catch {
    // 解析器理论上不抛错；万一抛了也别让整个聊天面板崩，退回纯文字
    return [{ type: 'paragraph', children: [{ type: 'text', text }] }]
  }
}

function FairyMarkdown({ text, streaming = false }: {
  text: string
  /** 正文还在流式输出：半截语法按闭合渲染，不闪标记 */
  streaming?: boolean
}) {
  const blocks = useMemo(() => {
    return safeParse(text, streaming).map((block) => ({ block, sig: JSON.stringify(block) }))
  }, [text, streaming])
  return (
    <View>
      {blocks.map(({ block, sig }, i) => (
        <TopBlock key={i} block={block} sig={sig} first={i === 0} last={i === blocks.length - 1} />
      ))}
    </View>
  )
}

// 流式输出时每来一个字都会重渲染：内容没变就别重新解析
export default memo(FairyMarkdown)

const CODE_BG = theme.sunk

const styles = StyleSheet.create({
  firstBlock: { marginTop: 0 },
  lastBlock: { marginBottom: 0 },
  tightGap: { marginBottom: 3 },
  paragraph: { fontSize: TEXT_SIZE, lineHeight: TEXT_LINE_HEIGHT, color: theme.ink, marginBottom: 9 },
  strong: { fontWeight: '700', color: theme.ink },
  em: { fontStyle: 'italic', color: theme.inkSoft },
  del: { textDecorationLine: 'line-through', color: theme.inkSoft },
  link: { color: theme.accent, textDecorationLine: 'underline' },
  inlineCode: { fontFamily: fonts.mono, fontSize: TEXT_SIZE - 2, color: '#A1487A', backgroundColor: CODE_BG },
  heading: { fontWeight: '700', color: theme.ink, marginTop: 13, marginBottom: 6 },
  h1: { fontSize: TEXT_SIZE * 1.22, lineHeight: TEXT_LINE_HEIGHT * 1.22 },
  h2: { fontSize: TEXT_SIZE * 1.12, lineHeight: TEXT_LINE_HEIGHT * 1.12 },
  h3: { fontSize: TEXT_SIZE * 1.02, lineHeight: TEXT_LINE_HEIGHT },
  codeWrap: { backgroundColor: CODE_BG, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginTop: 5, marginBottom: 11 },
  codeText: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 19, color: theme.ink },
  quote: { backgroundColor: alpha(theme.ink, 0.04), borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginTop: 5, marginBottom: 11 },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: theme.line, marginVertical: 13 },
  html: { color: theme.inkSoft },
  list: { marginTop: 2, marginBottom: 9 },
  listItem: { flexDirection: 'row', alignItems: 'flex-start', marginVertical: 2 },
  listMarker: { width: 16, fontSize: TEXT_SIZE, lineHeight: TEXT_LINE_HEIGHT, color: theme.accent, fontWeight: '700' },
  listMarkerOrdered: { width: undefined, minWidth: 18, marginRight: 4, fontVariant: ['tabular-nums'] },
  listBody: { flex: 1, minWidth: 0 },
  taskBox: {
    width: 14, height: 14, borderRadius: 3, borderWidth: 1.2, borderColor: theme.inkFaint,
    marginTop: (TEXT_LINE_HEIGHT - 14) / 2, marginRight: 7, alignItems: 'center', justifyContent: 'center',
  },
  taskBoxOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  taskCheck: { fontSize: 10, lineHeight: 12, color: '#FFFFFF', fontWeight: '700' },
  tableWrap: { marginTop: 5, marginBottom: 11, flexGrow: 0 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line, borderRadius: 6, overflow: 'hidden' },
  tableRow: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line },
  tableHeaderRow: { backgroundColor: theme.sunk, borderTopWidth: 0 },
  tableRowEven: { backgroundColor: alpha(theme.ink, 0.02) },
  tableCell: {
    paddingHorizontal: TABLE_CELL_PADDING, paddingVertical: 5,
    borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.line,
  },
  tableCellFirst: { borderLeftWidth: 0 },
  tableText: { fontSize: TABLE_FONT, lineHeight: 19, color: theme.ink },
  footnoteRef: { fontSize: 11, color: theme.accent },
  footnotes: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line, marginTop: 8, paddingTop: 8 },
  footnoteText: { fontSize: 12 },
})
