package com.sololevelingsystemmobile.syncserver

import com.sololevelingsystemmobile.solodb.SoloDb
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
  private val db: SoloDb,
  private val alias: String = "Solo Leveling Mobile",
) : NanoHTTPD(port) {

  override fun serve(session: IHTTPSession): Response {
    val uri = session.uri ?: "/"
    return try {
      when {
        session.method == Method.GET && uri == "/api/ping" -> handlePing()
        session.method == Method.GET && uri == "/api/sync/export" -> handleExport(session)
        session.method == Method.POST && uri == "/api/sync/import" -> handleImport(session)
        else -> envelopeError("not found: $uri")
      }
    } catch (e: Throwable) {
      envelopeError(e.message ?: "internal error")
    }
  }

  private fun handlePing(): Response {
    val payload = JSONObject().apply {
      put("deviceId", db.deviceId())
      put("alias", alias)
    }
    return envelope(payload)
  }

  private fun handleExport(session: IHTTPSession): Response {
    val since = session.parameters["since"]?.firstOrNull()
    val ex = db.exportSync(since)
    val payload = exportToJson(ex)
    return envelope(payload)
  }

  private fun handleImport(session: IHTTPSession): Response {
    // NanoHTTPD POST body 要先 parse 才能拿到（不是约定俗成的 ServletRequest）
    val files = HashMap<String, String>()
    session.parseBody(files)
    val bodyStr = files["postData"] ?: session.parameters["body"]?.firstOrNull() ?: "{}"
    val payload = jsonToExport(JSONObject(bodyStr))
    val r = db.importSync(payload)
    val rJson = JSONObject().apply {
      put("activityCategories", r.activityCategories)
      put("activityTags", r.activityTags)
      put("activityBlocks", r.activityBlocks)
      put("planNodes", r.planNodes)
      put("plannedBlocks", r.plannedBlocks)
      put("skipped", r.skipped)
    }
    return envelope(rJson)
  }

  // ── JSON 编解码（对齐 desktop SyncExport 字段名） ──

  private fun exportToJson(ex: SoloDb.SyncExport): JSONObject {
    val o = JSONObject()
    o.put("deviceId", ex.deviceId)
    o.put("exportedAt", ex.exportedAt)
    o.put("cursor", ex.cursor)
    o.put("activityCategories", JSONArray().apply {
      for (r in ex.activityCategories) put(JSONObject().apply {
        put("syncId", r.syncId); put("name", r.name); put("color", r.color)
        put("sortOrder", r.sortOrder); put("createdAt", r.createdAt)
        put("lastUsedAt", r.lastUsedAt); put("updatedAt", r.updatedAt)
        if (r.deletedAt != null) put("deletedAt", r.deletedAt)
      })
    })
    o.put("activityTags", JSONArray().apply {
      for (r in ex.activityTags) put(JSONObject().apply {
        put("syncId", r.syncId); put("categorySyncId", r.categorySyncId)
        put("fullPath", r.fullPath); put("leafName", r.leafName); put("depth", r.depth)
        put("createdAt", r.createdAt); put("lastUsedAt", r.lastUsedAt)
        put("updatedAt", r.updatedAt)
        if (r.deletedAt != null) put("deletedAt", r.deletedAt)
      })
    })
    o.put("activityBlocks", JSONArray().apply {
      for (r in ex.activityBlocks) put(JSONObject().apply {
        put("syncId", r.syncId); put("date", r.date); put("minute", r.minute)
        put("tagSyncId", r.tagSyncId)
        if (r.note != null) put("note", r.note)
        put("createdAt", r.createdAt); put("updatedAt", r.updatedAt)
        if (r.deletedAt != null) put("deletedAt", r.deletedAt)
      })
    })
    o.put("planNodes", JSONArray().apply {
      for (r in ex.planNodes) put(JSONObject().apply {
        put("syncId", r.syncId); put("projectTagSyncId", r.projectTagSyncId)
        if (r.parentSyncId != null) put("parentSyncId", r.parentSyncId)
        put("title", r.title); put("status", r.status); put("sortOrder", r.sortOrder)
        put("createdAt", r.createdAt); put("updatedAt", r.updatedAt)
        if (r.deletedAt != null) put("deletedAt", r.deletedAt)
      })
    })
    o.put("plannedBlocks", JSONArray().apply {
      for (r in ex.plannedBlocks) put(JSONObject().apply {
        put("syncId", r.syncId); put("date", r.date); put("minute", r.minute)
        put("planNodeSyncId", r.planNodeSyncId)
        if (r.note != null) put("note", r.note)
        put("createdAt", r.createdAt); put("updatedAt", r.updatedAt)
        if (r.deletedAt != null) put("deletedAt", r.deletedAt)
      })
    })
    return o
  }

  private fun jsonToExport(o: JSONObject): SoloDb.SyncExport {
    return SoloDb.SyncExport(
      deviceId = o.optString("deviceId"),
      exportedAt = o.optString("exportedAt"),
      cursor = o.optString("cursor"),
      activityCategories = jsonArr(o, "activityCategories") { it ->
        SoloDb.SyncCategoryRow(
          syncId = it.optString("syncId"), name = it.optString("name"),
          color = it.optString("color", "#888"),
          sortOrder = it.optInt("sortOrder"),
          createdAt = it.optString("createdAt"), lastUsedAt = it.optString("lastUsedAt"),
          updatedAt = it.optString("updatedAt"),
          deletedAt = if (it.isNull("deletedAt")) null else it.optString("deletedAt", null),
        )
      },
      activityTags = jsonArr(o, "activityTags") { it ->
        SoloDb.SyncTagRow(
          syncId = it.optString("syncId"), categorySyncId = it.optString("categorySyncId"),
          fullPath = it.optString("fullPath"), leafName = it.optString("leafName"),
          depth = it.optInt("depth", 1),
          createdAt = it.optString("createdAt"), lastUsedAt = it.optString("lastUsedAt"),
          updatedAt = it.optString("updatedAt"),
          deletedAt = if (it.isNull("deletedAt")) null else it.optString("deletedAt", null),
        )
      },
      activityBlocks = jsonArr(o, "activityBlocks") { it ->
        SoloDb.SyncBlockRow(
          syncId = it.optString("syncId"), date = it.optString("date"),
          minute = it.optInt("minute"), tagSyncId = it.optString("tagSyncId"),
          note = if (it.isNull("note")) null else it.optString("note", null),
          createdAt = it.optString("createdAt"), updatedAt = it.optString("updatedAt"),
          deletedAt = if (it.isNull("deletedAt")) null else it.optString("deletedAt", null),
        )
      },
      planNodes = jsonArr(o, "planNodes") { it ->
        SoloDb.SyncPlanNodeRow(
          syncId = it.optString("syncId"),
          projectTagSyncId = it.optString("projectTagSyncId"),
          parentSyncId = if (it.isNull("parentSyncId")) null else it.optString("parentSyncId", null),
          title = it.optString("title"), status = it.optString("status", "active"),
          sortOrder = it.optInt("sortOrder"),
          createdAt = it.optString("createdAt"), updatedAt = it.optString("updatedAt"),
          deletedAt = if (it.isNull("deletedAt")) null else it.optString("deletedAt", null),
        )
      },
      plannedBlocks = jsonArr(o, "plannedBlocks") { it ->
        SoloDb.SyncPlannedBlockRow(
          syncId = it.optString("syncId"), date = it.optString("date"),
          minute = it.optInt("minute"), planNodeSyncId = it.optString("planNodeSyncId"),
          note = if (it.isNull("note")) null else it.optString("note", null),
          createdAt = it.optString("createdAt"), updatedAt = it.optString("updatedAt"),
          deletedAt = if (it.isNull("deletedAt")) null else it.optString("deletedAt", null),
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
    return newFixedLengthResponse(Response.Status.OK, "application/json", body.toString())
  }

  private fun envelopeError(msg: String): Response {
    val body = JSONObject().apply {
      put("success", false)
      put("error", msg)
    }
    return newFixedLengthResponse(Response.Status.OK, "application/json", body.toString())
  }
}
