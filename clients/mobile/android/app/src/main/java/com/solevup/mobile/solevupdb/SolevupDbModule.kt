package com.solevup.mobile.solevupdb

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap

/**
 * SolevupDb 桥接 —— Phase 0：只暴露 ping / deviceId / stats，验证 SQLite 跑通。
 * 后续阶段会扩展 listCategories / upsertActivityBlock 等领域方法。
 */
class SolevupDbModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  private val db: SolevupDb by lazy { SolevupDb.shared(reactContext.applicationContext) }

  @ReactMethod
  fun ping(promise: Promise) {
    val map = Arguments.createMap().apply {
      putBoolean("ok", true)
      putDouble("ts", System.currentTimeMillis().toDouble())
      putString("module", NAME)
    }
    promise.resolve(map)
  }

  /** 返回 sync_meta 里的 device_id（首次 open DB 时会自动生成）。 */
  @ReactMethod
  fun getDeviceId(promise: Promise) {
    try {
      promise.resolve(db.deviceId())
    } catch (e: Throwable) {
      promise.reject("SOLEVUPDB_DEVICE_ID_FAILED", e.message, e)
    }
  }

  /** 各表行数 + DB 文件路径，Phase 0 验证连通 + 后续观察同步效果。 */
  @ReactMethod
  fun getStats(promise: Promise) {
    try {
      val (counts, path) = db.stats()
      val tables = Arguments.createMap()
      for ((name, count) in counts) tables.putDouble(name, count.toDouble())
      val out = Arguments.createMap().apply {
        putMap("tables", tables)
        putString("path", path)
      }
      promise.resolve(out)
    } catch (e: Throwable) {
      promise.reject("SOLEVUPDB_STATS_FAILED", e.message, e)
    }
  }

  // ── 数据访问（昼夜表 palette + blocks） ──

  @ReactMethod
  fun listCategories(promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (c in db.listCategories()) {
        arr.pushMap(Arguments.createMap().apply {
          putDouble("id", c.id.toDouble())
          putString("syncId", c.syncId)
          putString("name", c.name)
          putString("color", c.color)
          putInt("sortOrder", c.sortOrder)
          putString("createdAt", c.createdAt)
          putString("lastUsedAt", c.lastUsedAt)
          putString("updatedAt", c.updatedAt)
          c.deletedAt?.let { putString("deletedAt", it) }
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) { promise.reject("SOLEVUPDB_LIST_CAT_FAILED", e.message, e) }
  }

  @ReactMethod
  fun listTags(promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (t in db.listTags()) {
        arr.pushMap(Arguments.createMap().apply {
          putDouble("id", t.id.toDouble())
          putString("syncId", t.syncId)
          putDouble("categoryId", t.categoryId.toDouble())
          putString("fullPath", t.fullPath)
          putString("leafName", t.leafName)
          putInt("depth", t.depth)
          putString("createdAt", t.createdAt)
          putString("lastUsedAt", t.lastUsedAt)
          putString("updatedAt", t.updatedAt)
          t.deletedAt?.let { putString("deletedAt", it) }
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) { promise.reject("SOLEVUPDB_LIST_TAG_FAILED", e.message, e) }
  }

  @ReactMethod
  fun listBlocksForDate(date: String, promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (b in db.listBlocksForDate(date)) {
        arr.pushMap(Arguments.createMap().apply {
          putString("date", b.date)
          putInt("minute", b.minute)
          putString("syncId", b.syncId)
          putDouble("tagId", b.tagId.toDouble())
          b.note?.let { putString("note", it) }
          putString("createdAt", b.createdAt)
          putString("updatedAt", b.updatedAt)
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) { promise.reject("SOLEVUPDB_LIST_BLOCKS_FAILED", e.message, e) }
  }

  /**
   * Upsert category。args 字段：
   *   name, color, sortOrder (number)
   *   可选：syncId, createdAt, lastUsedAt（导入种子数据时传，让跨设备能匹配）
   * 返回 row id。
   */
  @ReactMethod
  fun upsertCategory(args: ReadableMap, promise: Promise) {
    try {
      val id = db.upsertCategory(
        name = args.getString("name") ?: error("name required"),
        color = args.getString("color") ?: "#888888",
        sortOrder = if (args.hasKey("sortOrder")) args.getInt("sortOrder") else 0,
        syncId = if (args.hasKey("syncId")) args.getString("syncId") else null,
        createdAt = if (args.hasKey("createdAt")) args.getString("createdAt") else null,
        lastUsedAt = if (args.hasKey("lastUsedAt")) args.getString("lastUsedAt") else null,
        updatedAt = if (args.hasKey("updatedAt")) args.getString("updatedAt") else null,
      )
      promise.resolve(id.toDouble())
    } catch (e: Throwable) { promise.reject("SOLEVUPDB_UPSERT_CAT_FAILED", e.message, e) }
  }

  /** Upsert tag。args: categoryId, fullPath, leafName, depth (+ 可选 syncId/createdAt/lastUsedAt/updatedAt)。 */
  @ReactMethod
  fun upsertTag(args: ReadableMap, promise: Promise) {
    try {
      val id = db.upsertTag(
        categoryId = args.getDouble("categoryId").toLong(),
        fullPath = args.getString("fullPath") ?: error("fullPath required"),
        leafName = args.getString("leafName") ?: error("leafName required"),
        depth = if (args.hasKey("depth")) args.getInt("depth") else 1,
        syncId = if (args.hasKey("syncId")) args.getString("syncId") else null,
        createdAt = if (args.hasKey("createdAt")) args.getString("createdAt") else null,
        lastUsedAt = if (args.hasKey("lastUsedAt")) args.getString("lastUsedAt") else null,
        updatedAt = if (args.hasKey("updatedAt")) args.getString("updatedAt") else null,
      )
      promise.resolve(id.toDouble())
    } catch (e: Throwable) { promise.reject("SOLEVUPDB_UPSERT_TAG_FAILED", e.message, e) }
  }

  @ReactMethod
  fun deleteTag(tagId: Double, promise: Promise) {
    try {
      val n = db.deleteTag(tagId.toLong())
      promise.resolve(n.toDouble())
    } catch (e: Throwable) { promise.reject("SOLEVUPDB_DELETE_TAG_FAILED", e.message, e) }
  }

  @ReactMethod
  fun deleteCategory(categoryId: Double, promise: Promise) {
    try {
      val n = db.deleteCategory(categoryId.toLong())
      promise.resolve(n.toDouble())
    } catch (e: Throwable) { promise.reject("SOLEVUPDB_DELETE_CAT_FAILED", e.message, e) }
  }

  @ReactMethod
  fun renameCategory(categoryId: Double, newName: String?, newColor: String?, promise: Promise) {
    try {
      val n = db.renameCategory(categoryId.toLong(), newName, newColor)
      promise.resolve(n.toDouble())
    } catch (e: Throwable) { promise.reject("SOLEVUPDB_RENAME_CAT_FAILED", e.message, e) }
  }

  @ReactMethod
  fun renameTagPath(tagId: Double, newFullPath: String, cascade: Boolean, promise: Promise) {
    try {
      val n = db.renameTagPath(tagId.toLong(), newFullPath, cascade)
      promise.resolve(n.toDouble())
    } catch (e: Throwable) { promise.reject("SOLEVUPDB_RENAME_TAG_FAILED", e.message, e) }
  }

  @ReactMethod
  fun paintBlocks(date: String, minutes: ReadableArray, tagId: Double, promise: Promise) {
    try {
      val arr = IntArray(minutes.size()) { minutes.getInt(it) }
      db.paintBlocks(date, arr, tagId.toLong())
      promise.resolve(arr.size.toDouble())
    } catch (e: Throwable) { promise.reject("SOLEVUPDB_PAINT_FAILED", e.message, e) }
  }

  // ── Sync export ──

  @ReactMethod
  fun importSync(payload: ReadableMap, promise: Promise) {
    try {
      // ReadableMap → SolevupDb.SyncExport
      val syncExport = SolevupDb.SyncExport(
        deviceId = payload.getString("deviceId") ?: "",
        exportedAt = payload.getString("exportedAt") ?: "",
        cursor = payload.getString("cursor") ?: "",
        activityCategories = readCats(payload.getArray("activityCategories")),
        activityTags = readTags(payload.getArray("activityTags")),
        activityBlocks = readBlocks(payload.getArray("activityBlocks")),
        planNodes = readPlanNodes(payload.getArray("planNodes")),
        plannedBlocks = readPlannedBlocks(payload.getArray("plannedBlocks")),
      )
      val r = db.importSync(syncExport)
      promise.resolve(Arguments.createMap().apply {
        putInt("activityCategories", r.activityCategories)
        putInt("activityTags", r.activityTags)
        putInt("activityBlocks", r.activityBlocks)
        putInt("planNodes", r.planNodes)
        putInt("plannedBlocks", r.plannedBlocks)
        putInt("skipped", r.skipped)
      })
    } catch (e: Throwable) {
      promise.reject("SOLEVUPDB_IMPORT_FAILED", e.message, e)
    }
  }

  private fun readCats(arr: ReadableArray?): List<SolevupDb.SyncCategoryRow> {
    if (arr == null) return emptyList()
    val out = ArrayList<SolevupDb.SyncCategoryRow>(arr.size())
    for (i in 0 until arr.size()) {
      val m = arr.getMap(i) ?: continue
      out.add(SolevupDb.SyncCategoryRow(
        syncId = m.getString("syncId") ?: continue,
        name = m.getString("name") ?: continue,
        color = m.getString("color") ?: "#888",
        sortOrder = if (m.hasKey("sortOrder")) m.getInt("sortOrder") else 0,
        createdAt = m.getString("createdAt") ?: "",
        lastUsedAt = m.getString("lastUsedAt") ?: "",
        updatedAt = m.getString("updatedAt") ?: "",
        deletedAt = if (m.hasKey("deletedAt")) m.getString("deletedAt") else null,
      ))
    }
    return out
  }

  private fun readTags(arr: ReadableArray?): List<SolevupDb.SyncTagRow> {
    if (arr == null) return emptyList()
    val out = ArrayList<SolevupDb.SyncTagRow>(arr.size())
    for (i in 0 until arr.size()) {
      val m = arr.getMap(i) ?: continue
      out.add(SolevupDb.SyncTagRow(
        syncId = m.getString("syncId") ?: continue,
        categorySyncId = m.getString("categorySyncId") ?: continue,
        fullPath = m.getString("fullPath") ?: continue,
        leafName = m.getString("leafName") ?: "",
        depth = if (m.hasKey("depth")) m.getInt("depth") else 1,
        createdAt = m.getString("createdAt") ?: "",
        lastUsedAt = m.getString("lastUsedAt") ?: "",
        updatedAt = m.getString("updatedAt") ?: "",
        deletedAt = if (m.hasKey("deletedAt")) m.getString("deletedAt") else null,
      ))
    }
    return out
  }

  private fun readBlocks(arr: ReadableArray?): List<SolevupDb.SyncBlockRow> {
    if (arr == null) return emptyList()
    val out = ArrayList<SolevupDb.SyncBlockRow>(arr.size())
    for (i in 0 until arr.size()) {
      val m = arr.getMap(i) ?: continue
      out.add(SolevupDb.SyncBlockRow(
        syncId = m.getString("syncId") ?: continue,
        date = m.getString("date") ?: continue,
        minute = m.getInt("minute"),
        tagSyncId = m.getString("tagSyncId") ?: continue,
        note = if (m.hasKey("note")) m.getString("note") else null,
        createdAt = m.getString("createdAt") ?: "",
        updatedAt = m.getString("updatedAt") ?: "",
        deletedAt = if (m.hasKey("deletedAt")) m.getString("deletedAt") else null,
      ))
    }
    return out
  }

  private fun readPlanNodes(arr: ReadableArray?): List<SolevupDb.SyncPlanNodeRow> {
    if (arr == null) return emptyList()
    val out = ArrayList<SolevupDb.SyncPlanNodeRow>(arr.size())
    for (i in 0 until arr.size()) {
      val m = arr.getMap(i) ?: continue
      out.add(SolevupDb.SyncPlanNodeRow(
        syncId = m.getString("syncId") ?: continue,
        projectTagSyncId = m.getString("projectTagSyncId") ?: continue,
        parentSyncId = if (m.hasKey("parentSyncId")) m.getString("parentSyncId") else null,
        title = m.getString("title") ?: "",
        status = m.getString("status") ?: "active",
        sortOrder = if (m.hasKey("sortOrder")) m.getInt("sortOrder") else 0,
        createdAt = m.getString("createdAt") ?: "",
        updatedAt = m.getString("updatedAt") ?: "",
        deletedAt = if (m.hasKey("deletedAt")) m.getString("deletedAt") else null,
      ))
    }
    return out
  }

  private fun readPlannedBlocks(arr: ReadableArray?): List<SolevupDb.SyncPlannedBlockRow> {
    if (arr == null) return emptyList()
    val out = ArrayList<SolevupDb.SyncPlannedBlockRow>(arr.size())
    for (i in 0 until arr.size()) {
      val m = arr.getMap(i) ?: continue
      out.add(SolevupDb.SyncPlannedBlockRow(
        syncId = m.getString("syncId") ?: continue,
        date = m.getString("date") ?: continue,
        minute = m.getInt("minute"),
        planNodeSyncId = m.getString("planNodeSyncId") ?: continue,
        note = if (m.hasKey("note")) m.getString("note") else null,
        createdAt = m.getString("createdAt") ?: "",
        updatedAt = m.getString("updatedAt") ?: "",
        deletedAt = if (m.hasKey("deletedAt")) m.getString("deletedAt") else null,
      ))
    }
    return out
  }

  @ReactMethod
  fun exportSync(since: String?, promise: Promise) {
    try {
      val ex = db.exportSync(since)
      val out = Arguments.createMap().apply {
        putString("deviceId", ex.deviceId)
        putString("exportedAt", ex.exportedAt)
        putString("cursor", ex.cursor)
        putArray("activityCategories", Arguments.createArray().apply {
          for (r in ex.activityCategories) pushMap(Arguments.createMap().apply {
            putString("syncId", r.syncId)
            putString("name", r.name)
            putString("color", r.color)
            putInt("sortOrder", r.sortOrder)
            putString("createdAt", r.createdAt)
            putString("lastUsedAt", r.lastUsedAt)
            putString("updatedAt", r.updatedAt)
            r.deletedAt?.let { putString("deletedAt", it) }
          })
        })
        putArray("activityTags", Arguments.createArray().apply {
          for (r in ex.activityTags) pushMap(Arguments.createMap().apply {
            putString("syncId", r.syncId)
            putString("categorySyncId", r.categorySyncId)
            putString("fullPath", r.fullPath)
            putString("leafName", r.leafName)
            putInt("depth", r.depth)
            putString("createdAt", r.createdAt)
            putString("lastUsedAt", r.lastUsedAt)
            putString("updatedAt", r.updatedAt)
            r.deletedAt?.let { putString("deletedAt", it) }
          })
        })
        putArray("activityBlocks", Arguments.createArray().apply {
          for (r in ex.activityBlocks) pushMap(Arguments.createMap().apply {
            putString("syncId", r.syncId)
            putString("date", r.date)
            putInt("minute", r.minute)
            putString("tagSyncId", r.tagSyncId)
            r.note?.let { putString("note", it) }
            putString("createdAt", r.createdAt)
            putString("updatedAt", r.updatedAt)
            r.deletedAt?.let { putString("deletedAt", it) }
          })
        })
        putArray("planNodes", Arguments.createArray().apply {
          for (r in ex.planNodes) pushMap(Arguments.createMap().apply {
            putString("syncId", r.syncId)
            putString("projectTagSyncId", r.projectTagSyncId)
            r.parentSyncId?.let { putString("parentSyncId", it) }
            putString("title", r.title)
            putString("status", r.status)
            putInt("sortOrder", r.sortOrder)
            putString("createdAt", r.createdAt)
            putString("updatedAt", r.updatedAt)
            r.deletedAt?.let { putString("deletedAt", it) }
          })
        })
        putArray("plannedBlocks", Arguments.createArray().apply {
          for (r in ex.plannedBlocks) pushMap(Arguments.createMap().apply {
            putString("syncId", r.syncId)
            putString("date", r.date)
            putInt("minute", r.minute)
            putString("planNodeSyncId", r.planNodeSyncId)
            r.note?.let { putString("note", it) }
            putString("createdAt", r.createdAt)
            putString("updatedAt", r.updatedAt)
            r.deletedAt?.let { putString("deletedAt", it) }
          })
        })
      }
      promise.resolve(out)
    } catch (e: Throwable) {
      promise.reject("SOLEVUPDB_EXPORT_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun eraseBlocks(date: String, minutes: ReadableArray, promise: Promise) {
    try {
      val arr = IntArray(minutes.size()) { minutes.getInt(it) }
      db.eraseBlocks(date, arr)
      promise.resolve(arr.size.toDouble())
    } catch (e: Throwable) { promise.reject("SOLEVUPDB_ERASE_FAILED", e.message, e) }
  }

  // ── 设备本地偏好（SharedPreferences）——
  // 跟 SolevupDb sqlite 解耦：zoom / focus 这些设备本地的 UI 偏好不走 LWW 同步，
  // 每台设备独立。重装 app 才会丢。

  @ReactMethod
  fun listSyncedSettings(promise: Promise) {
    try {
      promise.resolve(Arguments.createArray().apply {
        for (row in db.listSyncedSettings()) pushMap(Arguments.createMap().apply {
          putString("key", row.key)
          putString("value", row.value)
          putString("updatedAt", row.updatedAt)
        })
      })
    } catch (e: Throwable) { promise.reject("SETTINGS_LIST_FAILED", e.message, e) }
  }

  @ReactMethod
  fun saveSyncedSetting(key: String, value: String, seed: Boolean, promise: Promise) {
    try {
      db.saveSyncedSetting(key, value, seed)
      promise.resolve(true)
    } catch (e: Throwable) { promise.reject("SETTINGS_SAVE_FAILED", e.message, e) }
  }

  @ReactMethod
  fun getPref(key: String, fallback: String, promise: Promise) {
    try {
      promise.resolve(prefs().getString(key, fallback) ?: fallback)
    } catch (e: Throwable) { promise.reject("PREF_GET_FAILED", e.message, e) }
  }

  @ReactMethod
  fun setPref(key: String, value: String, promise: Promise) {
    try {
      prefs().edit().putString(key, value).apply()
      promise.resolve(true)
    } catch (e: Throwable) { promise.reject("PREF_SET_FAILED", e.message, e) }
  }

  private fun prefs(): android.content.SharedPreferences {
    val next = reactContext.getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
    if (next.all.isNotEmpty()) return next
    val legacy = reactContext.getSharedPreferences(LEGACY_PREFS_NAME, android.content.Context.MODE_PRIVATE)
    if (legacy.all.isEmpty()) return next
    val edit = next.edit()
    for ((key, value) in legacy.all) {
      when (value) {
        is String -> edit.putString(key, value)
        is Boolean -> edit.putBoolean(key, value)
        is Int -> edit.putInt(key, value)
        is Long -> edit.putLong(key, value)
        is Float -> edit.putFloat(key, value)
        is Set<*> -> {
          @Suppress("UNCHECKED_CAST")
          edit.putStringSet(key, value as Set<String>)
        }
      }
    }
    edit.apply()
    return next
  }

  // ── 模型配置（聊天链路：active key / 模型绑定 / 用量落库） ──

  private fun keyToMap(k: SolevupDb.ModelApiKeyInfo) = Arguments.createMap().apply {
    putString("id", k.id); putString("label", k.label)
    putString("apiKey", k.apiKey); putBoolean("isActive", k.isActive)
    putString("provider", k.provider)
    putString("createdAt", k.createdAt); putString("updatedAt", k.updatedAt)
  }

  @ReactMethod
  fun getActiveModelApiKey(provider: String?, promise: Promise) {
    try {
      val k = db.getActiveModelApiKey(provider ?: SolevupDb.PROVIDER_DASHSCOPE)
      promise.resolve(k?.let { keyToMap(it) })
    } catch (e: Throwable) { promise.reject("MODEL_KEY_FAILED", e.message, e) }
  }

  @ReactMethod
  fun listModelApiKeys(promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (k in db.listModelApiKeys()) arr.pushMap(keyToMap(k))
      promise.resolve(arr)
    } catch (e: Throwable) { promise.reject("MODEL_KEYS_FAILED", e.message, e) }
  }

  @ReactMethod
  fun upsertModelApiKey(id: String?, label: String, apiKey: String, provider: String?, activate: Boolean, promise: Promise) {
    try {
      promise.resolve(keyToMap(db.upsertModelApiKey(id, label, apiKey, provider, activate)))
    } catch (e: Throwable) { promise.reject("MODEL_KEY_UPSERT_FAILED", e.message, e) }
  }

  @ReactMethod
  fun setActiveModelApiKey(id: String, promise: Promise) {
    try { db.setActiveModelApiKey(id); promise.resolve(true) }
    catch (e: Throwable) { promise.reject("MODEL_KEY_ACTIVATE_FAILED", e.message, e) }
  }

  @ReactMethod
  fun deleteModelApiKey(id: String, promise: Promise) {
    try { db.deleteModelApiKey(id); promise.resolve(true) }
    catch (e: Throwable) { promise.reject("MODEL_KEY_DELETE_FAILED", e.message, e) }
  }

  // 模型库走 JSON 字符串：字段形状和 desktop ModelDef 完全一致（snake_case），JS 不用再转一层

  @ReactMethod
  fun listModelCatalog(promise: Promise) {
    try { promise.resolve(SyncJson.modelCatalogToJson(db.listModelCatalog()).toString()) }
    catch (e: Throwable) { promise.reject("MODEL_CATALOG_FAILED", e.message, e) }
  }

  @ReactMethod
  fun seedModelCatalogIfEmpty(json: String, promise: Promise) {
    try {
      val rows = SyncJson.parseModelRegistry(org.json.JSONObject().put("model_registry", org.json.JSONArray(json)))
      promise.resolve(db.seedModelCatalogIfEmpty(rows))
    } catch (e: Throwable) { promise.reject("MODEL_CATALOG_SEED_FAILED", e.message, e) }
  }

  @ReactMethod
  fun upsertModelCatalog(json: String, promise: Promise) {
    try {
      val rows = SyncJson.parseModelRegistry(org.json.JSONObject().put("model_registry", org.json.JSONArray(json)))
      promise.resolve(db.upsertModelCatalogRows(rows))
    } catch (e: Throwable) { promise.reject("MODEL_CATALOG_UPSERT_FAILED", e.message, e) }
  }

  @ReactMethod
  fun getFeatureBinding(feature: String, promise: Promise) {
    try { promise.resolve(db.getFeatureBinding(feature)) }
    catch (e: Throwable) { promise.reject("BINDING_FAILED", e.message, e) }
  }

  /** 返回 ModelCallLog 形状的 JSON 字符串，消息的 usage_json 直接存它（和 desktop 一致）。 */
  @ReactMethod
  fun logModelCall(row: ReadableMap, promise: Promise) {
    try {
      fun tokens(key: String) = if (row.hasKey(key) && !row.isNull(key)) row.getDouble(key).toLong() else 0L
      fun text(key: String) = if (row.hasKey(key) && !row.isNull(key)) row.getString(key) else null
      val logged = db.logModelCall(SolevupDb.LogModelCallRequest(
        apiKeyId = text("apiKeyId"),
        feature = text("feature") ?: "fairy_chat",
        modelId = text("modelId") ?: "",
        startedAt = text("startedAt") ?: "",
        durationMs = if (row.hasKey("durationMs") && !row.isNull("durationMs")) row.getDouble("durationMs").toLong() else null,
        promptTextTokens = tokens("promptTextTokens"),
        promptImageTokens = tokens("promptImageTokens"),
        promptVideoTokens = tokens("promptVideoTokens"),
        promptAudioTokens = tokens("promptAudioTokens"),
        completionTextTokens = tokens("completionTextTokens"),
        completionAudioTokens = tokens("completionAudioTokens"),
        success = if (row.hasKey("success")) row.getBoolean("success") else true,
        errorMessage = text("errorMessage"),
        metadata = text("metadata"),
      ))
      promise.resolve(SyncJson.modelCallLogToUsageJson(logged).toString())
    } catch (e: Throwable) { promise.reject("CALL_LOG_FAILED", e.message, e) }
  }

  @ReactMethod
  fun listFeatureBindings(promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (b in db.listFeatureBindings()) {
        arr.pushMap(Arguments.createMap().apply {
          putString("feature", b.feature); putString("modelId", b.modelId)
          putString("updatedAt", b.updatedAt)
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) { promise.reject("BINDINGS_FAILED", e.message, e) }
  }

  @ReactMethod
  fun setFeatureBinding(feature: String, modelId: String, promise: Promise) {
    try { db.setFeatureBinding(feature, modelId); promise.resolve(true) }
    catch (e: Throwable) { promise.reject("BINDING_SET_FAILED", e.message, e) }
  }

  @ReactMethod
  fun queryModelCallLog(since: String?, limit: Double, promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (r in db.queryModelCallLog(since, limit.toInt())) {
        arr.pushMap(Arguments.createMap().apply {
          putString("id", r.id)
          if (r.apiKeyId != null) putString("apiKeyId", r.apiKeyId) else putNull("apiKeyId")
          putString("feature", r.feature); putString("modelId", r.modelId)
          putString("startedAt", r.startedAt)
          if (r.durationMs != null) putDouble("durationMs", r.durationMs.toDouble()) else putNull("durationMs")
          putDouble("promptTextTokens", r.promptTextTokens.toDouble())
          putDouble("promptImageTokens", r.promptImageTokens.toDouble())
          putDouble("promptVideoTokens", r.promptVideoTokens.toDouble())
          putDouble("promptAudioTokens", r.promptAudioTokens.toDouble())
          putDouble("completionTextTokens", r.completionTextTokens.toDouble())
          putDouble("completionAudioTokens", r.completionAudioTokens.toDouble())
          if (r.costCny != null) putDouble("costCny", r.costCny) else putNull("costCny")
          if (r.costUsd != null) putDouble("costUsd", r.costUsd) else putNull("costUsd")
          putDouble("freeQuotaTokens", r.freeQuotaTokens.toDouble())
          putDouble("freeQuotaSavedCny", r.freeQuotaSavedCny)
          putBoolean("success", r.success == 1)
          if (r.errorMessage != null) putString("errorMessage", r.errorMessage) else putNull("errorMessage")
          if (r.metadata != null) putString("metadata", r.metadata) else putNull("metadata")
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) { promise.reject("CALL_LOG_QUERY_FAILED", e.message, e) }
  }

  // 用量界面：形状对齐 desktop ModelCallLog / CallLogBucket（snake_case JSON 字符串），limit <= 0 表示不限条数

  @ReactMethod
  fun queryCallLog(
    timeFrom: String?, timeTo: String?, feature: String?, modelId: String?, apiKeyId: String?, limit: Double,
    promise: Promise,
  ) {
    try {
      val rows = db.queryCallLog(timeFrom, timeTo, feature, modelId, apiKeyId, if (limit > 0) limit.toInt() else null)
      promise.resolve(SyncJson.modelCallLogsToUsageJson(rows).toString())
    } catch (e: Throwable) { promise.reject("CALL_LOG_QUERY_FAILED", e.message, e) }
  }

  @ReactMethod
  fun aggregateCallLog(
    timeFrom: String, timeTo: String, granularity: String, feature: String?, modelId: String?, apiKeyId: String?,
    promise: Promise,
  ) {
    try {
      val rows = db.aggregateCallLog(timeFrom, timeTo, granularity, feature, modelId, apiKeyId)
      promise.resolve(SyncJson.callLogBucketsToJson(rows).toString())
    } catch (e: Throwable) { promise.reject("CALL_LOG_AGGREGATE_FAILED", e.message, e) }
  }

  @ReactMethod
  fun getModelCallLog(id: String, promise: Promise) {
    try { promise.resolve(db.getModelCallLog(id)?.let { SyncJson.modelCallLogToUsageJson(it).toString() }) }
    catch (e: Throwable) { promise.reject("CALL_LOG_GET_FAILED", e.message, e) }
  }

  /** 复制 API Key 用：RN 自带 Clipboard 已废弃，又不引第三方包；打上敏感标记，系统不在剪贴板预览里显示明文。 */
  @ReactMethod
  fun copyText(text: String, promise: Promise) {
    try {
      val clipboard = reactContext.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
      val clip = android.content.ClipData.newPlainText("text", text)
      clip.description.extras = android.os.PersistableBundle().apply {
        putBoolean("android.content.extra.IS_SENSITIVE", true)
      }
      clipboard.setPrimaryClip(clip)
      promise.resolve(true)
    } catch (e: Throwable) { promise.reject("COPY_TEXT_FAILED", e.message, e) }
  }

  @ReactMethod
  fun listModelFreeQuota(promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (r in db.listModelFreeQuota()) {
        arr.pushMap(Arguments.createMap().apply {
          putString("modelId", r.modelId)
          putBoolean("hasFreeQuota", r.hasFreeQuota == 1)
          putBoolean("notSupported", r.notSupported == 1)
          putDouble("usedTokens", r.usedTokens.toDouble())
          putDouble("totalTokens", r.totalTokens.toDouble())
          putDouble("remainingTokens", r.remainingTokens.toDouble())
          if (r.usedPercent != null) putString("usedPercent", r.usedPercent) else putNull("usedPercent")
          if (r.expireDate != null) putString("expireDate", r.expireDate) else putNull("expireDate")
          if (r.rawQuota != null) putString("rawQuota", r.rawQuota) else putNull("rawQuota")
          putString("scannedAt", r.scannedAt)
          if (r.errorMessage != null) putString("errorMessage", r.errorMessage) else putNull("errorMessage")
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) { promise.reject("FREE_QUOTA_FAILED", e.message, e) }
  }

  // ── 聊天会话 ──

  private fun sessionToMap(r: SolevupDb.ChatSessionRow) = Arguments.createMap().apply {
    putString("id", r.id); putString("title", r.title)
    if (r.summary != null) putString("summary", r.summary) else putNull("summary")
    putString("createdAt", r.createdAt); putString("updatedAt", r.updatedAt)
    putInt("messageCount", r.messageCount)
  }

  @ReactMethod
  fun createChatSession(promise: Promise) {
    try { promise.resolve(sessionToMap(db.createChatSession())) }
    catch (e: Throwable) { promise.reject("SESSION_CREATE_FAILED", e.message, e) }
  }

  @ReactMethod
  fun listChatSessions(limit: Double, promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (r in db.listChatSessions(limit.toInt())) arr.pushMap(sessionToMap(r))
      promise.resolve(arr)
    } catch (e: Throwable) { promise.reject("SESSION_LIST_FAILED", e.message, e) }
  }

  @ReactMethod
  fun getChatMessages(sessionId: String, promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (r in db.getChatMessages(sessionId)) {
        arr.pushMap(Arguments.createMap().apply {
          putString("id", r.id); putString("role", r.role)
          if (r.content != null) putString("content", r.content) else putNull("content")
          putString("timestamp", r.timestamp)
          if (r.audioPath != null) putString("audioPath", r.audioPath) else putNull("audioPath")
          if (r.durationMs != null) putDouble("durationMs", r.durationMs.toDouble()) else putNull("durationMs")
          if (r.usageJson != null) putString("usageJson", r.usageJson) else putNull("usageJson")
          if (r.reasoning != null) putString("reasoning", r.reasoning) else putNull("reasoning")
          if (r.toolCalls != null) putString("toolCalls", r.toolCalls) else putNull("toolCalls")
          if (r.toolCallId != null) putString("toolCallId", r.toolCallId) else putNull("toolCallId")
          if (r.name != null) putString("name", r.name) else putNull("name")
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) { promise.reject("MESSAGES_GET_FAILED", e.message, e) }
  }

  @ReactMethod
  fun appendChatMessages(sessionId: String, rows: ReadableArray, promise: Promise) {
    try {
      val list = ArrayList<SolevupDb.ChatMessageRow>()
      for (i in 0 until rows.size()) {
        val m = rows.getMap(i) ?: continue
        list.add(SolevupDb.ChatMessageRow(
          id = m.getString("id") ?: continue,
          role = m.getString("role") ?: "user",
          content = if (m.hasKey("content") && !m.isNull("content")) m.getString("content") else null,
          timestamp = m.getString("timestamp") ?: "",
          audioPath = if (m.hasKey("audioPath") && !m.isNull("audioPath")) m.getString("audioPath") else null,
          durationMs = if (m.hasKey("durationMs") && !m.isNull("durationMs")) m.getDouble("durationMs").toLong() else null,
          usageJson = if (m.hasKey("usageJson") && !m.isNull("usageJson")) m.getString("usageJson") else null,
          reasoning = if (m.hasKey("reasoning") && !m.isNull("reasoning")) m.getString("reasoning") else null,
          toolCalls = if (m.hasKey("toolCalls") && !m.isNull("toolCalls")) m.getString("toolCalls") else null,
          toolCallId = if (m.hasKey("toolCallId") && !m.isNull("toolCallId")) m.getString("toolCallId") else null,
          name = if (m.hasKey("name") && !m.isNull("name")) m.getString("name") else null,
        ))
      }
      // false = 会话已是墓碑，写入被拒，JS 层新建会话接着写
      promise.resolve(db.appendChatMessages(sessionId, list))
    } catch (e: Throwable) { promise.reject("MESSAGES_APPEND_FAILED", e.message, e) }
  }

  @ReactMethod
  fun isChatSessionDeleted(sessionId: String, promise: Promise) {
    try { promise.resolve(db.isChatSessionDeleted(sessionId)) }
    catch (e: Throwable) { promise.reject("SESSION_STATE_FAILED", e.message, e) }
  }

  @ReactMethod
  fun searchChatSessions(query: String, limit: Double, promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (hit in db.searchChatSessions(query, limit.toInt())) {
        arr.pushMap(Arguments.createMap().apply {
          putMap("session", sessionToMap(hit.session))
          putArray("snippets", Arguments.createArray().apply {
            for (sn in hit.snippets) pushMap(Arguments.createMap().apply {
              putString("role", sn.role); putString("excerpt", sn.excerpt); putString("timestamp", sn.timestamp)
            })
          })
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) { promise.reject("SESSION_SEARCH_FAILED", e.message, e) }
  }

  @ReactMethod
  fun patchChatSession(sessionId: String, title: String?, summary: String?, promise: Promise) {
    try { db.patchChatSession(sessionId, title, summary); promise.resolve(true) }
    catch (e: Throwable) { promise.reject("SESSION_PATCH_FAILED", e.message, e) }
  }

  @ReactMethod
  fun deleteChatSession(sessionId: String, promise: Promise) {
    try { db.deleteChatSession(sessionId); promise.resolve(true) }
    catch (e: Throwable) { promise.reject("SESSION_DELETE_FAILED", e.message, e) }
  }

  @ReactMethod
  fun cleanupEmptyChatSessions(exceptId: String?, promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (id in db.cleanupEmptyChatSessions(exceptId)) arr.pushString(id)
      promise.resolve(arr)
    } catch (e: Throwable) { promise.reject("SESSION_CLEANUP_FAILED", e.message, e) }
  }

  companion object {
    const val NAME = "SolevupDb"
    private const val PREFS_NAME = "solevup_prefs"
    private const val LEGACY_PREFS_NAME = "solo_prefs"
  }
}
