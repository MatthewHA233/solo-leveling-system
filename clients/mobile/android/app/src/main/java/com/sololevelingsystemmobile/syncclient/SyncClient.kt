package com.sololevelingsystemmobile.syncclient

import android.util.Log
import com.sololevelingsystemmobile.solodb.SoloDb
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/**
 * Mobile 主动 HTTP client，跟 desktop sync_engine.rs bidirectional_sync 同形态：
 *   1) GET <peerBase>/api/sync/export  → 拉对端 export
 *   2) 本地 importSync()                → LWW 合并
 *   3) 本地 exportSync()                → 本端快照
 *   4) POST <peerBase>/api/sync/import  → 推给对端
 *
 * 不依赖 OkHttp，纯 java.net.HttpURLConnection 加 UTF-8 编解码。
 * 任意 step 失败抛 SyncException，调用方负责打日志或记录到 linked_devices。
 */
object SyncClient {
  private const val TAG = "SyncClient"
  private const val CONNECT_TIMEOUT_MS = 5_000
  private const val READ_TIMEOUT_MS = 30_000
  private const val MAX_BODY_LEN = 32 * 1024 * 1024  // 32MB 安全上限

  data class SyncRoundResult(
    val pulled: SoloDb.ImportResult,
    val pushed: SoloDb.ImportResult,
    val peerDeviceId: String,
    val peerAlias: String,
  )

  class SyncException(msg: String, cause: Throwable? = null) : Exception(msg, cause)

  /**
   * 完整双向同步。对端 base 形如 "http://192.168.0.104:49733"。
   * 失败任意一步立刻抛错并带上下文。
   */
  fun bidirectionalSync(db: SoloDb, peerBase: String): SyncRoundResult {
    val base = normalizeBase(peerBase)
    Log.i(TAG, "bidirectionalSync start: $base")

    // 1) pull 对端 export
    val remoteEnvelope = httpGetJson("$base/api/sync/export")
      ?: throw SyncException("拉取对端 export 失败: 空响应")
    if (!remoteEnvelope.optBoolean("success")) {
      throw SyncException("对端 export 错误: ${remoteEnvelope.optString("error", "unknown")}")
    }
    val remoteData = remoteEnvelope.optJSONObject("data")
      ?: throw SyncException("对端 export 数据为空")
    val remoteSnapshot = jsonToExport(remoteData)
    val peerDeviceId = remoteSnapshot.deviceId
    val peerAlias = remoteData.optString("alias", peerDeviceId)  // export 里没 alias，先用 device_id 顶

    // 2) 本地 import
    val pulled = db.importSync(remoteSnapshot)
    Log.i(TAG, "pulled: cats=${pulled.activityCategories} tags=${pulled.activityTags} " +
      "blocks=${pulled.activityBlocks} skipped=${pulled.skipped}")

    // 3) 本地 export
    val localSnapshot = db.exportSync(null)

    // 4) push 对端 import
    val pushEnvelope = httpPostJson("$base/api/sync/import", exportToJson(localSnapshot))
      ?: throw SyncException("推送对端 import 失败: 空响应")
    if (!pushEnvelope.optBoolean("success")) {
      throw SyncException("对端 import 错误: ${pushEnvelope.optString("error", "unknown")}")
    }
    val pushData = pushEnvelope.optJSONObject("data") ?: JSONObject()
    val pushed = SoloDb.ImportResult(
      activityCategories = pushData.optInt("activity_categories"),
      activityTags = pushData.optInt("activity_tags"),
      activityBlocks = pushData.optInt("activity_blocks"),
      planNodes = pushData.optInt("plan_nodes"),
      plannedBlocks = pushData.optInt("planned_blocks"),
      skipped = pushData.optInt("skipped"),
    )
    Log.i(TAG, "pushed: cats=${pushed.activityCategories} tags=${pushed.activityTags} " +
      "blocks=${pushed.activityBlocks} skipped=${pushed.skipped}")

    return SyncRoundResult(pulled, pushed, peerDeviceId, peerAlias)
  }

  /** GET <url>/api/sync/hello → 拿对端 device_id + alias 给 addLinkedDevice 用。 */
  fun fetchHello(peerBase: String): JSONObject {
    val base = normalizeBase(peerBase)
    val envelope = httpGetJson("$base/api/sync/hello")
      ?: throw SyncException("hello 失败: 空响应")
    if (!envelope.optBoolean("success")) {
      throw SyncException("hello 错误: ${envelope.optString("error", "unknown")}")
    }
    return envelope.optJSONObject("data")
      ?: throw SyncException("hello 数据为空")
  }

  private fun normalizeBase(raw: String): String {
    val trimmed = raw.trim().trimEnd('/')
    val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      trimmed
    } else "http://$trimmed"
    // 没端口默认 49733
    val url = URL(withScheme)
    val port = if (url.port == -1) 49733 else url.port
    return "${url.protocol}://${url.host}:$port"
  }

  private fun httpGetJson(url: String): JSONObject? {
    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      setRequestProperty("Accept", "application/json")
      useCaches = false
      if (this is HttpsURLConnection) {
        // 同 desktop sync_engine.rs 不走系统代理；HttpURLConnection 默认会读
        // http_proxy env，模拟器/真机一般没设，先不强 noproxy
      }
    }
    return try {
      conn.connect()
      val code = conn.responseCode
      if (code !in 200..299) throw SyncException("GET $url -> HTTP $code")
      val bytes = conn.inputStream.use { it.readBytes() }
      if (bytes.size > MAX_BODY_LEN) throw SyncException("响应过大: ${bytes.size} bytes")
      JSONObject(String(bytes, Charsets.UTF_8))
    } finally {
      conn.disconnect()
    }
  }

  private fun httpPostJson(url: String, payload: JSONObject): JSONObject? {
    val bodyBytes = payload.toString().toByteArray(Charsets.UTF_8)
    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      doOutput = true
      setRequestProperty("Accept", "application/json")
      setRequestProperty("Content-Type", "application/json; charset=UTF-8")
      setFixedLengthStreamingMode(bodyBytes.size)
      useCaches = false
    }
    return try {
      conn.connect()
      conn.outputStream.use { it.write(bodyBytes) }
      val code = conn.responseCode
      if (code !in 200..299) throw SyncException("POST $url -> HTTP $code")
      val bytes = conn.inputStream.use { it.readBytes() }
      if (bytes.size > MAX_BODY_LEN) throw SyncException("响应过大: ${bytes.size} bytes")
      JSONObject(String(bytes, Charsets.UTF_8))
    } finally {
      conn.disconnect()
    }
  }

  // ── JSON ↔ SyncExport 转换（snake_case，跟 SyncHttpServer 那边一致） ──

  private fun exportToJson(ex: SoloDb.SyncExport): JSONObject {
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
    return o
  }

  private fun jsonToExport(o: JSONObject): SoloDb.SyncExport {
    fun nullable(obj: JSONObject, key: String): String? =
      if (obj.isNull(key)) null else obj.optString(key, null)

    return SoloDb.SyncExport(
      deviceId = o.optString("device_id"),
      exportedAt = o.optString("exported_at"),
      cursor = o.optString("cursor"),
      activityCategories = arr(o, "activity_categories") {
        SoloDb.SyncCategoryRow(
          syncId = it.optString("sync_id"), name = it.optString("name"),
          color = it.optString("color", "#888"),
          sortOrder = it.optInt("sort_order"),
          createdAt = it.optString("created_at"), lastUsedAt = it.optString("last_used_at"),
          updatedAt = it.optString("updated_at"),
          deletedAt = nullable(it, "deleted_at"),
        )
      },
      activityTags = arr(o, "activity_tags") {
        SoloDb.SyncTagRow(
          syncId = it.optString("sync_id"), categorySyncId = it.optString("category_sync_id"),
          fullPath = it.optString("full_path"), leafName = it.optString("leaf_name"),
          depth = it.optInt("depth", 1),
          createdAt = it.optString("created_at"), lastUsedAt = it.optString("last_used_at"),
          updatedAt = it.optString("updated_at"),
          deletedAt = nullable(it, "deleted_at"),
        )
      },
      activityBlocks = arr(o, "activity_blocks") {
        SoloDb.SyncBlockRow(
          syncId = it.optString("sync_id"), date = it.optString("date"),
          minute = it.optInt("minute"), tagSyncId = it.optString("tag_sync_id"),
          note = nullable(it, "note"),
          createdAt = it.optString("created_at"), updatedAt = it.optString("updated_at"),
          deletedAt = nullable(it, "deleted_at"),
        )
      },
      planNodes = arr(o, "plan_nodes") {
        SoloDb.SyncPlanNodeRow(
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
        SoloDb.SyncPlannedBlockRow(
          syncId = it.optString("sync_id"), date = it.optString("date"),
          minute = it.optInt("minute"), planNodeSyncId = it.optString("plan_node_sync_id"),
          note = nullable(it, "note"),
          createdAt = it.optString("created_at"), updatedAt = it.optString("updated_at"),
          deletedAt = nullable(it, "deleted_at"),
        )
      },
    )
  }

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
