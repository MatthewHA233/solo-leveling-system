// ══════════════════════════════════════════════
// Chronos API — 昼夜表数据接口
// 使用本地 HTTP API
// ══════════════════════════════════════════════

import * as localApi from './local-api'

// 重新导出 local-api 的函数，保持接口兼容
export const fetchActivities = localApi.fetchActivities
export const createActivity = localApi.createActivity
export const deleteActivity = localApi.deleteActivity