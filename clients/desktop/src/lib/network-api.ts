// ══════════════════════════════════════════════
// 网络代理设置（齿轮页「网络代理」）的前端客户端 —— 后端 network.rs
//   所有需要走代理的请求（Anthropic、Fish 语音）共用这一个本机端口（127.0.0.1）
// ══════════════════════════════════════════════

import { API_BASE } from './local-api'

export const DEFAULT_PROXY_PORT = 7890

export interface NetworkSettings {
  readonly proxyPort: number
  readonly updatedAt: string | null
}

interface RawNetworkSettings {
  proxy_port: number
  updated_at: string | null
}

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, init)
  } catch {
    throw new Error('连不上本地服务（应用后端没在运行？）')
  }
  if (!res.ok) throw new Error(`网络设置服务出错（${res.status}）`)
  const json = (await res.json()) as ApiResponse<T>
  if (!json.success) throw new Error(json.error ?? '网络设置服务出错')
  return json.data as T
}

const mapSettings = (r: RawNetworkSettings): NetworkSettings => ({ proxyPort: r.proxy_port, updatedAt: r.updated_at })

export async function fetchNetworkSettings(): Promise<NetworkSettings> {
  return mapSettings(await call<RawNetworkSettings>('/api/network/settings'))
}

export async function saveNetworkSettings(proxyPort: number): Promise<NetworkSettings> {
  return mapSettings(await call<RawNetworkSettings>('/api/network/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxy_port: proxyPort }),
  }))
}

/** 代理端口：读不到就用默认 7890（语音连接不能因为设置接口没起来而失败） */
export async function fetchProxyPort(): Promise<number> {
  try {
    return (await fetchNetworkSettings()).proxyPort
  } catch {
    return DEFAULT_PROXY_PORT
  }
}
