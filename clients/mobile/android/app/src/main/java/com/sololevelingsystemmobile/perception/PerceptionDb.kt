package com.sololevelingsystemmobile.perception

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.security.MessageDigest
import java.text.SimpleDateFormat
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
  SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {

  override fun onConfigure(db: SQLiteDatabase) {
    super.onConfigure(db)
    // Android SQLite 默认外键不强制；perception_events_android.bucket_id 有
    // ON DELETE CASCADE，开外键避免删 bucket 后 events 残留孤儿。
    db.setForeignKeyConstraintsEnabled(true)
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
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    // Phase 1：尚无线上数据，破坏式升级即可
    db.execSQL("DROP TABLE IF EXISTS perception_events_android")
    db.execSQL("DROP TABLE IF EXISTS perception_buckets_android")
    db.execSQL("DROP TABLE IF EXISTS app_catalog_android")
    onCreate(db)
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

  /** 读最近一条 sls-watcher-usage_android summary 事件，parse data_json 为 apps 列表。 */
  fun latestUsageSummary(): UsageSummarySnapshot? {
    val db = readableDatabase
    return db.rawQuery(
      """
      SELECT id, data_json FROM perception_events_android
      WHERE bucket_id = 'sls-watcher-usage_android'
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
    val cap = limit.coerceIn(1, 500)
    val out = ArrayList<WindowEventSnapshot>()
    val startIso = isoFmt.format(Date(startMs))
    val endIso = isoFmt.format(Date(endMs))
    db.rawQuery(
      """
      SELECT id, start_at, data_json FROM perception_events_android
      WHERE bucket_id = 'sls-watcher-window_android'
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
          val pkg = obj.optString("package_name")
          // 查询端兜底过滤：旧版本 Service 没过滤自身的脏数据这里也挡掉
          if (pkg == "com.sololevelingsystemmobile") continue
          out.add(
            WindowEventSnapshot(
              rowId = rowId,
              startAt = startAt,
              packageName = pkg,
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
    return out
  }

  /** 写入电源 / 屏幕事件（screen_on / screen_off / unlocked / boot）。 */
  fun insertPowerEvent(event: String, eventTimeMs: Long) {
    val nowIso = nowIso()
    val payload = org.json.JSONObject().apply {
      put("event", event)
      put("event_time_ms", eventTimeMs)
    }.toString()
    ensureBucket(
      id = POWER_BUCKET_ID,
      kind = "power",
      eventType = "power.state_changed",
      source = "android_receiver",
    )
    insertEvent(POWER_BUCKET_ID, nowIso, nowIso, payload)
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
    val cap = limit.coerceIn(1, 500)
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
    return out
  }

  /** 一次性清掉所有 sls 自身的窗口事件（迁移用，新代码不会再写）。 */
  fun purgeSelfWindowEvents(): Int {
    val db = writableDatabase
    var deleted = 0
    db.rawQuery(
      """
      SELECT id FROM perception_events_android
      WHERE bucket_id = 'sls-watcher-window_android'
        AND data_json LIKE '%"package_name":"com.sololevelingsystemmobile"%'
      """.trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        val id = c.getLong(0)
        deleted += db.delete("perception_events_android", "id = ?", arrayOf(id.toString()))
      }
    }
    return deleted
  }

  /** 读最近 N 条窗口切换事件，按 id 倒序（最新在前）。 */
  fun recentWindowEvents(limit: Int): List<WindowEventSnapshot> {
    val db = readableDatabase
    val cap = limit.coerceIn(1, 200)
    val out = ArrayList<WindowEventSnapshot>(cap)
    db.rawQuery(
      """
      SELECT id, start_at, data_json FROM perception_events_android
      WHERE bucket_id = 'sls-watcher-window_android'
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

  companion object {
    private const val DB_NAME = "perception.db"
    private const val DB_VERSION = 1
    private const val POWER_BUCKET_ID = "sls-watcher-power_android"

    private val isoFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
      timeZone = TimeZone.getTimeZone("UTC")
    }

    fun nowIso(): String = isoFmt.format(Date())

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
