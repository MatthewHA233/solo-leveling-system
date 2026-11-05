package com.solevup.mobile.solevupdb

import org.json.JSONArray
import org.json.JSONObject

/**
 * 同步协议的 JSON ↔ 数据类转换（snake_case，对齐 desktop db.rs serde 字段）。
 * SyncClient（主动）和 SyncHttpServer（被动）共用，避免两份序列化漂移。
 */
object SyncJson {

  fun exportToJson(ex: SolevupDb.SyncExport): JSONObject {
    val o = JSONObject()
    o.put("device_id", ex.deviceId)
    o.put("exported_at", ex.exportedAt)
    o.put("cursor", ex.cursor)
    o.put("activity_categories", JSONArray().apply {
      for (r in ex.activityCategories) put(JSONObject().apply {
        put("sync_id", r.syncId); put("name", r.name); put("color", r.color)
        put("sort_order", r.sortOrder); put("created_at", r.createdAt)
        put("last_used_at", r.lastUsedAt); put("updated_at", r.updatedAt)
        if (r.deletedAt != null) put("deleted_at", r.deletedAt)
      })
    })
    o.put("activity_tags", JSONArray().apply {
      for (r in ex.activityTags) put(JSONObject().apply {
        put("sync_id", r.syncId); put("category_sync_id", r.categorySyncId)
        put("full_path", r.fullPath); put("leaf_name", r.leafName); put("depth", r.depth)
        put("created_at", r.createdAt); put("last_used_at", r.lastUsedAt)
        put("updated_at", r.updatedAt)
        if (r.deletedAt != null) put("deleted_at", r.deletedAt)
      })
    })
    o.put("activity_blocks", JSONArray().apply {
      for (r in ex.activityBlocks) put(JSONObject().apply {
        put("sync_id", r.syncId); put("date", r.date); put("minute", r.minute)
        put("tag_sync_id", r.tagSyncId)
        if (r.note != null) put("note", r.note)
        put("created_at", r.createdAt); put("updated_at", r.updatedAt)
        if (r.deletedAt != null) put("deleted_at", r.deletedAt)
      })
    })
    o.put("plan_nodes", JSONArray().apply {
      for (r in ex.planNodes) put(JSONObject().apply {
        put("sync_id", r.syncId); put("project_tag_sync_id", r.projectTagSyncId)
        if (r.parentSyncId != null) put("parent_sync_id", r.parentSyncId)
        put("title", r.title); put("status", r.status); put("sort_order", r.sortOrder)
        put("created_at", r.createdAt); put("updated_at", r.updatedAt)
        if (r.deletedAt != null) put("deleted_at", r.deletedAt)
      })
    })
    o.put("planned_blocks", JSONArray().apply {
      for (r in ex.plannedBlocks) put(JSONObject().apply {
        put("sync_id", r.syncId); put("date", r.date); put("minute", r.minute)
        put("plan_node_sync_id", r.planNodeSyncId)
        if (r.note != null) put("note", r.note)
        put("created_at", r.createdAt); put("updated_at", r.updatedAt)
        if (r.deletedAt != null) put("deleted_at", r.deletedAt)
      })
    })
    putModelTables(o, ex)
    return o
  }

  private fun putModelTables(o: JSONObject, ex: SolevupDb.SyncExport) {
    o.put("model_api_keys", JSONArray().apply {
      for (r in ex.modelApiKeys) put(JSONObject().apply {
        put("id", r.id); put("label", r.label); put("provider", r.provider); put("api_key", r.apiKey)
        put("is_active", r.isActive)
        put("created_at", r.createdAt); put("updated_at", r.updatedAt)
        if (r.deletedAt != null) put("deleted_at", r.deletedAt)
      })
    })
    o.put("model_call_log", JSONArray().apply {
      for (r in ex.modelCallLog) put(modelCallLogToJson(r))
    })
    o.put("model_free_quota", JSONArray().apply {
      for (r in ex.modelFreeQuota) put(JSONObject().apply {
        put("model_id", r.modelId)
        put("has_free_quota", r.hasFreeQuota); put("not_supported", r.notSupported)
        put("used_tokens", r.usedTokens); put("total_tokens", r.totalTokens)
        put("remaining_tokens", r.remainingTokens)
        if (r.usedPercent != null) put("used_percent", r.usedPercent)
        if (r.expireDate != null) put("expire_date", r.expireDate)
        if (r.rawQuota != null) put("raw_quota", r.rawQuota)
        put("scanned_at", r.scannedAt)
        if (r.errorMessage != null) put("error_message", r.errorMessage)
      })
    })
    o.put("feature_bindings", JSONArray().apply {
      for (r in ex.featureBindings) put(JSONObject().apply {
        put("feature", r.feature); put("model_id", r.modelId); put("updated_at", r.updatedAt)
      })
    })
  }

  fun modelCallLogToJson(r: SolevupDb.SyncModelCallLogRow): JSONObject = JSONObject().apply {
    put("id", r.id)
    if (r.apiKeyId != null) put("api_key_id", r.apiKeyId)
    put("feature", r.feature); put("model_id", r.modelId)
    put("started_at", r.startedAt)
    if (r.durationMs != null) put("duration_ms", r.durationMs)
    put("prompt_text_tokens", r.promptTextTokens)
    put("prompt_image_tokens", r.promptImageTokens)
    put("prompt_video_tokens", r.promptVideoTokens)
    put("prompt_audio_tokens", r.promptAudioTokens)
    put("completion_text_tokens", r.completionTextTokens)
    put("completion_audio_tokens", r.completionAudioTokens)
    if (r.costCny != null) put("cost_cny", r.costCny)
    if (r.costUsd != null) put("cost_usd", r.costUsd)
    put("free_quota_tokens", r.freeQuotaTokens)
    put("free_quota_saved_cny", r.freeQuotaSavedCny)
    put("success", r.success)
    if (r.errorMessage != null) put("error_message", r.errorMessage)
    if (r.metadata != null) put("metadata", r.metadata)
  }

  /** 聊天消息 usage_json 的形状对齐 desktop ModelCallLog：success 是布尔值，同步表里才是 0/1。 */
  fun modelCallLogToUsageJson(r: SolevupDb.SyncModelCallLogRow): JSONObject =
    modelCallLogToJson(r).apply {
      put("success", r.success == 1)
      put("api_key_id", r.apiKeyId ?: JSONObject.NULL)
      put("duration_ms", r.durationMs ?: JSONObject.NULL)
      put("cost_cny", r.costCny ?: JSONObject.NULL)
      put("cost_usd", r.costUsd ?: JSONObject.NULL)
      put("error_message", r.errorMessage ?: JSONObject.NULL)
      put("metadata", r.metadata ?: JSONObject.NULL)
    }

  fun modelCallLogsToUsageJson(rows: List<SolevupDb.SyncModelCallLogRow>): JSONArray = JSONArray().apply {
    for (r in rows) put(modelCallLogToUsageJson(r))
  }

  fun callLogBucketsToJson(rows: List<SolevupDb.CallLogBucketRow>): JSONArray = JSONArray().apply {
    for (b in rows) put(JSONObject().apply {
      put("bucket", b.bucket)
      put("call_count", b.callCount)
      put("prompt_tokens_total", b.promptTokensTotal)
      put("completion_tokens_total", b.completionTokensTotal)
      put("cost_cny_total", b.costCnyTotal)
      put("cost_usd_total", b.costUsdTotal)
    })
  }

  fun modelCatalogToJson(rows: List<SolevupDb.SyncModelDefRow>): JSONArray = JSONArray().apply {
    for (m in rows) put(JSONObject().apply {
      put("id", m.id); put("category", m.category); put("provider", m.provider)
      put("display_name", m.displayName ?: JSONObject.NULL)
      put("modalities", m.modalities ?: JSONObject.NULL)
      put("context_window", m.contextWindow ?: JSONObject.NULL)
      put("notes", m.notes ?: JSONObject.NULL)
      put("deprecated", m.deprecated == 1)
      put("updated_at", m.updatedAt); put("currency", m.currency)
      put("pricing", JSONArray().apply {
        for (t in m.pricing) put(JSONObject().apply {
          put("tier_min_tokens", t.tierMinTokens)
          put("tier_max_tokens", t.tierMaxTokens ?: JSONObject.NULL)
          put("price_input_text", t.priceInputText ?: JSONObject.NULL)
          put("price_input_image", t.priceInputImage ?: JSONObject.NULL)
          put("price_input_video", t.priceInputVideo ?: JSONObject.NULL)
          put("price_input_audio", t.priceInputAudio ?: JSONObject.NULL)
          put("price_output_text", t.priceOutputText ?: JSONObject.NULL)
          put("price_output_text_thinking", t.priceOutputTextThinking ?: JSONObject.NULL)
          put("price_output_audio", t.priceOutputAudio ?: JSONObject.NULL)
        })
      })
    })
  }

  fun jsonToExport(o: JSONObject): SolevupDb.SyncExport =
    SolevupDb.SyncExport(
      deviceId = o.optString("device_id"),
      exportedAt = o.optString("exported_at"),
      cursor = o.optString("cursor"),
      activityCategories = arr(o, "activity_categories") {
        SolevupDb.SyncCategoryRow(
          syncId = it.optString("sync_id"), name = it.optString("name"),
          color = it.optString("color", "#888"),
          sortOrder = it.optInt("sort_order"),
          createdAt = it.optString("created_at"), lastUsedAt = it.optString("last_used_at"),
          updatedAt = it.optString("updated_at"),
          deletedAt = nullable(it, "deleted_at"),
        )
      },
      activityTags = arr(o, "activity_tags") {
        SolevupDb.SyncTagRow(
          syncId = it.optString("sync_id"), categorySyncId = it.optString("category_sync_id"),
          fullPath = it.optString("full_path"), leafName = it.optString("leaf_name"),
          depth = it.optInt("depth", 1),
          createdAt = it.optString("created_at"), lastUsedAt = it.optString("last_used_at"),
          updatedAt = it.optString("updated_at"),
          deletedAt = nullable(it, "deleted_at"),
        )
      },
      activityBlocks = arr(o, "activity_blocks") {
        SolevupDb.SyncBlockRow(
          syncId = it.optString("sync_id"), date = it.optString("date"),
          minute = it.optInt("minute"), tagSyncId = it.optString("tag_sync_id"),
          note = nullable(it, "note"),
          createdAt = it.optString("created_at"), updatedAt = it.optString("updated_at"),
          deletedAt = nullable(it, "deleted_at"),
        )
      },
      planNodes = arr(o, "plan_nodes") {
        SolevupDb.SyncPlanNodeRow(
          syncId = it.optString("sync_id"),
          projectTagSyncId = it.optString("project_tag_sync_id"),
          parentSyncId = nullable(it, "parent_sync_id"),
          title = it.optString("title"), status = it.optString("status", "active"),
          sortOrder = it.optInt("sort_order"),
          createdAt = it.optString("created_at"), updatedAt = it.optString("updated_at"),
          deletedAt = nullable(it, "deleted_at"),
        )
      },
      plannedBlocks = arr(o, "planned_blocks") {
        SolevupDb.SyncPlannedBlockRow(
          syncId = it.optString("sync_id"), date = it.optString("date"),
          minute = it.optInt("minute"), planNodeSyncId = it.optString("plan_node_sync_id"),
          note = nullable(it, "note"),
          createdAt = it.optString("created_at"), updatedAt = it.optString("updated_at"),
          deletedAt = nullable(it, "deleted_at"),
        )
      },
      modelApiKeys = parseModelApiKeys(o),
      modelCallLog = parseModelCallLog(o),
      modelFreeQuota = parseModelFreeQuota(o),
      featureBindings = parseFeatureBindings(o),
      modelRegistry = parseModelRegistry(o),
    )

  fun importResultToJson(r: SolevupDb.ImportResult): JSONObject = JSONObject().apply {
    put("activity_categories", r.activityCategories)
    put("activity_tags", r.activityTags)
    put("activity_blocks", r.activityBlocks)
    put("plan_nodes", r.planNodes)
    put("planned_blocks", r.plannedBlocks)
    put("model_api_keys", r.modelApiKeys)
    put("model_call_log", r.modelCallLog)
    put("model_free_quota", r.modelFreeQuota)
    put("feature_bindings", r.featureBindings)
    put("chat_sessions", r.chatSessions)
    put("chat_messages", r.chatMessages)
    put("model_registry", r.modelRegistry)
    put("skipped", r.skipped)
  }

  fun jsonToImportResult(o: JSONObject): SolevupDb.ImportResult = SolevupDb.ImportResult(
    activityCategories = o.optInt("activity_categories"),
    activityTags = o.optInt("activity_tags"),
    activityBlocks = o.optInt("activity_blocks"),
    planNodes = o.optInt("plan_nodes"),
    plannedBlocks = o.optInt("planned_blocks"),
    modelApiKeys = o.optInt("model_api_keys"),
    modelCallLog = o.optInt("model_call_log"),
    modelFreeQuota = o.optInt("model_free_quota"),
    featureBindings = o.optInt("feature_bindings"),
    chatSessions = o.optInt("chat_sessions"),
    chatMessages = o.optInt("chat_messages"),
    modelRegistry = o.optInt("model_registry"),
    skipped = o.optInt("skipped"),
  )

  // ── 聊天增量通道（/api/sync/chat） ──

  fun chatPageToJson(page: SolevupDb.ChatSyncPage): JSONObject = JSONObject().apply {
    put("device_id", page.deviceId)
    put("seq", page.seq)
    put("more", page.more)
    put("sessions", JSONArray().apply {
      for (r in page.sessions) put(JSONObject().apply {
        put("id", r.id); put("title", r.title)
        if (r.summary != null) put("summary", r.summary)
        put("created_at", r.createdAt); put("updated_at", r.updatedAt)
        put("meta_updated_at", r.metaUpdatedAt)
        if (r.deletedAt != null) put("deleted_at", r.deletedAt)
      })
    })
    put("messages", JSONArray().apply {
      for (r in page.messages) put(JSONObject().apply {
        put("id", r.id); put("session_id", r.sessionId); put("role", r.role)
        if (r.content != null) put("content", r.content)
        if (r.toolCalls != null) put("tool_calls", r.toolCalls)
        if (r.toolCallId != null) put("tool_call_id", r.toolCallId)
        if (r.name != null) put("name", r.name)
        put("timestamp", r.timestamp)
        if (r.audioPath != null) put("audio_path", r.audioPath)
        if (r.durationMs != null) put("duration_ms", r.durationMs)
        if (r.usageJson != null) put("usage_json", r.usageJson)
        if (r.reasoning != null) put("reasoning", r.reasoning)
      })
    })
  }

  fun jsonToChatPage(o: JSONObject): SolevupDb.ChatSyncPage = SolevupDb.ChatSyncPage(
    deviceId = o.optString("device_id"),
    seq = o.optLong("seq"),
    more = o.optBoolean("more"),
    sessions = arr(o, "sessions") {
      SolevupDb.SyncChatSessionRow(
        id = it.getString("id"), title = it.optString("title"), summary = nullable(it, "summary"),
        createdAt = it.getString("created_at"), updatedAt = it.getString("updated_at"),
        metaUpdatedAt = it.optString("meta_updated_at").ifEmpty { it.getString("created_at") },
        deletedAt = nullable(it, "deleted_at"),
      )
    },
    messages = arr(o, "messages") {
      SolevupDb.SyncChatMessageRow(
        id = it.getString("id"), sessionId = it.getString("session_id"), role = it.getString("role"),
        content = nullable(it, "content"), toolCalls = nullable(it, "tool_calls"),
        toolCallId = nullable(it, "tool_call_id"), name = nullable(it, "name"),
        timestamp = it.getString("timestamp"), audioPath = nullable(it, "audio_path"),
        durationMs = if (it.isNull("duration_ms")) null else it.optLong("duration_ms"),
        usageJson = nullable(it, "usage_json"), reasoning = nullable(it, "reasoning"),
      )
    },
  )

  private fun parseModelApiKeys(o: JSONObject): List<SolevupDb.SyncModelApiKeyRow> =
    arr(o, "model_api_keys") {
      SolevupDb.SyncModelApiKeyRow(
        id = it.optString("id"), label = it.optString("label"),
        apiKey = it.optString("api_key"), isActive = it.optInt("is_active"),
        createdAt = it.optString("created_at"), updatedAt = it.optString("updated_at"),
        deletedAt = nullable(it, "deleted_at"),
        provider = it.optString("provider", SolevupDb.PROVIDER_DASHSCOPE),
      )
    }

  private fun parseModelCallLog(o: JSONObject): List<SolevupDb.SyncModelCallLogRow> =
    arr(o, "model_call_log") {
      SolevupDb.SyncModelCallLogRow(
        id = it.optString("id"), apiKeyId = nullable(it, "api_key_id"),
        feature = it.optString("feature"), modelId = it.optString("model_id"),
        startedAt = it.optString("started_at"),
        durationMs = if (it.isNull("duration_ms")) null else it.optLong("duration_ms"),
        promptTextTokens = it.optLong("prompt_text_tokens"),
        promptImageTokens = it.optLong("prompt_image_tokens"),
        promptVideoTokens = it.optLong("prompt_video_tokens"),
        promptAudioTokens = it.optLong("prompt_audio_tokens"),
        completionTextTokens = it.optLong("completion_text_tokens"),
        completionAudioTokens = it.optLong("completion_audio_tokens"),
        costCny = if (it.isNull("cost_cny")) null else it.optDouble("cost_cny"),
        freeQuotaTokens = it.optLong("free_quota_tokens"),
        freeQuotaSavedCny = it.optDouble("free_quota_saved_cny", 0.0),
        success = it.optInt("success", 1),
        errorMessage = nullable(it, "error_message"),
        metadata = nullable(it, "metadata"),
        costUsd = if (it.isNull("cost_usd")) null else it.optDouble("cost_usd"),
      )
    }

  private fun parseModelFreeQuota(o: JSONObject): List<SolevupDb.SyncModelFreeQuotaRow> =
    arr(o, "model_free_quota") {
      SolevupDb.SyncModelFreeQuotaRow(
        modelId = it.optString("model_id"),
        hasFreeQuota = it.optInt("has_free_quota"), notSupported = it.optInt("not_supported"),
        usedTokens = it.optLong("used_tokens"), totalTokens = it.optLong("total_tokens"),
        remainingTokens = it.optLong("remaining_tokens"),
        usedPercent = nullable(it, "used_percent"), expireDate = nullable(it, "expire_date"),
        rawQuota = nullable(it, "raw_quota"), scannedAt = it.optString("scanned_at"),
        errorMessage = nullable(it, "error_message"),
      )
    }

  private fun parseFeatureBindings(o: JSONObject): List<SolevupDb.SyncFeatureBindingRow> =
    arr(o, "feature_bindings") {
      SolevupDb.SyncFeatureBindingRow(
        feature = it.optString("feature"), modelId = it.optString("model_id"),
        updatedAt = it.optString("updated_at"),
      )
    }

  fun parseModelRegistry(o: JSONObject): List<SolevupDb.SyncModelDefRow> =
    arr(o, "model_registry") { m ->
      SolevupDb.SyncModelDefRow(
        id = m.getString("id"), category = m.optString("category"),
        provider = m.optString("provider", SolevupDb.PROVIDER_DASHSCOPE),
        displayName = nullable(m, "display_name"), modalities = nullable(m, "modalities"),
        contextWindow = if (m.isNull("context_window")) null else m.optLong("context_window"),
        notes = nullable(m, "notes"),
        deprecated = if (m.optBoolean("deprecated")) 1 else 0,
        updatedAt = m.optString("updated_at"), currency = m.optString("currency", "CNY"),
        pricing = arr(m, "pricing") { t ->
          SolevupDb.SyncModelPricingRow(
            tierMinTokens = t.optLong("tier_min_tokens"),
            tierMaxTokens = if (t.isNull("tier_max_tokens")) null else t.optLong("tier_max_tokens"),
            priceInputText = nullableDouble(t, "price_input_text"),
            priceInputImage = nullableDouble(t, "price_input_image"),
            priceInputVideo = nullableDouble(t, "price_input_video"),
            priceInputAudio = nullableDouble(t, "price_input_audio"),
            priceOutputText = nullableDouble(t, "price_output_text"),
            priceOutputTextThinking = nullableDouble(t, "price_output_text_thinking"),
            priceOutputAudio = nullableDouble(t, "price_output_audio"),
          )
        },
      )
    }

  private fun nullableDouble(obj: JSONObject, key: String): Double? =
    if (obj.isNull(key)) null else obj.optDouble(key)

  private fun nullable(obj: JSONObject, key: String): String? =
    if (obj.isNull(key)) null else obj.optString(key)

  private fun <T> arr(parent: JSONObject, key: String, parse: (JSONObject) -> T): List<T> {
    val arr = parent.optJSONArray(key) ?: return emptyList()
    val out = ArrayList<T>(arr.length())
    for (i in 0 until arr.length()) {
      val o = arr.optJSONObject(i) ?: continue
      try { out.add(parse(o)) } catch (_: Throwable) {}
    }
    return out
  }
}
