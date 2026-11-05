// ══════════════════════════════════════════════
// 网络代理 Native Module 桥接 (Android-only)
// Anthropic 和 Fish 语音从这个本机端口出去（127.0.0.1），和桌面端齿轮页「网络代理」一个意思。
// 0 = 没配，跟随系统 VPN 或系统代理。每台设备自己的设置，不同步。规则在 android/.../net/AppProxy.kt
// ══════════════════════════════════════════════

import { NativeModules, Platform } from 'react-native'

interface NetworkNative {
  getProxyPort(): Promise<number>
  setProxyPort(port: number): Promise<boolean>
}

const Native: NetworkNative | null =
  Platform.OS === 'android' ? (NativeModules.Network as NetworkNative) ?? null : null

let proxyPort = 0

export async function loadProxyPort(): Promise<number> {
  if (!Native) return 0
  proxyPort = await Native.getProxyPort()
  return proxyPort
}

/** text 留空 = 不用代理。返回存下的端口，不是合法端口时抛错 */
export async function saveProxyPort(text: string): Promise<number> {
  const trimmed = text.trim()
  const port = trimmed ? Number(trimmed) : 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口要是 1 到 65535 之间的数字')
  if (!Native) return 0
  await Native.setProxyPort(port)
  proxyPort = port
  return port
}

export function isConnectError(detail: string): boolean {
  return /resolve host|failed to connect|unable to connect|connection refused|unreachable|handshake|no address/i.test(detail)
}

/** 配了端口时连不上，多半是代理没开。不是这种情况返回 null。文案对齐桌面端 anthropic.rs */
export function explainProxyFailure(detail: string): string | null {
  if (!proxyPort || !isConnectError(detail)) return null
  return `连不上代理 127.0.0.1:${proxyPort}。确认代理软件开着，端口对得上（Fairy 设置 → 网络）：${detail}`
}
