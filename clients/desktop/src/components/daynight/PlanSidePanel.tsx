// 昼夜表右侧栏在「计划」时的外壳：浮岛与日程 / 计划安排 两页，用底下一排键切换
// （顶上右角是外层面板的关闭键，所以切换键放底部）

import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

interface Props {
  readonly islands: ReactNode
  readonly todo: ReactNode
}

type Page = 'islands' | 'todo'

const PAGES: ReadonlyArray<{ readonly id: Page; readonly label: string }> = [
  { id: 'islands', label: '主线浮岛日程' },
  { id: 'todo', label: '计划安排' },
]

export default function PlanSidePanel({ islands, todo }: Props) {
  const [page, setPage] = useState<Page>('islands')
  return (
    <div style={styles.root}>
      <div style={styles.body}>{page === 'islands' ? islands : todo}</div>
      <div style={styles.tabs}>
        {PAGES.map((p) => (
          <button key={p.id} type="button" className="ti-key" data-active={page === p.id ? '1' : undefined} onClick={() => setPage(p.id)} style={styles.tab}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  root: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' },
  body: { flex: 1, minHeight: 0, overflow: 'hidden' },
  tabs: { flexShrink: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '4px 14px 12px' },
  tab: { height: 28, fontSize: 12, fontWeight: 700 },
}
