package com.sololevelingsystemmobile.solodb

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap

/**
 * SoloDb 桥接 —— Phase 0：只暴露 ping / deviceId / stats，验证 SQLite 跑通。
 * 后续阶段会扩展 listCategories / upsertActivityBlock 等领域方法。
 */
class SoloDbModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  private val db: SoloDb by lazy { SoloDb(reactContext) }

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
      promise.reject("SOLODB_DEVICE_ID_FAILED", e.message, e)
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
      promise.reject("SOLODB_STATS_FAILED", e.message, e)
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
    } catch (e: Throwable) { promise.reject("SOLODB_LIST_CAT_FAILED", e.message, e) }
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
    } catch (e: Throwable) { promise.reject("SOLODB_LIST_TAG_FAILED", e.message, e) }
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
    } catch (e: Throwable) { promise.reject("SOLODB_LIST_BLOCKS_FAILED", e.message, e) }
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
    } catch (e: Throwable) { promise.reject("SOLODB_UPSERT_CAT_FAILED", e.message, e) }
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
    } catch (e: Throwable) { promise.reject("SOLODB_UPSERT_TAG_FAILED", e.message, e) }
  }

  @ReactMethod
  fun deleteTag(tagId: Double, promise: Promise) {
    try {
      val n = db.deleteTag(tagId.toLong())
      promise.resolve(n.toDouble())
    } catch (e: Throwable) { promise.reject("SOLODB_DELETE_TAG_FAILED", e.message, e) }
  }

  @ReactMethod
  fun deleteCategory(categoryId: Double, promise: Promise) {
    try {
      val n = db.deleteCategory(categoryId.toLong())
      promise.resolve(n.toDouble())
    } catch (e: Throwable) { promise.reject("SOLODB_DELETE_CAT_FAILED", e.message, e) }
  }

  @ReactMethod
  fun renameCategory(categoryId: Double, newName: String?, newColor: String?, promise: Promise) {
    try {
      val n = db.renameCategory(categoryId.toLong(), newName, newColor)
      promise.resolve(n.toDouble())
    } catch (e: Throwable) { promise.reject("SOLODB_RENAME_CAT_FAILED", e.message, e) }
  }

  @ReactMethod
  fun renameTagPath(tagId: Double, newFullPath: String, promise: Promise) {
    try {
      val n = db.renameTagPath(tagId.toLong(), newFullPath)
      promise.resolve(n.toDouble())
    } catch (e: Throwable) { promise.reject("SOLODB_RENAME_TAG_FAILED", e.message, e) }
  }

  @ReactMethod
  fun paintBlocks(date: String, minutes: ReadableArray, tagId: Double, promise: Promise) {
    try {
      val arr = IntArray(minutes.size()) { minutes.getInt(it) }
      db.paintBlocks(date, arr, tagId.toLong())
      promise.resolve(arr.size.toDouble())
    } catch (e: Throwable) { promise.reject("SOLODB_PAINT_FAILED", e.message, e) }
  }

  // ── Sync export ──

  @ReactMethod
  fun importSync(payload: ReadableMap, promise: Promise) {
    try {
      // ReadableMap → SoloDb.SyncExport
      val syncExport = SoloDb.SyncExport(
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
      promise.reject("SOLODB_IMPORT_FAILED", e.message, e)
    }
  }

  private fun readCats(arr: ReadableArray?): List<SoloDb.SyncCategoryRow> {
    if (arr == null) return emptyList()
    val out = ArrayList<SoloDb.SyncCategoryRow>(arr.size())
    for (i in 0 until arr.size()) {
      val m = arr.getMap(i) ?: continue
      out.add(SoloDb.SyncCategoryRow(
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

  private fun readTags(arr: ReadableArray?): List<SoloDb.SyncTagRow> {
    if (arr == null) return emptyList()
    val out = ArrayList<SoloDb.SyncTagRow>(arr.size())
    for (i in 0 until arr.size()) {
      val m = arr.getMap(i) ?: continue
      out.add(SoloDb.SyncTagRow(
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

  private fun readBlocks(arr: ReadableArray?): List<SoloDb.SyncBlockRow> {
    if (arr == null) return emptyList()
    val out = ArrayList<SoloDb.SyncBlockRow>(arr.size())
    for (i in 0 until arr.size()) {
      val m = arr.getMap(i) ?: continue
      out.add(SoloDb.SyncBlockRow(
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

  private fun readPlanNodes(arr: ReadableArray?): List<SoloDb.SyncPlanNodeRow> {
    if (arr == null) return emptyList()
    val out = ArrayList<SoloDb.SyncPlanNodeRow>(arr.size())
    for (i in 0 until arr.size()) {
      val m = arr.getMap(i) ?: continue
      out.add(SoloDb.SyncPlanNodeRow(
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

  private fun readPlannedBlocks(arr: ReadableArray?): List<SoloDb.SyncPlannedBlockRow> {
    if (arr == null) return emptyList()
    val out = ArrayList<SoloDb.SyncPlannedBlockRow>(arr.size())
    for (i in 0 until arr.size()) {
      val m = arr.getMap(i) ?: continue
      out.add(SoloDb.SyncPlannedBlockRow(
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
      promise.reject("SOLODB_EXPORT_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun eraseBlocks(date: String, minutes: ReadableArray, promise: Promise) {
    try {
      val arr = IntArray(minutes.size()) { minutes.getInt(it) }
      db.eraseBlocks(date, arr)
      promise.resolve(arr.size.toDouble())
    } catch (e: Throwable) { promise.reject("SOLODB_ERASE_FAILED", e.message, e) }
  }

  // ── 设备本地偏好（SharedPreferences）——
  // 跟 SoloDb sqlite 解耦：zoom / focus 这些设备本地的 UI 偏好不走 LWW 同步，
  // 每台设备独立。重装 app 才会丢。

  @ReactMethod
  fun getPref(key: String, fallback: String, promise: Promise) {
    try {
      val prefs = reactContext.getSharedPreferences("solo_prefs", android.content.Context.MODE_PRIVATE)
      promise.resolve(prefs.getString(key, fallback) ?: fallback)
    } catch (e: Throwable) { promise.reject("PREF_GET_FAILED", e.message, e) }
  }

  @ReactMethod
  fun setPref(key: String, value: String, promise: Promise) {
    try {
      val prefs = reactContext.getSharedPreferences("solo_prefs", android.content.Context.MODE_PRIVATE)
      prefs.edit().putString(key, value).apply()
      promise.resolve(true)
    } catch (e: Throwable) { promise.reject("PREF_SET_FAILED", e.message, e) }
  }

  companion object {
    const val NAME = "SoloDb"
  }
}
