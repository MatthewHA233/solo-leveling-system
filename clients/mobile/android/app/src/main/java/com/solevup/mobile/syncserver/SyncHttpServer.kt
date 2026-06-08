package com.solevup.mobile.syncserver

import com.solevup.mobile.solevupdb.SolevupDb
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject

/**
 * Phase 2-C：LAN 同步 HTTP server。
 *
 * 路由对齐 desktop ApiState（clients/desktop/src-tauri/src/api.rs 的
 * /api/sync/export + /api/sync/import 协议），让 desktop sync_engine.rs
 * 的 bidirectional_sync 能直接 pull / push 这台手机。
 *
 *   GET  /api/sync/export[?since=ISO]   → ApiEnvelope<SyncExport>
 *   POST /api/sync/import (body=SyncExport JSON) → ApiEnvelope<SyncImportResult>
 *   GET  /api/ping                       → ApiEnvelope<{ deviceId, alias }>
 *
 * 任意失败一律返 200 + { success: false, error }（desktop ApiEnvelope 约定）。
 */
class SyncHttpServer(
  port: Int,
  private val db: SolevupDb,
  private val alias: String = "Solevup Mobile",
  private val onImport: ((SolevupDb.ImportResult) -> Unit)? = null,
) : NanoHTTPD(port) {

  override fun serve(session: IHTTPSession): Response {
    val uri = session.uri ?: "/"
    return try {
      when {
        // desktop SyncPeerDialog 走 /api/sync/hello 做握手；/api/ping 是 alias 兜底
        session.method == Method.GET && (uri == "/api/sync/hello" || uri == "/api/ping") -> handlePing()
        session.method == Method.GET && uri == "/api/sync/export" -> handleExport(session)
        session.method == Method.POST && uri == "/api/sync/import" -> handleImport(session)
        else -> envelopeError("not found: $uri")
      }
    } catch (e: Throwable) {
      envelopeError(e.message ?: "internal error")
    }
  }

  private fun handlePing(): Response {
    // 协议字段对齐 desktop api.rs SyncHello (snake_case)；
    // 字段不全会让 desktop fetchSyncHello 解析失败 → 手动建链反馈"连接失败"。
    val devId = db.deviceId()
    val payload = JSONObject().apply {
      put("device_id", devId)
      put("pair_code", pairCode(devId))
      put("server_time", java.text.SimpleDateFormat(
        "yyyy-MM-dd HH:mm:ss", java.util.Locale.US,
      ).apply { timeZone = java.util.TimeZone.getDefault() }.format(java.util.Date()))
      put("protocol_version", 1)
      put("tables", org.json.JSONArray(listOf(
        "activity_categories", "activity_tags", "activity_blocks",
        "plan_nodes", "planned_blocks",
      )))
      put("alias", alias)
      put("device_type", "mobile")
      put("device_model", android.os.Build.MODEL ?: "Android")
    }
    return envelope(payload)
  }

  /**
   * 跟 desktop db.rs sync_pair_code 完全一致的 FNV-1a 64bit hash + 8 字符
   * "XXXX-XXXX" 大写格式。LinkPeer 比对用，必须一致才能识别同设备。
   */
  private fun pairCode(deviceId: String): String {
    val input = "solevup:sync:v1:$deviceId"
    var hash = 0xcbf29ce484222325UL
    for (byte in input.toByteArray(Charsets.UTF_8)) {
      hash = hash xor (byte.toUByte().toULong())
      hash = (hash * 0x100000001b3UL)
    }
    val hex = hash.toString(16).padStart(16, '0')
    return "${hex.substring(0, 4)}-${hex.substring(4, 8)}".uppercase()
  }

  private fun handleExport(session: IHTTPSession): Response {
    val since = session.parameters["since"]?.firstOrNull()
    val ex = db.exportSync(since)
    val payload = exportToJson(ex)
    return envelope(payload)
  }

  private fun handleImport(session: IHTTPSession): Response {
    // ⚠ NanoHTTPD parseBody().get("postData") 内部走 ISO-8859-1 解码
    // (NanoHTTPD 2.3.1 HTTPSession.java 硬编码 String(buf, "ISO-8859-1"))，
    // UTF-8 中文每个字 3 字节会被错拆成 3 个西欧字符，落到 mobile DB 就是乱码。
    // 改成直接从 input stream 读 raw bytes，按 Content-Length 截断，UTF-8 解码。
    val len = session.headers["content-length"]?.toIntOrNull() ?: 0
    val bodyStr = if (len > 0) {
      val buf = ByteArray(len)
      var off = 0
      while (off < len) {
        val r = session.inputStream.read(buf, off, len - off)
        if (r <= 0) break
        off += r
      }
      String(buf, 0, off, Charsets.UTF_8)
    } else "{}"
    val payload = jsonToExport(JSONObject(bodyStr))
    val r = db.importSync(payload)
    if (r.activityCategories + r.activityTags + r.activityBlocks + r.planNodes + r.plannedBlocks > 0) {
      onImport?.invoke(r)
    }
    // SyncImportResult 字段名对齐 desktop db.rs
    val rJson = JSONObject().apply {
      put("activity_categories", r.activityCategories)
      put("activity_tags", r.activityTags)
      put("activity_blocks", r.activityBlocks)
      put("plan_nodes", r.planNodes)
      put("planned_blocks", r.plannedBlocks)
      put("skipped", r.skipped)
    }
    return envelope(rJson)
  }

  // ── JSON 编解码（HTTP wire format 严格对齐 desktop SyncExport snake_case） ──
  // desktop db.rs 的 SyncExport / SyncActivityXxx 全部 snake_case 字段，
  // 没用 #[serde(rename_all)]；mobile 内部 native module 可以是 camelCase，
  // 但 HTTP 端必须 snake_case 才能跟 desktop 互通。

  private fun exportToJson(ex: SolevupDb.SyncExport): JSONObject {
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

  private fun nullableString(o: JSONObject, key: String): String? {
    return if (o.isNull(key)) null else o.optString(key)
  }

  private fun jsonToExport(o: JSONObject): SolevupDb.SyncExport {
    return SolevupDb.SyncExport(
      deviceId = o.optString("device_id"),
      exportedAt = o.optString("exported_at"),
      cursor = o.optString("cursor"),
      activityCategories = jsonArr(o, "activity_categories") { it ->
        SolevupDb.SyncCategoryRow(
          syncId = it.optString("sync_id"), name = it.optString("name"),
          color = it.optString("color", "#888"),
          sortOrder = it.optInt("sort_order"),
          createdAt = it.optString("created_at"), lastUsedAt = it.optString("last_used_at"),
          updatedAt = it.optString("updated_at"),
          deletedAt = nullableString(it, "deleted_at"),
        )
      },
      activityTags = jsonArr(o, "activity_tags") { it ->
        SolevupDb.SyncTagRow(
          syncId = it.optString("sync_id"), categorySyncId = it.optString("category_sync_id"),
          fullPath = it.optString("full_path"), leafName = it.optString("leaf_name"),
          depth = it.optInt("depth", 1),
          createdAt = it.optString("created_at"), lastUsedAt = it.optString("last_used_at"),
          updatedAt = it.optString("updated_at"),
          deletedAt = nullableString(it, "deleted_at"),
        )
      },
      activityBlocks = jsonArr(o, "activity_blocks") { it ->
        SolevupDb.SyncBlockRow(
          syncId = it.optString("sync_id"), date = it.optString("date"),
          minute = it.optInt("minute"), tagSyncId = it.optString("tag_sync_id"),
          note = nullableString(it, "note"),
          createdAt = it.optString("created_at"), updatedAt = it.optString("updated_at"),
          deletedAt = nullableString(it, "deleted_at"),
        )
      },
      planNodes = jsonArr(o, "plan_nodes") { it ->
        SolevupDb.SyncPlanNodeRow(
          syncId = it.optString("sync_id"),
          projectTagSyncId = it.optString("project_tag_sync_id"),
          parentSyncId = nullableString(it, "parent_sync_id"),
          title = it.optString("title"), status = it.optString("status", "active"),
          sortOrder = it.optInt("sort_order"),
          createdAt = it.optString("created_at"), updatedAt = it.optString("updated_at"),
          deletedAt = nullableString(it, "deleted_at"),
        )
      },
      plannedBlocks = jsonArr(o, "planned_blocks") { it ->
        SolevupDb.SyncPlannedBlockRow(
          syncId = it.optString("sync_id"), date = it.optString("date"),
          minute = it.optInt("minute"), planNodeSyncId = it.optString("plan_node_sync_id"),
          note = nullableString(it, "note"),
          createdAt = it.optString("created_at"), updatedAt = it.optString("updated_at"),
          deletedAt = nullableString(it, "deleted_at"),
        )
      },
    )
  }

  private fun <T> jsonArr(parent: JSONObject, key: String, parse: (JSONObject) -> T): List<T> {
    val arr = parent.optJSONArray(key) ?: return emptyList()
    val out = ArrayList<T>(arr.length())
    for (i in 0 until arr.length()) {
      val o = arr.optJSONObject(i) ?: continue
      try { out.add(parse(o)) } catch (_: Throwable) {}
    }
    return out
  }

  // ── ApiEnvelope { success, data?, error? } ──
  private fun envelope(data: Any): Response {
    val body = JSONObject().apply {
      put("success", true)
      put("data", data)
    }
    // 显式带 UTF-8 charset，desktop 解析中文 alias 等字段就不会回退到 latin-1
    return newFixedLengthResponse(
      Response.Status.OK,
      "application/json; charset=UTF-8",
      body.toString(),
    )
  }

  private fun envelopeError(msg: String): Response {
    val body = JSONObject().apply {
      put("success", false)
      put("error", msg)
    }
    // 显式带 UTF-8 charset，desktop 解析中文 alias 等字段就不会回退到 latin-1
    return newFixedLengthResponse(
      Response.Status.OK,
      "application/json; charset=UTF-8",
      body.toString(),
    )
  }
}
