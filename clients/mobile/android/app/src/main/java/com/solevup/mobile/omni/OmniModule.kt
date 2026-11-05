package com.solevup.mobile.omni

import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.solevup.mobile.voice.CaptureEvent
import com.solevup.mobile.voice.CaptureHandle
import com.solevup.mobile.voice.JsEvents
import com.solevup.mobile.voice.PcmPlayer
import com.solevup.mobile.voice.VoiceCapture
import com.solevup.mobile.voice.wavBytes
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Qwen Omni Realtime — DashScope 全模态单 WS（对应 desktop qwen_omni.rs + lib.rs 的 omni_* 命令）
 *
 * 协议流程:
 *   连接(Authorization header) → session.created
 *   → session.update(modalities/voice/格式/tools)
 *   → input_audio_buffer.append(PCM Base64)
 *   → input_audio_buffer.commit + response.create
 *   ← response.audio.delta (PCM Base64)
 *   ← response.text.delta  (AI 文字)
 *   ← response.output_item.added/done (type=function_call → 工具调用)
 *   ← response.function_call_arguments.delta/done (工具参数流式)
 *   ← response.audio.done  → omni://status {audio_done}
 *
 * JS 事件（DeviceEventEmitter，名字和 desktop 的 Tauri 事件一致）:
 *   omni://status          { status: connected|audio_done|error|disconnected, message? }
 *   omni://audio_chunk     { bytes }  桌面端带 Base64 由前端播放；手机端直接进 AudioTrack，这里只报字节数
 *   omni://text_chunk      { text }   AI 回复增量文字
 *   omni://user_transcript { text }   用户语音转写
 *   omni://tool_call       { call_id, name, arguments }  前端执行后回传 toolResult
 *   omni://usage           { model, usageJson }
 *   voice://level          { session: 0, level }  录音音量（级联模式同名事件）
 *
 * 和桌面端的差异（都是平台决定的）：
 *   · 录音不经过 JS：AudioRecord 线程直推 WS，松手时 stopRecording 返回 WAV 给气泡。
 *     就绪前的音频缓存、commit 挂起，session.updated 后按序补发（桌面端在 JS 里做 wsReady 判断）。
 *   · 回复音频直接进 AudioTrack 并在这里攒成 WAV，playbackState / takeAiAudio 给 JS。
 *   · 不做 HTTP 探测：OkHttp 握手失败时直接拿得到 401 响应，不必多发一次请求。
 */
class OmniModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME

  private val http = OkHttpClient.Builder()
    .connectTimeout(8, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS) // WS 长连
    .build()

  private val events = JsEvents(reactContext, TAG)

  @Volatile private var ws: WebSocket? = null
  @Volatile private var sessionReady = false
  @Volatile private var currentModel = ""

  // connect 时暂存，session.created 后真正发 session.update
  @Volatile private var pendingVoice = ""
  @Volatile private var pendingPrompt = ""
  @Volatile private var pendingTools = JSONArray()

  // 只发一次 session.update（Rust 接收任务里的 session_ready）
  private var sessionCreatedSeen = false

  // item_id → (call_id, name)：用于 arguments.delta/done 事件找回对应 call
  private val pendingCalls = HashMap<String, Pair<String, String>>()

  // item_id → accumulated arguments（部分实现只发 delta，不发 done 的 arguments 字段）
  private val callArgs = HashMap<String, StringBuilder>()

  // 时序保护（desktop 端踩过的坑）：按住说话可能早于 WS 就绪。
  // 就绪前采集的 append 先缓存、commit 先挂起，session.updated 后按序补发。
  private val pendingAudio = ArrayList<String>()
  @Volatile private var pendingCommit = false
  @Volatile private var pendingTranscribeOnly = false

  // 还在握手的 connect：连上、失败、被取代、被 stop 时都要给 JS 一个结果
  private val connectLock = Any()
  private var connectPromise: Promise? = null

  private var capture: CaptureHandle? = null
  private var captureClosed: CountDownLatch? = null
  private var captureGen = 0
  private val recorded = ByteArrayOutputStream()
  private var recordedChunks = 0
  private val recordLock = Any()

  @Volatile private var player: PcmPlayer? = null
  private val aiPcm = ByteArrayOutputStream()

  /** org.json 的 optString 会把 JSON null 变成 "null"，这里只认真正的字符串（Rust as_str） */
  private fun JSONObject?.str(key: String): String? = this?.opt(key) as? String

  private fun emitStatus(status: String, message: String? = null) {
    events.emit("omni://status", Arguments.createMap().apply {
      putString("status", status)
      if (message != null) putString("message", message)
    })
  }

  private fun takeConnectPromise(): Promise? = synchronized(connectLock) {
    connectPromise.also { connectPromise = null }
  }

  // ── 连接 ──

  /** 关闭旧连接并建新连接；WS 握手成功即 resolve（和 Rust omni_connect 一样不等 session.updated） */
  @ReactMethod
  fun connect(apiKey: String, model: String, voice: String, systemPrompt: String, toolsJson: String, promise: Promise) {
    try {
      takeConnectPromise()?.reject(ERROR, "连接已被新的会话取代")
      // 只断旧 WS + 停播放。绝不动录音线程和 pendingAudio：
      // 按住说话的 UX 是「先开录、连接并行」，connect 杀录音会导致 commit 时
      // buffer 为空（buffer too small / no user role，desktop 同款坑）。
      ws?.let { w -> try { w.close(1000, "reconnect") } catch (_: Throwable) {} }
      ws = null
      stopPlayer()
      sessionReady = false
      sessionCreatedSeen = false
      pendingCommit = false
      pendingTranscribeOnly = false
      pendingCalls.clear()
      callArgs.clear()
      currentModel = model
      pendingVoice = voice
      pendingPrompt = systemPrompt
      pendingTools = try { JSONArray(toolsJson) } catch (_: Throwable) { JSONArray() }
      synchronized(aiPcm) { aiPcm.reset() }

      val url = "$WS_BASE?model=$model"
      val req = try {
        Request.Builder()
          .url(url)
          .addHeader("Authorization", "Bearer $apiKey")
          .build()
      } catch (_: IllegalArgumentException) {
        promise.reject(ERROR, "API Key 格式无效")
        return
      }

      val keyPreview = apiKey.take(8)
      Log.i(TAG, "连接 $url  key=$keyPreview...")

      synchronized(connectLock) { connectPromise = promise }
      ws = http.newWebSocket(req, object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
          if (ws !== webSocket) return
          takeConnectPromise()?.resolve(true)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
          if (ws !== webSocket) return // 旧连接迟到消息忽略
          handleEvent(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
          if (ws !== webSocket) return
          Log.i(TAG, "连接关闭: $code $reason")
          emitStatus("disconnected")
          cleanupAfterClose()
          webSocket.close(1000, null)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
          // 旧连接被 reconnect 替换后的迟到回调不许动新状态（否则把新 WS/录音清了，
          // 表现为间断性「Omni 未连接」）
          if (ws !== webSocket) return
          Log.e(TAG, "WS failure: ${t.message} http=${response?.code}")
          val connecting = takeConnectPromise()
          if (connecting != null) {
            val message = if (response?.code == 401) {
              "API Key 无效（401 Unauthorized），请在设置中填入正确的 Key"
            } else {
              "WebSocket 连接失败: ${t.message}"
            }
            connecting.reject(ERROR, message, t)
          } else {
            // 桌面端接收循环遇到 WS 错误会静默退出，前端要等 30 秒超时；手机端直接报出去
            emitStatus("error", t.message ?: "连接失败")
          }
          cleanupAfterClose()
        }
      })
    } catch (e: Throwable) {
      promise.reject(ERROR, e.message, e)
    }
  }

  private fun sendSessionUpdate(voice: String, systemPrompt: String, tools: JSONArray) {
    val session = JSONObject().apply {
      put("modalities", JSONArray().put("text").put("audio"))
      // 音色空时使用默认
      put("voice", if (voice.isEmpty()) "Tina" else voice)
      put("input_audio_format", "pcm")
      put("output_audio_format", "pcm")
      put("instructions", systemPrompt)
      put("input_audio_transcription", JSONObject().put("model", "qwen-turbo"))
      // manual 模式：用户手动 commit，配合按住说话 UX
      put("turn_detection", JSONObject.NULL)
      // tools 非空数组时注入（Realtime API 扁平格式：{type, name, description, parameters}）
      if (tools.length() > 0) {
        put("tools", tools)
        put("tool_choice", "auto")
      }
    }
    ws?.send(JSONObject().apply {
      put("type", "session.update")
      put("session", session)
    }.toString())
  }

  private fun flushPendingOnReady() {
    val w = ws ?: return
    synchronized(pendingAudio) {
      for (msg in pendingAudio) w.send(msg)
      pendingAudio.clear()
    }
    if (pendingCommit) {
      pendingCommit = false
      sendCommit(w)
    }
    if (pendingTranscribeOnly) {
      pendingTranscribeOnly = false
      w.send(JSONObject().put("type", "input_audio_buffer.commit").toString())
    }
  }

  private fun sendCommit(w: WebSocket) {
    w.send(JSONObject().put("type", "input_audio_buffer.commit").toString())
    w.send(JSONObject().put("type", "response.create").toString())
  }

  private fun emitToolCall(callId: String, name: String, arguments: String) {
    events.emit("omni://tool_call", Arguments.createMap().apply {
      putString("call_id", callId)
      putString("name", name)
      putString("arguments", arguments)
    })
  }

  private fun handleEvent(text: String) {
    val v = try { JSONObject(text) } catch (_: Throwable) { return }
    when (val eventType = v.str("type") ?: "") {
      "session.created" -> {
        if (!sessionCreatedSeen) {
          sessionCreatedSeen = true
          // 发送 session.update
          sendSessionUpdate(pendingVoice, pendingPrompt, pendingTools)
        }
      }
      "session.updated" -> {
        Log.i(TAG, "会话就绪")
        sessionReady = true
        emitStatus("connected")
        flushPendingOnReady()
      }
      "response.audio.delta" -> {
        val delta = v.str("delta")
        if (!delta.isNullOrEmpty()) playPcmChunk(delta)
      }
      // AI 回复文字：text 模态或 audio 转写，两种事件名都接
      "response.text.delta", "response.audio.transcript.delta", "response.audio_transcript.delta" -> {
        val delta = v.str("delta")
        if (!delta.isNullOrEmpty()) {
          events.emit("omni://text_chunk", Arguments.createMap().apply { putString("text", delta) })
        }
      }
      "response.audio.done" -> {
        Log.i(TAG, "音频回复完成")
        emitStatus("audio_done")
      }
      // 一轮响应结束：携带 usage 用于审计计费
      "response.done" -> {
        val usage = v.optJSONObject("response")?.optJSONObject("usage")
        if (usage != null) {
          events.emit("omni://usage", Arguments.createMap().apply {
            putString("model", currentModel)
            putString("usageJson", usage.toString())
          })
        }
      }
      // 工具调用 item 首次出现：登记 item_id ↔ call_id/name 映射
      "response.output_item.added" -> {
        val item = v.optJSONObject("item")
        if (item.str("type") == "function_call") {
          val itemId = item.str("id") ?: ""
          val callId = item.str("call_id") ?: ""
          val name = item.str("name") ?: ""
          if (itemId.isNotEmpty() && callId.isNotEmpty()) {
            Log.i(TAG, "工具调用开始 item=$itemId call=$callId name=$name")
            pendingCalls[itemId] = callId to name
            callArgs[itemId] = StringBuilder()
          }
        }
      }
      // 工具参数流式
      "response.function_call_arguments.delta" -> {
        val delta = v.str("delta")
        if (delta != null) callArgs[v.str("item_id") ?: ""]?.append(delta)
      }
      // 工具参数完成：触发前端执行
      "response.function_call_arguments.done" -> {
        val itemId = v.str("item_id") ?: ""
        val finalArgs = v.str("arguments") ?: callArgs[itemId]?.toString() ?: ""
        val call = pendingCalls.remove(itemId)
        if (call != null) {
          callArgs.remove(itemId)
          Log.i(TAG, "工具调用完成 call=${call.first} name=${call.second} args=${finalArgs.take(200)}")
          emitToolCall(call.first, call.second, finalArgs)
        }
      }
      // 兜底：某些实现只发 output_item.done（不发 arguments.done）
      "response.output_item.done" -> {
        val item = v.optJSONObject("item")
        if (item.str("type") == "function_call") {
          val itemId = item.str("id") ?: ""
          // 若 arguments.done 已处理，这里 pendingCalls 已空，跳过
          val call = pendingCalls.remove(itemId)
          if (call != null) {
            val finalArgs = item.str("arguments") ?: callArgs[itemId]?.toString() ?: ""
            callArgs.remove(itemId)
            Log.i(TAG, "工具调用完成(item.done) call=${call.first} name=${call.second} args=${finalArgs.take(200)}")
            emitToolCall(call.first, call.second, finalArgs)
          }
        }
      }
      "conversation.item.input_audio_transcription.completed" -> {
        val t = v.str("transcript")
        if (t != null && t.isNotBlank()) {
          events.emit("omni://user_transcript", Arguments.createMap().apply { putString("text", t) })
        }
      }
      "error" -> {
        val msg = v.optJSONObject("error").str("message") ?: "未知错误"
        Log.e(TAG, "服务端错误: $msg")
        emitStatus("error", msg)
      }
      else -> Log.d(TAG, "← $eventType")
    }
  }

  // ── 上行（lib.rs omni_send_audio / omni_commit / omni_send_text / omni_tool_result） ──

  private fun appendMessage(b64: String): String =
    JSONObject().apply {
      put("type", "input_audio_buffer.append")
      put("audio", b64)
    }.toString()

  private fun sendOrBuffer(msg: String) {
    val w = ws
    if (w != null && sessionReady) w.send(msg)
    else synchronized(pendingAudio) { pendingAudio.add(msg) }
  }

  @ReactMethod
  fun sendAudio(pcmBase64: String, promise: Promise) {
    if (ws == null) {
      promise.reject(ERROR, "Omni 未连接")
      return
    }
    sendOrBuffer(appendMessage(pcmBase64))
    promise.resolve(true)
  }

  @ReactMethod
  fun commit(promise: Promise) {
    val w = ws
    if (w == null) {
      promise.reject(ERROR, "Omni 未连接")
      return
    }
    if (!sessionReady) {
      // 连接还在握手：挂起 commit，session.updated 后由 flushPendingOnReady 补发
      pendingCommit = true
    } else {
      sendCommit(w)
    }
    promise.resolve(true)
  }

  @ReactMethod
  fun sendText(text: String, promise: Promise) {
    val w = ws
    if (w == null) {
      promise.reject(ERROR, "Omni 未连接")
      return
    }
    val create = JSONObject().apply {
      put("type", "conversation.item.create")
      put("item", JSONObject().apply {
        put("type", "message")
        put("role", "user")
        put("content", JSONArray().put(JSONObject().put("type", "input_text").put("text", text)))
      })
    }
    w.send(create.toString())
    w.send(JSONObject().put("type", "response.create").toString())
    promise.resolve(true)
  }

  /** 回传工具执行结果，触发 AI 继续生成回复（音频 + 文字） */
  @ReactMethod
  fun toolResult(callId: String, output: String, promise: Promise) {
    val w = ws
    if (w == null) {
      promise.reject(ERROR, "Omni 未连接")
      return
    }
    val create = JSONObject().apply {
      put("type", "conversation.item.create")
      put("item", JSONObject().apply {
        put("type", "function_call_output")
        put("call_id", callId)
        put("output", output)
      })
    }
    w.send(create.toString())
    w.send(JSONObject().put("type", "response.create").toString())
    promise.resolve(true)
  }

  // ── 录音（复用 VoiceCapture：AudioRecord 16k PCM16 mono，100 ms 一块直推 WS） ──

  /** 麦克风真正开始录才 resolve；开不了就 reject（桌面端 getUserMedia 的语义） */
  @ReactMethod
  fun startRecording(promise: Promise) {
    synchronized(recordLock) {
      if (capture != null) {
        promise.resolve(true)
        return
      }
      synchronized(recorded) {
        recorded.reset()
        recordedChunks = 0
      }
      val closed = CountDownLatch(1)
      captureClosed = closed
      val gen = ++captureGen
      var settled = false
      capture = VoiceCapture.start { ev ->
        when (ev) {
          is CaptureEvent.Ready -> {
            if (!settled) { settled = true; promise.resolve(true) }
          }
          is CaptureEvent.Chunk -> {
            // 已放弃的录音还会录完 250 ms 尾巴：不能写进下一轮的 recorded，
            // 也不能落回刚清空的 pendingAudio（connect 不清它，下次连上会补发到新一轮最前面）
            if (synchronized(recordLock) { captureGen } != gen) return@start
            synchronized(recorded) {
              recorded.write(ev.pcm)
              recordedChunks += 1
            }
            // 音量广播（级联模式下由 VoiceSession 发同名事件）
            events.emit("voice://level", Arguments.createMap().apply {
              putDouble("session", 0.0)
              putDouble("level", ev.level.toDouble())
            })
            sendOrBuffer(appendMessage(Base64.encodeToString(ev.pcm, Base64.NO_WRAP)))
          }
          CaptureEvent.Glitch -> {}
          is CaptureEvent.Error -> {
            Log.e(TAG, "录音出错: ${ev.message}")
            if (!settled) { settled = true; promise.reject(ERROR, ev.message) }
          }
          CaptureEvent.Closed -> {
            if (!settled) { settled = true; promise.reject(ERROR, "没有录到声音：麦克风没有数据") }
            // 线程已退出（比如麦克风打不开）：清掉句柄，下次按下才会真的重新开麦
            synchronized(recordLock) {
              if (captureGen == gen) {
                capture = null
                captureClosed = null
              }
            }
            closed.countDown()
          }
        }
      }
    }
  }

  /** 停录并等尾巴录完；返回 chunks = 块数，块数 > 0 时带 wavBase64 + durationMs */
  private fun stopCaptureBlocking(): Triple<Int, ByteArray, Long> {
    val (handle, closed) = synchronized(recordLock) {
      val h = capture
      val c = captureClosed
      capture = null
      captureClosed = null
      h to c
    }
    handle?.requestStop()
    try { closed?.await(STOP_WAIT_MS, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) {}
    return synchronized(recorded) {
      val bytes = recorded.toByteArray()
      val chunks = recordedChunks
      Triple(chunks, bytes, (bytes.size / 2).toLong() * 1_000 / VoiceCapture.TARGET_RATE)
    }
  }

  /** 停止录音，不 commit（对应 desktop sr.stop() + 气泡 WAV）：{ chunks, wavBase64, durationMs } */
  @ReactMethod
  fun stopRecording(promise: Promise) {
    Thread({
      try {
        val (chunks, pcm, durationMs) = stopCaptureBlocking()
        promise.resolve(Arguments.createMap().apply {
          putInt("chunks", chunks)
          putString("wavBase64", if (chunks > 0) Base64.encodeToString(wavBytes(pcm, VoiceCapture.TARGET_RATE), Base64.NO_WRAP) else "")
          putDouble("durationMs", durationMs.toDouble())
        })
      } catch (e: Throwable) {
        promise.reject(ERROR, e.message, e)
      }
    }, "omni-stop-record").start()
  }

  /** 松开说话：停录音 → commit + response.create */
  @ReactMethod
  fun stopAndCommit(promise: Promise) {
    Thread({
      try {
        stopCaptureBlocking()
        val w = ws
        if (w == null) {
          promise.reject("OMNI_NOT_CONNECTED", "Omni 未连接")
          return@Thread
        }
        if (!sessionReady) {
          // 连接还在握手：挂起 commit，session.updated 后由 flushPendingOnReady 补发
          pendingCommit = true
          promise.resolve(true)
          return@Thread
        }
        sendCommit(w)
        promise.resolve(true)
      } catch (e: Throwable) {
        promise.reject("OMNI_COMMIT_FAILED", e.message, e)
      }
    }, "omni-commit").start()
  }

  /** 左上滑转文字：停录 + 仅 commit（不发 response.create）→ 服务端只回用户转写 */
  @ReactMethod
  fun stopAndTranscribe(promise: Promise) {
    Thread({
      try {
        stopCaptureBlocking()
        val w = ws
        if (w == null) {
          promise.reject("OMNI_NOT_CONNECTED", "Omni 未连接")
          return@Thread
        }
        if (!sessionReady) {
          pendingTranscribeOnly = true
          promise.resolve(true)
          return@Thread
        }
        w.send(JSONObject().put("type", "input_audio_buffer.commit").toString())
        promise.resolve(true)
      } catch (e: Throwable) {
        promise.reject("OMNI_TRANSCRIBE_FAILED", e.message, e)
      }
    }, "omni-transcribe").start()
  }

  /** 打断/取消：停录、停播、断连（与 desktop omni_stop 同语义）；没有会话时是空操作 */
  @ReactMethod
  fun stop(promise: Promise) {
    try {
      val hadSession = ws != null
      disconnectInternal()
      // 桌面端断开后服务端回 Close，接收循环发 disconnected；这里 ws 已置空收不到，直接发
      if (hadSession) emitStatus("disconnected")
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("OMNI_STOP_FAILED", e.message, e)
    }
  }

  // ── 播放（AudioTrack 24k PCM16 mono 流式） ──

  private fun playPcmChunk(b64: String) {
    try {
      val bytes = Base64.decode(b64, Base64.NO_WRAP)
      synchronized(aiPcm) { aiPcm.write(bytes) }
      val p = player ?: PcmPlayer(OUT_SAMPLE_RATE, "omni-play").also { player = it }
      p.write(bytes)
      events.emit("omni://audio_chunk", Arguments.createMap().apply { putInt("bytes", bytes.size) })
    } catch (e: Throwable) {
      Log.w(TAG, "play chunk failed: ${e.message}")
    }
  }

  private fun stopPlayer() {
    player?.close()
    player = null
  }

  /** 回复音频的播放进度：{ hasAudio, drainedMs }（对应 desktop omniLastSourceEndedRef 的轮询） */
  @ReactMethod
  fun playbackState(promise: Promise) {
    val p = player
    if (p == null) {
      promise.resolve(Arguments.createMap().apply {
        putBoolean("hasAudio", false)
        putDouble("drainedMs", 0.0)
      })
    } else {
      promise.resolve(p.stateMap())
    }
  }

  /** 取走本轮回复音频（对应 desktop 收集 omniAiPcmChunksRef 后拼 WAV）：{ wavBase64, durationMs } 或 null */
  @ReactMethod
  fun takeAiAudio(promise: Promise) {
    val bytes = synchronized(aiPcm) {
      val b = aiPcm.toByteArray()
      aiPcm.reset()
      b
    }
    if (bytes.isEmpty()) {
      promise.resolve(null)
      return
    }
    promise.resolve(Arguments.createMap().apply {
      putString("wavBase64", Base64.encodeToString(wavBytes(bytes, OUT_SAMPLE_RATE), Base64.NO_WRAP))
      putDouble("durationMs", ((bytes.size / 2).toLong() * 1_000 / OUT_SAMPLE_RATE).toDouble())
    })
  }

  // ── 清理 ──

  private fun stopRecordingInternal() {
    val handle = synchronized(recordLock) {
      val h = capture
      capture = null
      captureClosed = null
      captureGen += 1 // 放弃这次录音：尾巴作废（正常松手走 stopCaptureBlocking，尾巴要发出去）
      h
    }
    handle?.requestStop()
  }

  private fun disconnectInternal() {
    takeConnectPromise()?.reject(ERROR, "连接已取消")
    stopRecordingInternal()
    stopPlayer()
    synchronized(pendingAudio) { pendingAudio.clear() }
    pendingCommit = false
    pendingTranscribeOnly = false
    val w = ws
    ws = null
    sessionReady = false
    w?.let { try { it.close(1000, "bye") } catch (_: Throwable) {} }
  }

  private fun cleanupAfterClose() {
    stopRecordingInternal()
    ws = null
    sessionReady = false
    synchronized(pendingAudio) { pendingAudio.clear() }
    pendingCommit = false
    pendingTranscribeOnly = false
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
    private const val ERROR = "OMNI_ERROR"
    private const val WS_BASE = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    private const val OUT_SAMPLE_RATE = 24_000
    private const val STOP_WAIT_MS = 1_000L
  }
}
