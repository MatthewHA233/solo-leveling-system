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
    // 字段名对齐 desktop sync_engine.rs / db.rs（snake_case）
    val payload = JSONObject().apply {
      put("device_id", db.deviceId())
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
    return SoloDb.SyncExport(
      deviceId = o.optString("device_id"),
      exportedAt = o.optString("exported_at"),
      cursor = o.optString("cursor"),
      activityCategories = jsonArr(o, "activity_categories") { it ->
        SoloDb.SyncCategoryRow(
          syncId = it.optString("sync_id"), name = it.optString("name"),
          color = it.optString("color", "#888"),
          sortOrder = it.optInt("sort_order"),
          createdAt = it.optString("created_at"), lastUsedAt = it.optString("last_used_at"),
          updatedAt = it.optString("updated_at"),
          deletedAt = if (it.isNull("deleted_at")) null else it.optString("deleted_at", null),
        )
      },
      activityTags = jsonArr(o, "activity_tags") { it ->
        SoloDb.SyncTagRow(
          syncId = it.optString("sync_id"), categorySyncId = it.optString("category_sync_id"),
          fullPath = it.optString("full_path"), leafName = it.optString("leaf_name"),
          depth = it.optInt("depth", 1),
          createdAt = it.optString("created_at"), lastUsedAt = it.optString("last_used_at"),
          updatedAt = it.optString("updated_at"),
          deletedAt = if (it.isNull("deleted_at")) null else it.optString("deleted_at", null),
        )
      },
      activityBlocks = jsonArr(o, "activity_blocks") { it ->
        SoloDb.SyncBlockRow(
          syncId = it.optString("sync_id"), date = it.optString("date"),
          minute = it.optInt("minute"), tagSyncId = it.optString("tag_sync_id"),
          note = if (it.isNull("note")) null else it.optString("note", null),
          createdAt = it.optString("created_at"), updatedAt = it.optString("updated_at"),
          deletedAt = if (it.isNull("deleted_at")) null else it.optString("deleted_at", null),
        )
      },
      planNodes = jsonArr(o, "plan_nodes") { it ->
        SoloDb.SyncPlanNodeRow(
          syncId = it.optString("sync_id"),
          projectTagSyncId = it.optString("project_tag_sync_id"),
          parentSyncId = if (it.isNull("parent_sync_id")) null else it.optString("parent_sync_id", null),
          title = it.optString("title"), status = it.optString("status", "active"),
          sortOrder = it.optInt("sort_order"),
          createdAt = it.optString("created_at"), updatedAt = it.optString("updated_at"),
          deletedAt = if (it.isNull("deleted_at")) null else it.optString("deleted_at", null),
        )
      },
      plannedBlocks = jsonArr(o, "planned_blocks") { it ->
        SoloDb.SyncPlannedBlockRow(
          syncId = it.optString("sync_id"), date = it.optString("date"),
          minute = it.optInt("minute"), planNodeSyncId = it.optString("plan_node_sync_id"),
          note = if (it.isNull("note")) null else it.optString("note", null),
          createdAt = it.optString("created_at"), updatedAt = it.optString("updated_at"),
          deletedAt = if (it.isNull("deleted_at")) null else it.optString("deleted_at", null),
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
