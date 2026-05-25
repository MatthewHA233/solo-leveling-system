package com.sololevelingsystemmobile.perception

import android.accessibilityservice.AccessibilityService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * 前台窗口感知 Service。
 *
 * Phase 2-块 2：监听 [AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED]，
 * 提取 (package, class, window_title)，写入 perception_events_android
 * （bucket = `sls-watcher-window_android`, event_type = `window.state_changed`）。
 *
 * 设计要点：
 * - 同 (pkg, class) 1 秒内去重，过滤 launcher/旋转抖动
 * - SQLite 写在 SingleThreadExecutor，避免阻塞 Service 主线程
 * - window_title 从 [AccessibilityEvent.getText] 列表拼接，不读控件树，侵入最小
 *
 * 启用方式：用户去 设置 → 辅助功能 → 已下载的应用 → Solo Leveling · 活动感知 → 启用。
 */
class SlsAccessibilityService : AccessibilityService() {

  private val db: PerceptionDb by lazy { PerceptionDb(applicationContext) }
  private val executor: ExecutorService = Executors.newSingleThreadExecutor { r ->
    Thread(r, "sls-a11y-writer").apply { isDaemon = true }
  }
  private val pm: PackageManager by lazy { applicationContext.packageManager }

  @Volatile private var lastPkg: String? = null
  @Volatile private var lastClass: String? = null
  @Volatile private var lastTs: Long = 0L

  // 电源/屏幕事件 receiver —— SCREEN_ON / SCREEN_OFF / USER_PRESENT
  // ACTION_SCREEN_OFF/ON 在 Android O+ 不能 manifest 静态注册（implicit broadcast 限制），
  // 必须动态注册到常驻 Service。这个 Service 是 AccessibilityService，系统不杀，能稳收。
  // BOOT_COMPLETED 不在这处理（要 manifest + RECEIVE_BOOT_COMPLETED 权限，下个迭代）。
  private val powerReceiver: BroadcastReceiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context?, intent: Intent?) {
      val action = intent?.action ?: return
      val event = when (action) {
        Intent.ACTION_SCREEN_OFF -> "screen_off"
        Intent.ACTION_SCREEN_ON -> "screen_on"
        Intent.ACTION_USER_PRESENT -> "unlocked"
        else -> return
      }
      val ts = System.currentTimeMillis()
      executor.execute {
        try {
          db.insertPowerEvent(event, ts)
          Log.d(TAG, "power $event @ $ts")
        } catch (ex: Throwable) {
          Log.w(TAG, "write power event failed", ex)
        }
      }
    }
  }
  @Volatile private var powerReceiverRegistered = false

  @Volatile private var lastTorrentSampleTs: Long = 0L

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    val e = event ?: return
    // 诊断：B 站 a11y event 全打，看点视频时具体触发什么类型
    val pkg = e.packageName?.toString() ?: ""
    if (pkg == "tv.danmaku.bili") {
      val typeStr = AccessibilityEvent.eventTypeToString(e.eventType)
      val cdSrc = try { e.source?.contentDescription?.toString().orEmpty() } catch (_: Throwable) { "" }
      Log.i(TAG, "evt=$typeStr cls=${e.className} cd='${cdSrc.take(60)}'")
    }
    when (e.eventType) {
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
        handleWindowState(e)
        maybeSampleTorrent(e, throttle = false)
      }
      AccessibilityEvent.TYPE_VIEW_CLICKED -> handleClick(e)
      AccessibilityEvent.TYPE_VIEW_SCROLLED,
      AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> {
        maybeSampleTorrent(e, throttle = true)
      }
    }
  }

  /** "洪流域"抓取：限定 TORRENT_PACKAGES 白名单（先 B 站），throttle 500ms
   *  避免滚动时每帧抓取 → 走 getRootInActiveWindow 遍历整树拿可见文本 */
  private fun maybeSampleTorrent(e: AccessibilityEvent, throttle: Boolean) {
    val pkg = e.packageName?.toString() ?: return
    if (pkg !in TORRENT_PACKAGES) return
    val now = System.currentTimeMillis()
    if (throttle && now - lastTorrentSampleTs < TORRENT_THROTTLE_MS) return
    lastTorrentSampleTs = now
    val windowClass = lastClass ?: e.className?.toString() ?: ""
    // 控件树 root 必须在主线程拿（执行 a11y 回调时已在主线程）
    val root = try { rootInActiveWindow } catch (_: Throwable) { null } ?: return
    // 关键过滤：rootInActiveWindow 可能拿到 SystemUI / 输入法 / 浮窗根，
    // 即使 event.packageName == B 站，root 也可能是别的 app。
    // 这种情况下直接跳过，不要污染洪流域
    val rootPkg = root.packageName?.toString()
    if (rootPkg != pkg) {
      Log.d(TAG, "torrent skip: event pkg=$pkg but root pkg=$rootPkg")
      return
    }
    val texts = ArrayList<Pair<String, String>>()  // text, source_class
    collectTexts(root, texts, depth = 0, maxNodes = 600)
    if (texts.isEmpty()) return
    executor.execute {
      try {
        var inserted = 0
        for ((text, srcCls) in texts) {
          val trimmed = text.trim()
          if (trimmed.length < 2) continue  // 跳"是""×"这种无意义短文本
          if (db.insertTorrentCapture(
              eventTimeMs = now,
              packageName = pkg,
              windowClass = windowClass,
              captureType = "a11y-view",
              text = trimmed,
              sourceClass = srcCls,
            )) inserted++
        }
        if (inserted > 0) {
          Log.d(TAG, "torrent pkg=$pkg cls=$windowClass +$inserted (scanned ${texts.size})")
        }
      } catch (ex: Throwable) {
        Log.w(TAG, "torrent insert failed", ex)
      }
    }
  }

  /** 深度优先遍历控件树，收集所有 text/contentDescription
   *  maxNodes 防 RecyclerView 巨树爆栈 */
  private fun collectTexts(
    node: AccessibilityNodeInfo?,
    out: MutableList<Pair<String, String>>,
    depth: Int,
    maxNodes: Int,
  ) {
    if (node == null || depth > 30 || out.size >= maxNodes) return
    val cls = node.className?.toString() ?: ""
    node.text?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it to cls) }
    node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it to cls) }
    val n = node.childCount
    for (i in 0 until n) {
      collectTexts(node.getChild(i), out, depth + 1, maxNodes)
      if (out.size >= maxNodes) break
    }
  }

  private fun handleClick(e: AccessibilityEvent) {
    val pkg = e.packageName?.toString() ?: return
    if (pkg == applicationContext.packageName) return
    clickCountsByPkg
      .computeIfAbsent(pkg) { AtomicLong(0L) }
      .incrementAndGet()
    totalClicks.incrementAndGet()
    // 点击 = "用户主动选择"：抓 source view 的 contentDescription
    // 配合 TORRENT_PACKAGES 白名单。B 站 feed 卡片的 contentDescription
    // 就是聚合行 "视频,标题,UP主xxx,..." → 能精确还原"X 时间点了 Y 视频"
    if (pkg !in TORRENT_PACKAGES) return
    val now = System.currentTimeMillis()
    val source = try { e.source } catch (_: Throwable) { null }
    val cd = source?.contentDescription?.toString()?.trim().orEmpty()
    val txt = source?.text?.toString()?.trim().orEmpty()
    val sourceCls = source?.className?.toString().orEmpty()
    val windowClass = lastClass ?: e.className?.toString() ?: ""
    // 日志诊断：B 站 click 是否真的触发，source 是否有 cd/text
    Log.i(TAG, "click pkg=$pkg cls=$sourceCls cd='${cd.take(50)}' txt='${txt.take(50)}'")
    val pick = if (cd.length >= 2) cd else txt
    if (pick.length < 2) {
      try { source?.recycle() } catch (_: Throwable) {}
      return
    }
    try { source?.recycle() } catch (_: Throwable) {}
    executor.execute {
      try {
        db.insertTorrentCapture(
          eventTimeMs = now,
          packageName = pkg,
          windowClass = windowClass,
          captureType = "a11y-click",
          text = pick,
          sourceClass = sourceCls,
        )
      } catch (ex: Throwable) {
        Log.w(TAG, "click capture insert failed", ex)
      }
    }
  }

  private fun handleWindowState(e: AccessibilityEvent) {
    val pkg = e.packageName?.toString() ?: return
    // 过滤自身：AccessibilityEvent.text 会把整个 modal 内可见文字拼进 title，污染严重
    if (pkg == applicationContext.packageName) return
    val cls = e.className?.toString() ?: ""
    val now = System.currentTimeMillis()
    if (pkg == lastPkg && cls == lastClass && now - lastTs < DEDUP_WINDOW_MS) return
    lastPkg = pkg
    lastClass = cls
    lastTs = now

    val title = extractTitle(e)

    executor.execute {
      try {
        val label = resolveLabel(pkg)
        val payload = org.json.JSONObject().apply {
          put("package_name", pkg)
          put("class_name", cls)
          put("app_label", label)
          put("window_title", title)
          put("event_time_ms", now)
          put("source", SOURCE)
        }
        // AUDIT-020：start_at/end_at 用事件真实发生时刻（System.currentTimeMillis 时拍下的 now）
        // 派生，不要在 executor 内调 nowIso() —— executor 排队跨过 span 边界会让
        // windowEventsInRange() 漏查真实落在 span 内的事件
        val isoFromNow = PerceptionDb.isoFromMs(now)
        db.ensureBucket(
          id = BUCKET_ID,
          kind = BUCKET_KIND,
          eventType = EVENT_TYPE,
          source = SOURCE,
        )
        db.insertEvent(
          bucketId = BUCKET_ID,
          startAt = isoFromNow,
          endAt = isoFromNow,
          dataJson = payload.toString(),
        )
        Log.d(TAG, "window pkg=$pkg cls=$cls title=$title")
      } catch (ex: Throwable) {
        Log.w(TAG, "write window event failed", ex)
      }
    }
  }

  private fun extractTitle(e: AccessibilityEvent): String {
    val list = e.text ?: return ""
    val sb = StringBuilder()
    for (t in list) {
      val s = t?.toString() ?: continue
      if (s.isBlank()) continue
      if (sb.isNotEmpty()) sb.append(" / ")
      sb.append(s)
    }
    return sb.toString()
  }

  private fun resolveLabel(pkg: String): String = try {
    val ai = pm.getApplicationInfo(pkg, 0)
    pm.getApplicationLabel(ai).toString()
  } catch (_: PackageManager.NameNotFoundException) {
    pkg
  } catch (_: Throwable) {
    pkg
  }

  override fun onInterrupt() {
    // no-op
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    Log.i(TAG, "SlsAccessibilityService connected")
    instanceRunning = true
    if (!powerReceiverRegistered) {
      val filter = IntentFilter().apply {
        addAction(Intent.ACTION_SCREEN_OFF)
        addAction(Intent.ACTION_SCREEN_ON)
        addAction(Intent.ACTION_USER_PRESENT)
      }
      try {
        // RECEIVER_NOT_EXPORTED 标志在 Android 13+ 必须，避免 SecurityException
        // 系统广播不带数据走 manifest 内部，标志是 receiver 自身可见性
        registerReceiver(powerReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        powerReceiverRegistered = true
      } catch (ex: Throwable) {
        // Android 12 以下不接受 RECEIVER_NOT_EXPORTED 标志，回退
        try {
          @Suppress("UnspecifiedRegisterReceiverFlag")
          registerReceiver(powerReceiver, filter)
          powerReceiverRegistered = true
        } catch (ex2: Throwable) {
          Log.w(TAG, "register power receiver failed", ex2)
        }
      }
      // Service 启动那刻通常对应"应用启动 / 屏幕本来就亮"，记一个 boot 事件
      // 作为时间轴起点（区别真正 BOOT_COMPLETED 留到下个迭代）
      val ts = System.currentTimeMillis()
      executor.execute {
        try { db.insertPowerEvent("service_started", ts) } catch (_: Throwable) {}
      }
    }
  }

  override fun onDestroy() {
    instanceRunning = false
    if (powerReceiverRegistered) {
      try { unregisterReceiver(powerReceiver) } catch (_: Throwable) {}
      powerReceiverRegistered = false
    }
    executor.shutdown()
    super.onDestroy()
  }

  companion object {
    private const val TAG = "SlsAccessibility"

    private const val BUCKET_ID = "sls-watcher-window_android"
    private const val BUCKET_KIND = "window"
    private const val EVENT_TYPE = "window.state_changed"
    private const val SOURCE = "android_accessibility"

    private const val DEDUP_WINDOW_MS = 1000L

    // "洪流域"抓取白名单 + 节流。Phase 1 先 B 站
    private val TORRENT_PACKAGES = setOf("tv.danmaku.bili")
    private const val TORRENT_THROTTLE_MS = 500L

    @Volatile
    private var instanceRunning: Boolean = false

    /**
     * 进程内点击计数：pkg -> 累计次数。Service 进程重启即清零，
     * 语义是"开机/重启 Service 以来该 app 收到的 TYPE_VIEW_CLICKED 次数"。
     */
    private val clickCountsByPkg: ConcurrentHashMap<String, AtomicLong> = ConcurrentHashMap()
    private val totalClicks = AtomicLong(0L)

    /** 当前快照：返回 (pkg -> count) 列表，按 count 降序，以及总数。 */
    fun snapshotClicks(): Pair<List<Pair<String, Long>>, Long> {
      val list = clickCountsByPkg.entries
        .map { it.key to it.value.get() }
        .sortedByDescending { it.second }
      return list to totalClicks.get()
    }

    /** 清空当前计数。 */
    fun resetClicks() {
      clickCountsByPkg.clear()
      totalClicks.set(0L)
    }

    /** 判断当前 Service 是否已在系统辅助功能列表里启用。 */
    fun isEnabled(context: Context): Boolean {
      val self = ComponentName(context, SlsAccessibilityService::class.java)
      val enabled = Settings.Secure.getString(
        context.contentResolver,
        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
      ) ?: return false
      if (TextUtils.isEmpty(enabled)) return false
      val splitter = TextUtils.SimpleStringSplitter(':')
      splitter.setString(enabled)
      while (splitter.hasNext()) {
        val piece = splitter.next()
        val cn = ComponentName.unflattenFromString(piece) ?: continue
        if (cn == self) return true
      }
      return false
    }

    /** 跳转系统"辅助功能"设置主页面（用户需手动找到本应用并启用）。 */
    fun openSettings(context: Context): Boolean {
      val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      return try {
        context.startActivity(intent)
        true
      } catch (_: Throwable) {
        false
      }
    }
  }
}
