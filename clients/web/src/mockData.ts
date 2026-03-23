import type { ChronosActivity } from './types'

function step(minute: number, label: string, title: string) {
  return { id: `${minute}-${label}`, minute, label, title }
}

// 当前时间约 9:30 = 570 分钟
export const mockActivities: ChronosActivity[] = [
  {
    id: '1',
    title: 'VS Code · 昼夜表开发',
    category: 'coding',
    startMinute: 540,  // 09:00
    endMinute: 660,    // 11:00
    goalAlignment: '直接推进',
    steps: [
      step(543, '1', '重构 Canvas 绘制层'),
      step(570, '2', '修复 Trace 跨行连接器'),
      step(600, '3', '添加焊点 Glow 效果'),
      step(630, '4', '完成步骤节点序号'),
      step(655, '5', 'Git commit'),
    ],
  },
  {
    id: '2',
    title: 'Figma · UI 方案设计',
    category: 'design',
    startMinute: 480,  // 08:00
    endMinute: 540,    // 09:00
    goalAlignment: '间接相关',
    steps: [
      step(482, '1', '整理组件库'),
      step(510, '2', '昼夜表原型迭代'),
    ],
  },
  {
    id: '3',
    title: 'Chrome · 技术文档阅读',
    category: 'browsing',
    startMinute: 660,  // 11:00
    endMinute: 720,    // 12:00
    goalAlignment: '间接相关',
    steps: [
      step(662, '1', 'SwiftUI Canvas 文档'),
      step(690, '2', 'React Canvas 方案'),
    ],
  },
  {
    id: '4',
    title: 'Slack · 团队同步',
    category: 'communication',
    startMinute: 720,  // 12:00
    endMinute: 750,    // 12:30
    goalAlignment: '偏离主线',
    steps: [
      step(722, '1', '回复 PR Review'),
      step(735, '2', '同步进度'),
    ],
  },
  {
    id: '5',
    title: '午休',
    category: 'idle',
    startMinute: 750,  // 12:30
    endMinute: 840,    // 14:00
    goalAlignment: undefined,
    steps: [],
  },
  {
    id: '6',
    title: 'Notion · 架构笔记',
    category: 'writing',
    startMinute: 840,  // 14:00
    endMinute: 930,    // 15:30
    goalAlignment: '直接推进',
    steps: [
      step(843, '1', 'ReAct 架构设计'),
      step(870, '2', '工具调用协议文档'),
      step(900, '3', '数据流图'),
    ],
  },
  {
    id: '7',
    title: '论文阅读',
    category: 'learning',
    startMinute: 550,  // 09:10 (与编程并行)
    endMinute: 580,    // 09:40
    goalAlignment: '间接相关',
    steps: [
      step(553, '1', 'Attention Is All You Need'),
    ],
  },
]
