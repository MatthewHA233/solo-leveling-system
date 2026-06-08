// ══════════════════════════════════════════════
// 设备本地 UI 偏好（zoom / focus 等），SharedPreferences 后端。
// 不走 LWW 同步：每台设备独立保留自己的视图设置，跟着设备走。
// ══════════════════════════════════════════════

import { solevupGetPref, solevupSetPref } from './solevupdb'

const KEY_DAYNIGHT_ZOOM = 'dn.zoom.v1'

export interface DayNightZoomPrefs {
  zoomCols: number
  totalRows: number
  focusStart: number
}

const DEFAULTS: DayNightZoomPrefs = { zoomCols: 12, totalRows: 24, focusStart: 0 }

export async function loadDayNightZoomPrefs(): Promise<DayNightZoomPrefs> {
  try {
    const raw = await solevupGetPref(KEY_DAYNIGHT_ZOOM, '')
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<DayNightZoomPrefs>
    return {
      zoomCols: typeof parsed.zoomCols === 'number' ? parsed.zoomCols : DEFAULTS.zoomCols,
      totalRows: typeof parsed.totalRows === 'number' ? parsed.totalRows : DEFAULTS.totalRows,
      focusStart: typeof parsed.focusStart === 'number' ? parsed.focusStart : DEFAULTS.focusStart,
    }
  } catch {
    return DEFAULTS
  }
}

export async function saveDayNightZoomPrefs(prefs: DayNightZoomPrefs): Promise<void> {
  try {
    await solevupSetPref(KEY_DAYNIGHT_ZOOM, JSON.stringify(prefs))
  } catch {
    // 静默失败 —— 偏好丢了下次回默认值，不影响主功能
  }
}
