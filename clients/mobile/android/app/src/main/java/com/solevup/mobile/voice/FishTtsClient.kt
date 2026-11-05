package com.solevup.mobile.voice

import android.util.Log
import com.facebook.react.bridge.Arguments
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.ByteArrayOutputStream

/**
 * Fish TTS WebSocket 客户端（对应 desktop fish_tts.rs）
 * API: https://docs.fish.audio/api-reference/endpoint/websocket/tts-live
 *
 * 和桌面端的差异：
 *   · 手写的 CONNECT 隧道 / TLS / 握手 / Sec-WebSocket-Key 都由 OkHttp 完成，
 *     代理端口来自 AppProxy（VoiceModule 的 http），没配时跟随系统 VPN 或系统代理。
 *   · 音频不经过 JS：直接进 AudioTrack 并在这里攒成 WAV，JS 只收进度事件，最后按需取走。
 *   · 建连失败也发 finish（桌面端 run_ws_loop 用 ? 提前返回时不发，前端要干等 60 秒兜底）。
 */
internal class FishTtsConfig(
  val apiKey: String,
  val referenceId: String, // 音色 ID
  val sampleRate: Int,
  val model: String, // s1 或 s2-pro
  val eventId: String, // 每个连接一份唯一 ID；事件名 fish-tts-audio-{id} / fish-tts-finish-{id}，避免新旧实例串扰
)

internal class FishTtsConnection(
  private val config: FishTtsConfig,
  http: OkHttpClient,
  private val events: JsEvents,
) {
  val eventId: String get() = config.eventId

  private val audioEventName = "fish-tts-audio-${config.eventId}"
  private val finishEventName = "fish-tts-finish-${config.eventId}"
  private val player = PcmPlayer(config.sampleRate, "fish-tts-play")
  private val pcm = ByteArrayOutputStream()

  /** 连上之前的文字先排队（对应 Rust mpsc 通道在 WS 就绪前的缓冲） */
  private val pending = ArrayList<ByteArray>()
  private val lock = Any()
  private var opened = false
  private var ended = false
  private val ws: WebSocket

  init {
    Log.i(TAG, "开始连接, 模型: ${config.model}, event_id: ${config.eventId}")
    val req = Request.Builder()
      .url("wss://api.fish.audio/v1/tts/live")
      .header("authorization", "Bearer ${config.apiKey}")
      .header("model", config.model)
      .build()
    ws = http.newWebSocket(req, Listener())
  }

  fun sendText(text: String) {
    Log.i(TAG, "收到前端文本, 长度: ${text.length}")
    send(MsgPack.encodeMap(linkedMapOf("event" to "text", "text" to text)))
  }

  fun flush() {
    Log.i(TAG, "收到前端 flush")
    // 不要立即结束，继续等待音频
    send(MsgPack.encodeMap(linkedMapOf("event" to "flush")))
  }

  /** 打断：通知服务端并断开，同时立刻停声、丢掉没播的（桌面端这步是前端 audioCtx.close()） */
  fun stop() {
    Log.i(TAG, "收到前端 stop")
    synchronized(lock) {
      if (!ended) {
        ended = true
        if (opened) {
          ws.send(MsgPack.encodeMap(linkedMapOf("event" to "stop")).toByteString())
          ws.close(1000, null)
        } else {
          ws.cancel()
        }
      }
      pending.clear()
    }
    player.close()
  }

  fun playerState() = player.stateMap().apply {
    putDouble("totalBytes", synchronized(pcm) { pcm.size() }.toDouble())
  }

  /** 取走本轮收到的音频（WAV 字节 + 时长）；一个字节都没有时返回 null */
  fun takeAudio(): Pair<ByteArray, Long>? {
    val bytes = synchronized(pcm) {
      val b = pcm.toByteArray()
      pcm.reset()
      b
    }
    if (bytes.isEmpty()) return null
    val durationMs = (bytes.size / 2).toLong() * 1_000 / config.sampleRate
    return wavBytes(bytes, config.sampleRate) to durationMs
  }

  private fun send(bytes: ByteArray) {
    synchronized(lock) {
      if (ended) throw IllegalStateException("Fish TTS 连接已结束")
      if (opened) ws.send(bytes.toByteString()) else pending.add(bytes)
    }
  }

  private fun emitFinish() {
    val first = synchronized(lock) {
      val f = !ended
      ended = true
      pending.clear()
      f
    }
    if (first) events.emit(finishEventName, null)
  }

  private fun handleAudio(audio: ByteArray) {
    synchronized(pcm) { pcm.write(audio) }
    player.write(audio)
    events.emit(audioEventName, Arguments.createMap().apply { putInt("bytes", audio.size) })
  }

  private inner class Listener : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      Log.i(TAG, "WebSocket 已连接")
      synchronized(lock) {
        if (ended) return
        opened = true
        // 发送 start 事件（字段名和 Rust rmp_serde::to_vec_named 一致）
        val start = MsgPack.encodeMap(
          linkedMapOf(
            "event" to "start",
            "request" to linkedMapOf(
              "text" to "",
              "reference_id" to config.referenceId,
              "format" to "pcm",
              "sample_rate" to config.sampleRate,
              "latency" to "normal",
            ),
          ),
        )
        webSocket.send(start.toByteString())
        Log.i(TAG, "已发送 start 事件, reference_id: ${config.referenceId}")
        for (m in pending) webSocket.send(m.toByteString())
        pending.clear()
      }
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      val root = try {
        MsgPack.decode(bytes.toByteArray()) as? Map<*, *>
      } catch (e: Throwable) {
        null
      }
      val event = root?.get("event") as? String
      if (event == null) {
        Log.w(TAG, "无法解析 AudioEvent")
        return
      }
      when (event) {
        "audio", "audio_chunk" -> MsgPack.asBytes(root?.get("audio"))?.let { handleAudio(it) }
        "finish" -> {
          Log.i(TAG, "合成完成")
          emitFinish()
          webSocket.close(1000, null)
        }
        else -> Log.i(TAG, "其他事件: $event")
      }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      Log.i(TAG, "收到文本消息: $text")
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      Log.i(TAG, "收到 Close 消息，触发完成")
      emitFinish()
      webSocket.close(1000, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      emitFinish()
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      // stop() 主动 cancel 时也会走到这里，emitFinish 已被 ended 拦住
      Log.e(TAG, "WS 错误: ${t.message} http=${response?.code}")
      emitFinish()
    }
  }

  private companion object {
    const val TAG = "FishTTS"
  }
}

/**
 * MessagePack 最小实现（Fish 协议只用到 map / str / uint / bin；不引第三方包）。
 * 编码对齐 rmp_serde::to_vec_named（map 带字段名，整数取最短形式）；
 * 解码把所有类型读全，未知字段可以安全跳过（对应 serde 忽略未声明字段）。
 */
internal object MsgPack {
  fun encodeMap(map: Map<String, Any?>): ByteArray {
    val out = ByteArrayOutputStream()
    writeValue(out, map)
    return out.toByteArray()
  }

  private fun writeValue(out: ByteArrayOutputStream, v: Any?) {
    when (v) {
      null -> out.write(0xC0)
      is String -> writeStr(out, v)
      is Int -> writeUInt(out, v.toLong())
      is Long -> writeUInt(out, v)
      is Map<*, *> -> {
        val n = v.size
        when {
          n < 16 -> out.write(0x80 or n)
          n < 65_536 -> { out.write(0xDE); out.write(n shr 8); out.write(n and 0xFF) }
          else -> throw IllegalArgumentException("map 太大")
        }
        for ((k, value) in v) {
          writeStr(out, k as String)
          writeValue(out, value)
        }
      }
      else -> throw IllegalArgumentException("不支持的类型 ${v.javaClass}")
    }
  }

  private fun writeStr(out: ByteArrayOutputStream, s: String) {
    val b = s.toByteArray(Charsets.UTF_8)
    val n = b.size
    when {
      n < 32 -> out.write(0xA0 or n)
      n < 256 -> { out.write(0xD9); out.write(n) }
      n < 65_536 -> { out.write(0xDA); out.write(n shr 8); out.write(n and 0xFF) }
      else -> {
        out.write(0xDB)
        for (shift in intArrayOf(24, 16, 8, 0)) out.write((n shr shift) and 0xFF)
      }
    }
    out.write(b)
  }

  private fun writeUInt(out: ByteArrayOutputStream, v: Long) {
    require(v >= 0) { "只编码非负整数" }
    when {
      v < 128 -> out.write(v.toInt())
      v < 256 -> { out.write(0xCC); out.write(v.toInt()) }
      v < 65_536 -> { out.write(0xCD); out.write((v shr 8).toInt()); out.write((v and 0xFF).toInt()) }
      v < (1L shl 32) -> {
        out.write(0xCE)
        for (shift in intArrayOf(24, 16, 8, 0)) out.write(((v shr shift) and 0xFF).toInt())
      }
      else -> {
        out.write(0xCF)
        for (shift in intArrayOf(56, 48, 40, 32, 24, 16, 8, 0)) out.write(((v shr shift) and 0xFF).toInt())
      }
    }
  }

  /** Vec<u8> 既可能编成 bin，也可能编成整数数组 */
  fun asBytes(v: Any?): ByteArray? = when (v) {
    is ByteArray -> v
    is List<*> -> ByteArray(v.size) { i -> (v[i] as Number).toByte() }
    else -> null
  }

  fun decode(data: ByteArray): Any? = Reader(data).read()

  private class Reader(private val d: ByteArray) {
    private var p = 0

    private fun u8(): Int = d[p++].toInt() and 0xFF

    private fun uN(n: Int): Long {
      var v = 0L
      repeat(n) { v = (v shl 8) or u8().toLong() }
      return v
    }

    private fun bytes(n: Int): ByteArray {
      if (n < 0 || p + n > d.size) throw IllegalArgumentException("MessagePack 数据被截断")
      val b = d.copyOfRange(p, p + n)
      p += n
      return b
    }

    private fun str(n: Int) = String(bytes(n), Charsets.UTF_8)

    private fun array(n: Int): List<Any?> = List(n) { read() }

    private fun map(n: Int): Map<String, Any?> {
      val m = LinkedHashMap<String, Any?>(n)
      repeat(n) {
        val k = read()
        val v = read()
        if (k is String) m[k] = v
      }
      return m
    }

    fun read(): Any? {
      val b = u8()
      return when {
        b < 0x80 -> b.toLong()
        b < 0x90 -> map(b and 0x0F)
        b < 0xA0 -> array(b and 0x0F)
        b < 0xC0 -> str(b and 0x1F)
        b >= 0xE0 -> (b - 256).toLong()
        else -> when (b) {
          0xC0 -> null
          0xC2 -> false
          0xC3 -> true
          0xC4 -> bytes(u8())
          0xC5 -> bytes(uN(2).toInt())
          0xC6 -> bytes(uN(4).toInt())
          0xC7 -> { val n = u8(); p += 1; bytes(n) }
          0xC8 -> { val n = uN(2).toInt(); p += 1; bytes(n) }
          0xC9 -> { val n = uN(4).toInt(); p += 1; bytes(n) }
          0xCA -> java.lang.Float.intBitsToFloat(uN(4).toInt()).toDouble()
          0xCB -> java.lang.Double.longBitsToDouble(uN(8))
          0xCC -> uN(1)
          0xCD -> uN(2)
          0xCE -> uN(4)
          0xCF -> uN(8)
          0xD0 -> uN(1).toByte().toLong()
          0xD1 -> uN(2).toShort().toLong()
          0xD2 -> uN(4).toInt().toLong()
          0xD3 -> uN(8)
          0xD4 -> { p += 1; bytes(1) }
          0xD5 -> { p += 1; bytes(2) }
          0xD6 -> { p += 1; bytes(4) }
          0xD7 -> { p += 1; bytes(8) }
          0xD8 -> { p += 1; bytes(16) }
          0xD9 -> str(u8())
          0xDA -> str(uN(2).toInt())
          0xDB -> str(uN(4).toInt())
          0xDC -> array(uN(2).toInt())
          0xDD -> array(uN(4).toInt())
          0xDE -> map(uN(2).toInt())
          0xDF -> map(uN(4).toInt())
          else -> throw IllegalArgumentException("未知的 MessagePack 标记 $b")
        }
      }
    }
  }
}
