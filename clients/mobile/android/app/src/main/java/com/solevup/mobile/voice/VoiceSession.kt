package com.solevup.mobile.voice

import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import okhttp3.OkHttpClient
import java.io.ByteArrayOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.math.max
import kotlin.math.min

/**
 * 语音输入会话（按住说话），对应 desktop voice/mod.rs
 *
 *   按下 voiceStart ─┬─ 原生录音线程（VoiceCapture）：立刻开麦，100 ms 一块
 *                    └─ 流式识别连接（AsrStream）：并行建连，就绪前的音频先缓冲
 *   说话中           → voice://partial（边说边出字）、voice://level（音量）
 *   松开 voiceStop   → 多录 250 ms 尾巴 → finish-task → 定稿全文 + 录音 WAV + 用量 + 各段耗时
 *
 * 失败兜底（「绝不丢掉用户说的话」）：
 *   · 出第一个字之前识别连接出错 → 换新连接，重放已录全部音频（至多再试一次）
 *   · 录到了声音、识别却一个字都没回 → 同样重放一次
 *   · 两次都失败 → 用批量识别（qwen3-asr-flash-realtime）把整段录音再转一遍
 * 隐私：只在按住期间开麦；最长 90 秒自动停止，防止抬手事件丢失后麦克风一直开着。
 *
 * Rust 用 select! 同时等多路通道；这里把取消、停止、录音事件、识别结果放进同一个队列，
 * 重开麦克风 / 换识别连接时世代号 +1，旧世代的事件直接丢弃（对应 Rust 替换 receiver）。
 */
private const val MAX_RECORD_MS = 90_000L
private const val MAX_ATTEMPTS = 2

/** 录音中途麦克风出错（设备被抢占等）时，按住期间最多重开几次 */
private const val MAX_CAPTURE_RESTARTS = 3

/** 录音结束后等识别收尾的上限（识别任务自身另有 8 秒收尾超时） */
private const val FINALIZE_TIMEOUT_MS = 12_000L

/** voiceStop 等整个会话出结果的上限（含兜底批量识别） */
internal const val VOICE_STOP_TIMEOUT_MS = 40_000L
private const val FALLBACK_TIMEOUT_MS = 20_000L

/** 一块音频 RMS 超过它就算「有人在说话」 */
private const val SPEECH_LEVEL = 0.015f

/** 回放重放时每帧 3200 字节（100 ms） */
private const val REPLAY_FRAME_BYTES = 3_200
private const val GENERIC_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
private const val FALLBACK_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
private const val FALLBACK_MODEL = "qwen3-asr-flash-realtime"
private const val TAG = "Voice"

internal class VoiceStartRequest(
  val apiKey: String,
  val model: String,
  /** 百炼业务空间 ID：配了就优先走专属域名，连不上再回退通用域名 */
  val workspaceId: String?,
  val vocabulary: List<String>,
  val context: List<ContextTurn>,
  val languageHints: List<String>,
)

internal class VoiceTimings {
  var micOpenMs: Long? = null
  var asrConnectMs: Long? = null
  var asrStartMs: Long? = null
  var firstPartialMs: Long? = null

  /** 松手 → 拿到定稿 */
  var finalizeMs: Long? = null
  var totalMs: Long = 0

  fun toMap(): WritableMap = Arguments.createMap().apply {
    putNullableLong("micOpenMs", micOpenMs)
    putNullableLong("asrConnectMs", asrConnectMs)
    putNullableLong("asrStartMs", asrStartMs)
    putNullableLong("firstPartialMs", firstPartialMs)
    putNullableLong("finalizeMs", finalizeMs)
    putDouble("totalMs", totalMs.toDouble())
  }
}

private fun WritableMap.putNullableLong(key: String, value: Long?) {
  if (value == null) putNull(key) else putDouble(key, value.toDouble())
}

internal class VoiceResult(
  val session: Long,
  val text: String,
  val wavBase64: String,
  val durationMs: Long,
  val hadSpeech: Boolean,
  val model: String,
  val usage: AsrUsage?,
  val attempts: Int,
  /** 流式识别两次都失败，改用批量识别得到的结果 */
  val fallback: Boolean,
  val device: String?,
  /** 录音掉帧次数（不影响继续录，排查断录用） */
  val glitches: Int,
  /** 录音中途麦克风出错后重开的次数 */
  val captureRestarts: Int,
  val timings: VoiceTimings,
) {
  fun toMap(): WritableMap = Arguments.createMap().apply {
    putDouble("session", session.toDouble())
    putString("text", text)
    putString("wavBase64", wavBase64)
    putDouble("durationMs", durationMs.toDouble())
    putBoolean("hadSpeech", hadSpeech)
    putString("model", model)
    if (usage == null) {
      putNull("usage")
    } else {
      putMap(
        "usage",
        Arguments.createMap().apply {
          putDouble("input_tokens", usage.inputTokens.toDouble())
          putDouble("output_tokens", usage.outputTokens.toDouble())
        },
      )
    }
    putInt("attempts", attempts)
    putBoolean("fallback", fallback)
    if (device == null) putNull("device") else putString("device", device)
    putInt("glitches", glitches)
    putInt("captureRestarts", captureRestarts)
    putMap("timings", timings.toMap())
  }
}

/** 会话失败：message 直接给用户看（Rust Result::Err(String)） */
internal class VoiceFailure(message: String) : Exception(message)

internal fun voiceEndpoints(workspaceId: String?): List<String> {
  val list = ArrayList<String>()
  val id = workspaceId?.trim()
  if (!id.isNullOrEmpty() && id.all { (it in 'a'..'z') || (it in 'A'..'Z') || (it in '0'..'9') || it == '-' }) {
    list.add("wss://$id.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference")
  }
  list.add(GENERIC_ENDPOINT)
  return list
}

private fun joined(finals: List<String>, partial: String): String =
  (finals.joinToString("") + partial).trim()

/** 单声道 PCM16 → WAV（给语音气泡回放）；桌面端的 wav_bytes 固定 16 kHz，这里 TTS / Omni 回复（24 kHz）也共用 */
internal fun wavBytes(pcm: ByteArray, sampleRate: Int): ByteArray {
  val dataLen = pcm.size
  val out = ByteArrayOutputStream(44 + dataLen)
  fun le32(v: Int) {
    out.write(v and 0xFF); out.write((v shr 8) and 0xFF); out.write((v shr 16) and 0xFF); out.write((v shr 24) and 0xFF)
  }
  fun le16(v: Int) {
    out.write(v and 0xFF); out.write((v shr 8) and 0xFF)
  }
  fun ascii(s: String) = out.write(s.toByteArray(Charsets.US_ASCII))
  ascii("RIFF")
  le32(36 + dataLen)
  ascii("WAVEfmt ")
  le32(16)
  le16(1) // PCM
  le16(1) // 单声道
  le32(sampleRate)
  le32(sampleRate * 2)
  le16(2)
  le16(16)
  ascii("data")
  le32(dataLen)
  out.write(pcm)
  return out.toByteArray()
}

internal class VoiceSession(
  private val session: Long,
  private val req: VoiceStartRequest,
  private val http: OkHttpClient,
  private val events: JsEvents,
) {
  private sealed class Ev {
    object Stop : Ev()
    object Cancel : Ev()
    class Cap(val gen: Int, val ev: CaptureEvent) : Ev()
    class Asr(val gen: Int, val out: AsrOutput) : Ev()
  }

  private val queue = LinkedBlockingQueue<Ev>()
  private val result = CompletableFuture<VoiceResult>()

  /** 开始：立即返回，开麦 / 建连在后台进行（就绪时发 voice://ready） */
  fun start() {
    Thread({
      try {
        result.complete(runSession())
      } catch (e: VoiceFailure) {
        Log.w(TAG, "会话#$session 失败: ${e.message}")
        result.completeExceptionally(e)
      } catch (e: Throwable) {
        Log.e(TAG, "会话#$session 异常", e)
        result.completeExceptionally(VoiceFailure("录音会话意外结束"))
      }
    }, "voice-session-$session").start()
  }

  fun requestStop() {
    queue.offer(Ev.Stop)
  }

  /** 放弃本次录音；旧会话作废也走这里 */
  fun cancel() {
    queue.offer(Ev.Cancel)
  }

  /** 等结果；超时抛 TimeoutException，失败抛 VoiceFailure */
  fun await(timeoutMs: Long): VoiceResult {
    try {
      return result.get(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (e: java.util.concurrent.ExecutionException) {
      throw e.cause as? VoiceFailure ?: VoiceFailure("录音会话意外结束")
    }
  }

  private fun runSession(): VoiceResult {
    val t0 = SystemClock.elapsedRealtime()
    fun ms(since: Long): Long = SystemClock.elapsedRealtime() - since

    var capGen = 0
    fun capSink(gen: Int): (CaptureEvent) -> Unit = { queue.offer(Ev.Cap(gen, it)) }
    var capture = VoiceCapture.start(capSink(capGen))

    val cfg = AsrConfig(
      apiKey = req.apiKey,
      model = req.model,
      endpoints = voiceEndpoints(req.workspaceId),
      vocabulary = req.vocabulary,
      context = req.context,
      languageHints = req.languageHints,
    )
    var asrGen = 0
    fun asrSink(gen: Int): (AsrOutput) -> Unit = { queue.offer(Ev.Asr(gen, it)) }
    var asr = AsrStream.spawn(cfg, http, asrSink(asrGen))
    var attempts = 1

    val audio = ByteArrayOutputStream()
    val finals = ArrayList<String>()
    var partial = ""
    var usage: AsrUsage? = null
    var hadSpeech = false
    var device: String? = null
    val timings = VoiceTimings()
    var captureError: String? = null
    var glitches = 0
    var captureRestarts = 0
    var asrError: String? = null
    var stopping = false
    var stopAt: Long? = null
    var captureDone = false
    var asrDone = false
    var finalizeDeadline: Long? = null
    val recordDeadline = t0 + MAX_RECORD_MS

    fun respawnAsr() {
      asr.close()
      asrGen += 1
      asr = AsrStream.spawn(cfg, http, asrSink(asrGen))
    }

    fun replay(pcm: ByteArray, finish: Boolean) {
      var off = 0
      while (off < pcm.size) {
        val end = min(off + REPLAY_FRAME_BYTES, pcm.size)
        asr.sendAudio(pcm.copyOfRange(off, end))
        off = end
      }
      if (finish) asr.finish()
    }

    try {
      while (!(captureDone && asrDone)) {
        // 对应 select! 里的 sleep_until(record_deadline) if !stopping 和 sleep_until_opt(finalize_deadline)
        val now = SystemClock.elapsedRealtime()
        var waitMs = Long.MAX_VALUE
        if (!stopping) waitMs = min(waitMs, recordDeadline - now)
        finalizeDeadline?.let { waitMs = min(waitMs, it - now) }
        val ev = if (waitMs == Long.MAX_VALUE) queue.take() else queue.poll(max(0L, waitMs), TimeUnit.MILLISECONDS)

        if (ev == null) {
          val at = SystemClock.elapsedRealtime()
          if (!stopping && at >= recordDeadline) {
            stopping = true
            stopAt = at
            capture.requestStop()
            Log.w(TAG, "会话#$session 录音超过 ${MAX_RECORD_MS / 1000} 秒，自动停止")
            events.emit("voice://auto_stop", Arguments.createMap().apply { putDouble("session", session.toDouble()) })
          }
          val fd = finalizeDeadline
          if (fd != null && at >= fd) {
            if (asrError == null) asrError = "识别收尾超时"
            asrDone = true
          }
          continue
        }

        when (ev) {
          Ev.Cancel -> {
            capture.requestStop()
            throw VoiceFailure("已取消")
          }
          Ev.Stop -> if (!stopping) {
            stopping = true
            stopAt = SystemClock.elapsedRealtime()
            capture.requestStop()
          }
          is Ev.Cap -> {
            if (ev.gen != capGen || captureDone) continue
            when (val c = ev.ev) {
              is CaptureEvent.Ready -> {
                if (timings.micOpenMs == null) timings.micOpenMs = ms(t0)
                Log.i(
                  TAG,
                  "会话#$session 麦克风就绪 ${ms(t0)}ms（线程内 ${c.info.openMs}ms）: ${c.info.device} ${c.info.sampleRate}Hz ${c.info.channels}ch ${c.info.format}",
                )
                events.emit(
                  "voice://ready",
                  Arguments.createMap().apply {
                    putDouble("session", session.toDouble())
                    putString("device", c.info.device)
                  },
                )
                device = c.info.device
              }
              is CaptureEvent.Chunk -> {
                if (c.level > SPEECH_LEVEL) hadSpeech = true
                events.emit(
                  "voice://level",
                  Arguments.createMap().apply {
                    putDouble("session", session.toDouble())
                    putDouble("level", c.level.toDouble())
                  },
                )
                asr.sendAudio(c.pcm)
                audio.write(c.pcm)
              }
              CaptureEvent.Glitch -> glitches += 1
              is CaptureEvent.Error -> {
                if (!stopping && captureRestarts < MAX_CAPTURE_RESTARTS) {
                  // 还按着：重开麦克风接着录，只丢中断那一下（旧线程随旧 handle 一起停）
                  captureRestarts += 1
                  Log.w(TAG, "会话#$session 录音中断（${c.message}），第 $captureRestarts 次重开麦克风")
                  capture.requestStop()
                  capGen += 1
                  capture = VoiceCapture.start(capSink(capGen))
                } else {
                  Log.e(TAG, "会话#$session 录音出错: ${c.message}")
                  capture.requestStop()
                  if (!stopping) {
                    // 还按着却录不了了：通知前端收尾，别让「倾听中」一直骗人
                    events.emit(
                      "voice://auto_stop",
                      Arguments.createMap().apply {
                        putDouble("session", session.toDouble())
                        putString("message", "录音中断了，已结束这一段：${c.message}")
                      },
                    )
                  }
                  stopping = true
                  if (stopAt == null) stopAt = SystemClock.elapsedRealtime()
                  captureError = c.message
                }
              }
              CaptureEvent.Closed -> {
                captureDone = true
                if (audio.size() == 0) {
                  throw VoiceFailure(captureError ?: "没有录到声音：麦克风没有数据")
                }
                asr.finish()
                finalizeDeadline = SystemClock.elapsedRealtime() + FINALIZE_TIMEOUT_MS
              }
            }
          }
          is Ev.Asr -> {
            if (ev.gen != asrGen || asrDone) continue
            when (val o = ev.out) {
              is AsrOutput.Started -> {
                if (timings.asrConnectMs == null) timings.asrConnectMs = o.connectMs
                if (timings.asrStartMs == null) timings.asrStartMs = o.startMs
              }
              is AsrOutput.Partial -> {
                if (o.text.isNotEmpty() && timings.firstPartialMs == null) {
                  timings.firstPartialMs = ms(t0)
                }
                partial = o.text
                emitPartial(joined(finals, partial))
              }
              is AsrOutput.Final -> {
                finals.add(o.text)
                partial = ""
                if (o.usage != null) {
                  usage = o.usage // 服务端给的是本任务累计用量
                }
                emitPartial(joined(finals, ""))
              }
              AsrOutput.Finished -> {
                val silentDrop = joined(finals, partial).isEmpty() && hadSpeech
                if (captureDone && silentDrop && attempts < MAX_ATTEMPTS) {
                  attempts += 1
                  Log.w(TAG, "会话#$session 有声音却没识别出字，重放整段音频重试")
                  respawnAsr()
                  replay(audio.toByteArray(), true)
                } else if (captureDone) {
                  asrDone = true
                } else {
                  // 还在录音，服务端却先结束了：当作连接失败处理
                  asrError = "识别服务提前结束了任务"
                  if (attempts < MAX_ATTEMPTS) {
                    attempts += 1
                    respawnAsr()
                    replay(audio.toByteArray(), false)
                  } else {
                    asrDone = true
                  }
                }
              }
              is AsrOutput.Failed -> {
                Log.w(TAG, "会话#$session 第 $attempts 次识别失败: ${o.message}")
                val nothingYet = joined(finals, partial).isEmpty()
                if (o.retryable && nothingYet && attempts < MAX_ATTEMPTS) {
                  attempts += 1
                  respawnAsr()
                  replay(audio.toByteArray(), captureDone)
                } else {
                  asrError = o.message
                  asrDone = true
                }
              }
              AsrOutput.Closed -> {
                if (asrError == null) asrError = "识别连接意外结束"
                asrDone = true
              }
            }
          }
        }
      }
    } finally {
      asr.close() // 关掉仍在进行的识别连接
      capture.requestStop()
    }

    val pcm = audio.toByteArray()
    var text = joined(finals, partial)
    var fallback = false
    val err = asrError
    if (text.isEmpty() && hadSpeech && err != null) {
      Log.w(TAG, "会话#$session 流式识别失败（$err），改用批量识别兜底")
      try {
        text = AsrBatch.transcribePcm16(http, pcm, req.apiKey, FALLBACK_MODEL, FALLBACK_ENDPOINT, FALLBACK_TIMEOUT_MS).trim()
        fallback = true
      } catch (_: TimeoutException) {
        throw VoiceFailure("$err；批量识别兜底超时")
      } catch (e: Exception) {
        throw VoiceFailure("$err；批量识别兜底也失败：${e.message}")
      }
    }

    timings.finalizeMs = stopAt?.let { ms(it) }
    timings.totalMs = ms(t0)
    val durationMs = (pcm.size / 2).toLong() * 1_000 / VoiceCapture.TARGET_RATE
    Log.i(
      TAG,
      "会话#$session 完成：录音 ${durationMs}ms，开麦 ${timings.micOpenMs}ms，识别就绪 ${timings.asrStartMs}ms，首字 ${timings.firstPartialMs}ms，松手到定稿 ${timings.finalizeMs}ms，尝试 $attempts 次${if (fallback) "（批量兜底）" else ""}，${text.length} 字，掉帧 $glitches 次，重开麦克风 $captureRestarts 次",
    )

    return VoiceResult(
      session = session,
      text = text,
      wavBase64 = Base64.encodeToString(wavBytes(pcm, VoiceCapture.TARGET_RATE), Base64.NO_WRAP),
      durationMs = durationMs,
      hadSpeech = hadSpeech,
      model = if (fallback) FALLBACK_MODEL else req.model,
      usage = if (fallback) null else usage,
      attempts = attempts,
      fallback = fallback,
      device = device,
      glitches = glitches,
      captureRestarts = captureRestarts,
      timings = timings,
    )
  }

  private fun emitPartial(text: String) {
    events.emit(
      "voice://partial",
      Arguments.createMap().apply {
        putDouble("session", session.toDouble())
        putString("text", text)
      },
    )
  }
}
