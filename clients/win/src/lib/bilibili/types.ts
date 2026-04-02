// ══════════════════════════════════════════════
// Bilibili History — 类型定义
// ══════════════════════════════════════════════

export interface BiliHistoryItem {
  title: string
  cover: string
  uri: string
  author_name: string
  author_mid: number
  view_at: number      // Unix 时间戳（秒）
  duration: number     // 视频总时长（秒）
  progress: number     // 已看进度（秒），-1 表示看完
  badge: string
  history: {
    oid: number
    bvid: string
    page: number
    cid: number
    part: string
    business: string   // "archive" | "live" | "article"
    dt: number
  }
}

export interface BiliHistoryResponse {
  code: number
  message: string
  data: {
    cursor: {
      max: number
      view_at: number
      business: string
      ps: number
    }
    list: BiliHistoryItem[]
  }
}
