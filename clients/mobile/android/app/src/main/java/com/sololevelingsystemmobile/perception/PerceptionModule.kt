package com.sololevelingsystemmobile.perception

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray

/**
 * 感知层原生模块 (Android-only)。
 * 对齐 desktop 端 perception_windows.rs 的设置体系，
 * 数据写入本地 SQLite 表 perception_buckets_android / perception_events_android。
 *
 * Phase 1 块 1：骨架 + 桥接验证 (ping)
 * Phase 1 块 2：SQLite schema + 探针写入 (dbStats / dbInsertProbe)
 */
class PerceptionModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  private val db: PerceptionDb by lazy { PerceptionDb(reactContext) }

  @ReactMethod
  fun ping(promise: Promise) {
    val map = Arguments.createMap().apply {
      putBoolean("ok", true)
      putDouble("ts", System.currentTimeMillis().toDouble())
      putString("platform", "android")
      putString("module", NAME)
    }
    promise.resolve(map)
  }

  @ReactMethod
  fun dbStats(promise: Promise) {
    try {
      val (bucketCount, eventCount, path) = db.stats()
      val map = Arguments.createMap().apply {
        putDouble("bucketCount", bucketCount.toDouble())
        putDouble("eventCount", eventCount.toDouble())
        putString("path", path)
      }
      promise.resolve(map)
    } catch (e: Throwable) {
      promise.reject("DB_STATS_FAILED", e.message, e)
    }
  }

  /**
   * 写入一条 probe 事件，用于端到端验证写入路径。
   * 复用一个固定 bucket：`probe`，事件类型 `probe.heartbeat`。
   */
  @ReactMethod
  fun hasUsageAccess(promise: Promise) {
    try {
      promise.resolve(UsageStatsCollector.hasUsageAccess(reactContext))
    } catch (e: Throwable) {
      promise.reject("USAGE_ACCESS_CHECK_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun openUsageAccessSettings(promise: Promise) {
    try {
      promise.resolve(UsageStatsCollector.openUsageAccessSettings(reactContext))
    } catch (e: Throwable) {
      promise.reject("OPEN_USAGE_SETTINGS_FAILED", e.message, e)
    }
  }

  /** 采集 [now - rangeMs, now] 的 app 使用统计写一条 summary 事件。 */
  @ReactMethod
  fun collectUsageStats(rangeMs: Double, promise: Promise) {
    try {
      val sinceMs = System.currentTimeMillis() - rangeMs.toLong()
      val r = UsageStatsCollector.collectRecent(reactContext, db, sinceMs)
      val map = Arguments.createMap().apply {
        putDouble("rowId", r.rowId.toDouble())
        putString("intervalStart", r.intervalStart)
        putString("intervalEnd", r.intervalEnd)
        putInt("appCount", r.appCount)
        putDouble("totalForegroundMs", r.totalForegroundMs.toDouble())
      }
      promise.resolve(map)
    } catch (_: UsageAccessNotGranted) {
      promise.reject("USAGE_ACCESS_DENIED", "PACKAGE_USAGE_STATS not granted")
    } catch (e: Throwable) {
      promise.reject("COLLECT_USAGE_FAILED", e.message, e)
    }
  }

  /** 读最近一条 app.usage_summary 事件并展开为 apps 列表，方便 UI 直接渲染。 */
  @ReactMethod
  fun getLatestUsageSummary(promise: Promise) {
    try {
      val s = db.latestUsageSummary()
      if (s == null) {
        promise.resolve(null)
        return
      }
      val appsArr = Arguments.createArray()
      for (app in s.apps) {
        val m = Arguments.createMap().apply {
          putString("packageName", app.packageName)
          putString("appLabel", app.appLabel)
          putDouble("totalTimeMs", app.totalTimeMs.toDouble())
          putDouble("lastTimeUsed", app.lastTimeUsed.toDouble())
        }
        appsArr.pushMap(m)
      }
      val out = Arguments.createMap().apply {
        putDouble("rowId", s.rowId.toDouble())
        putDouble("intervalEndMs", s.intervalEndMs.toDouble())
        putArray("apps", appsArr)
      }
      promise.resolve(out)
    } catch (e: Throwable) {
      promise.reject("GET_LATEST_USAGE_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun getClickCounts(promise: Promise) {
    try {
      val (list, total) = SlsAccessibilityService.snapshotClicks()
      val pm = reactContext.packageManager
      val arr = Arguments.createArray()
      for ((pkg, count) in list) {
        val label = try {
          val ai = pm.getApplicationInfo(pkg, 0)
          pm.getApplicationLabel(ai).toString()
        } catch (_: Throwable) { pkg }
        arr.pushMap(Arguments.createMap().apply {
          putString("packageName", pkg)
          putString("appLabel", label)
          putDouble("count", count.toDouble())
        })
      }
      promise.resolve(Arguments.createMap().apply {
        putDouble("total", total.toDouble())
        putArray("entries", arr)
      })
    } catch (e: Throwable) {
      promise.reject("GET_CLICK_COUNTS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun resetClickCounts(promise: Promise) {
    try {
      SlsAccessibilityService.resetClicks()
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("RESET_CLICK_COUNTS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun purgeSelfWindowEvents(promise: Promise) {
    try {
      promise.resolve(db.purgeSelfWindowEvents())
    } catch (e: Throwable) {
      promise.reject("PURGE_SELF_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun getAppIcons(packageNames: ReadableArray, promise: Promise) {
    try {
      val out = Arguments.createMap()
      for (i in 0 until packageNames.size()) {
        val pkg = packageNames.getString(i) ?: continue
        val b64 = AppIconResolver.base64Of(reactContext, pkg)
        out.putString(pkg, b64)
      }
      promise.resolve(out)
    } catch (e: Throwable) {
      promise.reject("GET_APP_ICONS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun getWindowEventsInRange(startMs: Double, endMs: Double, limit: Double, promise: Promise) {
    try {
      val items = db.windowEventsInRange(startMs.toLong(), endMs.toLong(), limit.toInt())
      val arr = Arguments.createArray()
      for (it in items) {
        arr.pushMap(Arguments.createMap().apply {
          putDouble("rowId", it.rowId.toDouble())
          putString("startAt", it.startAt)
          putString("packageName", it.packageName)
          putString("className", it.className)
          putString("appLabel", it.appLabel)
          putString("windowTitle", it.windowTitle)
          putDouble("eventTimeMs", it.eventTimeMs.toDouble())
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) {
      promise.reject("GET_WINDOW_EVENTS_RANGE_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun getPowerEventsInRange(startMs: Double, endMs: Double, limit: Double, promise: Promise) {
    try {
      val items = db.powerEventsInRange(startMs.toLong(), endMs.toLong(), limit.toInt())
      val arr = Arguments.createArray()
      for (it in items) {
        arr.pushMap(Arguments.createMap().apply {
          putDouble("rowId", it.rowId.toDouble())
          putString("startAt", it.startAt)
          putString("event", it.event)
          putDouble("eventTimeMs", it.eventTimeMs.toDouble())
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) {
      promise.reject("GET_POWER_EVENTS_RANGE_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun getRecentWindowEvents(limit: Double, promise: Promise) {
    try {
      val items = db.recentWindowEvents(limit.toInt())
      val arr = Arguments.createArray()
      for (it in items) {
        arr.pushMap(Arguments.createMap().apply {
          putDouble("rowId", it.rowId.toDouble())
          putString("startAt", it.startAt)
          putString("packageName", it.packageName)
          putString("className", it.className)
          putString("appLabel", it.appLabel)
          putString("windowTitle", it.windowTitle)
          putDouble("eventTimeMs", it.eventTimeMs.toDouble())
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) {
      promise.reject("GET_WINDOW_EVENTS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun getAppMonitorSegmentsInRange(startMs: Double, endMs: Double, limit: Double, promise: Promise) {
    try {
      val items = db.appMonitorSegmentsInRange(startMs.toLong(), endMs.toLong(), limit.toInt())
      promise.resolve(appMonitorSegmentsToArray(items))
    } catch (e: Throwable) {
      promise.reject("GET_APP_MONITOR_SEGMENTS_RANGE_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun getRecentAppMonitorSegments(limit: Double, promise: Promise) {
    try {
      val items = db.recentAppMonitorSegments(limit.toInt())
      promise.resolve(appMonitorSegmentsToArray(items))
    } catch (e: Throwable) {
      promise.reject("GET_RECENT_APP_MONITOR_SEGMENTS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun isAccessibilityEnabled(promise: Promise) {
    try {
      promise.resolve(SlsAccessibilityService.isEnabled(reactContext))
    } catch (e: Throwable) {
      promise.reject("ACCESSIBILITY_CHECK_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun openAccessibilitySettings(promise: Promise) {
    try {
      promise.resolve(SlsAccessibilityService.openSettings(reactContext))
    } catch (e: Throwable) {
      promise.reject("OPEN_ACCESSIBILITY_SETTINGS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun dbInsertProbe(promise: Promise) {
    try {
      val now = PerceptionDb.nowIso()
      val bucketId = db.ensureBucket(
        id = "probe",
        kind = "probe",
        eventType = "probe.heartbeat",
        source = "perception_module",
      )
      val rowId = db.insertEvent(
        bucketId = bucketId,
        startAt = now,
        endAt = now,
        dataJson = """{"source":"manual","ts":"$now"}""",
      )
      val map = Arguments.createMap().apply {
        putDouble("rowId", rowId.toDouble())
        putString("bucketId", bucketId)
        putString("at", now)
      }
      promise.resolve(map)
    } catch (e: Throwable) {
      promise.reject("DB_INSERT_FAILED", e.message, e)
    }
  }

  // ── 洪流域 raw 文本捕获查询 ──

  @ReactMethod
  fun getRecentTorrentCaptures(limit: Double, promise: Promise) {
    try {
      val list = db.recentTorrentCaptures(limit.toInt())
      val arr = Arguments.createArray()
      for (c in list) {
        arr.pushMap(Arguments.createMap().apply {
          putDouble("rowId", c.rowId.toDouble())
          putDouble("eventTimeMs", c.eventTimeMs.toDouble())
          putString("packageName", c.packageName)
          putString("windowClass", c.windowClass)
          putString("captureType", c.captureType)
          putString("text", c.text)
          putString("textHash", c.textHash)
          putString("sourceClass", c.sourceClass)
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) {
      promise.reject("TORRENT_QUERY_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun getTorrentCapturesInRange(startMs: Double, endMs: Double, limit: Double, promise: Promise) {
    try {
      val list = db.torrentCapturesInRange(startMs.toLong(), endMs.toLong(), limit.toInt())
      val arr = Arguments.createArray()
      for (c in list) {
        arr.pushMap(Arguments.createMap().apply {
          putDouble("rowId", c.rowId.toDouble())
          putDouble("eventTimeMs", c.eventTimeMs.toDouble())
          putString("packageName", c.packageName)
          putString("windowClass", c.windowClass)
          putString("captureType", c.captureType)
          putString("text", c.text)
          putString("textHash", c.textHash)
          putString("sourceClass", c.sourceClass)
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) {
      promise.reject("TORRENT_QUERY_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun countTorrentCaptures(promise: Promise) {
    try { promise.resolve(db.countTorrentCaptures().toDouble()) }
    catch (e: Throwable) { promise.reject("TORRENT_COUNT_FAILED", e.message, e) }
  }

  @ReactMethod
  fun getTorrentRawFingerprintInRange(startMs: Double, endMs: Double, promise: Promise) {
    try {
      val fp = db.torrentRawFingerprintInRange(startMs.toLong(), endMs.toLong())
      promise.resolve(Arguments.createMap().apply {
        putDouble("count", fp.count.toDouble())
        putDouble("firstRowId", fp.firstRowId.toDouble())
        putDouble("lastRowId", fp.lastRowId.toDouble())
        putDouble("minEventTimeMs", fp.minEventTimeMs.toDouble())
        putDouble("maxEventTimeMs", fp.maxEventTimeMs.toDouble())
      })
    } catch (e: Throwable) {
      promise.reject("TORRENT_FINGERPRINT_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun getTorrentStats(promise: Promise) {
    try {
      val s = db.torrentStorageStats()
      promise.resolve(Arguments.createMap().apply {
        putDouble("rowCount", s.rowCount.toDouble())
        putDouble("rawBytes", s.rawBytes.toDouble())
        putDouble("databaseBytes", s.databaseBytes.toDouble())
        putInt("rawLimitMb", s.rawLimitMb)
        putDouble("appMonitorRowCount", s.appMonitorRowCount.toDouble())
        putDouble("appMonitorBytes", s.appMonitorBytes.toDouble())
        putDouble("formalActionCount", s.formalActionCount.toDouble())
        putDouble("formalActionBytes", s.formalActionBytes.toDouble())
        putDouble("formalCardCount", s.formalCardCount.toDouble())
        putDouble("formalCardBytes", s.formalCardBytes.toDouble())
      })
    } catch (e: Throwable) {
      promise.reject("TORRENT_STATS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun setTorrentRawLimitMb(rawLimitMb: Double, promise: Promise) {
    try {
      val normalized = db.setTorrentRawLimitMb(rawLimitMb.toInt())
      val pruned = db.pruneTorrentCapturesToRawLimit(normalized)
      promise.resolve(Arguments.createMap().apply {
        putInt("rawLimitMb", normalized)
        putDouble("deletedRows", pruned.deletedRows.toDouble())
        putInt("deletedDays", pruned.deletedDays)
        putDouble("rawBytesBefore", pruned.rawBytesBefore.toDouble())
        putDouble("rawBytesAfter", pruned.rawBytesAfter.toDouble())
      })
    } catch (e: Throwable) {
      promise.reject("TORRENT_LIMIT_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun clearTorrentCaptures(promise: Promise) {
    try { promise.resolve(db.clearTorrentCaptures().toDouble()) }
    catch (e: Throwable) { promise.reject("TORRENT_CLEAR_FAILED", e.message, e) }
  }

  @ReactMethod
  fun getTorrentFormalMaxSourceEndMs(dateKey: String, promise: Promise) {
    try { promise.resolve(db.torrentFormalMaxSourceEndMs(dateKey).toDouble()) }
    catch (e: Throwable) { promise.reject("TORRENT_FORMAL_RUN_QUERY_FAILED", e.message, e) }
  }

  @ReactMethod
  fun saveTorrentFormalDay(
    dateKey: String,
    parserId: String,
    parserVersion: Double,
    sourceStartMs: Double,
    sourceEndMs: Double,
    actionsJson: String,
    cardsJson: String,
    promise: Promise,
  ) {
    try {
      val r = db.saveTorrentFormalDay(
        dateKey = dateKey,
        parserId = parserId,
        parserVersion = parserVersion.toInt(),
        sourceStartMs = sourceStartMs.toLong(),
        sourceEndMs = sourceEndMs.toLong(),
        actionsJson = actionsJson,
        cardsJson = cardsJson,
      )
      promise.resolve(Arguments.createMap().apply {
        putInt("actionCount", r.actionCount)
        putInt("cardCount", r.cardCount)
      })
    } catch (e: Throwable) {
      promise.reject("TORRENT_FORMAL_SAVE_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun getTorrentFormalActionsInRange(startMs: Double, endMs: Double, limit: Double, promise: Promise) {
    try {
      val items = db.torrentFormalActionsInRange(startMs.toLong(), endMs.toLong(), limit.toInt())
      promise.resolve(torrentFormalActionsToArray(items))
    } catch (e: Throwable) {
      promise.reject("TORRENT_FORMAL_ACTIONS_QUERY_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun getTorrentFormalCardsInRange(startMs: Double, endMs: Double, limit: Double, promise: Promise) {
    try {
      val items = db.torrentFormalCardsInRange(startMs.toLong(), endMs.toLong(), limit.toInt())
      promise.resolve(torrentFormalCardsToArray(items))
    } catch (e: Throwable) {
      promise.reject("TORRENT_FORMAL_CARDS_QUERY_FAILED", e.message, e)
    }
  }

  companion object {
    const val NAME = "Perception"
  }

  private fun appMonitorSegmentsToArray(items: List<PerceptionDb.AppMonitorSegmentSnapshot>) =
    Arguments.createArray().apply {
      for (it in items) {
        val titles = Arguments.createArray()
        for (t in it.titles) titles.pushString(t)
        pushMap(Arguments.createMap().apply {
          putDouble("rowId", it.rowId.toDouble())
          putString("dateKey", it.dateKey)
          putString("kind", it.kind)
          putDouble("startMs", it.startMs.toDouble())
          putDouble("endMs", it.endMs.toDouble())
          putString("packageName", it.packageName)
          putString("className", it.className)
          putString("appLabel", it.appLabel)
          putString("windowTitle", it.windowTitle)
          putString("eventType", it.eventType)
          putInt("eventCount", it.eventCount)
          putArray("titles", titles)
        })
      }
    }

  private fun torrentFormalActionsToArray(items: List<PerceptionDb.TorrentFormalActionSnapshot>) =
    Arguments.createArray().apply {
      for (it in items) {
        pushMap(Arguments.createMap().apply {
          putDouble("rowId", it.rowId.toDouble())
          putString("dateKey", it.dateKey)
          putString("parserId", it.parserId)
          putInt("parserVersion", it.parserVersion)
          putString("key", it.key)
          putString("packageName", it.packageName)
          putString("appLabel", it.appLabel)
          putString("kind", it.kind)
          putDouble("startTs", it.startMs.toDouble())
          putDouble("endTs", it.endMs.toDouble())
          putString("title", it.title)
          putString("upName", it.upName)
          putBoolean("isStory", it.isStory)
          putString("payloadJson", it.payloadJson)
          putString("sourceRefsJson", it.sourceRefsJson)
        })
      }
    }

  private fun torrentFormalCardsToArray(items: List<PerceptionDb.TorrentFormalCardSnapshot>) =
    Arguments.createArray().apply {
      for (it in items) {
        pushMap(Arguments.createMap().apply {
          putDouble("rowId", it.rowId.toDouble())
          putString("dateKey", it.dateKey)
          putString("parserId", it.parserId)
          putInt("parserVersion", it.parserVersion)
          putString("key", it.key)
          putString("packageName", it.packageName)
          putString("appLabel", it.appLabel)
          putString("cardKind", it.cardKind)
          putDouble("startTs", it.startMs.toDouble())
          putDouble("endTs", it.endMs.toDouble())
          putString("title", it.title)
          putString("upName", it.upName)
          putString("payloadJson", it.payloadJson)
          putString("sourceRefsJson", it.sourceRefsJson)
        })
      }
    }
}
