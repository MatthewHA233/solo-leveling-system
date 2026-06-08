// ══════════════════════════════════════════════
// App 自更新（Android）
//   - 启动时静默拉 OSS latest.json，对比 versionCode 决定要不要提示
//   - 用户点"立即更新"调 Updater.downloadApk(url) → 完成后 installApk(path)
//   - OSS bucket lingflow / 路径前缀 solevup/android/，自定义域 assets.lingflow.cn
//   - 只保留 latest 一份 APK（与 OSS 覆盖式上传策略一致）
// ══════════════════════════════════════════════

import { NativeModules, Platform } from 'react-native'

// manifest URL 由 native Updater.getUpdateManifestUrl() 提供
// （build.gradle 从 clients/mobile/solevup.properties 读 OSS endpoint/bucket/prefix）
// 不在 TS 硬编码，方便切 OSS / CDN

export interface UpdateManifest {
  version_name: string
  version_code: number
  /** APK 完整 https URL */
  url: string
  /** 可选：APK sha256 校验，缺省则不校验 */
  sha256?: string
  size_bytes?: number
  released_at?: string
  /** 多行文案，UI 显示用 */
  changelog?: string
  /** 强制更新最低支持 code（本地 < 该值禁止跳过）；缺省则用户可选择稍后 */
  min_supported_code?: number
}

export interface LocalVersion {
  versionName: string
  versionCode: number
}

interface UpdaterNative {
  getCurrentVersion(): Promise<LocalVersion>
  getUpdateManifestUrl(): Promise<string>
  downloadApk(url: string): Promise<string>
  installApk(localPath: string): Promise<boolean>
}

const Native: UpdaterNative | null =
  Platform.OS === 'android' ? (NativeModules.Updater as UpdaterNative) ?? null : null

export function isUpdaterAvailable(): boolean {
  return Native != null
}

export async function getCurrentVersion(): Promise<LocalVersion | null> {
  if (!Native) return null
  return Native.getCurrentVersion()
}

export async function getUpdateManifestUrl(): Promise<string | null> {
  if (!Native) return null
  try {
    return await Native.getUpdateManifestUrl()
  } catch {
    return null
  }
}

/** 拉 OSS latest.json，对比本地版本码。返回 null 表示已是最新 / 没拉到。 */
export async function checkForUpdate(opts?: { signal?: AbortSignal }): Promise<
  | { manifest: UpdateManifest; current: LocalVersion; forced: boolean }
  | null
> {
  if (!Native) return null
  const [current, manifestUrl] = await Promise.all([
    Native.getCurrentVersion(),
    Native.getUpdateManifestUrl(),
  ])
  if (!manifestUrl) return null
  let manifest: UpdateManifest
  try {
    const resp = await fetch(manifestUrl, {
      method: 'GET',
      // 关键：服务端 + 本地都不要走缓存，否则刚发的版本看不到
      headers: { 'Cache-Control': 'no-cache' },
      signal: opts?.signal,
    })
    if (!resp.ok) return null
    manifest = (await resp.json()) as UpdateManifest
  } catch {
    return null
  }
  if (typeof manifest.version_code !== 'number' || !manifest.url) return null
  if (manifest.version_code <= current.versionCode) return null
  const forced =
    typeof manifest.min_supported_code === 'number' &&
    current.versionCode < manifest.min_supported_code
  return { manifest, current, forced }
}

export async function downloadApk(url: string): Promise<string | null> {
  if (!Native) return null
  return Native.downloadApk(url)
}

export async function installApk(localPath: string): Promise<boolean> {
  if (!Native) return false
  return Native.installApk(localPath)
}

/** 一键流程：下载 + 装。失败抛错（让 UI 显示 message）。 */
export async function downloadAndInstall(url: string): Promise<void> {
  const path = await downloadApk(url)
  if (!path) throw new Error('下载失败：updater 模块不可用')
  const ok = await installApk(path)
  if (!ok) throw new Error('调用系统安装器失败')
}
