package com.solevup.mobile.syncserver

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import com.solevup.mobile.solevupdb.SolevupDb
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * UDP multicast 广播，让 desktop SyncDiscovery 自动发现这台 mobile。
 *
 * 协议严格对齐 desktop sync_discovery.rs：
 *   - multicast group: 224.0.0.167
 *   - 端口: 跟 HTTP server 同（默认 49733）
 *   - 报文 JSON 字段: alias / version / device_id / pair_code /
 *     port / protocol / announce / device_type / device_model
 *   - 频率: 启动后立即广播 + 每 30s 重广播；每次发 3 帧 (0/180/650ms)
 *
 * 注意：Android Wi-Fi 默认会过滤 multicast，必须 acquire MulticastLock
 * 才能让 multicast 包到达接收端（这里我们只发不收，acquire 主要是
 * 让发送方进入 multicast 工作模式）。
 */
class SyncDiscoveryBroadcaster(
  private val context: Context,
  private val db: SolevupDb,
  private val port: Int,
  private val alias: String,
) {
  companion object {
    private const val TAG = "SyncDiscoveryBroadcaster"
    private const val MULTICAST_GROUP = "224.0.0.167"
    private const val PROTOCOL_VERSION = "1.0"
    private const val ANNOUNCE_PERIOD_SECONDS = 30L
  }

  @Volatile private var executor: ScheduledExecutorService? = null
  @Volatile private var multicastLock: WifiManager.MulticastLock? = null

  fun start() {
    if (executor != null) return  // 幂等
    val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    multicastLock = wifi?.createMulticastLock("solevup-sync-multicast")?.apply {
      setReferenceCounted(false)
      acquire()
    }
    val ex = Executors.newSingleThreadScheduledExecutor { r ->
      Thread(r, "solevup-discovery-broadcaster").apply { isDaemon = true }
    }
    executor = ex
    // 启动立即一轮，然后每 30s 重广播；每轮 sendBurst 在内部发 3 帧
    ex.scheduleAtFixedRate({
      try {
        sendBurst()
      } catch (t: Throwable) {
        Log.w(TAG, "broadcast failed", t)
      }
    }, 500, TimeUnit.SECONDS.toMillis(ANNOUNCE_PERIOD_SECONDS), TimeUnit.MILLISECONDS)
  }

  fun stop() {
    executor?.shutdownNow()
    executor = null
    try { multicastLock?.release() } catch (_: Throwable) {}
    multicastLock = null
  }

  /** 单轮广播 = 3 帧（0 / 180ms / 650ms），让网络抖动场景下提高送达率。 */
  private fun sendBurst() {
    val deviceId = db.deviceId()
    val payload = JSONObject().apply {
      put("alias", alias)
      put("version", PROTOCOL_VERSION)
      put("device_id", deviceId)
      put("pair_code", pairCode(deviceId))
      put("port", port)
      put("protocol", "http")
      put("announce", true)
      put("device_type", "mobile")
      put("device_model", Build.MODEL ?: "Android")
    }
    val bytes = payload.toString().toByteArray(Charsets.UTF_8)
    val group = InetAddress.getByName(MULTICAST_GROUP)
    val packet = DatagramPacket(bytes, bytes.size, group, port)

    val delays = longArrayOf(0L, 180L, 650L)
    for (delay in delays) {
      if (delay > 0) Thread.sleep(delay)
      try {
        DatagramSocket().use { s ->
          s.send(packet)
        }
      } catch (t: Throwable) {
        Log.w(TAG, "send packet failed (delay=$delay)", t)
      }
    }
  }

  /** 跟 desktop db.rs sync_pair_code 一致的 FNV-1a 64bit。 */
  private fun pairCode(deviceId: String): String {
    val input = "solevup:sync:v1:$deviceId"
    var hash = 0xcbf29ce484222325UL
    for (byte in input.toByteArray(Charsets.UTF_8)) {
      hash = hash xor (byte.toUByte().toULong())
      hash = (hash * 0x100000001b3UL)
    }
    val hex = hash.toString(16).padStart(16, '0')
    return "${hex.substring(0, 4)}-${hex.substring(4, 8)}".uppercase()
  }
}
