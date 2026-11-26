// 主舞台上的「笔记」面板（和昼夜表、协议志、洪流域平级）。
//   编辑器的包很大：第一次切到笔记才加载；加载过就一直留着，切走再回来页面和光标都还在。

import { lazy, memo, Suspense, useState } from 'react'

const NotesView = lazy(() => import('./NotesView'))

// 笔记的样式表跟着 NotesView 一起懒加载，占位这一行用不上它，直接写在这里
const LOADING_STYLE = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--ti-text-muted)',
  fontSize: 13,
} as const

export default memo(function NotesPanel({ active }: { readonly active: boolean }) {
  const [visited, setVisited] = useState(active)
  if (active && !visited) setVisited(true)
  if (!visited) return null
  return (
    // 屏幕那一层（ScreenBezel 里）不是弹性盒，靠 flex: 1 撑不开：直接占满它的宽高
    <div style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Suspense fallback={<div style={LOADING_STYLE}>正在载入笔记…</div>}>
        <NotesView active={active} />
      </Suspense>
    </div>
  )
})
