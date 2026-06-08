package com.solevup.mobile.perception

import android.app.AppOpsManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject

/**
 * Android UsageStatsManager 采集 —— 对应 desktop perception_windows.rs。
 *
 * 写入格式（对齐 desktop 的 solevup-watcher-window_windows + currentwindow 命名规则）：
 *   bucket_id   = solevup-watcher-usage_android
 *   kind        = usage
 *   event_type  = app.usage_summary
 *   data_json   = { interval_start, interval_end, apps: [...] }
 *
 * 选择"一次查询=一条 summary 事件"而非"每 app 一条事件"，因为 UsageStatsManager
 * 返回的本身就是聚合数据，与 desktop 的逐 tick window snapshot 性质不同；
 * Phase 2 加 AccessibilityService 后再处理逐窗口事件。
 */
object UsageStatsCollector {

  private const val BUCKET_ID = "solevup-watcher-usage_android"
  private const val BUCKET_KIND = "usage"
  private const val EVENT_TYPE = "app.usage_summary"
  private const val SOURCE = "android_usage_stats"

  /** 检查应用是否被授予 PACKAGE_USAGE_STATS。 */
  fun hasUsageAccess(context: Context): Boolean {
    val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      appOps.unsafeCheckOpNoThrow(
        AppOpsManager.OPSTR_GET_USAGE_STATS,
        Process.myUid(),
        context.packageName,
      )
    } else {
      @Suppress("DEPRECATION")
      appOps.checkOpNoThrow(
        AppOpsManager.OPSTR_GET_USAGE_STATS,
        Process.myUid(),
        context.packageName,
      )
    }
    return mode == AppOpsManager.MODE_ALLOWED
  }

  /** 跳转系统"使用情况访问"设置页。返回 Intent 是否成功发出。 */
  fun openUsageAccessSettings(context: Context): Boolean {
    val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    return try {
      context.startActivity(intent)
      true
    } catch (_: Throwable) {
      false
    }
  }

  data class CollectResult(
    val rowId: Long,
    val intervalStart: String,
    val intervalEnd: String,
    val appCount: Int,
    val totalForegroundMs: Long,
  )

  /**
   * 采集 [sinceMs, now] 区间内的 app 前台使用统计，写一条 summary event。
   * 返回元数据；如未授权，抛 [UsageAccessNotGranted]。
   */
  fun collectRecent(context: Context, db: PerceptionDb, sinceMs: Long): CollectResult {
    if (!hasUsageAccess(context)) throw UsageAccessNotGranted()

    val now = System.currentTimeMillis()
    val mgr = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
    val pm = context.packageManager
    val ownPkg = context.packageName

    // INTERVAL_BEST 让系统选最合适的聚合粒度。
    val raw = mgr.queryUsageStats(UsageStatsManager.INTERVAL_BEST, sinceMs, now)
      ?: emptyList()

    // queryUsageStats 可能在跨 bucket 边界处出现同 package 多条，按 totalTimeInForeground 累加。
    val agg = HashMap<String, Pair<Long, Long>>() // pkg -> (totalMs, lastUsed)
    for (us in raw) {
      val pkg = us.packageName ?: continue
      if (pkg == ownPkg) continue // 自身不计
      val foreground = us.totalTimeInForeground
      if (foreground <= 0) continue
      val prev = agg[pkg]
      if (prev == null) {
        agg[pkg] = foreground to us.lastTimeUsed
      } else {
        agg[pkg] = (prev.first + foreground) to maxOf(prev.second, us.lastTimeUsed)
      }
    }

    val appsArr = JSONArray()
    var totalMs = 0L
    val sorted = agg.entries.sortedByDescending { it.value.first }
    for ((pkg, pair) in sorted) {
      val (durMs, lastUsed) = pair
      totalMs += durMs
      val label = resolveAppLabel(pm, pkg)
      val obj = JSONObject().apply {
        put("package_name", pkg)
        put("app_label", label)
        put("total_time_ms", durMs)
        put("last_time_used", lastUsed)
      }
      appsArr.put(obj)
    }

    val intervalStartIso = PerceptionDb.nowIso() // 当前作为采集时刻；详细 ms 字段下面记录
    val intervalEndIso = intervalStartIso

    val payload = JSONObject().apply {
      put("interval_start_ms", sinceMs)
      put("interval_end_ms", now)
      put("app_count", appsArr.length())
      put("total_foreground_ms", totalMs)
      put("apps", appsArr)
    }

    db.ensureBucket(
      id = BUCKET_ID,
      kind = BUCKET_KIND,
      eventType = EVENT_TYPE,
      source = SOURCE,
    )
    val rowId = db.insertEvent(
      bucketId = BUCKET_ID,
      startAt = intervalStartIso,
      endAt = intervalEndIso,
      dataJson = payload.toString(),
    )

    return CollectResult(
      rowId = rowId,
      intervalStart = intervalStartIso,
      intervalEnd = intervalEndIso,
      appCount = appsArr.length(),
      totalForegroundMs = totalMs,
    )
  }

  private fun resolveAppLabel(pm: PackageManager, pkg: String): String {
    return try {
      val ai = pm.getApplicationInfo(pkg, 0)
      pm.getApplicationLabel(ai).toString()
    } catch (_: PackageManager.NameNotFoundException) {
      pkg
    } catch (_: Throwable) {
      pkg
    }
  }
}

class UsageAccessNotGranted : RuntimeException("PACKAGE_USAGE_STATS not granted")
