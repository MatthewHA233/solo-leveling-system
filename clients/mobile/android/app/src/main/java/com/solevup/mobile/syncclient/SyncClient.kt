package com.solevup.mobile.syncclient

import android.util.Log
import com.solevup.mobile.solevupdb.SolevupDb
import com.solevup.mobile.solevupdb.SyncJson
import com.solevup.mobile.sync.SyncPairing
import com.solevup.mobile.sync.SyncProtocol
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap

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
  private const val CHAT_IMAGE_MAX_BYTES = 16 * 1024 * 1024
  private const val CHAT_IMAGE_BATCH = 32
  private const val CHAT_IMAGE_RETRY_MS = 600_000L // 对端也没有的图片（可能是第三台设备发的），隔这么久再问
  private const val PAIRING_REJECTED = "对方不认这次配对了，可能已经解除。请解除链接后重新配对"

  data class SyncRoundResult(
    val pulled: SolevupDb.ImportResult,
    val pushed: SolevupDb.ImportResult,
    val peerDeviceId: String,
    val peerAlias: String,
  )

  class SyncException(msg: String, cause: Throwable? = null) : Exception(msg, cause)

  private val chatImageMisses = ConcurrentHashMap<String, Long>()

  data class PairedPeer(val token: String, val deviceId: String, val alias: String)

  /** 拿对方屏幕上的配对码换令牌。两边都把对方记成已链接 */
  fun pair(peerBase: String, code: String, selfId: String, selfAlias: String): PairedPeer {
    val base = SyncProtocol.normalizeBase(peerBase)
    val payload = JSONObject().apply {
      put("code", code)
      put("device_id", selfId)
      put("alias", selfAlias)
    }
    val envelope = httpPostJson("$base/api/sync/pair", payload, null)
      ?: throw SyncException("配对失败: 空响应")
    if (!envelope.optBoolean("success")) {
      throw SyncException(envelope.optString("error", "配对失败"))
    }
    val data = envelope.optJSONObject("data") ?: throw SyncException("对端配对结果为空")
    return PairedPeer(data.getString("token"), data.getString("device_id"), data.getString("alias"))
  }

  /** 解除链接时顺手告诉对方；对方连不上也没关系，它下次同步会校验失败，提示主人解除 */
  fun notifyUnpair(peerBase: String, token: String) {
    try {
      httpPostJson("${SyncProtocol.normalizeBase(peerBase)}/api/sync/unpair", JSONObject(), token)
    } catch (t: Throwable) {
      Log.i(TAG, "notify unpair failed: ${t.message}")
    }
  }

  /**
   * 发现广播和地址都可能是假的：对面算得出应答，才说明它持有同一个令牌。
   * 这一步不带令牌。返回 hello 内容
   */
  fun verifyPeer(peerBase: String, selfId: String, deviceId: String, token: String): JSONObject {
    val challenge = SyncPairing.newChallenge()
    val query = "peer=${URLEncoder.encode(selfId, "UTF-8")}&challenge=$challenge"
    val hello = fetchHello(peerBase, query)
    // 地址可能已被 DHCP 分给别的设备
    if (hello.optString("device_id") != deviceId) {
      throw SyncException("地址 $peerBase 已不是这台设备")
    }
    val proof = hello.optString("proof")
    if (proof.isEmpty() || !SyncPairing.verifyProof(token, challenge, deviceId, proof)) {
      throw SyncException(PAIRING_REJECTED)
    }
    return hello
  }

  /**
   * 完整双向同步。对端 base 形如 "http://192.168.0.104:39733"。
   * 调用前先过 verifyPeer。失败任意一步立刻抛错并带上下文。
   */
  fun bidirectionalSync(db: SolevupDb, peerBase: String, token: String): SyncRoundResult {
    val base = SyncProtocol.normalizeBase(peerBase)
    Log.i(TAG, "bidirectionalSync start: $base")

    // 1) pull 对端 export
    val remoteEnvelope = httpGetJson("$base/api/sync/export", token)
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
    val pushEnvelope = httpPostJson("$base/api/sync/import", SyncJson.exportToJson(localSnapshot), token)
      ?: throw SyncException("推送对端 import 失败: 空响应")
    if (!pushEnvelope.optBoolean("success")) {
      throw SyncException("对端 import 错误: ${pushEnvelope.optString("error", "unknown")}")
    }
    val pushed = SyncJson.jsonToImportResult(pushEnvelope.optJSONObject("data") ?: JSONObject())
    Log.i(TAG, "pushed: $pushed")

    // 5) 聊天记录走独立通道
    val (chatPulled, chatPushed) = syncChat(db, base, peerDeviceId, token)

    // 6) 消息同步过来了，图片文件也要有。失败不影响这一轮，下一轮再试
    val chatImages = pullChatImages(db, base, peerDeviceId, token)
    return SyncRoundResult(
      pulled.copy(chatSessions = chatPulled.chatSessions, chatMessages = chatPulled.chatMessages, chatImages = chatImages),
      pushed.copy(chatSessions = chatPushed.chatSessions, chatMessages = chatPushed.chatMessages),
      peerDeviceId,
      peerAlias,
    )
  }

  /** 消息引用了、本机没有文件的图片，从这台对端拉（规则见 src/lib/agent/chat-images.ts） */
  private fun pullChatImages(db: SolevupDb, base: String, peerDeviceId: String, token: String): Int {
    val dir = db.chatImageDir
    var pulled = 0
    var tried = 0
    try {
      for (id in db.chatImageIds()) {
        if (tried >= CHAT_IMAGE_BATCH) break
        if (!SyncProtocol.isChatImageId(id) || File(dir, "$id.jpg").exists()) continue
        val missKey = "$peerDeviceId:$id"
        val missedAt = chatImageMisses[missKey]
        if (missedAt != null && System.currentTimeMillis() - missedAt < CHAT_IMAGE_RETRY_MS) continue
        tried++
        val bytes = fetchChatImage("$base/api/sync/chat-image/$id", token)
        if (bytes == null) {
          chatImageMisses[missKey] = System.currentTimeMillis()
          continue
        }
        savePulledImage(dir, id, bytes)
        pulled++
      }
    } catch (t: Throwable) {
      Log.i(TAG, "拉图片中断 ($base): ${t.message}")
    }
    return pulled
  }

  /** null = 对端没有这张（旧版对端没有这个接口，也算没有） */
  private fun fetchChatImage(url: String, token: String): ByteArray? {
    val conn = (URL(url).openConnection(Proxy.NO_PROXY) as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      setRequestProperty("Authorization", "Bearer $token")
      useCaches = false
    }
    return try {
      conn.connect()
      val code = conn.responseCode
      if (code == HttpURLConnection.HTTP_UNAUTHORIZED) throw SyncException(PAIRING_REJECTED)
      if (code !in 200..299) return null
      val bytes = conn.inputStream.use { it.readBytes() }
      val isJpeg = bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte()
      if (bytes.size > CHAT_IMAGE_MAX_BYTES || !isJpeg) null else bytes
    } finally {
      conn.disconnect()
    }
  }

  /** 先写临时文件再改名：中途断了不会留下半张图 */
  private fun savePulledImage(dir: File, id: String, bytes: ByteArray) {
    dir.mkdirs()
    val part = File(dir, "$id.part")
    part.writeBytes(bytes)
    if (!part.renameTo(File(dir, "$id.jpg"))) {
      part.delete()
      throw SyncException("保存图片失败")
    }
  }

  /** 旧版对端没有 /api/sync/chat：游标不前进，等它升级后补齐。 */
  private fun syncChat(
    db: SolevupDb,
    base: String,
    peerDeviceId: String,
    token: String,
  ): Pair<SolevupDb.ImportResult, SolevupDb.ImportResult> {
    var pulled = SolevupDb.ImportResult()
    var pushed = SolevupDb.ImportResult()
    try {
      val cursor = db.chatSyncCursor(peerDeviceId)
      val self = URLEncoder.encode(db.deviceId(), "UTF-8")
      var since = cursor.pullSeq
      for (i in 0 until CHAT_MAX_PAGES) {
        val envelope = httpGetJson("$base/api/sync/chat?since=$since&peer=$self&max_bytes=$CHAT_PAGE_BYTES", token)
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
          val envelope = httpPostJson("$base/api/sync/chat", SyncJson.chatPageToJson(page), token)
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

  /** GET <url>/api/sync/hello → 拿对端 device_id + alias。这个接口公开，不带令牌。 */
  fun fetchHello(peerBase: String, query: String = "", timeoutMs: Int? = null): JSONObject {
    val base = SyncProtocol.normalizeBase(peerBase)
    val url = if (query.isEmpty()) "$base/api/sync/hello" else "$base/api/sync/hello?$query"
    val envelope = httpGetJson(url, null, timeoutMs)
      ?: throw SyncException("hello 失败: 空响应")
    if (!envelope.optBoolean("success")) {
      throw SyncException("hello 错误: ${envelope.optString("error", "unknown")}")
    }
    return envelope.optJSONObject("data")
      ?: throw SyncException("hello 数据为空")
  }

  private fun httpGetJson(url: String, token: String?, timeoutMs: Int? = null): JSONObject? {
    val conn = (URL(url).openConnection(Proxy.NO_PROXY) as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = timeoutMs ?: CONNECT_TIMEOUT_MS
      readTimeout = timeoutMs ?: READ_TIMEOUT_MS
      setRequestProperty("Accept", "application/json")
      if (token != null) setRequestProperty("Authorization", "Bearer $token")
      useCaches = false
    }
    return try {
      conn.connect()
      val code = conn.responseCode
      if (code == HttpURLConnection.HTTP_UNAUTHORIZED) throw SyncException(PAIRING_REJECTED)
      if (code !in 200..299) throw SyncException("GET $url -> HTTP $code")
      val bytes = conn.inputStream.use { it.readBytes() }
      if (bytes.size > MAX_BODY_LEN) throw SyncException("响应过大: ${bytes.size} bytes")
      JSONObject(String(bytes, Charsets.UTF_8))
    } finally {
      conn.disconnect()
    }
  }

  private fun httpPostJson(url: String, payload: JSONObject, token: String?): JSONObject? {
    val bodyBytes = payload.toString().toByteArray(Charsets.UTF_8)
    val conn = (URL(url).openConnection(Proxy.NO_PROXY) as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      doOutput = true
      setRequestProperty("Accept", "application/json")
      setRequestProperty("Content-Type", "application/json; charset=UTF-8")
      if (token != null) setRequestProperty("Authorization", "Bearer $token")
      setFixedLengthStreamingMode(bodyBytes.size)
      useCaches = false
    }
    return try {
      conn.connect()
      conn.outputStream.use { it.write(bodyBytes) }
      val code = conn.responseCode
      if (code == HttpURLConnection.HTTP_UNAUTHORIZED) throw SyncException(PAIRING_REJECTED)
      if (code !in 200..299) throw SyncException("POST $url -> HTTP $code")
      val bytes = conn.inputStream.use { it.readBytes() }
      if (bytes.size > MAX_BODY_LEN) throw SyncException("响应过大: ${bytes.size} bytes")
      JSONObject(String(bytes, Charsets.UTF_8))
    } finally {
      conn.disconnect()
    }
  }
}
