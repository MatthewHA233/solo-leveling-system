// 前端建窗（Fairy、摄像头预览）必须带上和 Rust 建窗同一份 WebView2 浏览器参数：
// 同一个 WebView2 环境里参数不一致会建窗失败。开发构建时这份参数里有远程调试端口（给 devtools MCP），
// 正式包为 null，行为不变。前端的类型定义没公开 additionalBrowserArgs，但 Rust 端的窗口配置认这个字段。

import { invoke } from '@tauri-apps/api/core'

let cached: Promise<string | null> | null = null

function webviewBrowserArgs(): Promise<string | null> {
  cached ??= invoke<string | null>('webview_browser_args').catch(() => null)
  return cached
}

export async function withBrowserArgs<T extends object>(options: T): Promise<T> {
  const args = await webviewBrowserArgs()
  return args ? { ...options, additionalBrowserArgs: args } : options
}
