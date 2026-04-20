import type { ChronosActivity } from './types'

// 当前时间约 9:30 = 570 分钟
export const mockActivities: ChronosActivity[] = [
  {
    id: '1',
    title: 'VS Code · 昼夜表开发',
    category: 'coding',
    startMinute: 540,  // 09:00
    endMinute: 660,    // 11:00
    goalAlignment: '直接推进',
  events: [],
  },
  {
    id: '2',
    title: 'Figma · UI 方案设计',
    category: 'design',
    startMinute: 480,  // 08:00
    endMinute: 540,    // 09:00
    goalAlignment: '间接相关',
  events: [],
  },
  {
    id: '3',
    title: 'Chrome · 技术文档阅读',
    category: 'browsing',
    startMinute: 660,  // 11:00
    endMinute: 720,    // 12:00
    goalAlignment: '间接相关',
  events: [],
  },
  {
    id: '4',
    title: 'Slack · 团队同步',
    category: 'communication',
    startMinute: 720,  // 12:00
    endMinute: 750,    // 12:30
    goalAlignment: '偏离主线',
  events: [],
  },
  {
    id: '5',
    title: '午休',
    category: 'idle',
    startMinute: 750,  // 12:30
    endMinute: 840,    // 14:00
    goalAlignment: undefined,
  events: [],
  },
  {
    id: '6',
    title: 'Notion · 架构笔记',
    category: 'writing',
    startMinute: 840,  // 14:00
    endMinute: 930,    // 15:30
    goalAlignment: '直接推进',
  events: [],
  },
  {
    id: '7',
    title: '论文阅读',
    category: 'learning',
    startMinute: 550,  // 09:10 (与编程并行)
    endMinute: 580,    // 09:40
    goalAlignment: '间接相关',
  events: [],
  },
]
