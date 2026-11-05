package com.solevup.mobile.voice

import android.os.SystemClock
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * 流式语音识别客户端（百炼 Qwen-Audio-ASR-Streaming / Fun-ASR 协议），对应 desktop voice/asr_stream.rs
 *
 *   连接 → run-task（参数 + 即时热词 + 对话上下文）→ task-started
 *        → 二进制 PCM 帧 … → finish-task → result-generated* → task-finished
 *
 * 每个连接跑在自己的线程里：上游通过 sendAudio/finish 喂音频、下游通过 out 回调收结果。
 * task-started 之前到达的音频先攒着，开始后按序补发。重连 / 重放由会话编排层决定。
 *
 * Rust 用 select! 同时等服务端帧和上游输入；这里把 OkHttp 回调和上游输入都放进同一个 inbox，
 * 线程按序取出，循环结构和分支与 Rust 一一对应。
 */

/** 上下文：服务端最多保留最近 5 轮，每轮 user + assistant 合计不超过 400 字 */
internal const val CONTEXT_MAX_TURNS = 5
private const val CONTEXT_TURN_CHARS = 400

/** 即时热词：普通权重上限 5；数量控制在 100 以内，太多会稀释效果 */
private const val VOCAB_MAX_WEIGHT = 5
private const val VOCAB_MAX_WORDS = 100

private const val CONNECT_TIMEOUT_MS = 5_000L
private const val START_TIMEOUT_MS = 5_000L

/** 发出 finish-task 后等 task-finished 的上限（正常约 0.3 秒） */
private const val FINALIZE_TIMEOUT_MS = 8_000L
private const val TAG = "VoiceAsr"

internal class ContextTurn(val user: String, val assistant: String)

internal class AsrConfig(
  val apiKey: String,
  val model: String,
  /** 按顺序尝试，第一个连上的为准（业务空间专属域名优先，通用域名兜底） */
  val endpoints: List<String>,
  val vocabulary: List<String>,
  val context: List<ContextTurn>,
  val languageHints: List<String>,
)

internal class AsrUsage(val inputTokens: Long, val outputTokens: Long)

internal sealed class AsrOutput {
  class Started(val connectMs: Long, val startMs: Long) : AsrOutput()
  class Partial(val text: String) : AsrOutput()
  class Final(val text: String, val usage: AsrUsage?) : AsrOutput()
  object Finished : AsrOutput()

  /** retryable=false 表示换条连接也没用（鉴权失败、参数错误等） */
  class Failed(val message: String, val retryable: Boolean) : AsrOutput()

  /** 连接线程已退出（对应 Rust 接收端收到 None） */
  object Closed : AsrOutput()
}

// ── 协议构造 ──

internal fun runTaskMessage(taskId: String, cfg: AsrConfig): String {
  val parameters = JSONObject()
    .put("format", "pcm")
    .put("sample_rate", 16_000)
    // 拿着手机说话属于近场；默认的远场模型更适合会议室
    .put("vad_model", "near_meeting_16k")
  if (cfg.languageHints.isNotEmpty()) {
    parameters.put("language_hints", JSONArray(cfg.languageHints))
  }
  val vocabulary = vocabularyJson(cfg.vocabulary)
  if (vocabulary.length() > 0) {
    parameters.put("vocabulary", vocabulary)
  }
  val context = contextJson(cfg.context)
  val input = if (context.length() == 0) JSONObject() else JSONObject().put("context", context)
  return JSONObject()
    .put(
      "header",
      JSONObject().put("action", "run-task").put("task_id", taskId).put("streaming", "duplex"),
    )
    .put(
      "payload",
      JSONObject()
        .put("task_group", "audio")
        .put("task", "asr")
        .put("function", "recognition")
        .put("model", cfg.model)
        .put("parameters", parameters)
        .put("input", input),
    )
    .toString()
}

internal fun finishTaskMessage(taskId: String): String =
  JSONObject()
    .put(
      "header",
      JSONObject().put("action", "finish-task").put("task_id", taskId).put("streaming", "duplex"),
    )
    .put("payload", JSONObject().put("input", JSONObject()))
    .toString()

private fun vocabularyJson(words: List<String>): JSONObject {
  val map = JSONObject()
  for (w in words.map { it.trim() }.filter { it.isNotEmpty() }) {
    if (map.length() >= VOCAB_MAX_WORDS) break
    if (!map.has(w)) map.put(w, VOCAB_MAX_WEIGHT)
  }
  return map
}

/** 取最近几轮，每轮先保证用户原话、再把剩余额度给助手回复 */
private fun contextJson(turns: List<ContextTurn>): JSONArray {
  val out = JSONArray()
  for (t in turns.takeLast(CONTEXT_MAX_TURNS)) {
    val user = takeChars(t.user.trim(), CONTEXT_TURN_CHARS)
    if (user.isEmpty()) continue
    val budget = CONTEXT_TURN_CHARS - user.codePointCount(0, user.length)
    val assistant = takeChars(t.assistant.trim(), budget)
    out.put(
      JSONObject()
        .put("role", "user")
        .put("content", JSONArray().put(JSONObject().put("type", "input_text").put("text", user))),
    )
    if (assistant.isNotEmpty()) {
      out.put(
        JSONObject()
          .put("role", "assistant")
          .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", assistant))),
      )
    }
  }
  return out
}

/** 按 Unicode 字符数截断（Rust chars().take(n)；String.take 按 UTF-16 算，会把 emoji 切坏） */
private fun takeChars(s: String, n: Int): String {
  if (n <= 0) return ""
  if (s.codePointCount(0, s.length) <= n) return s
  return s.substring(0, s.offsetByCodePoints(0, n))
}

// ── 协议解析 ──

internal sealed class ServerEvent {
  object Started : ServerEvent()
  class Partial(val text: String) : ServerEvent()
  class Final(val text: String, val usage: AsrUsage?) : ServerEvent()
  object Finished : ServerEvent()
  class Failed(val code: String, val message: String) : ServerEvent()
  object Ignore : ServerEvent()
}

/** org.json 的 optString 会把 JSON null 变成 "null"，这里只认真正的字符串（Rust as_str） */
private fun JSONObject?.str(key: String): String? = this?.opt(key) as? String

/** Rust as_u64：只认非负整数 */
private fun JSONObject?.u64(key: String): Long? = when (val v = this?.opt(key)) {
  is Int -> v.toLong().takeIf { it >= 0 }
  is Long -> v.takeIf { it >= 0 }
  else -> null
}

internal fun parseServerEvent(raw: String): ServerEvent {
  val v = try { JSONObject(raw) } catch (_: Throwable) { return ServerEvent.Ignore }
  val header = v.optJSONObject("header")
  return when (header.str("event")) {
    "task-started" -> ServerEvent.Started
    "task-finished" -> ServerEvent.Finished
    "task-failed" -> ServerEvent.Failed(
      code = header.str("error_code") ?: "UNKNOWN",
      message = header.str("error_message") ?: "识别任务失败",
    )
    "result-generated" -> {
      val payload = v.optJSONObject("payload")
      val s = payload?.optJSONObject("output")?.optJSONObject("sentence")
      if (s?.opt("heartbeat") == true) return ServerEvent.Ignore
      val text = s.str("text") ?: ""
      if (s?.opt("sentence_end") == true) {
        val u = payload?.optJSONObject("usage")
        val usage = u.u64("input_tokens")?.let { AsrUsage(it, u.u64("output_tokens") ?: 0L) }
        ServerEvent.Final(text, usage)
      } else {
        ServerEvent.Partial(text)
      }
    }
    else -> ServerEvent.Ignore
  }
}

/** 鉴权 / 参数类错误重连也没用 */
private fun isRetryable(code: String): Boolean =
  code !in setOf("InvalidApiKey", "AccessDenied", "InvalidParameter", "ModelNotFound", "Arrearage")

// ── 连接任务 ──

private class Fail(val text: String, val retryable: Boolean) : Exception(text)

private sealed class Item {
  class Audio(val pcm: ByteArray) : Item()
  object Finish : Item()

  /** 上游喊停（对应 Rust input.recv() 收到 None：会话被取消） */
  object InputClosed : Item()

  class Text(val text: String) : Item()
  object OtherFrame : Item()
  class CloseFrame(val reason: String) : Item()
  class Broken(val t: Throwable) : Item()
}

internal class AsrStream private constructor(
  private val cfg: AsrConfig,
  private val http: OkHttpClient,
  private val out: (AsrOutput) -> Unit,
) {
  private val inbox = LinkedBlockingQueue<Item>()

  fun sendAudio(pcm: ByteArray) {
    inbox.offer(Item.Audio(pcm))
  }

  fun finish() {
    inbox.offer(Item.Finish)
  }

  /** 对应 Rust drop(asr_tx)：关掉仍在进行的识别连接 */
  fun close() {
    inbox.offer(Item.InputClosed)
  }

  private fun run() {
    try {
      session()
    } catch (e: Fail) {
      out(AsrOutput.Failed(e.text, e.retryable))
    } catch (e: Throwable) {
      out(AsrOutput.Failed("识别连接出错: ${e.message}", true))
    } finally {
      out(AsrOutput.Closed)
    }
  }

  private fun session() {
    val t0 = SystemClock.elapsedRealtime()
    val ws = connectAny()
    val connectMs = SystemClock.elapsedRealtime() - t0
    var closedPolitely = false
    try {
      val taskId = UUID.randomUUID().toString().replace("-", "")
      if (!ws.send(runTaskMessage(taskId, cfg))) throw Fail("发送识别任务失败", true)

      // task-started 之前到达的音频先攒着
      val backlog = ArrayList<ByteArray>()
      var finishRequested = false
      val startDeadline = SystemClock.elapsedRealtime() + START_TIMEOUT_MS
      while (true) {
        val item = inbox.poll(remaining(startDeadline), TimeUnit.MILLISECONDS)
          ?: throw Fail("识别服务启动超时", true)
        when (item) {
          is Item.Audio -> backlog.add(item.pcm)
          Item.Finish -> finishRequested = true
          Item.InputClosed -> return // 会话被取消
          else -> if (handleFrame(item) is ServerEvent.Started) break
        }
      }
      out(AsrOutput.Started(connectMs, SystemClock.elapsedRealtime() - t0))
      for (frame in backlog) sendBinary(ws, frame)
      backlog.clear()
      if (finishRequested) {
        if (!ws.send(finishTaskMessage(taskId))) throw Fail("结束识别任务失败", true)
      }

      var finishDeadline: Long? = if (finishRequested) SystemClock.elapsedRealtime() + FINALIZE_TIMEOUT_MS else null
      while (true) {
        val deadline = finishDeadline
        val item = if (deadline == null) {
          inbox.take()
        } else {
          inbox.poll(remaining(deadline), TimeUnit.MILLISECONDS) ?: throw Fail("识别收尾超时", true)
        }
        when (item) {
          is Item.Audio -> if (finishDeadline == null) sendBinary(ws, item.pcm)
          Item.Finish -> if (finishDeadline == null) {
            finishDeadline = SystemClock.elapsedRealtime() + FINALIZE_TIMEOUT_MS
            if (!ws.send(finishTaskMessage(taskId))) throw Fail("结束识别任务失败", true)
          }
          Item.InputClosed -> {
            ws.close(1000, null) // 会话被取消
            closedPolitely = true
            return
          }
          else -> if (handleFrame(item) is ServerEvent.Finished) {
            out(AsrOutput.Finished)
            return
          }
        }
      }
    } finally {
      if (!closedPolitely) ws.cancel()
    }
  }

  private fun remaining(deadline: Long): Long = maxOf(0L, deadline - SystemClock.elapsedRealtime())

  private fun sendBinary(ws: WebSocket, pcm: ByteArray) {
    if (!ws.send(pcm.toByteString(0, pcm.size))) throw Fail("发送音频失败", true)
  }

  /** 处理一个服务端帧：结果转发给下游，失败 / 断开转成错误 */
  private fun handleFrame(item: Item): ServerEvent? = when (item) {
    is Item.Text -> {
      val ev = parseServerEvent(item.text)
      when (ev) {
        is ServerEvent.Partial -> out(AsrOutput.Partial(ev.text))
        is ServerEvent.Final -> out(AsrOutput.Final(ev.text, ev.usage))
        is ServerEvent.Failed -> throw Fail("识别失败（${ev.code}）：${ev.message}", isRetryable(ev.code))
        else -> {}
      }
      ev
    }
    is Item.CloseFrame -> throw Fail("识别连接被关闭 ${item.reason}", true)
    is Item.Broken -> throw Fail("识别连接出错: ${item.t.message}", true)
    else -> null
  }

  private sealed class Attempt {
    class Opened(val ws: WebSocket) : Attempt()
    class Failed(val text: String, val code: Int?) : Attempt()
  }

  private fun connectAny(): WebSocket {
    var last = Fail("没有可用的识别服务地址", true)
    for (url in cfg.endpoints) {
      val base = try {
        Request.Builder().url(url)
      } catch (e: IllegalArgumentException) {
        last = Fail("识别地址无效 $url: ${e.message}", false)
        continue
      }
      val req = try {
        base.header("Authorization", "Bearer ${cfg.apiKey}").build()
      } catch (_: IllegalArgumentException) {
        throw Fail("API Key 格式无效", false)
      }
      val attempts = LinkedBlockingQueue<Attempt>()
      val ws = http.newWebSocket(req, Listener(attempts))
      val result = attempts.poll(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      when (result) {
        is Attempt.Opened -> return result.ws
        is Attempt.Failed -> {
          val authFailed = result.code == 401 || result.code == 403 ||
            result.text.contains("401") || result.text.contains("403")
          Log.w(TAG, "识别服务连接失败 $url: ${result.text}")
          last = if (authFailed) {
            Fail("识别服务拒绝了 API Key（401/403），请检查百炼 Key", false)
          } else {
            Fail("连接识别服务失败: ${result.text}", true)
          }
          if (authFailed) throw last
        }
        null -> {
          ws.cancel()
          Log.w(TAG, "识别服务连接超时 $url")
          last = Fail("连接识别服务超时", true)
        }
      }
    }
    throw last
  }

  /** 连上之前的结果进 attempts，连上之后的帧进 inbox */
  private inner class Listener(private val attempts: LinkedBlockingQueue<Attempt>) : WebSocketListener() {
    @Volatile private var opened = false

    override fun onOpen(webSocket: WebSocket, response: Response) {
      opened = true
      attempts.offer(Attempt.Opened(webSocket))
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      inbox.offer(Item.Text(text))
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      inbox.offer(Item.OtherFrame)
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      inbox.offer(Item.CloseFrame(reason))
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      if (opened) {
        inbox.offer(Item.Broken(t))
      } else {
        attempts.offer(Attempt.Failed(t.message ?: t.toString(), response?.code))
      }
    }
  }

  companion object {
    fun spawn(cfg: AsrConfig, http: OkHttpClient, out: (AsrOutput) -> Unit): AsrStream {
      val stream = AsrStream(cfg, http, out)
      Thread({ stream.run() }, "voice-asr").start()
      return stream
    }
  }
}
