package com.solevup.mobile.voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * 流式 PCM16 单声道播放（Fish TTS / Omni 回复共用），替代 desktop 前端的 WebAudio 排队播放。
 *
 * 专用线程把队列里的块写进 AudioTrack，网络线程永远不被阻塞。close() 立刻停声并丢掉队列（打断用）。
 * 桌面端靠 AudioContext 时间轴判断「真的播完了」；这里用 playbackHeadPosition，
 * 通过 stateMap() 把同样的信息给 JS：hasAudio 对应收到首段音频，drainedMs 对应 currentTime - nextStartTime。
 * 播空几秒后自动释放 AudioTrack，下一块音频来了再建，不让音频通路一直开着。
 */
internal class PcmPlayer(private val sampleRate: Int, private val threadName: String) {
  private val queue = LinkedBlockingQueue<ByteArray>()
  private val lock = Any()

  @Volatile private var closed = false
  @Volatile private var failed = false
  @Volatile private var hasAudio = false
  @Volatile private var track: AudioTrack? = null
  @Volatile private var drainedAt = 0L
  private var thread: Thread? = null
  private var oddByte: Byte? = null // 上一块多出来的半个样本；write 只有一个生产者线程（WS 回调）

  fun write(pcm: ByteArray) {
    if (closed) return
    val aligned = alignToSamples(pcm)
    if (aligned.isEmpty()) return
    hasAudio = true
    drainedAt = 0L
    queue.offer(aligned)
    synchronized(lock) { startThreadLocked() }
  }

  /**
   * 网络块不保证按样本对齐，而 AudioTrack 只写整帧：多出的 1 字节写不进去会被丢掉，
   * 之后所有样本高低字节错位，变成响亮的噪声。所以留给下一块拼上。
   */
  private fun alignToSamples(pcm: ByteArray): ByteArray {
    val head = oddByte
    if (head == null && pcm.size % 2 == 0) return pcm
    val joined = if (head == null) pcm else byteArrayOf(head) + pcm
    val even = joined.size - joined.size % 2
    oddByte = if (even < joined.size) joined[even] else null
    return joined.copyOf(even)
  }

  private fun startThreadLocked() {
    if (thread == null && !closed) {
      thread = Thread({ loop() }, threadName).also { it.start() }
    }
  }

  /** 立刻停声、丢掉没播的（pause + flush 会让阻塞中的 write 返回，AudioTrack 由播放线程释放） */
  fun close() {
    synchronized(lock) {
      if (closed) return
      closed = true
    }
    queue.clear()
    track?.let { t ->
      try { t.pause(); t.flush() } catch (_: Throwable) {}
    }
  }

  /** 已经连续播空了多少毫秒（对应桌面端 currentTime - nextStartTime）；还有音频没播完时为 0 */
  fun drainedMs(): Long {
    if (!hasAudio) return 0
    // 停了或 AudioTrack 建不起来：没有东西还要播，别让上层干等
    if (closed || failed) return ALREADY_DRAINED_MS
    val at = drainedAt
    return if (at == 0L) 0 else SystemClock.elapsedRealtime() - at
  }

  fun stateMap(): WritableMap = Arguments.createMap().apply {
    putBoolean("hasAudio", hasAudio)
    putDouble("drainedMs", drainedMs().toDouble())
  }

  private fun loop() {
    val t = try {
      createTrack()
    } catch (e: Throwable) {
      Log.e(TAG, "AudioTrack 创建失败: ${e.message}")
      failed = true
      synchronized(lock) { thread = null }
      return
    }
    track = t
    try {
      if (!closed) t.play()
      var total = 0L // 写进轨道的总帧数（含静音）
      var realEnd = 0L // 最后一个真实音频帧的位置
      var lastWriteAt = SystemClock.elapsedRealtime()
      val silence = ByteArray(SILENCE_BYTES)
      while (!closed) {
        val chunk = queue.poll(POLL_MS, TimeUnit.MILLISECONDS)
        if (chunk != null) {
          drainedAt = 0L
          writeAll(t, chunk)
          total += chunk.size / 2
          realEnd = total
          lastWriteAt = SystemClock.elapsedRealtime()
          continue
        }
        val played = t.playbackHeadPosition.toLong() and 0xFFFFFFFFL
        if (played >= realEnd) {
          if (drainedAt == 0L && queue.isEmpty()) drainedAt = SystemClock.elapsedRealtime()
          val at = drainedAt
          if (at != 0L && SystemClock.elapsedRealtime() - at >= IDLE_RELEASE_MS) break
        } else if (SystemClock.elapsedRealtime() - lastWriteAt >= PAD_AFTER_MS) {
          // 队列空了但头指针还没走到末尾：AudioTrack 要攒够起播门限才开播，
          // 尾部不足一个混音周期的样本也会卡在缓冲里。补静音把真实音频顶出去。
          writeAll(t, silence)
          total += silence.size / 2
        }
      }
    } catch (e: Throwable) {
      Log.w(TAG, "播放线程退出: ${e.message}")
      failed = true
    } finally {
      track = null
      try { t.pause(); t.flush() } catch (_: Throwable) {}
      t.release()
      // 决定退出和这里之间可能又来了音频：接着开一轮
      synchronized(lock) {
        thread = null
        if (!failed && queue.isNotEmpty()) startThreadLocked()
      }
    }
  }

  private fun writeAll(t: AudioTrack, bytes: ByteArray) {
    var off = 0
    while (off < bytes.size && !closed) {
      val n = t.write(bytes, off, bytes.size - off)
      if (n < 0) throw IllegalStateException("AudioTrack.write=$n")
      if (n == 0) return // 被 pause 打断
      off += n
    }
  }

  private fun createTrack(): AudioTrack {
    val minBuf = AudioTrack.getMinBufferSize(
      sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
    )
    return AudioTrack(
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build(),
      AudioFormat.Builder()
        .setSampleRate(sampleRate)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .build(),
      maxOf(minBuf * 2, sampleRate / 5), // ≥100 ms；缓冲放在自己的队列里，轨道不必很大，打断才快
      AudioTrack.MODE_STREAM,
      AudioManager.AUDIO_SESSION_ID_GENERATE,
    )
  }

  private companion object {
    const val TAG = "PcmPlayer"
    const val POLL_MS = 20L
    const val PAD_AFTER_MS = 60L
    const val SILENCE_BYTES = 960
    const val IDLE_RELEASE_MS = 3_000L
    const val ALREADY_DRAINED_MS = 60_000L
  }
}
