package com.solevup.mobile.syncclient

import android.util.Log
import com.solevup.mobile.solevupdb.SolevupDb
import com.solevup.mobile.solevupdb.SyncJson
import com.solevup.mobile.sync.SyncProtocol
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.net.URLEncoder

/**
 * Mobile 主动 HTTP client，跟 desktop sync_engine.rs bidirectional_sync 同形态：
 *   1) GET <peerBase>/api/sync/export  → 拉对端 export
 *   2) 本地 importSync()                → LWW 合并
 *   3) 本地 exportSync()                → 本端快照
 *   4) POST <peerBase>/api/sync/import  → 推给对端
 *   5) /api/sync/chat                   → 聊天记录按序号增量分页；失败不影响前面的结果
 *
 * 不依赖 OkHttp，纯 java.net.HttpURLConnection 加 UTF-8 编解码。对端都在局域网，不走系统代理（对齐 desktop no_proxy）。
 * 任意 step 失败抛 SyncException，调用方负责打日志或记录到 linked_devices。
 */
object SyncClient {
  private const val TAG = "SyncClient"
  private const val CONNECT_TIMEOUT_MS = 5_000
  private const val READ_TIMEOUT_MS = 30_000
  private const val MAX_BODY_LEN = 32 * 1024 * 1024  // 32MB 安全上限
  private const val CHAT_PAGE_BYTES = 1_500_000
  private const val CHAT_MAX_PAGES = 200

  data class SyncRoundResult(
    val pulled: SolevupDb.ImportResult,
    val pushed: SolevupDb.ImportResult,
    val peerDeviceId: String,
    val peerAlias: String,
  )

  class SyncException(msg: String, cause: Throwable? = null) : Exception(msg, cause)

  /**
   * 完整双向同步。对端 base 形如 "http://192.168.0.104:39733"。
   * 失败任意一步立刻抛错并带上下文。
   */
  fun bidirectionalSync(db: SolevupDb, peerBase: String): SyncRoundResult {
    val base = SyncProtocol.normalizeBase(peerBase)
    Log.i(TAG, "bidirectionalSync start: $base")

    // 1) pull 对端 export
    val remoteEnvelope = httpGetJson("$base/api/sync/export")
      ?: throw SyncException("拉取对端 export 失败: 空响应")
    if (!remoteEnvelope.optBoolean("success")) {
      throw SyncException("对端 export 错误: ${remoteEnvelope.optString("error", "unknown")}")
    }
    val remoteData = remoteEnvelope.optJSONObject("data")
      ?: throw SyncException("对端 export 数据为空")
    val remoteSnapshot = SyncJson.jsonToExport(remoteData)
    val peerDeviceId = remoteSnapshot.deviceId
    val peerAlias = remoteData.optString("alias", peerDeviceId)  // export 里没 alias，先用 device_id 顶

    // 2) 本地 import
    val pulled = db.importSync(remoteSnapshot)
    Log.i(TAG, "pulled: $pulled")

    // 3) 本地 export
    val localSnapshot = db.exportSync(null)

    // 4) push 对端 import
    val pushEnvelope = httpPostJson("$base/api/sync/import", SyncJson.exportToJson(localSnapshot))
      ?: throw SyncException("推送对端 import 失败: 空响应")
    if (!pushEnvelope.optBoolean("success")) {
      throw SyncException("对端 import 错误: ${pushEnvelope.optString("error", "unknown")}")
    }
    val pushed = SyncJson.jsonToImportResult(pushEnvelope.optJSONObject("data") ?: JSONObject())
    Log.i(TAG, "pushed: $pushed")

    // 5) 聊天记录走独立通道
    val (chatPulled, chatPushed) = syncChat(db, base, peerDeviceId)
    return SyncRoundResult(
      pulled.copy(chatSessions = chatPulled.chatSessions, chatMessages = chatPulled.chatMessages),
      pushed.copy(chatSessions = chatPushed.chatSessions, chatMessages = chatPushed.chatMessages),
      peerDeviceId,
      peerAlias,
    )
  }

  /** 旧版对端没有 /api/sync/chat：游标不前进，等它升级后补齐。 */
  private fun syncChat(
    db: SolevupDb,
    base: String,
    peerDeviceId: String,
  ): Pair<SolevupDb.ImportResult, SolevupDb.ImportResult> {
    var pulled = SolevupDb.ImportResult()
    var pushed = SolevupDb.ImportResult()
    try {
      val cursor = db.chatSyncCursor(peerDeviceId)
      val self = URLEncoder.encode(db.deviceId(), "UTF-8")
      var since = cursor.pullSeq
      for (i in 0 until CHAT_MAX_PAGES) {
        val envelope = httpGetJson("$base/api/sync/chat?since=$since&peer=$self&max_bytes=$CHAT_PAGE_BYTES")
          ?: throw SyncException("拉取聊天记录失败: 空响应")
        if (!envelope.optBoolean("success")) {
          throw SyncException(envelope.optString("error", "unknown"))
        }
        val page = SyncJson.jsonToChatPage(
          envelope.optJSONObject("data") ?: throw SyncException("聊天记录数据为空"),
        )
        val r = db.importChatPage(peerDeviceId, page.sessions, page.messages)
        pulled = pulled.copy(
          chatSessions = pulled.chatSessions + r.chatSessions,
          chatMessages = pulled.chatMessages + r.chatMessages,
        )
        db.saveChatPullSeq(peerDeviceId, page.seq)
        since = page.seq
        if (!page.more) break
      }

      since = cursor.pushSeq
      for (i in 0 until CHAT_MAX_PAGES) {
        val page = db.exportChatPage(since, peerDeviceId, CHAT_PAGE_BYTES)
        if (page.sessions.isNotEmpty() || page.messages.isNotEmpty()) {
          val envelope = httpPostJson("$base/api/sync/chat", SyncJson.chatPageToJson(page))
            ?: throw SyncException("推送聊天记录失败: 空响应")
          if (!envelope.optBoolean("success")) {
            throw SyncException(envelope.optString("error", "unknown"))
          }
          val r = SyncJson.jsonToImportResult(envelope.optJSONObject("data") ?: JSONObject())
          pushed = pushed.copy(
            chatSessions = pushed.chatSessions + r.chatSessions,
            chatMessages = pushed.chatMessages + r.chatMessages,
          )
        }
        db.saveChatPushSeq(peerDeviceId, page.seq)
        since = page.seq
        if (!page.more) break
      }
    } catch (e: Throwable) {
      Log.w(TAG, "chat sync skipped: ${e.message}")
    }
    return pulled to pushed
  }

  /** GET <url>/api/sync/hello → 拿对端 device_id + alias 给 addLinkedDevice 用。 */
  fun fetchHello(peerBase: String): JSONObject {
    val base = SyncProtocol.normalizeBase(peerBase)
    val envelope = httpGetJson("$base/api/sync/hello")
      ?: throw SyncException("hello 失败: 空响应")
    if (!envelope.optBoolean("success")) {
      throw SyncException("hello 错误: ${envelope.optString("error", "unknown")}")
    }
    return envelope.optJSONObject("data")
      ?: throw SyncException("hello 数据为空")
  }

  private fun httpGetJson(url: String): JSONObject? {
    val conn = (URL(url).openConnection(Proxy.NO_PROXY) as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      setRequestProperty("Accept", "application/json")
      useCaches = false
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
    val conn = (URL(url).openConnection(Proxy.NO_PROXY) as HttpURLConnection).apply {
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
}
