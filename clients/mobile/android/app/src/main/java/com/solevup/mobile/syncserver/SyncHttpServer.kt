package com.solevup.mobile.syncserver

import com.solevup.mobile.solevupdb.SolevupDb
import com.solevup.mobile.solevupdb.SyncJson
import com.solevup.mobile.sync.SyncPairing
import com.solevup.mobile.sync.SyncProtocol
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
 *   GET  /api/sync/chat?since=N&peer=ID  → ApiEnvelope<ChatSyncPage>（聊天记录增量分页）
 *   POST /api/sync/chat (body=ChatSyncPage JSON) → ApiEnvelope<SyncImportResult>
 *   POST /api/sync/pair  → 拿配对码换令牌（规则见 SyncPairing）
 *   POST /api/sync/unpair → 对方解除了链接，这边也删掉
 *
 * hello、ping 和 pair 公开，其余都要带配对令牌，没带的返 401。
 * 其他失败一律返 200 + { success: false, error }（desktop ApiEnvelope 约定）。
 */
class SyncHttpServer(
  port: Int,
  private val db: SolevupDb,
  private val alias: String = "Solevup Mobile",
  private val pairing: SyncPairing,
  private val onLinksChanged: (deviceId: String) -> Unit,
  private val onImport: ((deviceId: String, remoteIp: String?, result: SolevupDb.ImportResult) -> Unit)? = null,
) : NanoHTTPD(port) {

  override fun serve(session: IHTTPSession): Response {
    val uri = session.uri ?: "/"
    val response = try {
      when {
        // 浏览器跨域预检：直接放行（真正的请求由下方路由处理）
        session.method == Method.OPTIONS -> newFixedLengthResponse(Response.Status.NO_CONTENT, "text/plain", "")
        // desktop SyncPeerDialog 走 /api/sync/hello 做握手；/api/ping 是 alias 兜底
        session.method == Method.GET && (uri == "/api/sync/hello" || uri == "/api/ping") -> handlePing(session)
        session.method == Method.POST && uri == "/api/sync/pair" -> handlePair(session)
        callerDeviceId(session) == null -> unauthorized()
        session.method == Method.POST && uri == "/api/sync/unpair" -> handleUnpair(session)
        session.method == Method.GET && uri == "/api/sync/export" -> handleExport(session)
        session.method == Method.POST && uri == "/api/sync/import" -> handleImport(session)
        session.method == Method.GET && uri == "/api/sync/chat" -> handleChatPage(session)
        session.method == Method.POST && uri == "/api/sync/chat" -> handleChatImport(session)
        else -> envelopeError("not found: $uri")
      }
    } catch (e: Throwable) {
      envelopeError(e.message ?: "internal error")
    }
    return withCors(response)
  }

  /**
   * 允许跨域：desktop 页面跑在 http://localhost:5172，直接 fetch 本机属于跨域，
   * 不带这组头会被 WebView2 拦下（表现为电脑端"建立链接"点了没反应、手机永远显示离线）。
   * 这个端口上的数据接口都要令牌，放开来源不影响安全。
   */
  private fun withCors(response: Response): Response = response.apply {
    addHeader("Access-Control-Allow-Origin", "*")
    addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
    addHeader("Access-Control-Max-Age", "600")
  }

  /** 令牌属于哪台已链接设备，没带或无效返回 null */
  private fun callerDeviceId(session: IHTTPSession): String? =
    SyncPairing.bearerToken(session.headers["authorization"])?.let { db.linkedDeviceByToken(it) }

  private fun unauthorized(): Response {
    val body = JSONObject().apply {
      put("success", false)
      put("error", "这台设备还没有配对")
    }
    return newFixedLengthResponse(Response.Status.UNAUTHORIZED, "application/json; charset=UTF-8", body.toString())
  }

  /** 对方拿配对码来换令牌。两边都记成已链接，之后不用再输 */
  private fun handlePair(session: IHTTPSession): Response {
    val body = JSONObject(readBody(session, MAX_PAIR_BODY_LEN))
    val peerId = body.optString("device_id").trim()
    if (peerId.isEmpty() || peerId == db.deviceId()) return envelopeError("对方设备 ID 不对")
    pairing.verify(body.optString("code"))?.let { return envelopeError(it) }
    val token = SyncPairing.newToken()
    val base = "http://${session.remoteIpAddress}:${SyncProtocol.DEFAULT_PORT}"
    db.addLinkedDevice(peerId, body.optString("alias", peerId), base, token)
    onLinksChanged(peerId)
    return envelope(JSONObject().apply {
      put("token", token)
      put("device_id", db.deviceId())
      put("alias", alias)
    })
  }

  private fun handleUnpair(session: IHTTPSession): Response {
    val peerId = callerDeviceId(session) ?: return unauthorized()
    db.removeLinkedDevice(peerId)
    onLinksChanged(peerId)
    return envelope(JSONObject.NULL)
  }

  private fun handlePing(session: IHTTPSession): Response {
    // 协议字段对齐 desktop api.rs SyncHello (snake_case)；
    // 字段不全会让 desktop fetchSyncHello 解析失败 → 手动建链反馈"连接失败"。
    val devId = db.deviceId()
    val payload = JSONObject().apply {
      put("device_id", devId)
      put("pair_code", SyncProtocol.pairCode(devId))
      put("server_time", java.text.SimpleDateFormat(
        "yyyy-MM-dd HH:mm:ss", java.util.Locale.US,
      ).apply { timeZone = java.util.TimeZone.getDefault() }.format(java.util.Date()))
      put("protocol_version", 2)
      // 问话方是已配对设备时的挑战应答
      val peer = session.parameters["peer"]?.firstOrNull()
      val challenge = session.parameters["challenge"]?.firstOrNull()
      if (peer != null && challenge != null) {
        db.linkedDeviceToken(peer)?.let { put("proof", SyncPairing.peerProof(it, challenge, devId)) }
      }
      put("tables", JSONArray(listOf(
        "activity_categories", "activity_tags", "activity_blocks",
        "plan_nodes", "planned_blocks",
        "model_api_keys", "model_call_log", "model_free_quota", "feature_bindings",
        "chat_sessions", "chat_messages",
      )))
      put("alias", alias)
      put("device_type", "mobile")
      put("device_model", android.os.Build.MODEL ?: "Android")
    }
    return envelope(payload)
  }

  private fun handleExport(session: IHTTPSession): Response {
    val since = session.parameters["since"]?.firstOrNull()
    return envelope(SyncJson.exportToJson(db.exportSync(since)))
  }

  private fun handleImport(session: IHTTPSession): Response {
    val payload = SyncJson.jsonToExport(JSONObject(readBody(session)))
    val r = db.importSync(payload)
    onImport?.invoke(payload.deviceId, session.remoteIpAddress, r)
    return envelope(SyncJson.importResultToJson(r))
  }

  private fun handleChatPage(session: IHTTPSession): Response {
    val since = session.parameters["since"]?.firstOrNull()?.toLongOrNull() ?: 0L
    val peer = session.parameters["peer"]?.firstOrNull()
    val maxBytes = session.parameters["max_bytes"]?.firstOrNull()?.toIntOrNull() ?: DEFAULT_CHAT_PAGE_BYTES
    return envelope(SyncJson.chatPageToJson(db.exportChatPage(since, peer, maxBytes)))
  }

  private fun handleChatImport(session: IHTTPSession): Response {
    val page = SyncJson.jsonToChatPage(JSONObject(readBody(session)))
    val r = db.importChatPage(page.deviceId, page.sessions, page.messages)
    if (r.hasChanges) onImport?.invoke(page.deviceId, session.remoteIpAddress, r)
    return envelope(SyncJson.importResultToJson(r))
  }

  // ⚠ NanoHTTPD parseBody().get("postData") 内部走 ISO-8859-1 解码
  // (NanoHTTPD 2.3.1 HTTPSession.java 硬编码 String(buf, "ISO-8859-1"))，
  // UTF-8 中文每个字 3 字节会被错拆成 3 个西欧字符，落到 mobile DB 就是乱码。
  // 改成直接从 input stream 读 raw bytes，按 Content-Length 截断，UTF-8 解码。
  private fun readBody(session: IHTTPSession, limit: Int = MAX_BODY_LEN): String {
    val len = session.headers["content-length"]?.toIntOrNull() ?: 0
    if (len <= 0) return "{}"
    // 对齐 desktop SYNC_BODY_LIMIT。必须在分配前判断：长度是对方说的，一个伪造的值就能把内存撑爆
    if (len > limit) throw IllegalArgumentException("请求体过大")
    val buf = ByteArray(len)
    var off = 0
    while (off < len) {
      val r = session.inputStream.read(buf, off, len - off)
      if (r <= 0) break
      off += r
    }
    return String(buf, 0, off, Charsets.UTF_8)
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

  private companion object {
    const val DEFAULT_CHAT_PAGE_BYTES = 1_500_000
    const val MAX_BODY_LEN = 64 * 1024 * 1024
    // 配对接口不用令牌就能调，没必要给它留同步数据那么大的额度
    const val MAX_PAIR_BODY_LEN = 4 * 1024
  }
}
