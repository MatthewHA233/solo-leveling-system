// 这台设备执行哪个平台的应用规则（手机端同名文件固定是 android）
import type { LockPlatform } from './island-model'

export const LOCK_PLATFORM: LockPlatform = /Mac/i.test(navigator.userAgent) ? 'mac' : 'windows'
