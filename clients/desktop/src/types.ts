// ── 活动记录：自定义标签 + 5min 块 ──

export interface ActivityCategory {
  id: number
  name: string
  color: string
  sortOrder: number
  createdAt: string
  lastUsedAt: string
}

export interface ActivityTag {
  id: number
  categoryId: number
  fullPath: string    // "工作,毕业论文,DPO章节"
  leafName: string
  depth: number       // 1..4
  createdAt: string
  lastUsedAt: string
}

export interface ActivityBlock {
  date: string        // 'YYYY-MM-DD'
  minute: number      // 0/5/10/.../1435
  tagId: number
  note: string | null
  createdAt: string
}

export interface PlanNode {
  id: number
  projectTagId: number
  parentId: number | null
  title: string
  status: 'active' | 'done' | 'archived'
  sortOrder: number
  createdAt: string
  updatedAt: string
  /** 截止日期 'YYYY-MM-DD'（协议志清单） */
  dueDate: string | null
  /** 0 无 / 1 低 / 2 中 / 3 高 */
  priority: PlanPriority
  note: string | null
  completedAt: string | null
}

export type PlanPriority = 0 | 1 | 2 | 3

export interface PlannedBlock {
  date: string
  minute: number
  planNodeId: number
  note: string | null
  createdAt: string
}

export type RecordLayer = 'actual' | 'plan'

export interface ActivityPalette {
  categories: ActivityCategory[]
  tags: ActivityTag[]
}
