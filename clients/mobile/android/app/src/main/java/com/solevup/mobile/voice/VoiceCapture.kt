package com.solevup.mobile.voice

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * 原生麦克风采集（对应 desktop voice/capture.rs + voice/resample.rs）
 *
 * 桌面端：cpal 打开设备原生格式 → 下混单声道 → 加窗 sinc 低通 + 线性插值重采样到 16 kHz → 切 100 ms 一块。
 * 手机端：AudioRecord 直接按 16 kHz 单声道 PCM16 打开（Android 保证所有设备都支持这个规格），
 *        下混、重采样、抗混叠都由系统音频栈完成，这里只剩「切块 + 算音量 + 松手多录尾巴」。
 *
 * 专用线程读取，事件通过 sink 交给会话编排；线程退出时发 Closed（对应 Rust 接收端收到 None）。
 */
internal object VoiceCapture {
  const val TARGET_RATE = 16_000

  /** 每块 100 ms */
  const val CHUNK_SAMPLES = 1_600

  /** 松手后多录的尾巴 */
  private const val TAIL_MS = 250L
  private const val POLL_MS = 10L

  /** 每次读 20 ms：尾巴的时长才能卡得准（Rust 这边是录音回调的粒度，约 10 ms） */
  private const val READ_SAMPLES = 320
  private const val TAG = "VoiceCapture"

  /** 起录音线程；线程起不来时直接发 Closed，调用方按「没录到声音」处理 */
  fun start(sink: (CaptureEvent) -> Unit): CaptureHandle {
    val stop = AtomicBoolean(false)
    try {
      Thread({
        try {
          run(sink, stop)
        } catch (e: CaptureFailure) {
          sink(CaptureEvent.Error(e.message ?: "打开麦克风失败"))
        } catch (e: Throwable) {
          sink(CaptureEvent.Error("打开麦克风失败（${e.message}）"))
        } finally {
          sink(CaptureEvent.Closed)
        }
      }, "voice-capture").start()
    } catch (e: Throwable) {
      Log.e(TAG, "录音线程启动失败: ${e.message}")
      sink(CaptureEvent.Closed)
    }
    return CaptureHandle(stop)
  }

  private fun run(sink: (CaptureEvent) -> Unit, stop: AtomicBoolean) {
    val t0 = SystemClock.elapsedRealtime()
    val minBuf = AudioRecord.getMinBufferSize(
      TARGET_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
    )
    if (minBuf <= 0) throw CaptureFailure("没有找到可用的麦克风")
    val rec = try {
      AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        TARGET_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
        max(minBuf, CHUNK_SAMPLES * 2 * 2),
      )
    } catch (e: SecurityException) {
      throw CaptureFailure(describe(RECORD_DENIED, e.message))
    }
    try {
      if (rec.state != AudioRecord.STATE_INITIALIZED) {
        throw CaptureFailure(describe(RECORD_DENIED, "AudioRecord 初始化失败"))
      }
      rec.startRecording()
      if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        // 另一个 App 正占着麦克风（通话、录屏）时 startRecording 不抛错，只是没进录音态
        throw CaptureFailure(describe(RECORD_BUSY, "recordingState=${rec.recordingState}"))
      }

      sink(
        CaptureEvent.Ready(
          CaptureInfo(
            device = rec.routedDevice?.productName?.toString()?.takeIf { it.isNotBlank() } ?: "默认麦克风",
            sampleRate = TARGET_RATE,
            channels = 1,
            format = "PCM16",
            openMs = SystemClock.elapsedRealtime() - t0,
          ),
        ),
      )

      val chunker = Chunker(sink)
      val buf = ShortArray(READ_SAMPLES)
      var stopSeenAt = -1L
      while (true) {
        if (stop.get()) {
          if (stopSeenAt < 0) stopSeenAt = SystemClock.elapsedRealtime()
          // 松手后再录一小段尾巴，然后把不足一块的剩余样本也发出去
          if (SystemClock.elapsedRealtime() - stopSeenAt >= TAIL_MS) {
            chunker.flush()
            break
          }
        }
        val n = rec.read(buf, 0, buf.size)
        when {
          n > 0 -> chunker.push(buf, n)
          n == 0 -> {
            // 没读到东西：流还在，只记一次小毛病
            sink(CaptureEvent.Glitch)
            Thread.sleep(POLL_MS)
          }
          else -> {
            sink(CaptureEvent.Error(describeRead(n)))
            // 和 Rust 一样等到上层喊停才退出：上层决定重开麦克风还是收尾
            while (!stop.get()) Thread.sleep(POLL_MS)
            chunker.flush()
            break
          }
        }
      }
      try { rec.stop() } catch (_: Throwable) {}
    } finally {
      rec.release()
    }
  }

  private const val RECORD_DENIED = 1
  private const val RECORD_BUSY = 2

  /** AudioRecord 错误 → 给用户看的中文说明（对应 Rust describe） */
  private fun describe(kind: Int, detail: String?): String {
    val hint = when (kind) {
      RECORD_DENIED -> "麦克风权限被拒绝：请在系统设置 → 应用 → Solevup → 权限里允许使用麦克风"
      RECORD_BUSY -> "麦克风被其他程序独占，请关掉占用它的程序再试"
      else -> "打开麦克风失败"
    }
    return if (detail.isNullOrEmpty()) hint else "$hint（$detail）"
  }

  private fun describeRead(code: Int): String = when (code) {
    AudioRecord.ERROR_DEAD_OBJECT -> "麦克风不可用或刚被拔出，请检查设备（AudioRecord=$code）"
    else -> "打开麦克风失败（AudioRecord=$code）"
  }

  /** 读取线程里的状态：把任意长度的读取结果切成 100 ms 一块（对应 Rust Chunker） */
  private class Chunker(private val sink: (CaptureEvent) -> Unit) {
    private val pending = ShortArray(CHUNK_SAMPLES * 2)
    private var len = 0

    fun push(input: ShortArray, n: Int) {
      var off = 0
      while (off < n) {
        val take = min(n - off, CHUNK_SAMPLES - len)
        System.arraycopy(input, off, pending, len, take)
        len += take
        off += take
        if (len >= CHUNK_SAMPLES) {
          emit(pending, CHUNK_SAMPLES)
          len = 0
        }
      }
    }

    fun flush() {
      if (len > 0) emit(pending, len)
      len = 0
    }

    private fun emit(block: ShortArray, n: Int) {
      var sum = 0f
      val bytes = ByteArray(n * 2)
      for (i in 0 until n) {
        val s = block[i].toInt()
        val v = s / 32768f
        sum += v * v
        bytes[i * 2] = (s and 0xFF).toByte()
        bytes[i * 2 + 1] = ((s shr 8) and 0xFF).toByte()
      }
      sink(CaptureEvent.Chunk(bytes, min(sqrt(sum / n), 1f)))
    }
  }
}

private class CaptureFailure(message: String) : Exception(message)

internal class CaptureInfo(
  val device: String,
  val sampleRate: Int,
  val channels: Int,
  val format: String,
  val openMs: Long,
)

internal sealed class CaptureEvent {
  class Ready(val info: CaptureInfo) : CaptureEvent()

  /** 16 kHz 单声道 PCM16（小端）一块，附 0~1 的音量（RMS） */
  class Chunk(val pcm: ByteArray, val level: Float) : CaptureEvent()

  /** 掉帧这类小毛病：流还在继续录，只记一次数 */
  object Glitch : CaptureEvent()

  class Error(val message: String) : CaptureEvent()

  /** 录音线程已退出 */
  object Closed : CaptureEvent()
}

internal class CaptureHandle(private val stop: AtomicBoolean) {
  /** 请求停止：线程再录 TAIL 后冲刷剩余样本并退出，随后发 Closed */
  fun requestStop() {
    stop.set(true)
  }
}
