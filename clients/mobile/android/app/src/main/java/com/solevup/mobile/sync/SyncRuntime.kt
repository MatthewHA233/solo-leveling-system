package com.solevup.mobile.sync

import android.app.Activity
import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Bundle
import android.util.Log
import com.solevup.mobile.solevupdb.SolevupDb
import com.solevup.mobile.syncclient.SyncWorker
import com.solevup.mobile.syncserver.SyncHttpServer
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 进程级同步运行时：HTTP server、UDP 发现、网络回调、周期任务都在这里，
 * 由 MainApplication 拉起，不依赖 RN 和任何页面。
 *
 * 进程存活靠无障碍服务（启用时常驻）和 WorkManager（15 分钟兜底）；
 * 不用前台服务，避免常驻通知。
 */
object SyncRuntime : SyncCoordinator.Listener {
  interface EventSink {
    fun onDbChanged(source: String, result: SolevupDb.ImportResult)
    fun onSyncStatus(deviceId: String, syncing: Boolean, ok: Boolean?, error: String?)
  }

  data class Status(
    val running: Boolean,
    val port: Int,
    val ipv4s: List<String>,
    val error: String?,
    val alias: String,
    val deviceId: String,
    val deviceModel: String,
    val pairCode: String,
    // 下次自动同步的时间（毫秒）。不在前台时是 0
    val nextAutoSyncAt: Long,
  )

  private const val TAG = "SyncRuntime"
  private const val SOCKET_TIMEOUT_MS = 30_000
  private const val STARTUP_SYNC_DELAY_MS = 1_500L
  private const val NETWORK_SETTLE_MS = 2_000L
  private const val AUTO_SYNC_PERIOD_MS = 60_000L

  private val started = AtomicBoolean(false)
  private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
    Thread(r, "solevup-sync-runtime").apply { isDaemon = true }
  }

  private lateinit var appContext: Context

  private val db: SolevupDb by lazy { SolevupDb.shared(appContext) }

  val coordinator: SyncCoordinator by lazy { SyncCoordinator(db, this) }

  private val pairing = SyncPairing()

  @Volatile private var server: SyncHttpServer? = null
  @Volatile private var discovery: SyncDiscovery? = null
  @Volatile private var lastError: String? = null
  @Volatile private var sink: EventSink? = null
  @Volatile private var pendingNetworkSync: ScheduledFuture<*>? = null
  @Volatile private var autoSync: ScheduledFuture<*>? = null
  @Volatile private var nextAutoSyncAt = 0L

  fun start(application: Application) {
    if (!started.compareAndSet(false, true)) return
    appContext = application.applicationContext
    application.registerActivityLifecycleCallbacks(foregroundTracker)
    scheduler.execute { bootstrap() }
  }

  /** RN 模块注册；reload 后新模块实例会覆盖旧的。 */
  fun setEventSink(next: EventSink?) {
    sink = next
  }

  fun clearEventSink(current: EventSink) {
    if (sink === current) sink = null
  }

  fun status(): Status {
    val id = db.deviceId()
    return Status(
      running = server != null,
      port = SyncProtocol.DEFAULT_PORT,
      ipv4s = SyncProtocol.lanIpv4Addresses(),
      error = lastError,
      alias = db.syncAlias(),
      deviceId = id,
      deviceModel = Build.MODEL ?: "Android",
      pairCode = SyncProtocol.pairCode(id),
      nextAutoSyncAt = nextAutoSyncAt,
    )
  }

  fun nearbyPeers(): List<SyncDiscovery.NearbyPeer> = discovery?.listPeers() ?: emptyList()

  /** 主人点刷新。会阻塞几秒，调用方开线程 */
  fun refreshPeers(): List<SyncDiscovery.NearbyPeer> = discovery?.discoverRound() ?: emptyList()

  /** 改别名后马上广播，附近设备不用等下一轮。已链接设备下次同步时更新 */
  fun setAlias(alias: String): Status {
    db.setSyncAlias(alias)
    discovery?.announceNow()
    return status()
  }

  /** 生成配对码给对方设备输入（5 分钟有效，用一次就作废） */
  fun createPairCode(): SyncPairing.PairCode = pairing.generate()

  /** 启动失败时由配对页手动重试。 */
  fun retry(): Status {
    startEndpoints()
    return status()
  }

  private fun bootstrap() {
    startEndpoints()
    registerNetworkCallback()
    try {
      SyncWorker.enqueuePeriodic(appContext)
    } catch (t: Throwable) {
      Log.w(TAG, "enqueue periodic failed", t)
    }
    scheduler.schedule(
      { coordinator.enqueueAll("startup", 0) },
      STARTUP_SYNC_DELAY_MS, TimeUnit.MILLISECONDS,
    )
  }

  @Synchronized
  private fun startEndpoints() {
    var error: String? = null
    if (server == null) {
      try {
        val s = SyncHttpServer(
          SyncProtocol.DEFAULT_PORT, db, pairing,
          coordinator::onLinksChanged, coordinator::onInboundImport,
        )
        s.start(SOCKET_TIMEOUT_MS, false)
        server = s
      } catch (t: Throwable) {
        error = "同步服务启动失败：${t.message}"
        Log.w(TAG, error, t)
      }
    }
    if (discovery == null) {
      try {
        val d = SyncDiscovery(appContext, db, SyncProtocol.DEFAULT_PORT, coordinator::onPeerSeen)
        d.start()
        discovery = d
      } catch (t: Throwable) {
        error = error ?: "设备发现启动失败：${t.message}"
        Log.w(TAG, error, t)
      }
    }
    lastError = error
  }

  private fun registerNetworkCallback() {
    val cm = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    try {
      cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = scheduleNetworkSync()
      })
    } catch (t: Throwable) {
      Log.w(TAG, "register network callback failed", t)
    }
  }

  // onAvailable 触发时路由和 DHCP 还没稳定，稍等再重建组播；连续切换只跑最后一次
  private fun scheduleNetworkSync() {
    pendingNetworkSync?.cancel(false)
    pendingNetworkSync = scheduler.schedule({
      try {
        discovery?.restart()
      } catch (t: Throwable) {
        Log.w(TAG, "discovery restart failed", t)
      }
      coordinator.enqueueAll("network", 0)
    }, NETWORK_SETTLE_MS, TimeUnit.MILLISECONDS)
  }

  // 在前台时每分钟同步附近的已链接设备（和 desktop 一样）。后台靠 WorkManager
  private fun startAutoSync() {
    autoSync?.cancel(false)
    nextAutoSyncAt = System.currentTimeMillis() + AUTO_SYNC_PERIOD_MS
    autoSync = scheduler.scheduleWithFixedDelay({
      nextAutoSyncAt = System.currentTimeMillis() + AUTO_SYNC_PERIOD_MS
      try {
        val peers = nearbyPeers().associateBy { it.deviceId }
        for (link in db.listLinkedDevices()) {
          val peer = peers[link.deviceId] ?: continue
          coordinator.enqueue(link.copy(lastBase = peer.base), "auto", SyncCoordinator.FOREGROUND_COOLDOWN_MS)
        }
      } catch (t: Throwable) {
        Log.w(TAG, "auto sync failed", t)
      }
    }, AUTO_SYNC_PERIOD_MS, AUTO_SYNC_PERIOD_MS, TimeUnit.MILLISECONDS)
  }

  private fun stopAutoSync() {
    autoSync?.cancel(false)
    autoSync = null
    nextAutoSyncAt = 0L
  }

  private val foregroundTracker = object : Application.ActivityLifecycleCallbacks {
    private var startedCount = 0

    override fun onActivityStarted(activity: Activity) {
      startedCount++
      if (startedCount == 1 && ::appContext.isInitialized) {
        scheduler.execute {
          discovery?.announceNow()
          coordinator.enqueueAll("foreground", SyncCoordinator.FOREGROUND_COOLDOWN_MS)
          startAutoSync()
        }
      }
    }

    override fun onActivityStopped(activity: Activity) {
      startedCount = (startedCount - 1).coerceAtLeast(0)
      if (startedCount == 0) scheduler.execute { stopAutoSync() }
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
  }

  override fun onDbChanged(source: String, result: SolevupDb.ImportResult) {
    sink?.onDbChanged(source, result)
  }

  override fun onSyncStatus(deviceId: String, syncing: Boolean, ok: Boolean?, error: String?) {
    sink?.onSyncStatus(deviceId, syncing, ok, error)
  }

  override fun onRoundFailed() {
    discovery?.announceNow()
  }
}
