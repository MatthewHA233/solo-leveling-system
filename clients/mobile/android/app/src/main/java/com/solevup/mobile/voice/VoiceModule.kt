package com.solevup.mobile.voice

import android.media.MediaPlayer
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicLong

/** 事件桥：名字和 desktop 的 Tauri 事件一致（voice://partial、fish-tts-audio-{id} …） */
internal class JsEvents(private val ctx: ReactApplicationContext, private val tag: String) {
  fun emit(name: String, params: Any?) {
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, params)
    } catch (e: Throwable) {
      Log.w(tag, "emit $name failed: ${e.message}")
    }
  }
}

/**
 * 语音 NativeModule：desktop lib.rs / voice/mod.rs 里 voice_* 和 fish_tts_* 命令的手机版。
 *
 * 全局状态对应 AppState.fish_tts（单槽位）和 VoiceState（active + seq）。
 * Key 和桌面端一样由 JS 传入（src/lib/voice/voice-service.ts、fish-tts.ts 负责从配置 / SolevupDb 取），这里不读库。
 */
class VoiceModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME

  private val events = JsEvents(reactContext, TAG)

  private val http = OkHttpClient.Builder()
    .connectTimeout(CONNECT_TIMEOUT_S, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS) // WS 长连
    .build()

  // ── 按住说话（VoiceState） ──

  private val activeLock = Any()
  private var active: VoiceSession? = null
  private val seq = AtomicLong(0)

  private fun ReadableArray?.strings(): List<String> {
    if (this == null) return emptyList()
    return (0 until size()).mapNotNull { getString(it) }
  }

  /** 开始一次按住说话：立即返回会话号，开麦 / 建连在后台进行（就绪时发 voice://ready） */
  @ReactMethod
  fun voiceStart(req: ReadableMap, promise: Promise) {
    val apiKey = req.getString("apiKey") ?: ""
    if (apiKey.isBlank()) {
      promise.reject(ERROR, "未配置百炼 API Key，无法语音识别")
      return
    }
    try {
      val contextArr = if (req.hasKey("context")) req.getArray("context") else null
      val context = if (contextArr == null) {
        emptyList()
      } else {
        (0 until contextArr.size()).mapNotNull { i ->
          contextArr.getMap(i)?.let { ContextTurn(it.getString("user") ?: "", it.getString("assistant") ?: "") }
        }
      }
      val request = VoiceStartRequest(
        apiKey = apiKey,
        model = req.getString("model") ?: "",
        workspaceId = if (req.hasKey("workspaceId")) req.getString("workspaceId") else null,
        vocabulary = (if (req.hasKey("vocabulary")) req.getArray("vocabulary") else null).strings(),
        context = context,
        languageHints = (if (req.hasKey("languageHints")) req.getArray("languageHints") else null).strings(),
      )
      val session = synchronized(activeLock) {
        active?.cancel() // 快速连按 / 上一轮没收尾：旧会话作废
        val id = seq.incrementAndGet()
        val s = VoiceSession(id, request, http, events)
        active = s
        s.start()
        id
      }
      promise.resolve(session.toDouble())
    } catch (e: Throwable) {
      promise.reject(ERROR, e.message ?: "语音启动失败", e)
    }
  }

  /** 松手：停止录音并等待定稿 */
  @ReactMethod
  fun voiceStop(promise: Promise) {
    val s = synchronized(activeLock) { active.also { active = null } }
    if (s == null) {
      promise.reject(ERROR, "当前没有进行中的录音")
      return
    }
    s.requestStop()
    // 等待最长 40 秒，不能占着 native modules 线程
    Thread({
      try {
        promise.resolve(s.await(VOICE_STOP_TIMEOUT_MS).toMap())
      } catch (_: TimeoutException) {
        s.cancel()
        promise.reject(ERROR, "语音识别超时，请重试")
      } catch (e: VoiceFailure) {
        promise.reject(ERROR, e.message)
      } catch (e: Throwable) {
        promise.reject(ERROR, "录音会话意外结束", e)
      }
    }, "voice-stop").start()
  }

  /** 放弃本次录音（误触、上滑取消） */
  @ReactMethod
  fun voiceCancel(promise: Promise) {
    synchronized(activeLock) {
      active?.cancel()
      active = null
    }
    promise.resolve(null)
  }

  // ── Fish TTS（AppState.fish_tts，单槽位） ──

  private val fishLock = Any()
  private var fish: FishTtsConnection? = null

  /** stop 之后 JS 还可能来取已收到的那部分音频，留一个引用 */
  private var fishLast: FishTtsConnection? = null

  @ReactMethod
  fun fishTtsConnect(
    apiKey: String,
    referenceId: String,
    sampleRate: Double,
    model: String,
    eventId: String,
    promise: Promise,
  ) {
    try {
      val config = FishTtsConfig(apiKey, referenceId, sampleRate.toInt(), model, eventId)
      synchronized(fishLock) {
        // 桌面端这里只覆盖槽位，旧连接要等服务端关；手机上旧连接的声音也要一起停，否则两轮回复叠音
        fish?.stop()
        val conn = FishTtsConnection(config, http, events)
        fish = conn
        fishLast = conn
      }
      Log.i(TAG, "Fish TTS 连接已建立")
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject(ERROR, e.message ?: "Fish TTS 连接失败", e)
    }
  }

  @ReactMethod
  fun fishTtsSendText(text: String, promise: Promise) {
    val conn = synchronized(fishLock) { fish }
    if (conn == null) {
      promise.reject(ERROR, "Fish TTS 未连接")
      return
    }
    try {
      conn.sendText(text)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject(ERROR, e.message ?: "Fish TTS 发送失败", e)
    }
  }

  @ReactMethod
  fun fishTtsFlush(promise: Promise) {
    val conn = synchronized(fishLock) { fish }
    if (conn == null) {
      promise.reject(ERROR, "Fish TTS 未连接")
      return
    }
    try {
      conn.flush()
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject(ERROR, e.message ?: "Fish TTS flush 失败", e)
    }
  }

  /**
   * 只停这个 eventId 的连接。桌面端 fish_tts_stop 不带 id，单槽位里是谁就停谁；
   * 手机上这里同时管声音，上一轮收尾晚到的 stop 不能把新一轮的连接和声音一起停掉。
   */
  @ReactMethod
  fun fishTtsStop(eventId: String, promise: Promise) {
    val conn = synchronized(fishLock) {
      fish?.takeIf { it.eventId == eventId }?.also { fish = null }
    }
    try {
      conn?.stop()
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject(ERROR, e.message ?: "Fish TTS 停止失败", e)
    }
  }

  /** 播放进度（JS 轮询）：{ hasAudio, drainedMs, totalBytes }；连接不是这个 eventId 时返回 null */
  @ReactMethod
  fun fishTtsPlaybackState(eventId: String, promise: Promise) {
    val conn = synchronized(fishLock) { fishLast?.takeIf { it.eventId == eventId } }
    promise.resolve(conn?.playerState())
  }

  /** 取走这一轮已收到的音频：{ wavBase64, durationMs } 或 null */
  @ReactMethod
  fun fishTtsTakeAudio(eventId: String, promise: Promise) {
    val conn = synchronized(fishLock) { fishLast?.takeIf { it.eventId == eventId } }
    val audio = conn?.takeAudio()
    if (audio == null) {
      promise.resolve(null)
      return
    }
    promise.resolve(
      Arguments.createMap().apply {
        putString("wavBase64", Base64.encodeToString(audio.first, Base64.NO_WRAP))
        putDouble("durationMs", audio.second.toDouble())
      },
    )
  }

  // ── 音频文件（desktop lib.rs save_audio_file / get_audio_dir） ──

  private fun audioRoot(): File = File(reactContext.filesDir, "audio")

  /** 保存一条语音消息 WAV；返回相对路径 "{session_id}/{filename}"，供 DB 存储 */
  @ReactMethod
  fun saveAudioFile(sessionId: String, wavBase64: String, timestamp: String, promise: Promise) {
    Thread({
      try {
        // 桌面端 session_id 来自自己生成的 UUID；这里多挡一道，防止路径逃出音频目录
        require(sessionId.isNotEmpty() && !sessionId.contains('/') && !sessionId.contains("..")) { "会话 ID 无效" }
        val safeTs = timestamp.replace(':', '-').replace('.', '-')
        val filename = "$safeTs.wav"
        val dir = File(audioRoot(), sessionId)
        if (!dir.isDirectory && !dir.mkdirs()) throw IllegalStateException("创建目录失败")
        File(dir, filename).writeBytes(Base64.decode(wavBase64, Base64.NO_WRAP))
        promise.resolve("$sessionId/$filename")
      } catch (e: Throwable) {
        promise.reject(ERROR, "写入失败: ${e.message}", e)
      }
    }, "voice-save-audio").start()
  }

  @ReactMethod
  fun getAudioDir(promise: Promise) {
    promise.resolve(audioRoot().absolutePath)
  }

  // ── 气泡回放（桌面端是 <audio> 标签；手机端用系统 MediaPlayer，不引第三方包） ──

  private val replayLock = Any()
  private var replay: MediaPlayer? = null
  private var replayPath: String? = null

  private fun releaseReplay() {
    replay?.let { p ->
      try { p.stop() } catch (_: Throwable) {}
      p.release()
    }
    replay = null
    replayPath = null
  }

  /** 播放一条已落盘的语音；relativePath 是 saveAudioFile 的返回值。放完 / 失败发 voice://playback_end { path, error? } */
  @ReactMethod
  fun playAudioFile(relativePath: String, promise: Promise) {
    try {
      val file = File(audioRoot(), relativePath)
      require(file.canonicalPath.startsWith(audioRoot().canonicalPath + File.separator)) { "音频路径无效" }
      if (!file.isFile) throw IllegalStateException("音频文件不存在")
      val endEvent = { error: String? ->
        val shouldEmit = synchronized(replayLock) {
          val same = replayPath == relativePath
          if (same) releaseReplay()
          same
        }
        if (shouldEmit) {
          events.emit(
            "voice://playback_end",
            Arguments.createMap().apply {
              putString("path", relativePath)
              if (error != null) putString("error", error)
            },
          )
        }
      }
      synchronized(replayLock) {
        releaseReplay()
        val p = MediaPlayer()
        p.setDataSource(file.absolutePath)
        p.setOnCompletionListener { endEvent(null) }
        p.setOnErrorListener { _, what, extra ->
          endEvent("播放失败（$what/$extra）")
          true
        }
        replay = p
        replayPath = relativePath
        p.prepare()
        p.start()
      }
      promise.resolve(null)
    } catch (e: Throwable) {
      synchronized(replayLock) { releaseReplay() }
      promise.reject(ERROR, e.message ?: "播放失败", e)
    }
  }

  @ReactMethod
  fun stopAudioPlayback(promise: Promise) {
    synchronized(replayLock) { releaseReplay() }
    promise.resolve(null)
  }

  // RN EventEmitter 协议要求（无操作）
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  override fun invalidate() {
    synchronized(activeLock) {
      active?.cancel()
      active = null
    }
    synchronized(fishLock) {
      fish?.stop()
      fish = null
      fishLast = null
    }
    synchronized(replayLock) { releaseReplay() }
    super.invalidate()
  }

  companion object {
    const val NAME = "SolevupVoice"
    private const val TAG = "Voice"
    private const val ERROR = "VOICE_ERROR"
    private const val CONNECT_TIMEOUT_S = 5L
  }
}
