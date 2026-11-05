package com.solevup.mobile.sync

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import com.solevup.mobile.solevupdb.SolevupDb
import com.solevup.mobile.syncclient.SyncClient
import org.json.JSONObject
import java.io.IOException
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * UDP 发现，协议严格对齐 desktop sync_discovery.rs：
 *   - 报文 JSON: alias / version / device_id / pair_code / port / protocol /
 *     announce / device_type / device_model
 *   - 启动后立即一轮 + 每 30s 一轮，每轮 3 帧（0 / 180 / 650ms）
 *   - 收到 announce=true 时单播回 announce=false，这样不依赖对方的组播能到达自己
 *
 * 既发又收：只发不收的话，电脑换 IP 后手机拿不到新地址，只能等电脑主动推。
 * Android Wi-Fi 默认过滤组播，接收必须持有 MulticastLock。
 */
class SyncDiscovery(
  private val context: Context,
  private val db: SolevupDb,
  private val port: Int,
  private val onPeerSeen: (NearbyPeer) -> Unit,
) {
  data class NearbyPeer(
    val deviceId: String,
    val alias: String,
    val base: String,
    val pairCode: String,
    val deviceType: String,
    val deviceModel: String,
    val lastSeenMs: Long,
  )

  private val deviceId: String by lazy { db.deviceId() }
  private val peers = ConcurrentHashMap<String, NearbyPeer>()

  @Volatile private var socket: MulticastSocket? = null
  @Volatile private var receiver: Thread? = null
  @Volatile private var scheduler: ScheduledExecutorService? = null
  @Volatile private var multicastLock: WifiManager.MulticastLock? = null

  @Synchronized
  fun start() {
    if (socket != null) return
    val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    multicastLock = wifi?.createMulticastLock("solevup-sync-multicast")?.apply {
      setReferenceCounted(false)
      acquire()
    }
    val s = try {
      MulticastSocket(port).apply { loopbackMode = true }
    } catch (t: Throwable) {
      // 不释放的话，下次 start 又建一把新锁，这把就一直持有，Wi-Fi 无法省电
      try { multicastLock?.release() } catch (_: Throwable) {}
      multicastLock = null
      throw t
    }
    val group = InetSocketAddress(InetAddress.getByName(SyncProtocol.MULTICAST_GROUP), port)
    for (nif in SyncProtocol.lanInterfaces()) {
      try {
        s.joinGroup(group, nif)
      } catch (t: Throwable) {
        Log.w(TAG, "join ${nif.name} failed: ${t.message}")
      }
    }
    socket = s
    receiver = Thread({ receiveLoop(s) }, "solevup-discovery-recv").apply {
      isDaemon = true
      start()
    }
    val ex = Executors.newSingleThreadScheduledExecutor { r ->
      Thread(r, "solevup-discovery-send").apply { isDaemon = true }
    }
    scheduler = ex
    ex.scheduleWithFixedDelay({ sendBurst() }, 500, ANNOUNCE_PERIOD_MS, TimeUnit.MILLISECONDS)
  }

  @Synchronized
  fun stop() {
    scheduler?.shutdownNow()
    scheduler = null
    socket?.close()
    socket = null
    receiver?.interrupt()
    receiver = null
    try { multicastLock?.release() } catch (_: Throwable) {}
    multicastLock = null
  }

  /** 网络切换后组播成员关系绑在旧网卡上，必须重建 socket。 */
  @Synchronized
  fun restart() {
    stop()
    start()
  }

  fun announceNow() {
    val ex = scheduler ?: return
    try {
      ex.execute { sendBurst() }
    } catch (_: Throwable) {
      // 正在 stop，下次 start 会立即广播
    }
  }

  /** 最近 75s 内见过的对端（与 desktop 的 peer 过期时间一致）。 */
  fun listPeers(): List<NearbyPeer> {
    val cutoff = System.currentTimeMillis() - PEER_TTL_MS
    peers.values.removeAll { it.lastSeenMs < cutoff }
    return peers.values.sortedBy { it.alias }
  }

  /**
   * 主人点刷新：广播一轮，再问一遍已链接的地址。1 秒内谁都没回应就扫 /24，
   * 路由器拦组播的网络靠这个才找得到（对齐 desktop discover_round）。
   */
  fun discoverRound(): List<NearbyPeer> {
    val roundStart = System.currentTimeMillis()
    announceNow()
    val linkedBases = db.listLinkedDevices().map { it.lastBase }
    probeBases(linkedBases)
    Thread.sleep(SCAN_GRACE_MS)
    if (peers.values.none { it.lastSeenMs >= roundStart }) probeBases(subnetBases(linkedBases))
    return listPeers()
  }

  private fun subnetBases(linkedBases: List<String>): List<String> {
    val own = SyncProtocol.lanIpv4Addresses()
    val linked = linkedBases.mapNotNull { base ->
      try { URL(base).host } catch (_: Throwable) { null }
    }
    return (own + linked)
      .filter { isPrivateIpv4(it) }
      .map { it.substringBeforeLast('.') }
      .distinct()
      .flatMap { net -> (1..254).map { "$net.$it" } }
      .filter { it !in own }
      .map { "http://$it:$port" }
  }

  private fun isPrivateIpv4(ip: String): Boolean {
    val parts = ip.split('.').mapNotNull { it.toIntOrNull() }
    if (parts.size != 4) return false
    return parts[0] == 10 ||
      (parts[0] == 172 && parts[1] in 16..31) ||
      (parts[0] == 192 && parts[1] == 168)
  }

  private fun probeBases(bases: List<String>) {
    if (bases.isEmpty()) return
    val pool = Executors.newFixedThreadPool(SCAN_CONCURRENCY)
    for (base in bases) {
      pool.execute {
        try {
          rememberHello(SyncClient.fetchHello(base, timeoutMs = SCAN_TIMEOUT_MS), base)
        } catch (_: Throwable) {
          // 这个地址上没有设备
        }
      }
    }
    pool.shutdown()
    pool.awaitTermination(SCAN_WAIT_MS, TimeUnit.MILLISECONDS)
  }

  private fun rememberHello(hello: JSONObject, base: String) {
    val peerId = hello.optString("device_id")
    if (peerId.isEmpty() || peerId == deviceId) return
    val peer = NearbyPeer(
      deviceId = peerId,
      alias = hello.optString("alias", peerId),
      base = base,
      pairCode = hello.optString("pair_code"),
      deviceType = hello.optString("device_type"),
      deviceModel = hello.optString("device_model"),
      lastSeenMs = System.currentTimeMillis(),
    )
    peers[peerId] = peer
    onPeerSeen(peer)
  }

  private fun receiveLoop(s: MulticastSocket) {
    val buf = ByteArray(MAX_PACKET_LEN)
    while (!s.isClosed) {
      val packet = DatagramPacket(buf, buf.size)
      try {
        s.receive(packet)
        handlePacket(s, packet)
      } catch (e: IOException) {
        if (s.isClosed) return
        Log.w(TAG, "receive failed: ${e.message}")
      } catch (t: Throwable) {
        Log.w(TAG, "bad discovery packet: ${t.message}")
      }
    }
  }

  private fun handlePacket(s: MulticastSocket, packet: DatagramPacket) {
    val o = JSONObject(String(packet.data, packet.offset, packet.length, Charsets.UTF_8))
    val peerId = o.optString("device_id")
    if (peerId.isEmpty() || peerId == deviceId) return
    val peerPort = o.optInt("port", port).takeIf { it > 0 } ?: port
    val addr = packet.address
    val peer = NearbyPeer(
      deviceId = peerId,
      alias = o.optString("alias", peerId),
      base = "${o.optString("protocol", "http")}://${addr.hostAddress}:$peerPort",
      pairCode = o.optString("pair_code"),
      deviceType = o.optString("device_type"),
      deviceModel = o.optString("device_model"),
      lastSeenMs = System.currentTimeMillis(),
    )
    peers[peerId] = peer
    onPeerSeen(peer)
    if (o.optBoolean("announce")) {
      val bytes = payload(announce = false)
      s.send(DatagramPacket(bytes, bytes.size, addr, peerPort))
    }
  }

  private fun sendBurst() {
    val s = socket ?: return
    val bytes = try {
      payload(announce = true)
    } catch (t: Throwable) {
      Log.w(TAG, "build payload failed: ${t.message}")
      return
    }
    val packet = DatagramPacket(bytes, bytes.size, InetAddress.getByName(SyncProtocol.MULTICAST_GROUP), port)
    var last = 0L
    for (delay in BURST_DELAYS_MS) {
      try {
        Thread.sleep(delay - last)
      } catch (_: InterruptedException) {
        return
      }
      last = delay
      sendOnEveryInterface(s, packet)
    }
  }

  // 多网卡（Wi-Fi + 热点）时默认路由不一定是电脑所在的网段，逐网卡各发一帧
  private fun sendOnEveryInterface(s: MulticastSocket, packet: DatagramPacket) {
    for (nif in SyncProtocol.lanInterfaces()) {
      try {
        synchronized(s) {
          s.networkInterface = nif
          s.send(packet)
        }
      } catch (t: Throwable) {
        Log.w(TAG, "send via ${nif.name} failed: ${t.message}")
      }
    }
  }

  private fun payload(announce: Boolean): ByteArray =
    JSONObject().apply {
      put("alias", db.syncAlias())
      put("version", SyncProtocol.DISCOVERY_VERSION)
      put("device_id", deviceId)
      put("pair_code", SyncProtocol.pairCode(deviceId))
      put("port", port)
      put("protocol", "http")
      put("announce", announce)
      put("device_type", "mobile")
      put("device_model", Build.MODEL ?: "Android")
    }.toString().toByteArray(Charsets.UTF_8)

  companion object {
    private const val TAG = "SyncDiscovery"
    private const val ANNOUNCE_PERIOD_MS = 30_000L
    private const val PEER_TTL_MS = 75_000L
    private const val MAX_PACKET_LEN = 4096
    private val BURST_DELAYS_MS = longArrayOf(0L, 180L, 650L)
    // 扫网段的参数和 desktop sync_discovery.rs 一致
    private const val SCAN_GRACE_MS = 1_000L
    private const val SCAN_TIMEOUT_MS = 700
    private const val SCAN_CONCURRENCY = 64
    private const val SCAN_WAIT_MS = 30_000L
  }
}
