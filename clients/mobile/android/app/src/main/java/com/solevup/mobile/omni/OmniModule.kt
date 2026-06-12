package com.solevup.mobile.omni

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Omni Realtime — DashScope 全模态单 WS（mobile native 版）
 * 协议与 desktop qwen_omni.rs 完全对齐：
 *   连接(Authorization header) → session.created → session.update(manual turn)
 *   → input_audio_buffer.append(PCM16/16k Base64，AudioRecord 直推)
 *   → input_audio_buffer.commit + response.create
 *   ← response.audio.delta(PCM16/24k，AudioTrack 直播) / 文字 delta / 用户转写 / usage
 *
 * 分层对齐 desktop："WS + 音频在 native，JS 只收事件"。
 * JS 事件（DeviceEventEmitter）：
 *   omni-status          { status: connected|audio_done|disconnected|error, message? }
 *   omni-text            { text }   AI 回复文字增量
 *   omni-user-transcript { text }   用户语音转写
 *   omni-usage           { model, usageJson }
 */
class OmniModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME

  private val http = OkHttpClient.Builder()
    .connectTimeout(8, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS) // WS 长连
    .build()

  @Volatile private var ws: WebSocket? = null
  @Volatile private var sessionReady = false
  @Volatile private var currentModel = ""

  private var recorder: AudioRecord? = null
  private var recordThread: Thread? = null
  private val recording = AtomicBoolean(false)

  @Volatile private var player: AudioTrack? = null

  // ── 事件桥 ──

  private fun emit(event: String, params: Any?) {
    try {
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(event, params)
    } catch (e: Throwable) {
      Log.w(TAG, "emit $event failed: ${e.message}")
    }
  }

  private fun emitStatus(status: String, message: String? = null) {
    emit("omni-status", Arguments.createMap().apply {
      putString("status", status)
      if (message != null) putString("message", message)
    })
  }

  // ── 连接 ──

  @ReactMethod
  fun connect(apiKey: String, model: String, voice: String, systemPrompt: String, promise: Promise) {
    try {
      // 只断旧 WS + 停播放。绝不动录音线程和 pendingAudio：
      // 按住说话的 UX 是「先开录、连接并行」，connect 杀录音会导致 commit 时
      // buffer 为空（buffer too small / no user role，desktop 同款坑）。
      ws?.let { w -> try { w.close(1000, "reconnect") } catch (_: Throwable) {} }
      ws = null
      stopPlayer()
      sessionReady = false
      pendingCommit = false
      currentModel = model
      pendingVoice = voice
      pendingPrompt = systemPrompt

      val url = "$WS_BASE?model=$model"
      val req = Request.Builder()
        .url(url)
        .addHeader("Authorization", "Bearer $apiKey")
        .build()

      var resolved = false
      ws = http.newWebSocket(req, object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
          if (ws !== webSocket) return // 旧连接迟到消息忽略
          handleEvent(text) {
            // session.updated → 会话就绪，resolve connect
            if (!resolved) { resolved = true; promise.resolve(true) }
          }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
          // 旧连接被 reconnect 替换后的迟到回调不许动新状态（否则把新 WS/录音清了，
          // 表现为间断性「Omni 未连接」）
          if (ws !== webSocket) return
          Log.e(TAG, "WS failure: ${t.message}")
          emitStatus("error", t.message ?: "连接失败")
          if (!resolved) { resolved = true; promise.reject("OMNI_WS_FAILED", t.message, t) }
          cleanupAfterClose()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
          if (ws !== webSocket) return
          Log.i(TAG, "WS closed: $code $reason")
          emitStatus("disconnected")
          cleanupAfterClose()
        }
      })
    } catch (e: Throwable) {
      promise.reject("OMNI_CONNECT_FAILED", e.message, e)
    }
  }

  private fun sendSessionUpdate(voice: String, systemPrompt: String) {
    val session = JSONObject().apply {
      put("modalities", JSONArray().put("text").put("audio"))
      put("voice", if (voice.isEmpty()) "Tina" else voice)
      put("input_audio_format", "pcm")
      put("output_audio_format", "pcm")
      put("instructions", systemPrompt)
      put("input_audio_transcription", JSONObject().put("model", "qwen-turbo"))
      // manual 模式：用户手动 commit，配合按住说话 UX
      put("turn_detection", JSONObject.NULL)
    }
    ws?.send(JSONObject().apply {
      put("type", "session.update")
      put("session", session)
    }.toString())
  }

  // connect 时暂存，session.created 后真正发 session.update
  @Volatile private var pendingVoice = ""
  @Volatile private var pendingPrompt = ""

  // 时序保护（desktop 端踩过的坑）：按住说话可能早于 WS 就绪。
  // 就绪前采集的 append 先缓存、commit 先挂起，session.updated 后按序补发。
  private val pendingAudio = ArrayList<String>()
  @Volatile private var pendingCommit = false

  private fun flushPendingOnReady() {
    val w = ws ?: return
    synchronized(pendingAudio) {
      for (msg in pendingAudio) w.send(msg)
      pendingAudio.clear()
    }
    if (pendingCommit) {
      pendingCommit = false
      w.send(JSONObject().put("type", "input_audio_buffer.commit").toString())
      w.send(JSONObject().put("type", "response.create").toString())
    }
  }

  private fun handleEvent(text: String, onReady: () -> Unit) {
    val v = try { JSONObject(text) } catch (_: Throwable) { return }
    when (v.optString("type")) {
      "session.created" -> {
        if (!sessionReady) sendSessionUpdate(pendingVoice, pendingPrompt)
      }
      "session.updated" -> {
        sessionReady = true
        emitStatus("connected")
        flushPendingOnReady()
        onReady()
      }
      "response.audio.delta" -> {
        val delta = v.optString("delta")
        if (delta.isNotEmpty()) playPcmChunk(delta)
      }
      "response.text.delta", "response.audio.transcript.delta", "response.audio_transcript.delta" -> {
        val delta = v.optString("delta")
        if (delta.isNotEmpty()) {
          emit("omni-text", Arguments.createMap().apply { putString("text", delta) })
        }
      }
      "conversation.item.input_audio_transcription.completed" -> {
        val t = v.optString("transcript").trim()
        if (t.isNotEmpty()) {
          emit("omni-user-transcript", Arguments.createMap().apply { putString("text", t) })
        }
      }
      "response.audio.done" -> emitStatus("audio_done")
      "response.done" -> {
        val usage = v.optJSONObject("response")?.optJSONObject("usage")
        if (usage != null) {
          emit("omni-usage", Arguments.createMap().apply {
            putString("model", currentModel)
            putString("usageJson", usage.toString())
          })
        }
      }
      "error" -> {
        val msg = v.optJSONObject("error")?.optString("message") ?: "未知错误"
        Log.e(TAG, "服务端错误: $msg")
        emitStatus("error", msg)
      }
    }
  }

  // ── 录音（AudioRecord 16k PCM16 mono，chunk 直推 WS） ──

  @ReactMethod
  fun startRecording(promise: Promise) {
    try {
      if (recording.get()) { promise.resolve(true); return }
      val minBuf = AudioRecord.getMinBufferSize(
        IN_SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
      )
      val rec = AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        IN_SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
        maxOf(minBuf, IN_CHUNK_BYTES * 2),
      )
      if (rec.state != AudioRecord.STATE_INITIALIZED) {
        rec.release()
        promise.reject("MIC_INIT_FAILED", "AudioRecord 初始化失败（缺少 RECORD_AUDIO 权限？）")
        return
      }
      recorder = rec
      recording.set(true)
      rec.startRecording()

      recordThread = Thread {
        val buf = ByteArray(IN_CHUNK_BYTES) // 100ms @16k/16bit/mono = 3200 bytes
        while (recording.get()) {
          val n = rec.read(buf, 0, buf.size)
          if (n <= 0) continue
          val b64 = Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)
          val msg = JSONObject().apply {
            put("type", "input_audio_buffer.append")
            put("audio", b64)
          }.toString()
          val w = ws
          if (w != null && sessionReady) w.send(msg)
          else synchronized(pendingAudio) { pendingAudio.add(msg) }
        }
      }.apply { name = "omni-record"; start() }

      promise.resolve(true)
    } catch (e: SecurityException) {
      promise.reject("MIC_PERMISSION", "缺少录音权限", e)
    } catch (e: Throwable) {
      promise.reject("MIC_START_FAILED", e.message, e)
    }
  }

  private fun stopRecordingInternal() {
    recording.set(false)
    recordThread?.let { t -> try { t.join(500) } catch (_: InterruptedException) {} }
    recordThread = null
    recorder?.let { r -> try { r.stop() } catch (_: Throwable) {}; r.release() }
    recorder = null
  }

  /** 松开说话：停录音 → commit + response.create（与 desktop omni_commit 同语义） */
  @ReactMethod
  fun stopAndCommit(promise: Promise) {
    try {
      stopRecordingInternal()
      val w = ws
      if (w == null) {
        promise.reject("OMNI_NOT_CONNECTED", "Omni 未连接")
        return
      }
      if (!sessionReady) {
        // 连接还在握手：挂起 commit，session.updated 后由 flushPendingOnReady 补发
        pendingCommit = true
        promise.resolve(true)
        return
      }
      w.send(JSONObject().put("type", "input_audio_buffer.commit").toString())
      w.send(JSONObject().put("type", "response.create").toString())
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("OMNI_COMMIT_FAILED", e.message, e)
    }
  }

  /** 打断/取消：停录、停播、断连（与 desktop omni_stop 同语义） */
  @ReactMethod
  fun stop(promise: Promise) {
    try {
      disconnectInternal()
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("OMNI_STOP_FAILED", e.message, e)
    }
  }

  // ── 播放（AudioTrack 24k PCM16 mono 流式） ──

  private fun ensurePlayer(): AudioTrack {
    player?.let { return it }
    val minBuf = AudioTrack.getMinBufferSize(
      OUT_SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
    )
    val t = AudioTrack(
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build(),
      AudioFormat.Builder()
        .setSampleRate(OUT_SAMPLE_RATE)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .build(),
      maxOf(minBuf, OUT_SAMPLE_RATE), // ≥0.5s 缓冲
      AudioTrack.MODE_STREAM,
      AudioManager.AUDIO_SESSION_ID_GENERATE,
    )
    t.play()
    player = t
    return t
  }

  private fun playPcmChunk(b64: String) {
    try {
      val bytes = Base64.decode(b64, Base64.NO_WRAP)
      ensurePlayer().write(bytes, 0, bytes.size)
    } catch (e: Throwable) {
      Log.w(TAG, "play chunk failed: ${e.message}")
    }
  }

  private fun stopPlayer() {
    player?.let { p ->
      try { p.pause(); p.flush(); p.stop() } catch (_: Throwable) {}
      p.release()
    }
    player = null
  }

  // ── 清理 ──

  private fun disconnectInternal() {
    stopRecordingInternal()
    stopPlayer()
    synchronized(pendingAudio) { pendingAudio.clear() }
    pendingCommit = false
    ws?.let { w -> try { w.close(1000, "bye") } catch (_: Throwable) {} }
    ws = null
    sessionReady = false
  }

  private fun cleanupAfterClose() {
    stopRecordingInternal()
    stopPlayer()
    ws = null
    sessionReady = false
  }

  @ReactMethod
  fun setSessionParams(voice: String, systemPrompt: String, promise: Promise) {
    pendingVoice = voice
    pendingPrompt = systemPrompt
    promise.resolve(true)
  }

  // RN EventEmitter 协议要求（无操作）
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  override fun invalidate() {
    disconnectInternal()
    super.invalidate()
  }

  companion object {
    const val NAME = "OmniRealtime"
    private const val TAG = "OmniRealtime"
    private const val WS_BASE = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    private const val IN_SAMPLE_RATE = 16_000
    private const val OUT_SAMPLE_RATE = 24_000
    private const val IN_CHUNK_BYTES = 3_200 // 100ms
  }
}
