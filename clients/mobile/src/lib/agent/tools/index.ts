// ══════════════════════════════════════════════
// Agent Tools — Fairy 可调用的工具（desktop src/lib/agent/agent-tools.ts 的手机端）
// 工具集合和顺序与 desktop 一致，按领域拆在同目录的文件里，数据来源分类见 ./types.ts
// ══════════════════════════════════════════════

import { isDesktopUnreachable } from '../../desktop-api'
import type { ToolDefinition } from '../../llm/types'
import { getActivityTags } from './activity-tools'
import { getAnchors, updateAnchor } from './anchor-tools'
import { getBiliHistory } from './bili-tools'
import { editFile, readFile, writeFile } from './file-tools'
import { getAppUsage, getComputerStatus } from './perception-tools'
import {
  createThoughtCard,
  getThoughtCards,
  getVideoTranscript,
  listBrokenThoughtCards,
  repairBrokenThoughtCard,
  updateThoughtCard,
} from './thought-tools'
import { desktopOfflineText, type Tool } from './types'

export type { Tool } from './types'
export { fetchBiliSpans, type BiliSpan } from './bili-tools'
export { fetchPerceptionSpans, type PerceptionSpan } from './perception-tools'
export { fetchActivityTagSpansRange, type ActivityTagSpan } from './activity-tools'
export {
  fetchBiliTranscriptPlain,
  fetchBiliTranscriptSentences,
  jsonlToPlain,
  jsonlToSentences,
  type TranscriptSentence,
} from './bili-transcript'

// ── Registry ──

const ALL_TOOLS: readonly Tool[] = [
  getAppUsage,
  getActivityTags,
  getComputerStatus,
  getBiliHistory,
  getThoughtCards,
  createThoughtCard,
  updateThoughtCard,
  getAnchors,
  updateAnchor,
  listBrokenThoughtCards,
  getVideoTranscript,
  repairBrokenThoughtCard,
  readFile,
  writeFile,
  editFile,
]

/** 发给 AI 的工具定义列表（OpenAI function calling 格式） */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = ALL_TOOLS.map(t => t.definition)

/** 按名称执行工具，返回结果字符串 */
export async function executeAgentTool(name: string, argsJson: string): Promise<string> {
  const tool = ALL_TOOLS.find(t => t.definition.function.name === name)
  if (!tool) return `未知工具：${name}`

  try {
    const args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
    return await tool.execute(args)
  } catch (err) {
    if (tool.desktop && isDesktopUnreachable(err)) return desktopOfflineText(tool.desktop, err)
    return `工具执行失败：${err instanceof Error ? err.message : String(err)}`
  }
}
