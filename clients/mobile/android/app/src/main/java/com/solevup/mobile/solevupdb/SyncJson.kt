package com.solevup.mobile.solevupdb

import org.json.JSONArray
import org.json.JSONObject

/**
 * 模型同步四表的 JSON ↔ 数据类转换（snake_case，对齐 desktop db.rs serde 字段）。
 * SyncClient（主动）和 SyncHttpServer（被动）共用，避免两份序列化漂移。
 */
object SyncJson {

  fun putModelTables(o: JSONObject, ex: SolevupDb.SyncExport) {
    o.put("model_api_keys", JSONArray().apply {
      for (r in ex.modelApiKeys) put(JSONObject().apply {
        put("id", r.id); put("label", r.label); put("api_key", r.apiKey)
        put("is_active", r.isActive)
        put("created_at", r.createdAt); put("updated_at", r.updatedAt)
        if (r.deletedAt != null) put("deleted_at", r.deletedAt)
      })
    })
    o.put("model_call_log", JSONArray().apply {
      for (r in ex.modelCallLog) put(JSONObject().apply {
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
        put("free_quota_tokens", r.freeQuotaTokens)
        put("free_quota_saved_cny", r.freeQuotaSavedCny)
        put("success", r.success)
        if (r.errorMessage != null) put("error_message", r.errorMessage)
        if (r.metadata != null) put("metadata", r.metadata)
      })
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

  fun parseModelApiKeys(o: JSONObject): List<SolevupDb.SyncModelApiKeyRow> =
    arr(o, "model_api_keys") {
      SolevupDb.SyncModelApiKeyRow(
        id = it.optString("id"), label = it.optString("label"),
        apiKey = it.optString("api_key"), isActive = it.optInt("is_active"),
        createdAt = it.optString("created_at"), updatedAt = it.optString("updated_at"),
        deletedAt = nullable(it, "deleted_at"),
      )
    }

  fun parseModelCallLog(o: JSONObject): List<SolevupDb.SyncModelCallLogRow> =
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
      )
    }

  fun parseModelFreeQuota(o: JSONObject): List<SolevupDb.SyncModelFreeQuotaRow> =
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

  fun parseFeatureBindings(o: JSONObject): List<SolevupDb.SyncFeatureBindingRow> =
    arr(o, "feature_bindings") {
      SolevupDb.SyncFeatureBindingRow(
        feature = it.optString("feature"), modelId = it.optString("model_id"),
        updatedAt = it.optString("updated_at"),
      )
    }

  private fun nullable(obj: JSONObject, key: String): String? =
    if (obj.isNull(key)) null else obj.optString(key, null)

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
