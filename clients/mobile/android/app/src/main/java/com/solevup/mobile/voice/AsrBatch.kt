package com.solevup.mobile.voice

import android.os.SystemClock
import android.util.Base64
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.math.min

/**
 * 批量语音识别（对应 desktop qwen_asr.rs 的 transcribe_pcm16）：流式识别两次都失败时的兜底。
 *
 * 官方协议（Manual 模式）：
 *   open → session.update → input_audio_buffer.append(chunks)
 *        → input_audio_buffer.commit → session.finish
 *        → conversation.item.input_audio_transcription.completed
 */
internal object AsrBatch {
  private const val TAG = "VoiceAsrBatch"
  private const val CHUNK_BYTES = 3_200 // 每块 ≈ 0.1s

  private sealed class Frame {
    class Text(val text: String) : Frame()
    class Broken(val text: String) : Frame()
    object Closed : Frame()
  }

  /**
   * 把一整段 16 kHz 单声道 PCM16（小端）一次性送去识别。
   * totalTimeoutMs 对应 Rust 外层 timeout(FALLBACK_TIMEOUT, ...)，超时抛 TimeoutException。
   */
  fun transcribePcm16(
    http: OkHttpClient,
    pcm16: ByteArray,
    apiKey: String,
    model: String,
    wsUrl: String,
    totalTimeoutMs: Long,
  ): String {
    if (pcm16.isEmpty()) throw IllegalStateException("PCM 数据为空")
    val deadline = SystemClock.elapsedRealtime() + totalTimeoutMs

    val frames = LinkedBlockingQueue<Frame>()
    val opened = LinkedBlockingQueue<Result<Unit>>()
    val req = Request.Builder()
      .url("$wsUrl?model=$model")
      .header("Authorization", "Bearer $apiKey")
      .header("OpenAI-Beta", "realtime=v1")
      .build()
    val ws = http.newWebSocket(req, object : WebSocketListener() {
      @Volatile private var isOpen = false

      override fun onOpen(webSocket: WebSocket, response: Response) {
        isOpen = true
        opened.offer(Result.success(Unit))
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        frames.offer(Frame.Text(text))
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        frames.offer(Frame.Closed)
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        if (isOpen) frames.offer(Frame.Broken("WS 错误: ${t.message}"))
        else opened.offer(Result.failure(IllegalStateException("WebSocket 连接失败: ${t.message}")))
      }
    })
    try {
      val connect = opened.poll(remaining(deadline), TimeUnit.MILLISECONDS) ?: throw TimeoutException()
      connect.getOrThrow()
      Log.i(TAG, "已连接 model=$model")

      // 等待 session.created（或直接发 session.update 也可以）
      waitType(frames, "session.created", 10_000, deadline)

      // session.update：Manual 模式，16kHz PCM
      send(
        ws,
        JSONObject()
          .put("event_id", "ev_update")
          .put("type", "session.update")
          .put(
            "session",
            JSONObject()
              .put("modalities", JSONArray().put("text"))
              .put("input_audio_format", "pcm")
              .put("sample_rate", 16_000)
              .put("input_audio_transcription", JSONObject().put("language", "zh"))
              .put("turn_detection", JSONObject.NULL),
          ),
      )
      waitType(frames, "session.updated", 10_000, deadline)

      // 分块发送 PCM16
      var offset = 0
      while (offset < pcm16.size) {
        val end = min(offset + CHUNK_BYTES, pcm16.size)
        send(
          ws,
          JSONObject()
            .put("event_id", "ev_audio_$offset")
            .put("type", "input_audio_buffer.append")
            .put("audio", Base64.encodeToString(pcm16, offset, end - offset, Base64.NO_WRAP)),
        )
        offset = end
      }

      // commit + finish
      send(ws, JSONObject().put("event_id", "ev_commit").put("type", "input_audio_buffer.commit"))
      send(ws, JSONObject().put("event_id", "ev_finish").put("type", "session.finish"))

      // 等待转写结果
      val transcript = recvTranscript(frames, 30_000, deadline)
      Log.i(TAG, "完成：${transcript.length} 字")
      return transcript
    } finally {
      ws.cancel()
    }
  }

  private fun remaining(deadline: Long): Long = maxOf(0L, deadline - SystemClock.elapsedRealtime())

  private fun send(ws: WebSocket, v: JSONObject) {
    if (!ws.send(v.toString())) throw IllegalStateException("发送失败")
  }

  private fun errorMessage(v: JSONObject, raw: String): String =
    (v.optJSONObject("error")?.opt("message") as? String) ?: raw

  private fun waitType(frames: LinkedBlockingQueue<Frame>, event: String, ownMs: Long, overall: Long) {
    val own = SystemClock.elapsedRealtime() + ownMs
    while (true) {
      val left = min(remaining(own), remaining(overall))
      val frame = frames.poll(left, TimeUnit.MILLISECONDS)
      if (frame == null) {
        if (remaining(overall) == 0L) throw TimeoutException()
        throw IllegalStateException("等待 $event 超时")
      }
      when (frame) {
        is Frame.Text -> {
          val v = try { JSONObject(frame.text) } catch (_: Throwable) { JSONObject() }
          val typ = v.opt("type") as? String
          if (typ == event) return
          if (typ == "error") throw IllegalStateException("API 错误: ${errorMessage(v, frame.text)}")
        }
        is Frame.Broken -> throw IllegalStateException(frame.text)
        Frame.Closed -> throw IllegalStateException("WS 关闭（等待 $event）")
      }
    }
  }

  private fun recvTranscript(frames: LinkedBlockingQueue<Frame>, ownMs: Long, overall: Long): String {
    val own = SystemClock.elapsedRealtime() + ownMs
    while (true) {
      val left = min(remaining(own), remaining(overall))
      val frame = frames.poll(left, TimeUnit.MILLISECONDS)
      if (frame == null) {
        if (remaining(overall) == 0L) throw TimeoutException()
        throw IllegalStateException("转写超时")
      }
      when (frame) {
        is Frame.Text -> {
          val v = try { JSONObject(frame.text) } catch (_: Throwable) { JSONObject() }
          when (v.opt("type") as? String) {
            "conversation.item.input_audio_transcription.completed" -> return (v.opt("transcript") as? String) ?: ""
            "error" -> throw IllegalStateException("API 错误: ${errorMessage(v, frame.text)}")
          }
        }
        is Frame.Broken -> throw IllegalStateException(frame.text)
        Frame.Closed -> throw IllegalStateException("WS 意外关闭")
      }
    }
  }
}
