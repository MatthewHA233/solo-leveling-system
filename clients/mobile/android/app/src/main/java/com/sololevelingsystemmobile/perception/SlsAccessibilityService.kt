package com.sololevelingsystemmobile.perception

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.view.accessibility.AccessibilityEvent
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
 * 启用方式：用户去 设置 → 辅助功能 → 已下载的应用 → SLS 感知前台窗口 → 启用。
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

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    val e = event ?: return
    when (e.eventType) {
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> handleWindowState(e)
      AccessibilityEvent.TYPE_VIEW_CLICKED -> handleClick(e)
    }
  }

  private fun handleClick(e: AccessibilityEvent) {
    val pkg = e.packageName?.toString() ?: return
    clickCountsByPkg
      .computeIfAbsent(pkg) { AtomicLong(0L) }
      .incrementAndGet()
    totalClicks.incrementAndGet()
  }

  private fun handleWindowState(e: AccessibilityEvent) {
    val pkg = e.packageName?.toString() ?: return
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
        val nowIso = PerceptionDb.nowIso()
        db.ensureBucket(
          id = BUCKET_ID,
          kind = BUCKET_KIND,
          eventType = EVENT_TYPE,
          source = SOURCE,
        )
        db.insertEvent(
          bucketId = BUCKET_ID,
          startAt = nowIso,
          endAt = nowIso,
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
  }

  override fun onDestroy() {
    instanceRunning = false
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
