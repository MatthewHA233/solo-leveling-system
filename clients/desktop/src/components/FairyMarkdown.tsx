// ══════════════════════════════════════════════
// Fairy 回复的 markdown 渲染（通讯栏）
//   · remark-gfm：表格 / 删除线 / 任务勾选框；remark-breaks：单个换行就换行（大模型常靠单换行分行）
//   · remark-cjk-friendly：星号贴着中文标点时也能加粗
//   · 不执行原始 HTML（react-markdown 默认就不渲染），模型输出里夹带的标签只当文字
//   · 链接交给系统浏览器打开（只放行 http / https），点了不会把应用窗口跳走
//   · 样式在 fairy-markdown.css：钛合金配色，行内代码 / 代码块用黑玻璃槽，列表符号是信号橙
// ══════════════════════════════════════════════

import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkCjkFriendly from 'remark-cjk-friendly'
import { invoke } from '@tauri-apps/api/core'
import './fairy-markdown.css'

const SAFE_LINK = /^https?:\/\//i

// remark-cjk-friendly：标准 markdown 里「是**"引号"**」这种（星号贴着中文标点）不算加粗，中文回复里很常见
const PLUGINS = [remarkGfm, remarkCjkFriendly, remarkBreaks]

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault()
        if (href && SAFE_LINK.test(href)) invoke('open_url_in_browser', { url: href }).catch(() => {})
      }}
    >
      {children}
    </a>
  ),
  // 表格太宽时横向滚动，不撑破通讯栏
  table: ({ children }) => (
    <div className="fmd-table-wrap">
      <table>{children}</table>
    </div>
  ),
}

function FairyMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
      {text}
    </ReactMarkdown>
  )
}

// 流式输出时每来一个字都会重渲染：内容没变就别重新解析
export default memo(FairyMarkdown)
