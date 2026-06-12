package com.solevup.mobile.perception

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.File
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 感知层 SQLite 持久化（Android 端）。
 *
 * 设计对齐 desktop 的 `perception_buckets_windows` / `perception_events_windows`
 * （见 clients/desktop/src-tauri/src/db.rs），便于后续 LAN 同步时直接合表。
 *
 * 表命名后缀为 `_android`，与 desktop 的 `_windows` / `_macos` 平级。
 */
class PerceptionDb(context: Context) :
  SQLiteOpenHelper(context.applicationContext, migratedDbName(context.applicationContext), null, DB_VERSION) {

  private val appContext = context.applicationContext
  @Volatile private var lastTorrentPruneCheckMs: Long = 0L

  override fun onConfigure(db: SQLiteDatabase) {
    super.onConfigure(db)
    // Android SQLite 默认外键不强制；perception_events_android.bucket_id 有
    // ON DELETE CASCADE，开外键避免删 bucket 后 events 残留孤儿。
    db.setForeignKeyConstraintsEnabled(true)
  }

  override fun onOpen(db: SQLiteDatabase) {
    super.onOpen(db)
    migrateLegacyBucketIds(db)
  }

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS perception_buckets_android (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        hostname TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      """.trimIndent()
    )
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS perception_events_android (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket_id TEXT NOT NULL REFERENCES perception_buckets_android(id) ON DELETE CASCADE,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        data_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      """.trimIndent()
    )
    db.execSQL(
      "CREATE INDEX IF NOT EXISTS idx_perception_android_bucket_time " +
        "ON perception_events_android(bucket_id, start_at, end_at);"
    )
    db.execSQL(
      "CREATE INDEX IF NOT EXISTS idx_perception_android_time " +
        "ON perception_events_android(start_at, end_at);"
    )
    db.execSQL(
      "CREATE INDEX IF NOT EXISTS idx_perception_android_hash " +
        "ON perception_events_android(bucket_id, data_hash, end_at);"
    )

    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS app_catalog_android (
        app_key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        package_name TEXT,
        color TEXT NOT NULL,
        icon_png BLOB,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      """.trimIndent()
    )

    createTorrentTables(db)
    createAppMonitorTables(db)
  }

  /** "洪流域"raw 文本捕获：每次 a11y 抓到的文本都入库，调试期不做去重
   *  后期可加自动清理（如保留最近 N 天）。capture_type: a11y-view / a11y-click */
  private fun createTorrentTables(db: SQLiteDatabase) {
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS torrent_capture_android (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_time_ms INTEGER NOT NULL,
        package_name TEXT NOT NULL,
        window_class TEXT NOT NULL DEFAULT '',
        capture_type TEXT NOT NULL,
        text TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        source_class TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      """.trimIndent()
    )
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_torrent_time ON torrent_capture_android(event_time_ms);")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_torrent_pkg_time ON torrent_capture_android(package_name, event_time_ms);")
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS torrent_actions_android (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date_key TEXT NOT NULL,
        parser_id TEXT NOT NULL,
        parser_version INTEGER NOT NULL,
        action_key TEXT NOT NULL,
        package_name TEXT NOT NULL DEFAULT '',
        app_label TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        up_name TEXT NOT NULL DEFAULT '',
        is_story INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL DEFAULT '{}',
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      """.trimIndent()
    )
    db.execSQL(
      """
      CREATE UNIQUE INDEX IF NOT EXISTS idx_torrent_actions_unique
      ON torrent_actions_android(date_key, parser_id, action_key);
      """.trimIndent()
    )
    db.execSQL(
      "CREATE INDEX IF NOT EXISTS idx_torrent_actions_range " +
        "ON torrent_actions_android(date_key, start_ms, end_ms);"
    )
    db.execSQL(
      "CREATE INDEX IF NOT EXISTS idx_torrent_actions_parser " +
        "ON torrent_actions_android(parser_id, parser_version, start_ms);"
    )
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS torrent_cards_android (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date_key TEXT NOT NULL,
        parser_id TEXT NOT NULL,
        parser_version INTEGER NOT NULL,
        card_key TEXT NOT NULL,
        package_name TEXT NOT NULL DEFAULT '',
        app_label TEXT NOT NULL DEFAULT '',
        card_kind TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        up_name TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      """.trimIndent()
    )
    db.execSQL(
      """
      CREATE UNIQUE INDEX IF NOT EXISTS idx_torrent_cards_unique
      ON torrent_cards_android(date_key, parser_id, card_key);
      """.trimIndent()
    )
    db.execSQL(
      "CREATE INDEX IF NOT EXISTS idx_torrent_cards_range " +
        "ON torrent_cards_android(date_key, start_ms, end_ms);"
    )
    db.execSQL(
      "CREATE INDEX IF NOT EXISTS idx_torrent_cards_parser " +
        "ON torrent_cards_android(parser_id, parser_version, start_ms);"
    )
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS torrent_translate_runs_android (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date_key TEXT NOT NULL,
        parser_id TEXT NOT NULL,
        parser_version INTEGER NOT NULL,
        source_start_ms INTEGER NOT NULL,
        source_end_ms INTEGER NOT NULL,
        action_count INTEGER NOT NULL DEFAULT 0,
        card_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(date_key, parser_id)
      );
      """.trimIndent()
    )
    db.execSQL(
      "CREATE INDEX IF NOT EXISTS idx_torrent_translate_runs_date " +
        "ON torrent_translate_runs_android(date_key, parser_id, parser_version);"
    )
  }

  private fun createAppMonitorTables(db: SQLiteDatabase) {
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS app_monitor_segments_android (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        package_name TEXT NOT NULL DEFAULT '',
        class_name TEXT NOT NULL DEFAULT '',
        app_label TEXT NOT NULL DEFAULT '',
        window_title TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL DEFAULT '',
        event_count INTEGER NOT NULL DEFAULT 1,
        titles_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      """.trimIndent()
    )
    db.execSQL(
      "CREATE INDEX IF NOT EXISTS idx_app_monitor_date_start " +
        "ON app_monitor_segments_android(date_key, start_ms, end_ms);"
    )
    db.execSQL(
      "CREATE INDEX IF NOT EXISTS idx_app_monitor_kind_start " +
        "ON app_monitor_segments_android(kind, start_ms);"
    )
    db.execSQL(
      """
      CREATE UNIQUE INDEX IF NOT EXISTS idx_app_monitor_power_unique
      ON app_monitor_segments_android(kind, event_type, start_ms)
      WHERE kind = 'power';
      """.trimIndent()
    )
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    // AUDIT-034：增量迁移，保留 perception_events_android / perception_buckets_android
    // / app_catalog_android 历史数据，不再破坏式 DROP（v0.0.0.17 之前的 onUpgrade
    // 会清掉用户感知历史）。
    // v1 → v3：torrent_capture_android 当时还不存在，补建即可
    // v2 → v3：torrent_capture_android 已存在且 column 集合兼容（v2 阶段多过一个
    //   idx_torrent_dedupe 索引，新代码不依赖它、留着也无害），createTorrentTables
    //   的 IF NOT EXISTS 兜底不会破坏数据
    // v4 → v5：补建洪流域 action/card 正式转译表，只增表和索引。
    createTorrentTables(db)
    createAppMonitorTables(db)
  }

  /** 确保 bucket 存在；返回 bucket id。 */
  fun ensureBucket(
    id: String,
    kind: String,
    eventType: String,
    source: String,
    hostname: String = "",
  ): String {
    val now = nowIso()
    writableDatabase.execSQL(
      """
      INSERT INTO perception_buckets_android
        (id, kind, event_type, source, hostname, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind,
        event_type=excluded.event_type,
        source=excluded.source,
        hostname=excluded.hostname,
        updated_at=excluded.updated_at
      """.trimIndent(),
      arrayOf(id, kind, eventType, source, hostname, now, now),
    )
    return id
  }

  /** 写入一条事件；返回 rowid。dataHash 缺省为 dataJson 的 sha256 前 16 字节十六进制。 */
  fun insertEvent(
    bucketId: String,
    startAt: String,
    endAt: String,
    dataJson: String,
    dataHash: String? = null,
  ): Long {
    val hash = dataHash ?: sha256Short(dataJson)
    val cv = ContentValues().apply {
      put("bucket_id", bucketId)
      put("start_at", startAt)
      put("end_at", endAt)
      put("data_json", dataJson)
      put("data_hash", hash)
    }
    return writableDatabase.insertOrThrow("perception_events_android", null, cv)
  }

  /** 读最近一条 solevup-watcher-usage_android summary 事件，parse data_json 为 apps 列表。 */
  fun latestUsageSummary(): UsageSummarySnapshot? {
    val db = readableDatabase
    return db.rawQuery(
      """
      SELECT id, data_json FROM perception_events_android
      WHERE bucket_id = 'solevup-watcher-usage_android'
      ORDER BY id DESC LIMIT 1
      """.trimIndent(),
      null,
    ).use { c ->
      if (!c.moveToFirst()) return@use null
      val rowId = c.getLong(0)
      val raw = c.getString(1) ?: return@use null
      try {
        val obj = org.json.JSONObject(raw)
        val intervalEndMs = obj.optLong("interval_end_ms", 0L)
        val appsArr = obj.optJSONArray("apps") ?: org.json.JSONArray()
        val apps = ArrayList<UsageAppEntry>(appsArr.length())
        for (i in 0 until appsArr.length()) {
          val a = appsArr.getJSONObject(i)
          apps.add(
            UsageAppEntry(
              packageName = a.optString("package_name"),
              appLabel = a.optString("app_label"),
              totalTimeMs = a.optLong("total_time_ms", 0L),
              lastTimeUsed = a.optLong("last_time_used", 0L),
            )
          )
        }
        UsageSummarySnapshot(rowId, intervalEndMs, apps)
      } catch (_: Throwable) {
        null
      }
    }
  }

  /**
   * 按 [startMs, endMs) 时间区间查窗口事件，按 id 升序（时间正序，方便 UI 渲染 timeline）。
   * 时间字段比较走 `start_at`（UTC ISO 字符串），与 [nowIso] 同格式可直接 lex 比较。
   */
  fun windowEventsInRange(startMs: Long, endMs: Long, limit: Int): List<WindowEventSnapshot> {
    val db = readableDatabase
    val cap = limit.coerceIn(1, 5000)
    val out = ArrayList<WindowEventSnapshot>()
    val startIso = isoFmt.format(Date(startMs))
    val endIso = isoFmt.format(Date(endMs))
    db.rawQuery(
      """
      SELECT id, start_at, data_json FROM perception_events_android
      WHERE bucket_id = 'solevup-watcher-window_android'
        AND start_at >= ? AND start_at < ?
      ORDER BY id ASC LIMIT ?
      """.trimIndent(),
      arrayOf(startIso, endIso, cap.toString()),
    ).use { c ->
      while (c.moveToNext()) {
        val rowId = c.getLong(0)
        val startAt = c.getString(1) ?: ""
        val raw = c.getString(2) ?: continue
        try {
          val obj = org.json.JSONObject(raw)
          out.add(
            WindowEventSnapshot(
              rowId = rowId,
              startAt = startAt,
              packageName = obj.optString("package_name"),
              className = obj.optString("class_name"),
              appLabel = obj.optString("app_label"),
              windowTitle = obj.optString("window_title"),
              eventTimeMs = obj.optLong("event_time_ms", 0L),
            )
          )
        } catch (_: Throwable) {
          // ignore
        }
      }
    }
    if (out.isEmpty()) {
      queryAppMonitorSegments(startMs, endMs, cap, newestFirst = false)
        .asSequence()
        .filter { it.kind == "app" }
        .forEach {
          out.add(
            WindowEventSnapshot(
              rowId = it.rowId,
              startAt = isoFromMs(it.startMs),
              packageName = it.packageName,
              className = it.className,
              appLabel = it.appLabel,
              windowTitle = it.windowTitle,
              eventTimeMs = it.startMs,
            )
          )
        }
    }
    return out
  }

  /** 写入屏幕 / 解锁 / 感知服务事件（screen_on / screen_off / unlocked / service_started / service_stopped）。
   *  AUDIT-018: start_at/end_at 必须用真实 eventTimeMs 派生，不能用 nowIso()。
   *  否则异步 executor 排队、应用忙碌、跨过 span 结束边界时，真实落在 span
   *  内的事件因为写入时间在 span 外被 powerEventsInRange() 漏掉，影响"花了多久"。 */
  fun insertPowerEvent(event: String, eventTimeMs: Long) {
    if (event.isBlank() || event == "boot" || event == "shutdown") return
    savePowerSegment(writableDatabase, localDateKey(eventTimeMs), eventTimeMs, event)
  }

  fun insertSelfWindowEvent(
    packageName: String,
    className: String,
    appLabel: String,
    windowTitle: String,
    eventTimeMs: Long = System.currentTimeMillis(),
  ) {
    insertAppMonitorWindowEvent(packageName, className, appLabel, windowTitle, eventTimeMs)
  }

  fun insertAppMonitorWindowEvent(
    packageName: String,
    className: String,
    appLabel: String,
    windowTitle: String,
    eventTimeMs: Long = System.currentTimeMillis(),
  ): Boolean {
    if (isMonitorNoise(packageName, className, windowTitle)) return false
    val db = writableDatabase
    val dateKey = localDateKey(eventTimeMs)
    val dayEndMs = localDayStartMs(eventTimeMs) + DAY_MS
    db.beginTransaction()
    try {
      val latest = loadLastAppSegmentBefore(db, dateKey, Long.MAX_VALUE)
      val label = if (appLabel.isBlank()) packageName else appLabel
      if (latest != null && eventTimeMs >= latest.startMs && latest.endMs >= eventTimeMs) {
        if (latest.packageName == packageName) {
          latest.endMs = dayEndMs
          latest.className = className
          latest.appLabel = label
          latest.windowTitle = windowTitle
          latest.eventCount += 1
          appendCompactTitle(latest.titles, label, packageName, windowTitle)
          saveAppSegment(db, latest)
        } else {
          latest.endMs = eventTimeMs.coerceAtLeast(latest.startMs)
          saveAppSegment(db, latest)
          val next = AppSegmentDraft(
            id = null,
            dateKey = dateKey,
            startMs = eventTimeMs,
            endMs = dayEndMs,
            packageName = packageName,
            className = className,
            appLabel = label,
            windowTitle = windowTitle,
            eventCount = 1,
            titles = mutableListOf(),
          )
          appendCompactTitle(next.titles, label, packageName, windowTitle)
          saveAppSegment(db, next)
        }
      } else {
        val next = AppSegmentDraft(
          id = null,
          dateKey = dateKey,
          startMs = eventTimeMs,
          endMs = dayEndMs,
          packageName = packageName,
          className = className,
          appLabel = label,
          windowTitle = windowTitle,
          eventCount = 1,
          titles = mutableListOf(),
        )
        appendCompactTitle(next.titles, label, packageName, windowTitle)
        saveAppSegment(db, next)
      }
      db.setTransactionSuccessful()
      return true
    } finally {
      db.endTransaction()
    }
  }

  data class PowerEventSnapshot(
    val rowId: Long,
    val startAt: String,
    val event: String,
    val eventTimeMs: Long,
  )

  /** 区间内电源事件，按时间正序。 */
  fun powerEventsInRange(startMs: Long, endMs: Long, limit: Int): List<PowerEventSnapshot> {
    val db = readableDatabase
    val cap = limit.coerceIn(1, 2000)
    val out = ArrayList<PowerEventSnapshot>()
    val startIso = isoFmt.format(Date(startMs))
    val endIso = isoFmt.format(Date(endMs))
    db.rawQuery(
      """
      SELECT id, start_at, data_json FROM perception_events_android
      WHERE bucket_id = ?
        AND start_at >= ? AND start_at < ?
      ORDER BY id ASC LIMIT ?
      """.trimIndent(),
      arrayOf(POWER_BUCKET_ID, startIso, endIso, cap.toString()),
    ).use { c ->
      while (c.moveToNext()) {
        val rowId = c.getLong(0)
        val startAt = c.getString(1) ?: ""
        val raw = c.getString(2) ?: continue
        try {
          val obj = org.json.JSONObject(raw)
          out.add(
            PowerEventSnapshot(
              rowId = rowId,
              startAt = startAt,
              event = obj.optString("event"),
              eventTimeMs = obj.optLong("event_time_ms", 0L),
            ),
          )
        } catch (_: Throwable) {
          // ignore malformed
        }
      }
    }
    if (out.isEmpty()) {
      queryAppMonitorSegments(startMs, endMs, cap, newestFirst = false)
        .asSequence()
        .filter { it.kind == "power" }
        .forEach {
          out.add(
            PowerEventSnapshot(
              rowId = it.rowId,
              startAt = isoFromMs(it.startMs),
              event = it.eventType,
              eventTimeMs = it.startMs,
            )
          )
        }
    }
    return out
  }

  /** 一次性清掉所有 Solevup 自身的窗口事件 / 正式段（迁移用，新代码仅在 a11y 开启时写）。 */
  fun purgeSelfWindowEvents(): Int {
    val db = writableDatabase
    val ownPackage = appContext.packageName
    var deleted = 0
    db.rawQuery(
      """
      SELECT id FROM perception_events_android
      WHERE bucket_id = 'solevup-watcher-window_android'
        AND data_json LIKE ?
      """.trimIndent(),
      arrayOf("%\"package_name\":\"$ownPackage\"%"),
    ).use { c ->
      while (c.moveToNext()) {
        val id = c.getLong(0)
        deleted += db.delete("perception_events_android", "id = ?", arrayOf(id.toString()))
      }
    }
    deleted += db.delete(
      "app_monitor_segments_android",
      "kind = 'app' AND package_name = ?",
      arrayOf(ownPackage),
    )
    return deleted
  }

  /** 读最近 N 条窗口切换事件，按 id 倒序（最新在前）。 */
  fun recentWindowEvents(limit: Int): List<WindowEventSnapshot> {
    val db = readableDatabase
    val cap = limit.coerceIn(1, 500)
    val out = ArrayList<WindowEventSnapshot>(cap)
    db.rawQuery(
      """
      SELECT id, start_at, data_json FROM perception_events_android
      WHERE bucket_id = 'solevup-watcher-window_android'
      ORDER BY id DESC LIMIT ?
      """.trimIndent(),
      arrayOf(cap.toString()),
    ).use { c ->
      while (c.moveToNext()) {
        val rowId = c.getLong(0)
        val startAt = c.getString(1) ?: ""
        val raw = c.getString(2) ?: continue
        try {
          val obj = org.json.JSONObject(raw)
          out.add(
            WindowEventSnapshot(
              rowId = rowId,
              startAt = startAt,
              packageName = obj.optString("package_name"),
              className = obj.optString("class_name"),
              appLabel = obj.optString("app_label"),
              windowTitle = obj.optString("window_title"),
              eventTimeMs = obj.optLong("event_time_ms", 0L),
            )
          )
        } catch (_: Throwable) {
          // ignore malformed row
        }
      }
    }
    return out
  }

  /** 返回 (bucketCount, eventCount, dbAbsolutePath)。 */
  fun stats(): Triple<Long, Long, String> {
    val db = readableDatabase
    val bucketCount = db.rawQuery("SELECT COUNT(*) FROM perception_buckets_android", null)
      .use { c -> if (c.moveToFirst()) c.getLong(0) else 0L }
    val eventCount = db.rawQuery("SELECT COUNT(*) FROM perception_events_android", null)
      .use { c -> if (c.moveToFirst()) c.getLong(0) else 0L }
    return Triple(bucketCount, eventCount, db.path ?: "")
  }

  data class UsageAppEntry(
    val packageName: String,
    val appLabel: String,
    val totalTimeMs: Long,
    val lastTimeUsed: Long,
  )

  data class UsageSummarySnapshot(
    val rowId: Long,
    val intervalEndMs: Long,
    val apps: List<UsageAppEntry>,
  )

  data class WindowEventSnapshot(
    val rowId: Long,
    val startAt: String,
    val packageName: String,
    val className: String,
    val appLabel: String,
    val windowTitle: String,
    val eventTimeMs: Long,
  )

  data class AppMonitorSegmentSnapshot(
    val rowId: Long,
    val dateKey: String,
    val kind: String,
    val startMs: Long,
    val endMs: Long,
    val packageName: String,
    val className: String,
    val appLabel: String,
    val windowTitle: String,
    val eventType: String,
    val eventCount: Int,
    val titles: List<String>,
  )

  private data class AppSegmentDraft(
    var id: Long?,
    val dateKey: String,
    var startMs: Long,
    var endMs: Long,
    var packageName: String,
    var className: String,
    var appLabel: String,
    var windowTitle: String,
    var eventCount: Int,
    val titles: MutableList<String>,
  )

  fun appMonitorSegmentsInRange(startMs: Long, endMs: Long, limit: Int): List<AppMonitorSegmentSnapshot> {
    // 读取路径必须是纯索引查询。之前这里会先按天转译 raw，再查询正式段；
    // 当某天 raw 较多时，打开应用监控会卡在 native bridge 上，表现为长时间转圈。
    // raw → 正式段由写入侧触发；历史 raw 的补译应走显式后台任务，不能阻塞 UI 读取。
    return queryAppMonitorSegments(startMs, endMs, limit, newestFirst = false)
  }

  fun recentAppMonitorSegments(limit: Int): List<AppMonitorSegmentSnapshot> {
    // 同上：最近列表也不能在读取时补译所有 pending raw days。
    return queryAppMonitorSegments(0L, Long.MAX_VALUE, limit, newestFirst = true)
  }

  fun materializeAppMonitorRawForTimestamp(tsMs: Long) {
    materializeAppMonitorRawForDay(localDayStartMs(tsMs))
  }

  private fun materializeAppMonitorRawForRange(startMs: Long, endMs: Long) {
    if (endMs <= startMs) return
    var cursor = localDayStartMs(startMs)
    val last = localDayStartMs((endMs - 1).coerceAtLeast(startMs))
    while (cursor <= last) {
      materializeAppMonitorRawForDay(cursor)
      cursor += DAY_MS
    }
  }

  private fun materializePendingAppMonitorRawDays() {
    val days = ArrayList<Long>()
    readableDatabase.rawQuery(
      """
      SELECT DISTINCT date(
        CAST(json_extract(data_json, '$.event_time_ms') AS INTEGER) / 1000,
        'unixepoch',
        'localtime'
      ) AS day_key
      FROM perception_events_android
      WHERE bucket_id IN (?, ?)
      ORDER BY day_key DESC
      LIMIT 60
      """.trimIndent(),
      arrayOf(WINDOW_BUCKET_ID, POWER_BUCKET_ID),
    ).use { c ->
      while (c.moveToNext()) {
        parseLocalDayStartMs(c.getString(0) ?: "")?.let { days.add(it) }
      }
    }
    for (day in days) materializeAppMonitorRawForDay(day)
  }

  private fun materializeAppMonitorRawForDay(dayStartMs: Long) {
    val dayEndMs = dayStartMs + DAY_MS
    val dateKey = localDateKey(dayStartMs)
    val dayStartIso = isoFmt.format(Date(dayStartMs))
    val dayEndIso = isoFmt.format(Date(dayEndMs))
    val rawWindowMinMs = readableDatabase.rawQuery(
      """
      SELECT MIN(CAST(json_extract(data_json, '$.event_time_ms') AS INTEGER))
      FROM perception_events_android
      WHERE bucket_id = ?
        AND start_at >= ? AND start_at < ?
      """.trimIndent(),
      arrayOf(WINDOW_BUCKET_ID, dayStartIso, dayEndIso),
    ).use { c ->
      if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null
    }
    val rawPowerMinMs = readableDatabase.rawQuery(
      """
      SELECT MIN(CAST(json_extract(data_json, '$.event_time_ms') AS INTEGER))
      FROM perception_events_android
      WHERE bucket_id = ?
        AND start_at >= ? AND start_at < ?
      """.trimIndent(),
      arrayOf(POWER_BUCKET_ID, dayStartIso, dayEndIso),
    ).use { c ->
      if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null
    }
    if (rawWindowMinMs == null && rawPowerMinMs == null) return

    val db = writableDatabase
    db.beginTransaction()
    try {
      if (rawWindowMinMs != null) {
        db.delete(
          "app_monitor_segments_android",
          "date_key = ? AND kind = 'app' AND start_ms >= ?",
          arrayOf(dateKey, rawWindowMinMs.toString()),
        )
      }
      if (rawPowerMinMs != null) {
        db.delete(
          "app_monitor_segments_android",
          "date_key = ? AND kind = 'power' AND start_ms >= ?",
          arrayOf(dateKey, rawPowerMinMs.toString()),
        )
      }

      // 闭合点：screen_off / service_stopped 在该时刻截断当前段；
      // service_started 表示此前存在监控断档（服务被关时连 screen_off 都收不到），
      // 当前段闭合到最后一次已知事件时间，断档期不计入任何应用
      val cutoffs = ArrayList<Pair<Long, String>>()
      if (rawPowerMinMs != null) {
        db.rawQuery(
          """
          SELECT data_json
          FROM perception_events_android
          WHERE bucket_id = ?
            AND start_at >= ? AND start_at < ?
          ORDER BY start_at ASC, id ASC
          """.trimIndent(),
          arrayOf(POWER_BUCKET_ID, dayStartIso, dayEndIso),
        ).use { c ->
          while (c.moveToNext()) {
            val raw = c.getString(0) ?: continue
            val obj = try { org.json.JSONObject(raw) } catch (_: Throwable) { continue }
            val eventTimeMs = obj.optLong("event_time_ms", 0L)
            val event = obj.optString("event")
            if ((event == "screen_off" || event == "service_stopped" || event == "service_started") &&
              eventTimeMs >= dayStartMs && eventTimeMs < dayEndMs
            ) {
              cutoffs.add(eventTimeMs to event)
            }
          }
        }
      }

      var current = rawWindowMinMs?.let { loadLastAppSegmentBefore(db, dateKey, it) }
      var currentDirty = false
      var currentLastEventMs = current?.startMs ?: rawWindowMinMs ?: dayStartMs
      fun firstCutoffAfter(fromMs: Long, toMs: Long): Pair<Long, String>? =
        cutoffs.firstOrNull { it.first > fromMs && it.first <= toMs }
      fun cutoffCloseTs(cut: Pair<Long, String>, lastEventMs: Long): Long =
        if (cut.second == "service_started") lastEventMs else cut.first
      fun closeCurrentAt(tsMs: Long) {
        val draft = current ?: return
        draft.endMs = tsMs.coerceAtLeast(draft.startMs)
        saveAppSegment(db, draft)
        current = null
        currentDirty = false
        currentLastEventMs = tsMs
      }
      db.rawQuery(
        """
        SELECT data_json
        FROM perception_events_android
        WHERE bucket_id = ?
          AND start_at >= ? AND start_at < ?
        ORDER BY start_at ASC, id ASC
        """.trimIndent(),
        arrayOf(WINDOW_BUCKET_ID, dayStartIso, dayEndIso),
      ).use { c ->
        while (c.moveToNext()) {
          val raw = c.getString(0) ?: continue
          val obj = try { org.json.JSONObject(raw) } catch (_: Throwable) { continue }
          val eventTimeMs = obj.optLong("event_time_ms", 0L)
          if (rawWindowMinMs == null || eventTimeMs < rawWindowMinMs || eventTimeMs < dayStartMs || eventTimeMs >= dayEndMs) continue
          val packageName = obj.optString("package_name")
          val className = obj.optString("class_name")
          val appLabel = obj.optString("app_label")
          val windowTitle = obj.optString("window_title")
          if (isMonitorNoise(packageName, className, windowTitle)) continue

          if (current != null) {
            firstCutoffAfter(currentLastEventMs, eventTimeMs)?.let { closeCurrentAt(cutoffCloseTs(it, currentLastEventMs)) }
          }
          if (current != null && current!!.packageName == packageName) {
            val draft = current!!
            draft.endMs = dayEndMs
            draft.className = className
            draft.appLabel = if (appLabel.isBlank()) packageName else appLabel
            draft.windowTitle = windowTitle
            draft.eventCount += 1
            appendCompactTitle(draft.titles, draft.appLabel, packageName, windowTitle)
            currentDirty = true
          } else {
            if (current != null) {
              val draft = current!!
              draft.endMs = eventTimeMs.coerceAtLeast(draft.startMs)
              saveAppSegment(db, draft)
            }
            val label = if (appLabel.isBlank()) packageName else appLabel
            current = AppSegmentDraft(
              id = null,
              dateKey = dateKey,
              startMs = eventTimeMs,
              endMs = dayEndMs,
              packageName = packageName,
              className = className,
              appLabel = label,
              windowTitle = windowTitle,
              eventCount = 1,
              titles = mutableListOf(),
            )
            appendCompactTitle(current!!.titles, label, packageName, windowTitle)
            currentDirty = true
          }
          currentLastEventMs = eventTimeMs
        }
      }
      if (current != null && currentDirty) {
        firstCutoffAfter(currentLastEventMs, dayEndMs)?.let {
          current!!.endMs = cutoffCloseTs(it, currentLastEventMs).coerceAtLeast(current!!.startMs)
        }
        saveAppSegment(db, current!!)
      }

      db.rawQuery(
        """
        SELECT data_json
        FROM perception_events_android
        WHERE bucket_id = ?
          AND start_at >= ? AND start_at < ?
        ORDER BY start_at ASC, id ASC
        """.trimIndent(),
        arrayOf(POWER_BUCKET_ID, dayStartIso, dayEndIso),
      ).use { c ->
        while (c.moveToNext()) {
          val raw = c.getString(0) ?: continue
          val obj = try { org.json.JSONObject(raw) } catch (_: Throwable) { continue }
          val eventTimeMs = obj.optLong("event_time_ms", 0L)
          if (rawPowerMinMs == null || eventTimeMs < rawPowerMinMs || eventTimeMs < dayStartMs || eventTimeMs >= dayEndMs) continue
          val event = obj.optString("event")
          if (event.isBlank() || event == "boot" || event == "shutdown") continue
          savePowerSegment(db, dateKey, eventTimeMs, event)
        }
      }

      db.delete(
        "perception_events_android",
        "bucket_id IN (?, ?) AND start_at >= ? AND start_at < ?",
        arrayOf(WINDOW_BUCKET_ID, POWER_BUCKET_ID, dayStartIso, dayEndIso),
      )
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  private fun queryAppMonitorSegments(
    startMs: Long,
    endMs: Long,
    limit: Int,
    newestFirst: Boolean,
  ): List<AppMonitorSegmentSnapshot> {
    val cap = limit.coerceIn(1, 100000)
    val out = ArrayList<AppMonitorSegmentSnapshot>()
    val where = if (startMs <= 0L && endMs == Long.MAX_VALUE) {
      "1 = 1"
    } else {
      "end_ms > ? AND start_ms < ?"
    }
    val args = if (startMs <= 0L && endMs == Long.MAX_VALUE) {
      arrayOf(cap.toString())
    } else {
      arrayOf(startMs.toString(), endMs.toString(), cap.toString())
    }
    val order = if (newestFirst) "start_ms DESC, id DESC" else "start_ms ASC, id ASC"
    readableDatabase.rawQuery(
      """
      SELECT id, date_key, kind, start_ms, end_ms, package_name, class_name, app_label,
        window_title, event_type, event_count, titles_json
      FROM app_monitor_segments_android
      WHERE $where
      ORDER BY $order
      LIMIT ?
      """.trimIndent(),
      args,
    ).use { c ->
      while (c.moveToNext()) {
        out.add(
          AppMonitorSegmentSnapshot(
            rowId = c.getLong(0),
            dateKey = c.getString(1),
            kind = c.getString(2),
            startMs = c.getLong(3),
            endMs = c.getLong(4),
            packageName = c.getString(5),
            className = c.getString(6),
            appLabel = c.getString(7),
            windowTitle = c.getString(8),
            eventType = c.getString(9),
            eventCount = c.getInt(10),
            titles = parseTitlesJson(c.getString(11)),
          )
        )
      }
    }
    return out
  }

  private fun loadLastAppSegmentBefore(db: SQLiteDatabase, dateKey: String, beforeMs: Long): AppSegmentDraft? {
    return db.rawQuery(
      """
      SELECT id, start_ms, end_ms, package_name, class_name, app_label, window_title, event_count, titles_json
      FROM app_monitor_segments_android
      WHERE date_key = ? AND kind = 'app' AND start_ms < ?
      ORDER BY start_ms DESC, id DESC
      LIMIT 1
      """.trimIndent(),
      arrayOf(dateKey, beforeMs.toString()),
    ).use { c ->
      if (!c.moveToFirst()) return@use null
      AppSegmentDraft(
        id = c.getLong(0),
        dateKey = dateKey,
        startMs = c.getLong(1),
        endMs = c.getLong(2),
        packageName = c.getString(3),
        className = c.getString(4),
        appLabel = c.getString(5),
        windowTitle = c.getString(6),
        eventCount = c.getInt(7),
        titles = parseTitlesJson(c.getString(8)).toMutableList(),
      )
    }
  }

  private fun saveAppSegment(db: SQLiteDatabase, draft: AppSegmentDraft) {
    val now = nowIso()
    val cv = ContentValues().apply {
      put("date_key", draft.dateKey)
      put("kind", "app")
      put("start_ms", draft.startMs)
      put("end_ms", draft.endMs.coerceAtLeast(draft.startMs))
      put("package_name", draft.packageName)
      put("class_name", draft.className)
      put("app_label", draft.appLabel)
      put("window_title", draft.windowTitle)
      put("event_type", "")
      put("event_count", draft.eventCount.coerceAtLeast(1))
      put("titles_json", titlesToJson(draft.titles))
      put("updated_at", now)
    }
    val id = draft.id
    if (id != null) {
      db.update("app_monitor_segments_android", cv, "id = ?", arrayOf(id.toString()))
    } else {
      cv.put("created_at", now)
      draft.id = db.insertOrThrow("app_monitor_segments_android", null, cv)
    }
  }

  private fun savePowerSegment(db: SQLiteDatabase, dateKey: String, eventTimeMs: Long, event: String) {
    if (event == "screen_off") truncateCurrentAppSegmentAt(db, dateKey, eventTimeMs)
    val now = nowIso()
    val cv = ContentValues().apply {
      put("date_key", dateKey)
      put("kind", "power")
      put("start_ms", eventTimeMs)
      put("end_ms", eventTimeMs)
      put("package_name", "")
      put("class_name", "")
      put("app_label", "")
      put("window_title", "")
      put("event_type", event)
      put("event_count", 1)
      put("titles_json", "[]")
      put("created_at", now)
      put("updated_at", now)
    }
    db.insertWithOnConflict("app_monitor_segments_android", null, cv, SQLiteDatabase.CONFLICT_IGNORE)
  }

  private fun truncateCurrentAppSegmentAt(db: SQLiteDatabase, dateKey: String, eventTimeMs: Long) {
    val latest = loadLastAppSegmentBefore(db, dateKey, eventTimeMs + 1L) ?: return
    if (latest.startMs >= eventTimeMs || latest.endMs <= eventTimeMs) return
    latest.endMs = eventTimeMs
    saveAppSegment(db, latest)
  }

  private fun appendCompactTitle(titles: MutableList<String>, appLabel: String, packageName: String, rawTitle: String) {
    val title = rawTitle.trim()
    if (title.isBlank() || title == appLabel || title == packageName) return
    if (titles.lastOrNull() == title) return
    titles.add(title)
  }

  private fun parseTitlesJson(raw: String?): List<String> {
    if (raw.isNullOrBlank()) return emptyList()
    return try {
      val arr = org.json.JSONArray(raw)
      val out = ArrayList<String>(arr.length())
      for (i in 0 until arr.length()) {
        val v = arr.optString(i).trim()
        if (v.isNotBlank()) out.add(v)
      }
      out
    } catch (_: Throwable) {
      emptyList()
    }
  }

  private fun titlesToJson(titles: List<String>): String {
    val arr = org.json.JSONArray()
    for (t in titles.takeLast(16)) arr.put(t)
    return arr.toString()
  }

  private fun parseJsonArray(raw: String?): org.json.JSONArray {
    if (raw.isNullOrBlank()) return org.json.JSONArray()
    return try {
      org.json.JSONArray(raw)
    } catch (_: Throwable) {
      org.json.JSONArray()
    }
  }

  private fun optJsonLong(obj: org.json.JSONObject, key: String, fallback: Long): Long {
    if (!obj.has(key) || obj.isNull(key)) return fallback
    return try {
      obj.optDouble(key, fallback.toDouble()).toLong()
    } catch (_: Throwable) {
      fallback
    }
  }

  private fun jsonValueToString(value: Any?, fallback: String): String {
    if (value == null || value == org.json.JSONObject.NULL) return fallback
    val raw = value.toString()
    return raw.ifBlank { fallback }
  }

  private fun isMonitorNoise(packageName: String, className: String, windowTitle: String): Boolean {
    val title = windowTitle.trim()
    if (packageName.isBlank()) return true
    if (packageName == "com.android.systemui" || packageName == "com.coloros.smartsidebar") return true
    if (packageName.contains("inputmethod") || className.contains("inputmethodservice.SoftInputWindow")) return true
    if (packageName == "com.android.launcher") {
      if (title.contains("最近用过的应用") || title.startsWith("文件夹已") || title == "应用图标") return true
    }
    return title == "应用图标"
  }

  data class TorrentCaptureSnapshot(
    val rowId: Long,
    val eventTimeMs: Long,
    val packageName: String,
    val windowClass: String,
    val captureType: String,
    val text: String,
    val textHash: String,
    val sourceClass: String,
  )

  data class TorrentFormalSaveResult(
    val actionCount: Int,
    val cardCount: Int,
  )

  data class TorrentRawFingerprintSnapshot(
    val count: Long,
    val firstRowId: Long,
    val lastRowId: Long,
    val minEventTimeMs: Long,
    val maxEventTimeMs: Long,
  )

  data class TorrentFormalActionSnapshot(
    val rowId: Long,
    val dateKey: String,
    val parserId: String,
    val parserVersion: Int,
    val key: String,
    val packageName: String,
    val appLabel: String,
    val kind: String,
    val startMs: Long,
    val endMs: Long,
    val title: String,
    val upName: String,
    val isStory: Boolean,
    val payloadJson: String,
    val sourceRefsJson: String,
  )

  data class TorrentFormalCardSnapshot(
    val rowId: Long,
    val dateKey: String,
    val parserId: String,
    val parserVersion: Int,
    val key: String,
    val packageName: String,
    val appLabel: String,
    val cardKind: String,
    val startMs: Long,
    val endMs: Long,
    val title: String,
    val upName: String,
    val payloadJson: String,
    val sourceRefsJson: String,
  )

  /** raw 文本捕获插入：调试期不做去重，每次抓到都入库
   *  text_hash 还是计算保留（后续 UI / 分析可用），但不再用作去重 key */
  fun insertTorrentCapture(
    eventTimeMs: Long,
    packageName: String,
    windowClass: String,
    captureType: String,
    text: String,
    sourceClass: String,
  ): Boolean {
    if (text.isBlank()) return false
    val hash = sha256Short(text)
    val db = writableDatabase
    val cv = ContentValues().apply {
      put("event_time_ms", eventTimeMs)
      put("package_name", packageName)
      put("window_class", windowClass)
      put("capture_type", captureType)
      put("text", text)
      put("text_hash", hash)
      put("source_class", sourceClass)
    }
    db.insertOrThrow("torrent_capture_android", null, cv)
    maybePruneTorrentCaptures(eventTimeMs)
    return true
  }

  /** 按时间区间倒序返回，最多 limit 条 */
  fun torrentCapturesInRange(startMs: Long, endMs: Long, limit: Int): List<TorrentCaptureSnapshot> {
    val db = readableDatabase
    val cap = limit.coerceIn(1, 500000)
    val out = ArrayList<TorrentCaptureSnapshot>()
    db.rawQuery(
      """
      SELECT id, event_time_ms, package_name, window_class, capture_type, text, text_hash, source_class
      FROM torrent_capture_android
      WHERE event_time_ms >= ? AND event_time_ms < ?
      ORDER BY event_time_ms DESC
      LIMIT ?
      """.trimIndent(),
      arrayOf(startMs.toString(), endMs.toString(), cap.toString()),
    ).use { c ->
      while (c.moveToNext()) {
        out.add(TorrentCaptureSnapshot(
          rowId = c.getLong(0),
          eventTimeMs = c.getLong(1),
          packageName = c.getString(2),
          windowClass = c.getString(3),
          captureType = c.getString(4),
          text = c.getString(5),
          textHash = c.getString(6),
          sourceClass = c.getString(7),
        ))
      }
    }
    return out
  }

  /** 最近 N 条（任意 package），调试 / 时间线倒序 */
  fun recentTorrentCaptures(limit: Int): List<TorrentCaptureSnapshot> {
    val db = readableDatabase
    val cap = limit.coerceIn(1, 50000)
    val out = ArrayList<TorrentCaptureSnapshot>()
    db.rawQuery(
      """
      SELECT id, event_time_ms, package_name, window_class, capture_type, text, text_hash, source_class
      FROM torrent_capture_android
      ORDER BY event_time_ms DESC
      LIMIT ?
      """.trimIndent(),
      arrayOf(cap.toString()),
    ).use { c ->
      while (c.moveToNext()) {
        out.add(TorrentCaptureSnapshot(
          rowId = c.getLong(0),
          eventTimeMs = c.getLong(1),
          packageName = c.getString(2),
          windowClass = c.getString(3),
          captureType = c.getString(4),
          text = c.getString(5),
          textHash = c.getString(6),
          sourceClass = c.getString(7),
        ))
      }
    }
    return out
  }

  fun torrentRawFingerprintInRange(startMs: Long, endMs: Long): TorrentRawFingerprintSnapshot {
    return readableDatabase.rawQuery(
      """
      SELECT COUNT(*), MIN(id), MAX(id), MIN(event_time_ms), MAX(event_time_ms)
      FROM torrent_capture_android
      WHERE event_time_ms >= ? AND event_time_ms < ?
      """.trimIndent(),
      arrayOf(startMs.toString(), endMs.toString()),
    ).use { c ->
      if (!c.moveToFirst() || c.isNull(0) || c.getLong(0) <= 0L) {
        return@use TorrentRawFingerprintSnapshot(0L, 0L, 0L, 0L, 0L)
      }
      TorrentRawFingerprintSnapshot(
        count = c.getLong(0),
        firstRowId = if (c.isNull(1)) 0L else c.getLong(1),
        lastRowId = if (c.isNull(2)) 0L else c.getLong(2),
        minEventTimeMs = if (c.isNull(3)) 0L else c.getLong(3),
        maxEventTimeMs = if (c.isNull(4)) 0L else c.getLong(4),
      )
    }
  }

  fun torrentFormalMaxSourceEndMs(dateKey: String): Long {
    return readableDatabase.rawQuery(
      """
      SELECT MAX(source_end_ms)
      FROM torrent_translate_runs_android
      WHERE date_key = ?
      """.trimIndent(),
      arrayOf(dateKey.trim()),
    ).use { c ->
      if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else 0L
    }
  }

  fun saveTorrentFormalDay(
    dateKey: String,
    parserId: String,
    parserVersion: Int,
    sourceStartMs: Long,
    sourceEndMs: Long,
    actionsJson: String,
    cardsJson: String,
  ): TorrentFormalSaveResult {
    val normalizedDateKey = dateKey.trim()
    val normalizedParserId = parserId.trim().ifBlank { "unknown" }
    if (normalizedDateKey.isBlank()) {
      throw IllegalArgumentException("dateKey is required")
    }
    val actions = parseJsonArray(actionsJson)
    val cards = parseJsonArray(cardsJson)
    val db = writableDatabase
    val now = nowIso()
    var actionCount = 0
    var cardCount = 0

    db.beginTransaction()
    try {
      // 同一天同 parser 只保留最新一次转译结果，raw 可删但正式表稳定。
      db.delete(
        "torrent_actions_android",
        "date_key = ? AND parser_id = ?",
        arrayOf(normalizedDateKey, normalizedParserId),
      )
      db.delete(
        "torrent_cards_android",
        "date_key = ? AND parser_id = ?",
        arrayOf(normalizedDateKey, normalizedParserId),
      )

      for (i in 0 until actions.length()) {
        val obj = actions.optJSONObject(i) ?: continue
        val actionKey = obj.optString("key").trim().ifBlank { "$normalizedParserId-action-$i" }
        val startMs = optJsonLong(obj, "startTs", sourceStartMs)
        val endMs = optJsonLong(obj, "endTs", startMs).coerceAtLeast(startMs)
        val cv = ContentValues().apply {
          put("date_key", normalizedDateKey)
          put("parser_id", normalizedParserId)
          put("parser_version", parserVersion)
          put("action_key", actionKey)
          put("package_name", obj.optString("packageName"))
          put("app_label", obj.optString("appLabel"))
          put("kind", obj.optString("kind").trim().ifBlank { "unknown" })
          put("start_ms", startMs)
          put("end_ms", endMs)
          put("title", obj.optString("title"))
          put("up_name", obj.optString("upName"))
          put("is_story", if (obj.optBoolean("isStory", false)) 1 else 0)
          put("payload_json", jsonValueToString(obj.opt("payload"), "{}"))
          put("source_refs_json", jsonValueToString(obj.opt("sourceRefs"), "[]"))
          put("created_at", now)
          put("updated_at", now)
        }
        db.insertWithOnConflict("torrent_actions_android", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
        actionCount++
      }

      for (i in 0 until cards.length()) {
        val obj = cards.optJSONObject(i) ?: continue
        val cardKey = obj.optString("key").trim().ifBlank { "$normalizedParserId-card-$i" }
        val startMs = optJsonLong(obj, "startTs", sourceStartMs)
        val endMs = optJsonLong(obj, "endTs", startMs).coerceAtLeast(startMs)
        val cv = ContentValues().apply {
          put("date_key", normalizedDateKey)
          put("parser_id", normalizedParserId)
          put("parser_version", parserVersion)
          put("card_key", cardKey)
          put("package_name", obj.optString("packageName"))
          put("app_label", obj.optString("appLabel"))
          put("card_kind", obj.optString("cardKind").trim().ifBlank { "unknown" })
          put("start_ms", startMs)
          put("end_ms", endMs)
          put("title", obj.optString("title"))
          put("up_name", obj.optString("upName"))
          put("payload_json", jsonValueToString(obj.opt("payload"), "{}"))
          put("source_refs_json", jsonValueToString(obj.opt("sourceRefs"), "[]"))
          put("created_at", now)
          put("updated_at", now)
        }
        db.insertWithOnConflict("torrent_cards_android", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
        cardCount++
      }

      val run = ContentValues().apply {
        put("date_key", normalizedDateKey)
        put("parser_id", normalizedParserId)
        put("parser_version", parserVersion)
        put("source_start_ms", sourceStartMs)
        put("source_end_ms", sourceEndMs.coerceAtLeast(sourceStartMs))
        put("action_count", actionCount)
        put("card_count", cardCount)
        put("created_at", now)
        put("updated_at", now)
      }
      db.insertWithOnConflict("torrent_translate_runs_android", null, run, SQLiteDatabase.CONFLICT_REPLACE)
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
    return TorrentFormalSaveResult(actionCount, cardCount)
  }

  fun torrentFormalActionsInRange(startMs: Long, endMs: Long, limit: Int): List<TorrentFormalActionSnapshot> {
    val cap = limit.coerceIn(1, 100000)
    val out = ArrayList<TorrentFormalActionSnapshot>()
    readableDatabase.rawQuery(
      """
      SELECT id, date_key, parser_id, parser_version, action_key, package_name, app_label,
        kind, start_ms, end_ms, title, up_name, is_story, payload_json, source_refs_json
      FROM torrent_actions_android
      WHERE end_ms >= ? AND start_ms < ?
      ORDER BY start_ms DESC, id DESC
      LIMIT ?
      """.trimIndent(),
      arrayOf(startMs.toString(), endMs.toString(), cap.toString()),
    ).use { c ->
      while (c.moveToNext()) {
        out.add(TorrentFormalActionSnapshot(
          rowId = c.getLong(0),
          dateKey = c.getString(1),
          parserId = c.getString(2),
          parserVersion = c.getInt(3),
          key = c.getString(4),
          packageName = c.getString(5),
          appLabel = c.getString(6),
          kind = c.getString(7),
          startMs = c.getLong(8),
          endMs = c.getLong(9),
          title = c.getString(10),
          upName = c.getString(11),
          isStory = c.getInt(12) != 0,
          payloadJson = c.getString(13),
          sourceRefsJson = c.getString(14),
        ))
      }
    }
    return out
  }

  fun torrentFormalCardsInRange(startMs: Long, endMs: Long, limit: Int): List<TorrentFormalCardSnapshot> {
    val cap = limit.coerceIn(1, 100000)
    val out = ArrayList<TorrentFormalCardSnapshot>()
    readableDatabase.rawQuery(
      """
      SELECT id, date_key, parser_id, parser_version, card_key, package_name, app_label,
        card_kind, start_ms, end_ms, title, up_name, payload_json, source_refs_json
      FROM torrent_cards_android
      WHERE end_ms >= ? AND start_ms < ?
      ORDER BY start_ms DESC, id DESC
      LIMIT ?
      """.trimIndent(),
      arrayOf(startMs.toString(), endMs.toString(), cap.toString()),
    ).use { c ->
      while (c.moveToNext()) {
        out.add(TorrentFormalCardSnapshot(
          rowId = c.getLong(0),
          dateKey = c.getString(1),
          parserId = c.getString(2),
          parserVersion = c.getInt(3),
          key = c.getString(4),
          packageName = c.getString(5),
          appLabel = c.getString(6),
          cardKind = c.getString(7),
          startMs = c.getLong(8),
          endMs = c.getLong(9),
          title = c.getString(10),
          upName = c.getString(11),
          payloadJson = c.getString(12),
          sourceRefsJson = c.getString(13),
        ))
      }
    }
    return out
  }

  fun countTorrentCaptures(): Long {
    return readableDatabase.rawQuery("SELECT COUNT(*) FROM torrent_capture_android", null).use { c ->
      if (c.moveToFirst()) c.getLong(0) else 0L
    }
  }

  data class TorrentStorageStats(
    val rowCount: Long,
    val rawBytes: Long,
    val databaseBytes: Long,
    val rawLimitMb: Int,
    val appMonitorRowCount: Long,
    val appMonitorBytes: Long,
    val formalActionCount: Long,
    val formalActionBytes: Long,
    val formalCardCount: Long,
    val formalCardBytes: Long,
  )

  fun torrentStorageStats(): TorrentStorageStats {
    val db = readableDatabase
    val (rowCount, rawBytes) = db.rawQuery(
      """
      SELECT COUNT(*),
        COALESCE(SUM(
          COALESCE(LENGTH(CAST(package_name AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(window_class AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(capture_type AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(text AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(text_hash AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(source_class AS BLOB)), 0)
        ), 0)
      FROM torrent_capture_android
      """.trimIndent(),
      null,
    ).use { c ->
      if (c.moveToFirst()) Pair(c.getLong(0), c.getLong(1)) else Pair(0L, 0L)
    }
    val databaseBytes = try {
      val p = db.path
      if (p.isNullOrBlank()) 0L else File(p).length()
    } catch (_: Throwable) {
      0L
    }
    val appMonitorUsage = appMonitorStorageUsage(db)
    val formalActionUsage = torrentFormalActionStorageUsage(db)
    val formalCardUsage = torrentFormalCardStorageUsage(db)
    return TorrentStorageStats(
      rowCount = rowCount,
      rawBytes = rawBytes,
      databaseBytes = databaseBytes,
      rawLimitMb = torrentRawLimitMb(),
      appMonitorRowCount = appMonitorUsage.rowCount,
      appMonitorBytes = appMonitorUsage.bytes,
      formalActionCount = formalActionUsage.rowCount,
      formalActionBytes = formalActionUsage.bytes,
      formalCardCount = formalCardUsage.rowCount,
      formalCardBytes = formalCardUsage.bytes,
    )
  }

  private data class TableUsage(val rowCount: Long, val bytes: Long)

  private fun appMonitorStorageUsage(db: SQLiteDatabase): TableUsage {
    return db.rawQuery(
      """
      SELECT COUNT(*),
        COALESCE(SUM(
          COALESCE(LENGTH(CAST(date_key AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(kind AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(package_name AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(class_name AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(app_label AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(window_title AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(event_type AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(titles_json AS BLOB)), 0)
        ), 0)
      FROM app_monitor_segments_android
      """.trimIndent(),
      null,
    ).use { c ->
      if (c.moveToFirst()) TableUsage(c.getLong(0), c.getLong(1)) else TableUsage(0L, 0L)
    }
  }

  private fun torrentFormalActionStorageUsage(db: SQLiteDatabase): TableUsage {
    return db.rawQuery(
      """
      SELECT COUNT(*),
        COALESCE(SUM(
          COALESCE(LENGTH(CAST(date_key AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(parser_id AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(action_key AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(package_name AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(app_label AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(kind AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(title AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(up_name AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(payload_json AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(source_refs_json AS BLOB)), 0)
        ), 0)
      FROM torrent_actions_android
      """.trimIndent(),
      null,
    ).use { c ->
      if (c.moveToFirst()) TableUsage(c.getLong(0), c.getLong(1)) else TableUsage(0L, 0L)
    }
  }

  private fun torrentFormalCardStorageUsage(db: SQLiteDatabase): TableUsage {
    return db.rawQuery(
      """
      SELECT COUNT(*),
        COALESCE(SUM(
          COALESCE(LENGTH(CAST(date_key AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(parser_id AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(card_key AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(package_name AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(app_label AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(card_kind AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(title AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(up_name AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(payload_json AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(source_refs_json AS BLOB)), 0)
        ), 0)
      FROM torrent_cards_android
      """.trimIndent(),
      null,
    ).use { c ->
      if (c.moveToFirst()) TableUsage(c.getLong(0), c.getLong(1)) else TableUsage(0L, 0L)
    }
  }

  data class TorrentPruneResult(
    val deletedRows: Long,
    val deletedDays: Int,
    val rawBytesBefore: Long,
    val rawBytesAfter: Long,
  )

  private data class TorrentDayUsage(
    val dayKey: String,
    val rowCount: Long,
    val rawBytes: Long,
  )

  fun torrentRawLimitMb(): Int {
    return prefs().getInt(PREF_TORRENT_RAW_LIMIT_MB, DEFAULT_TORRENT_RAW_LIMIT_MB)
  }

  fun setTorrentRawLimitMb(rawLimitMb: Int): Int {
    val normalized = normalizeTorrentRawLimitMb(rawLimitMb)
    prefs().edit().putInt(PREF_TORRENT_RAW_LIMIT_MB, normalized).apply()
    return normalized
  }

  fun pruneTorrentCapturesToRawLimit(rawLimitMb: Int = torrentRawLimitMb()): TorrentPruneResult {
    val limitMb = normalizeTorrentRawLimitMb(rawLimitMb)
    if (limitMb <= 0) {
      val before = torrentRawBytes()
      return TorrentPruneResult(0L, 0, before, before)
    }
    val limitBytes = limitMb.toLong() * 1024L * 1024L
    val beforeDays = torrentDayUsages()
    val beforeBytes = beforeDays.sumOf { it.rawBytes }
    if (beforeBytes <= limitBytes || beforeDays.size <= 1) {
      return TorrentPruneResult(0L, 0, beforeBytes, beforeBytes)
    }

    var projectedBytes = beforeBytes
    val deleteDays = ArrayList<String>()
    // 保留最新一天：如果当天 raw 自己超过上限，也不要清掉用户正在记录的上下文。
    for (i in 0 until beforeDays.size - 1) {
      if (projectedBytes <= limitBytes) break
      val d = beforeDays[i]
      deleteDays.add(d.dayKey)
      projectedBytes -= d.rawBytes
    }
    if (deleteDays.isEmpty()) return TorrentPruneResult(0L, 0, beforeBytes, beforeBytes)

    val db = writableDatabase
    var deletedRows = 0L
    db.beginTransaction()
    try {
      for (day in deleteDays) {
        deletedRows += db.delete(
          "torrent_capture_android",
          "date(event_time_ms / 1000, 'unixepoch', 'localtime') = ?",
          arrayOf(day),
        ).toLong()
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
    try {
      db.execSQL("VACUUM")
    } catch (_: Throwable) {
      // 删除已经完成；VACUUM 失败只影响文件回收，不影响上限语义。
    }
    val afterBytes = torrentRawBytes()
    return TorrentPruneResult(deletedRows, deleteDays.size, beforeBytes, afterBytes)
  }

  private fun maybePruneTorrentCaptures(nowMs: Long) {
    val limitMb = torrentRawLimitMb()
    if (limitMb <= 0) return
    if (nowMs - lastTorrentPruneCheckMs < TORRENT_PRUNE_CHECK_INTERVAL_MS) return
    lastTorrentPruneCheckMs = nowMs
    try {
      pruneTorrentCapturesToRawLimit(limitMb)
    } catch (_: Throwable) {
      // a11y 写入路径不能因为清理失败中断。
    }
  }

  private fun prefs() = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  private fun normalizeTorrentRawLimitMb(rawLimitMb: Int): Int {
    if (rawLimitMb <= 0) return 0
    return rawLimitMb.coerceIn(MIN_TORRENT_RAW_LIMIT_MB, MAX_TORRENT_RAW_LIMIT_MB)
  }

  private fun torrentRawBytes(): Long = torrentDayUsages().sumOf { it.rawBytes }

  private fun torrentDayUsages(): List<TorrentDayUsage> {
    val db = readableDatabase
    val out = ArrayList<TorrentDayUsage>()
    db.rawQuery(
      """
      SELECT date(event_time_ms / 1000, 'unixepoch', 'localtime') AS day_key,
        COUNT(*),
        COALESCE(SUM(
          COALESCE(LENGTH(CAST(package_name AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(window_class AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(capture_type AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(text AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(text_hash AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(source_class AS BLOB)), 0)
        ), 0) AS raw_bytes
      FROM torrent_capture_android
      GROUP BY day_key
      ORDER BY MIN(event_time_ms) ASC
      """.trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        out.add(TorrentDayUsage(
          dayKey = c.getString(0),
          rowCount = c.getLong(1),
          rawBytes = c.getLong(2),
        ))
      }
    }
    return out
  }

  /** 清空所有 raw 文本捕获 */
  fun clearTorrentCaptures(): Int {
    val db = writableDatabase
    val deleted = db.delete("torrent_capture_android", null, null)
    // 清空是低频显式操作，顺手 VACUUM 回收 raw 文本占用的 DB 文件空间。
    try {
      db.execSQL("VACUUM")
    } catch (_: Throwable) {
      // 清空结果优先返回；VACUUM 失败只影响文件回收，不影响数据删除。
    }
    return deleted
  }

  companion object {
    const val DEDUP_WINDOW_MS = 5 * 60 * 1000L  // 5 分钟去重窗
    private const val DB_NAME = "solevup_perception.db"
    private val LEGACY_DB_NAMES = listOf("perception.db")
    private const val DB_VERSION = 5
    private const val DAY_MS = 24L * 60L * 60L * 1000L
    private const val PREFS_NAME = "solevup_perception"
    private const val PREF_TORRENT_RAW_LIMIT_MB = "torrent_raw_limit_mb"
    private const val DEFAULT_TORRENT_RAW_LIMIT_MB = 256
    private const val MIN_TORRENT_RAW_LIMIT_MB = 16
    private const val MAX_TORRENT_RAW_LIMIT_MB = 4096
    private const val TORRENT_PRUNE_CHECK_INTERVAL_MS = 60_000L
    private const val USAGE_BUCKET_ID = "solevup-watcher-usage_android"
    private const val WINDOW_BUCKET_ID = "solevup-watcher-window_android"
    private const val POWER_BUCKET_ID = "solevup-watcher-power_android"
    private const val LEGACY_USAGE_BUCKET_ID = "sls-watcher-usage_android"
    private const val LEGACY_WINDOW_BUCKET_ID = "sls-watcher-window_android"
    private const val LEGACY_POWER_BUCKET_ID = "sls-watcher-power_android"

    private val isoFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
      timeZone = TimeZone.getTimeZone("UTC")
    }
    private val localDayFmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)

    fun nowIso(): String = isoFmt.format(Date())

    private fun migratedDbName(context: Context): String {
      migrateLegacyDatabaseFiles(context, DB_NAME, LEGACY_DB_NAMES)
      return DB_NAME
    }

    private fun migrateLegacyDatabaseFiles(context: Context, newName: String, legacyNames: List<String>) {
      val newDb = context.getDatabasePath(newName)
      if (newDb.exists()) return
      for (legacyName in legacyNames) {
        val oldDb = context.getDatabasePath(legacyName)
        if (!oldDb.exists()) continue
        runCatching {
          newDb.parentFile?.mkdirs()
          oldDb.copyTo(newDb, overwrite = false)
          for (suffix in listOf("-wal", "-shm", "-journal")) {
            val oldSidecar = File(oldDb.path + suffix)
            if (!oldSidecar.exists()) continue
            val newSidecar = File(newDb.path + suffix)
            oldSidecar.copyTo(newSidecar, overwrite = false)
          }
        }
        return
      }
    }

    private fun migrateLegacyBucketIds(db: SQLiteDatabase) {
      val pairs = listOf(
        LEGACY_USAGE_BUCKET_ID to USAGE_BUCKET_ID,
        LEGACY_WINDOW_BUCKET_ID to WINDOW_BUCKET_ID,
        LEGACY_POWER_BUCKET_ID to POWER_BUCKET_ID,
      )
      runCatching {
        db.beginTransaction()
        try {
          for ((oldId, newId) in pairs) {
            db.execSQL(
              """
              INSERT OR IGNORE INTO perception_buckets_android
                (id, kind, event_type, source, hostname, created_at, updated_at)
              SELECT ?, kind, event_type, source, hostname, created_at, updated_at
              FROM perception_buckets_android
              WHERE id = ?
              """.trimIndent(),
              arrayOf(newId, oldId),
            )
            db.execSQL(
              "UPDATE perception_events_android SET bucket_id = ? WHERE bucket_id = ?",
              arrayOf(newId, oldId),
            )
            db.execSQL(
              """
              DELETE FROM perception_buckets_android
              WHERE id = ?
                AND NOT EXISTS (
                  SELECT 1 FROM perception_events_android WHERE bucket_id = ?
                )
              """.trimIndent(),
              arrayOf(oldId, oldId),
            )
          }
          db.setTransactionSuccessful()
        } finally {
          db.endTransaction()
        }
      }
    }

    /** AUDIT-020：把"事件真实发生时刻"派生为查询索引用的 ISO 字符串，
     *  让 SolevupAccessibilityService / 其他 watcher 可以用真实时间写 start_at，
     *  避免 executor 排队 / executor 内 nowIso() 在边界跨过 span 导致漏查。 */
    fun isoFromMs(ms: Long): String = isoFmt.format(Date(ms))

    fun localDateKey(ms: Long): String = localDayFmt.format(Date(ms))

    fun localDayStartMs(ms: Long): Long {
      return Calendar.getInstance().apply {
        timeInMillis = ms
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
      }.timeInMillis
    }

    fun parseLocalDayStartMs(dayKey: String): Long? {
      return try { localDayFmt.parse(dayKey)?.time } catch (_: Throwable) { null }
    }

    private fun sha256Short(s: String): String {
      val md = MessageDigest.getInstance("SHA-256")
      val bytes = md.digest(s.toByteArray(Charsets.UTF_8))
      val sb = StringBuilder(32)
      for (i in 0 until 16) {
        val b = bytes[i].toInt() and 0xff
        sb.append(Integer.toHexString(0x100 or b).substring(1))
      }
      return sb.toString()
    }
  }
}
