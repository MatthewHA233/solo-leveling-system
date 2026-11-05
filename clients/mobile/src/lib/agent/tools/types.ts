// ══════════════════════════════════════════════
// Fairy 工具的公共接口 + 桌面端连不上时给模型的文字
//
// 工具集合、工具名、参数 schema、描述文字都和 desktop src/lib/agent/agent-tools.ts 一致，
// 两端的模型看到的是同一套工具。数据从哪里来按工具分三类，每个工具上方都标了：
//   ① 本地表：走同步协议、手机本地就有（活动块、标签等），查 src/lib/solevupdb.ts
//   ② 桌面端：只在桌面端的数据（想法卡、语境流、绑定、B 站记录），经局域网查 src/lib/desktop-api.ts
//   ③ 感知：手机自己的感知层（src/lib/perception.ts）+ 桌面端的 span，两边合并并标明来源
// ══════════════════════════════════════════════

import type { ToolDefinition } from '../../llm/types'
import type { DesktopUnreachableError } from '../../desktop-api'

/**
 * 依赖桌面端的工具声明自己在做什么。连不上时 executeAgentTool 据此生成文字，
 * 绝不返回空结果：模型会把空结果当成「确实没有」告诉主人。
 */
export type DesktopUse =
  | { readonly read: string }    // 查不到什么，如「想法卡」
  | { readonly write: string }   // 没做成什么，如「创建想法卡」

export interface Tool {
  readonly definition: ToolDefinition
  execute(args: Record<string, unknown>): Promise<string>
  readonly desktop?: DesktopUse
}

export function desktopOfflineText(use: DesktopUse, e: DesktopUnreachableError): string {
  if ('read' in use) {
    return `桌面端不在线，查不到${use.read}（${e.message}）。这不代表没有${use.read}，如实告诉主人现在连不上电脑，不要换参数重试。`
  }
  if (e.requestSent) {
    return `桌面端连接中断，不确定「${use.write}」有没有完成（${e.message}）：请求发出后才断开，桌面端可能已经写入。现在不能告诉主人已经做好，等连上后先查一下再决定要不要重做。`
  }
  return `桌面端不在线，「${use.write}」没有完成，什么也没有写入（${e.message}）。如实告诉主人现在连不上电脑，不能说已经做好。`
}

/** 感知类工具合并两个来源时用：电脑这部分查不到时的说明 */
export function desktopPartMissingText(what: string, e: unknown, offline: boolean): string {
  const reason = e instanceof Error ? e.message : String(e)
  return offline
    ? `桌面端不在线，查不到电脑上的${what}（${reason}）`
    : `桌面端查询失败，电脑上的${what}未知（${reason}）`
}
