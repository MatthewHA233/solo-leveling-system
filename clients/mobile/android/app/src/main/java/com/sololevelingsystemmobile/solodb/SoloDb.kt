package com.sololevelingsystemmobile.solodb

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * 主数据 SQLite —— 镜像 desktop solo.db 的同步表 schema，
 * 为 Phase 5 LAN P2P 同步打底。和感知层 perception.db 分开两个文件，
 * 隔离用户活动数据（昼夜表）和系统观测数据（窗口/usage 事件）。
 *
 * 包含同步必需的 5 张表 + sync_meta + linked_devices：
 *   activity_categories / activity_tags / activity_blocks
 *   plan_nodes / planned_blocks
 *   linked_devices, sync_meta（device_id / device_alias）
 *
 * 关键设计（跟 desktop ensure_sync_metadata 一致）：
 *   - 每张同步表都有 sync_id (UUID)、updated_at、deleted_at
 *   - last-write-wins by updated_at；sync_id 匹配同一条记录
 *   - 业务键 UNIQUE：activity_categories.name; activity_tags(category_id, full_path)
 *   - activity_blocks / planned_blocks 用 PK(date, minute) 表达稀疏 5min 槽位
 */
class SoloDb(context: Context) :
  SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {

  override fun onConfigure(db: SQLiteDatabase) {
    super.onConfigure(db)
    // Android SQLite 默认外键不强制，但 schema 用了 ON DELETE CASCADE。
    // 跟 desktop db.rs 的 `PRAGMA foreign_keys = ON` 保持一致，
    // 避免删 category/tag/plan_node 后残留孤儿行。每个连接都要开。
    db.setForeignKeyConstraintsEnabled(true)
  }

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS activity_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id TEXT NOT NULL UNIQUE,
        name TEXT UNIQUE NOT NULL,
        color TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      """.trimIndent()
    )
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_activity_categories_sync_updated ON activity_categories(updated_at);")

    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS activity_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id TEXT NOT NULL UNIQUE,
        category_id INTEGER NOT NULL REFERENCES activity_categories(id) ON DELETE CASCADE,
        full_path TEXT NOT NULL,
        leaf_name TEXT NOT NULL,
        depth INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE (category_id, full_path)
      );
      """.trimIndent()
    )
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_activity_tags_category ON activity_tags(category_id);")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_activity_tags_sync_updated ON activity_tags(updated_at);")

    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS activity_blocks (
        date TEXT NOT NULL,
        minute INTEGER NOT NULL,
        sync_id TEXT NOT NULL UNIQUE,
        tag_id INTEGER NOT NULL REFERENCES activity_tags(id) ON DELETE CASCADE,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        PRIMARY KEY (date, minute)
      );
      """.trimIndent()
    )
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_activity_blocks_tag ON activity_blocks(tag_id);")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_activity_blocks_sync_updated ON activity_blocks(updated_at);")

    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS plan_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id TEXT NOT NULL UNIQUE,
        project_tag_id INTEGER NOT NULL REFERENCES activity_tags(id) ON DELETE CASCADE,
        parent_id INTEGER REFERENCES plan_nodes(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      """.trimIndent()
    )
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_plan_nodes_project ON plan_nodes(project_tag_id);")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_plan_nodes_parent ON plan_nodes(parent_id);")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_plan_nodes_sync_updated ON plan_nodes(updated_at);")

    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS planned_blocks (
        date TEXT NOT NULL,
        minute INTEGER NOT NULL,
        sync_id TEXT NOT NULL UNIQUE,
        plan_node_id INTEGER NOT NULL REFERENCES plan_nodes(id) ON DELETE CASCADE,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        PRIMARY KEY (date, minute)
      );
      """.trimIndent()
    )
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_planned_blocks_node ON planned_blocks(plan_node_id);")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_planned_blocks_sync_updated ON planned_blocks(updated_at);")

    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS linked_devices (
        device_id TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        last_base TEXT NOT NULL,
        last_synced_at TEXT,
        created_at TEXT NOT NULL
      );
      """.trimIndent()
    )

    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      """.trimIndent()
    )
    // 进程内创建好 device_id（同 desktop get_or_create_device_id 行为）
    val now = nowIso()
    val deviceId = UUID.randomUUID().toString()
    db.execSQL(
      "INSERT OR IGNORE INTO sync_meta (key, value, updated_at) VALUES ('device_id', ?, ?)",
      arrayOf(deviceId, now),
    )
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    // Phase 0：尚无线上数据，破坏式升级最快
    db.execSQL("DROP TABLE IF EXISTS planned_blocks")
    db.execSQL("DROP TABLE IF EXISTS plan_nodes")
    db.execSQL("DROP TABLE IF EXISTS activity_blocks")
    db.execSQL("DROP TABLE IF EXISTS activity_tags")
    db.execSQL("DROP TABLE IF EXISTS activity_categories")
    db.execSQL("DROP TABLE IF EXISTS linked_devices")
    db.execSQL("DROP TABLE IF EXISTS sync_meta")
    onCreate(db)
  }

  // ── 数据访问 ──

  data class CategoryRow(
    val id: Long, val syncId: String, val name: String, val color: String, val sortOrder: Int,
    val createdAt: String, val lastUsedAt: String, val updatedAt: String, val deletedAt: String?,
  )

  data class TagRow(
    val id: Long, val syncId: String, val categoryId: Long, val fullPath: String,
    val leafName: String, val depth: Int, val createdAt: String, val lastUsedAt: String,
    val updatedAt: String, val deletedAt: String?,
  )

  data class BlockRow(
    val date: String, val minute: Int, val syncId: String, val tagId: Long, val note: String?,
    val createdAt: String, val updatedAt: String, val deletedAt: String?,
  )

  fun listCategories(): List<CategoryRow> {
    val out = ArrayList<CategoryRow>()
    readableDatabase.rawQuery(
      """SELECT id, sync_id, name, color, sort_order, created_at, last_used_at, updated_at, deleted_at
         FROM activity_categories WHERE deleted_at IS NULL ORDER BY sort_order, id""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) out.add(
        CategoryRow(
          c.getLong(0), c.getString(1), c.getString(2), c.getString(3), c.getInt(4),
          c.getString(5), c.getString(6), c.getString(7), c.getString(8),
        ),
      )
    }
    return out
  }

  fun listTags(): List<TagRow> {
    val out = ArrayList<TagRow>()
    readableDatabase.rawQuery(
      """SELECT id, sync_id, category_id, full_path, leaf_name, depth, created_at, last_used_at, updated_at, deleted_at
         FROM activity_tags WHERE deleted_at IS NULL ORDER BY category_id, id""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) out.add(
        TagRow(
          c.getLong(0), c.getString(1), c.getLong(2), c.getString(3),
          c.getString(4), c.getInt(5), c.getString(6), c.getString(7),
          c.getString(8), c.getString(9),
        ),
      )
    }
    return out
  }

  fun listBlocksForDate(date: String): List<BlockRow> {
    val out = ArrayList<BlockRow>()
    readableDatabase.rawQuery(
      """SELECT date, minute, sync_id, tag_id, note, created_at, updated_at, deleted_at
         FROM activity_blocks WHERE date = ? AND deleted_at IS NULL ORDER BY minute""".trimIndent(),
      arrayOf(date),
    ).use { c ->
      while (c.moveToNext()) out.add(
        BlockRow(
          c.getString(0), c.getInt(1), c.getString(2), c.getLong(3),
          c.getString(4), c.getString(5), c.getString(6), c.getString(7),
        ),
      )
    }
    return out
  }

  /**
   * Upsert category by name UNIQUE；返回 row id。
   * syncId / createdAt / lastUsedAt / updatedAt 都可选；
   * updatedAt 是 LWW 同步的关键，seed 时必须传 desktop 原始 updated_at，
   * 否则会被对端视为"mobile 刚改"覆盖 desktop 更新的版本。
   */
  fun upsertCategory(
    name: String, color: String, sortOrder: Int,
    syncId: String? = null,
    createdAt: String? = null, lastUsedAt: String? = null, updatedAt: String? = null,
  ): Long {
    val now = nowIso()
    val sid = syncId?.takeIf { it.isNotEmpty() } ?: UUID.randomUUID().toString()
    val cAt = createdAt ?: now
    val lAt = lastUsedAt ?: now
    val uAt = updatedAt ?: now
    val db = writableDatabase
    db.execSQL(
      """INSERT INTO activity_categories
           (sync_id, name, color, sort_order, created_at, last_used_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(name) DO UPDATE SET
           color = excluded.color, sort_order = excluded.sort_order,
           last_used_at = excluded.last_used_at, updated_at = excluded.updated_at,
           deleted_at = NULL""".trimIndent(),
      arrayOf(sid, name, color, sortOrder, cAt, lAt, uAt),
    )
    return db.rawQuery(
      "SELECT id FROM activity_categories WHERE name = ?", arrayOf(name),
    ).use { c -> if (c.moveToFirst()) c.getLong(0) else -1L }
  }

  /** Upsert tag by (category_id, full_path) UNIQUE；返回 row id。同 upsertCategory 注释。 */
  fun upsertTag(
    categoryId: Long, fullPath: String, leafName: String, depth: Int,
    syncId: String? = null,
    createdAt: String? = null, lastUsedAt: String? = null, updatedAt: String? = null,
  ): Long {
    val now = nowIso()
    val sid = syncId?.takeIf { it.isNotEmpty() } ?: UUID.randomUUID().toString()
    val cAt = createdAt ?: now
    val lAt = lastUsedAt ?: now
    val uAt = updatedAt ?: now
    val db = writableDatabase
    db.execSQL(
      """INSERT INTO activity_tags
           (sync_id, category_id, full_path, leaf_name, depth, created_at, last_used_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(category_id, full_path) DO UPDATE SET
           leaf_name = excluded.leaf_name, depth = excluded.depth,
           last_used_at = excluded.last_used_at, updated_at = excluded.updated_at,
           deleted_at = NULL""".trimIndent(),
      arrayOf(sid, categoryId, fullPath, leafName, depth, cAt, lAt, uAt),
    )
    return db.rawQuery(
      "SELECT id FROM activity_tags WHERE category_id = ? AND full_path = ?",
      arrayOf(categoryId.toString(), fullPath),
    ).use { c -> if (c.moveToFirst()) c.getLong(0) else -1L }
  }

  /** Paint：UPSERT 每个 (date, minute) 槽位为 tagId；undelete + bump updated_at。 */
  fun paintBlocks(date: String, minutes: IntArray, tagId: Long) {
    if (minutes.isEmpty()) return
    val now = nowIso()
    val db = writableDatabase
    db.beginTransaction()
    try {
      for (m in minutes) {
        val sid = UUID.randomUUID().toString()
        db.execSQL(
          """INSERT INTO activity_blocks
               (date, minute, sync_id, tag_id, note, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)
             ON CONFLICT(date, minute) DO UPDATE SET
               tag_id = excluded.tag_id, updated_at = excluded.updated_at, deleted_at = NULL""".trimIndent(),
          arrayOf(date, m, sid, tagId, now, now),
        )
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  /** Erase：soft delete + bump updated_at（LWW 同步时另一端能看到删除）。 */
  fun eraseBlocks(date: String, minutes: IntArray) {
    if (minutes.isEmpty()) return
    val now = nowIso()
    val db = writableDatabase
    db.beginTransaction()
    try {
      for (m in minutes) {
        db.execSQL(
          """UPDATE activity_blocks SET deleted_at = ?, updated_at = ?
             WHERE date = ? AND minute = ?""".trimIndent(),
          arrayOf(now, now, date, m),
        )
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  // ── Sync export ── 镜像 desktop SyncExport：用 sync_id 而非 local id，
  // tags / blocks / plan_nodes / planned_blocks 都 JOIN 出关联表的 sync_id。
  // 对端 import 时按 sync_id 匹配或建 FK 关系，跨设备稳定。

  data class SyncCategoryRow(
    val syncId: String, val name: String, val color: String, val sortOrder: Int,
    val createdAt: String, val lastUsedAt: String,
    val updatedAt: String, val deletedAt: String?,
  )

  data class SyncTagRow(
    val syncId: String, val categorySyncId: String,
    val fullPath: String, val leafName: String, val depth: Int,
    val createdAt: String, val lastUsedAt: String,
    val updatedAt: String, val deletedAt: String?,
  )

  data class SyncBlockRow(
    val syncId: String, val date: String, val minute: Int,
    val tagSyncId: String, val note: String?,
    val createdAt: String, val updatedAt: String, val deletedAt: String?,
  )

  data class SyncPlanNodeRow(
    val syncId: String, val projectTagSyncId: String,
    val parentSyncId: String?, val title: String, val status: String, val sortOrder: Int,
    val createdAt: String, val updatedAt: String, val deletedAt: String?,
  )

  data class SyncPlannedBlockRow(
    val syncId: String, val date: String, val minute: Int,
    val planNodeSyncId: String, val note: String?,
    val createdAt: String, val updatedAt: String, val deletedAt: String?,
  )

  data class SyncExport(
    val deviceId: String,
    val exportedAt: String,
    val cursor: String,
    val activityCategories: List<SyncCategoryRow>,
    val activityTags: List<SyncTagRow>,
    val activityBlocks: List<SyncBlockRow>,
    val planNodes: List<SyncPlanNodeRow>,
    val plannedBlocks: List<SyncPlannedBlockRow>,
  )

  /**
   * 按 since cursor 增量导出（updated_at > since 或 deleted_at > since）。
   * since = null → 全量导出。
   */
  fun exportSync(since: String?): SyncExport {
    val db = readableDatabase
    val exportedAt = nowIso()
    val devId = deviceId()
    val changed: (String, String?) -> Boolean = { u, d ->
      since == null || u > since || (d != null && d > since)
    }

    val cats = ArrayList<SyncCategoryRow>()
    db.rawQuery(
      "SELECT sync_id, name, color, sort_order, created_at, last_used_at, updated_at, deleted_at FROM activity_categories",
      null,
    ).use { c ->
      while (c.moveToNext()) {
        val u = c.getString(6); val d = c.getString(7)
        if (!changed(u, d)) continue
        cats.add(SyncCategoryRow(
          c.getString(0), c.getString(1), c.getString(2), c.getInt(3),
          c.getString(4), c.getString(5), u, d,
        ))
      }
    }

    val tags = ArrayList<SyncTagRow>()
    db.rawQuery(
      """SELECT t.sync_id, c.sync_id, t.full_path, t.leaf_name, t.depth,
                t.created_at, t.last_used_at, t.updated_at, t.deleted_at
         FROM activity_tags t
         JOIN activity_categories c ON c.id = t.category_id""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        val u = c.getString(7); val d = c.getString(8)
        if (!changed(u, d)) continue
        tags.add(SyncTagRow(
          c.getString(0), c.getString(1), c.getString(2), c.getString(3), c.getInt(4),
          c.getString(5), c.getString(6), u, d,
        ))
      }
    }

    val blocks = ArrayList<SyncBlockRow>()
    db.rawQuery(
      """SELECT b.sync_id, b.date, b.minute, t.sync_id, b.note,
                b.created_at, b.updated_at, b.deleted_at
         FROM activity_blocks b
         JOIN activity_tags t ON t.id = b.tag_id""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        val u = c.getString(6); val d = c.getString(7)
        if (!changed(u, d)) continue
        blocks.add(SyncBlockRow(
          c.getString(0), c.getString(1), c.getInt(2), c.getString(3), c.getString(4),
          c.getString(5), u, d,
        ))
      }
    }

    val planNodes = ArrayList<SyncPlanNodeRow>()
    db.rawQuery(
      """SELECT n.sync_id, t.sync_id, p.sync_id,
                n.title, n.status, n.sort_order,
                n.created_at, n.updated_at, n.deleted_at
         FROM plan_nodes n
         JOIN activity_tags t ON t.id = n.project_tag_id
         LEFT JOIN plan_nodes p ON p.id = n.parent_id""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        val u = c.getString(7); val d = c.getString(8)
        if (!changed(u, d)) continue
        planNodes.add(SyncPlanNodeRow(
          c.getString(0), c.getString(1), c.getString(2),
          c.getString(3), c.getString(4), c.getInt(5),
          c.getString(6), u, d,
        ))
      }
    }

    val plannedBlocks = ArrayList<SyncPlannedBlockRow>()
    db.rawQuery(
      """SELECT pb.sync_id, pb.date, pb.minute, n.sync_id, pb.note,
                pb.created_at, pb.updated_at, pb.deleted_at
         FROM planned_blocks pb
         JOIN plan_nodes n ON n.id = pb.plan_node_id""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        val u = c.getString(6); val d = c.getString(7)
        if (!changed(u, d)) continue
        plannedBlocks.add(SyncPlannedBlockRow(
          c.getString(0), c.getString(1), c.getInt(2), c.getString(3), c.getString(4),
          c.getString(5), u, d,
        ))
      }
    }

    return SyncExport(
      deviceId = devId,
      exportedAt = exportedAt,
      cursor = exportedAt,
      activityCategories = cats,
      activityTags = tags,
      activityBlocks = blocks,
      planNodes = planNodes,
      plannedBlocks = plannedBlocks,
    )
  }

  /** 当前 device_id（从 sync_meta 读出）。 */
  fun deviceId(): String {
    return readableDatabase.rawQuery(
      "SELECT value FROM sync_meta WHERE key = 'device_id'", null,
    ).use { c -> if (c.moveToFirst()) c.getString(0) else "" }
  }

  /** 返回 (tableName → row count, dbPath)。Phase 0 阶段用来验证连通。 */
  fun stats(): Pair<Map<String, Long>, String> {
    val db = readableDatabase
    val tables = listOf(
      "activity_categories", "activity_tags", "activity_blocks",
      "plan_nodes", "planned_blocks", "linked_devices", "sync_meta",
    )
    val counts = LinkedHashMap<String, Long>()
    for (t in tables) {
      counts[t] = db.rawQuery("SELECT COUNT(*) FROM $t", null)
        .use { c -> if (c.moveToFirst()) c.getLong(0) else 0L }
    }
    return counts to (db.path ?: "")
  }

  companion object {
    private const val DB_NAME = "solo.db"
    private const val DB_VERSION = 1

    private val isoFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
      timeZone = TimeZone.getTimeZone("UTC")
    }

    fun nowIso(): String = isoFmt.format(Date())
  }
}
