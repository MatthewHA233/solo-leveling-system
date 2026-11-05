package com.solevup.mobile.sync

import com.solevup.mobile.solevupdb.SolevupDb

/**
 * 同步日志，配对页看。最近 20 条，5 秒内同样的文案不重复记，避免离线重试刷屏。
 * 规则和文案对齐 desktop App.tsx pushSyncLog / fmtImport。只在内存里，进程重启就清空。
 */
object SyncLog {
  data class Entry(val at: Long, val text: String)

  private const val MAX_ENTRIES = 20
  private const val DEDUPE_MS = 5_000L

  private val entries = ArrayDeque<Entry>()

  @Synchronized
  fun add(text: String) {
    val now = System.currentTimeMillis()
    if (entries.any { it.text == text && now - it.at < DEDUPE_MS }) return
    entries.addFirst(Entry(now, text))
    while (entries.size > MAX_ENTRIES) entries.removeLast()
  }

  /** 新的在前 */
  @Synchronized
  fun list(): List<Entry> = entries.toList()

  fun describe(r: SolevupDb.ImportResult): String {
    val parts = listOf(
      "分类" to r.activityCategories,
      "标签" to r.activityTags,
      "实际块" to r.activityBlocks,
      "计划节点" to r.planNodes,
      "计划块" to r.plannedBlocks,
      "用量日志" to r.modelCallLog,
      "API key" to r.modelApiKeys,
      "免费额度" to r.modelFreeQuota,
      "功能绑定" to r.featureBindings,
      "聊天会话" to r.chatSessions,
      "聊天消息" to r.chatMessages,
      "设置" to r.settings,
      "聊天图片" to r.chatImages,
    ).filter { it.second > 0 }.map { "${it.first}×${it.second}" }
    if (parts.isEmpty()) return if (r.skipped > 0) "0 条（跳过 ${r.skipped}）" else "0 条"
    val skipNote = if (r.skipped > 0) " · 跳过 ${r.skipped}" else ""
    return parts.joinToString(" + ") + skipNote
  }
}
