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

  // ── Sync import ── 镜像 desktop db.rs import_sync 的 LWW 合并逻辑：
  //   1. sync_id 是跨设备主键 —— 已存在按 sync_id 找；否则业务键回查（name /
  //      (cat,full_path) / (date,minute)）
  //   2. updated_at 字符串字典序比较：incoming 更新才覆盖
  //   3. blocks / planned_blocks 多一层 slot 冲突保护：同 (date, minute) 但
  //      sync_id 不同的两条记录，取 updated_at 更大的
  //   4. tags / blocks / plan_nodes / planned_blocks 都要查 FK sync_id 对应
  //      的 local row id；找不到就 skip（FK 未到位时不要写入产生外键错误）

  data class ImportResult(
    val activityCategories: Int = 0,
    val activityTags: Int = 0,
    val activityBlocks: Int = 0,
    val planNodes: Int = 0,
    val plannedBlocks: Int = 0,
    val skipped: Int = 0,
  )

  fun importSync(payload: SyncExport): ImportResult {
    val db = writableDatabase
    var cats = 0; var tags = 0; var blocks = 0
    var pNodes = 0; var pBlocks = 0; var skipped = 0

    db.beginTransaction()
    try {
      // ── activity_categories ──
      for (row in payload.activityCategories) {
        if (!shouldApplySyncRow(db, "activity_categories", row.syncId, row.updatedAt)) {
          skipped++; continue
        }
        val existingByName = queryLong(db, "SELECT id FROM activity_categories WHERE name = ?", arrayOf(row.name))
        if (existingByName != null) {
          if (!shouldApplyExistingId(db, "activity_categories", existingByName, row.updatedAt)) {
            skipped++; continue
          }
          // 防 sync_id UNIQUE 冲突：UPDATE 会把目标行 sync_id 改成 incoming.syncId，
          // 但 mobile DB 里可能已有另一行 sync_id == incoming.syncId（对端历史重新分配）。
          // 不能裸 DELETE 旁系 —— FK ON DELETE CASCADE 会静默吞掉它的 tags/blocks/plan
          // 等本地子数据。改为 cascade-aware merge：先把旁系的子 tag 迁/合并到 existing
          // 这个权威行，再删空旁系（详见 mergeCategoryConflict）。
          mergeCategoryConflict(db, row.syncId, existingByName)
          db.execSQL(
            """UPDATE activity_categories
               SET sync_id=?, color=?, sort_order=?, created_at=?, last_used_at=?,
                   updated_at=?, deleted_at=?
               WHERE id=?""".trimIndent(),
            arrayOf(row.syncId, row.color, row.sortOrder, row.createdAt, row.lastUsedAt,
                    row.updatedAt, row.deletedAt, existingByName),
          )
        } else {
          db.execSQL(
            """INSERT INTO activity_categories
                 (sync_id, name, color, sort_order, created_at, last_used_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(sync_id) DO UPDATE SET
                 name=excluded.name, color=excluded.color, sort_order=excluded.sort_order,
                 created_at=excluded.created_at, last_used_at=excluded.last_used_at,
                 updated_at=excluded.updated_at, deleted_at=excluded.deleted_at""".trimIndent(),
            arrayOf(row.syncId, row.name, row.color, row.sortOrder, row.createdAt,
                    row.lastUsedAt, row.updatedAt, row.deletedAt),
          )
        }
        cats++
      }

      // ── activity_tags ── (要先有 categories)
      for (row in payload.activityTags) {
        if (!shouldApplySyncRow(db, "activity_tags", row.syncId, row.updatedAt)) {
          skipped++; continue
        }
        val categoryId = lookupIdBySync(db, "activity_categories", row.categorySyncId)
        if (categoryId == null) { skipped++; continue }
        val existingByPath = queryLong(db,
          "SELECT id FROM activity_tags WHERE category_id = ? AND full_path = ?",
          arrayOf(categoryId, row.fullPath),
        )
        if (existingByPath != null) {
          if (!shouldApplyExistingId(db, "activity_tags", existingByPath, row.updatedAt)) {
            skipped++; continue
          }
          // 同 categories：cascade-aware merge 旁系 sync_id 占用行，
          // 把它的 activity_blocks/plan_nodes 迁到 existingByPath 后才删空
          mergeTagConflict(db, row.syncId, existingByPath)
          db.execSQL(
            """UPDATE activity_tags
               SET sync_id=?, leaf_name=?, depth=?, created_at=?, last_used_at=?,
                   updated_at=?, deleted_at=?
               WHERE id=?""".trimIndent(),
            arrayOf(row.syncId, row.leafName, row.depth, row.createdAt, row.lastUsedAt,
                    row.updatedAt, row.deletedAt, existingByPath),
          )
        } else {
          db.execSQL(
            """INSERT INTO activity_tags
                 (sync_id, category_id, full_path, leaf_name, depth, created_at, last_used_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(sync_id) DO UPDATE SET
                 category_id=excluded.category_id, full_path=excluded.full_path, leaf_name=excluded.leaf_name,
                 depth=excluded.depth, created_at=excluded.created_at, last_used_at=excluded.last_used_at,
                 updated_at=excluded.updated_at, deleted_at=excluded.deleted_at""".trimIndent(),
            arrayOf(row.syncId, categoryId, row.fullPath, row.leafName, row.depth,
                    row.createdAt, row.lastUsedAt, row.updatedAt, row.deletedAt),
          )
        }
        tags++
      }

      // ── plan_nodes ── (要先有 tags + 自引用 parent)
      for (row in payload.planNodes) {
        if (!shouldApplySyncRow(db, "plan_nodes", row.syncId, row.updatedAt)) {
          skipped++; continue
        }
        val projectTagId = lookupIdBySync(db, "activity_tags", row.projectTagSyncId)
        if (projectTagId == null) { skipped++; continue }
        val parentId = row.parentSyncId?.let { lookupIdBySync(db, "plan_nodes", it) }
        // 注：如果 parentSyncId 给了但还没 import，parentId=null 会丢失 parent 关系；
        // desktop 现在也是这样处理（"插入顺序" 假设父先于子）。Phase 5 可以加两遍 pass。
        db.execSQL(
          """INSERT INTO plan_nodes
               (sync_id, project_tag_id, parent_id, title, status, sort_order,
                created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(sync_id) DO UPDATE SET
               project_tag_id=excluded.project_tag_id, parent_id=excluded.parent_id,
               title=excluded.title, status=excluded.status, sort_order=excluded.sort_order,
               created_at=excluded.created_at, updated_at=excluded.updated_at,
               deleted_at=excluded.deleted_at""".trimIndent(),
          arrayOf(row.syncId, projectTagId, parentId, row.title, row.status, row.sortOrder,
                  row.createdAt, row.updatedAt, row.deletedAt),
        )
        pNodes++
      }

      // ── activity_blocks ── (要先有 tags)
      // 槽位双键挑战：sync_id UNIQUE + PRIMARY KEY(date, minute)。
      // 同 sync_id 跨槽位迁移（block 被改时间或日期）时旧 INSERT 只 ON CONFLICT(date,minute)
      // 会撞 UNIQUE(sync_id) → 整事务回滚。
      // 正确做法：先按 sync_id 查 local row：
      //   有 → 删旧槽位 + 在新槽位 UPSERT（保证 sync_id 唯一性）
      //   无 → 直接 UPSERT 到 (date, minute) 槽，槽里有别人覆盖
      for (row in payload.activityBlocks) {
        if (!shouldApplySyncRow(db, "activity_blocks", row.syncId, row.updatedAt)) {
          skipped++; continue
        }
        if (!shouldApplySlotRow(db, "activity_blocks", row.date, row.minute, row.syncId, row.updatedAt)) {
          skipped++; continue
        }
        val tagId = lookupIdBySync(db, "activity_tags", row.tagSyncId)
        if (tagId == null) { skipped++; continue }
        // 先删 sync_id 对应的任何旧槽位（如果 row.date/minute 跟旧槽不一致就生效）
        db.execSQL(
          "DELETE FROM activity_blocks WHERE sync_id = ? AND NOT (date = ? AND minute = ?)",
          arrayOf(row.syncId, row.date, row.minute),
        )
        db.execSQL(
          """INSERT INTO activity_blocks
               (sync_id, date, minute, tag_id, note, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(date, minute) DO UPDATE SET
               sync_id=excluded.sync_id, tag_id=excluded.tag_id, note=excluded.note,
               created_at=excluded.created_at, updated_at=excluded.updated_at,
               deleted_at=excluded.deleted_at""".trimIndent(),
          arrayOf(row.syncId, row.date, row.minute, tagId, row.note,
                  row.createdAt, row.updatedAt, row.deletedAt),
        )
        blocks++
      }

      // ── planned_blocks ── (要先有 plan_nodes) ── 同 activity_blocks 双键处理
      for (row in payload.plannedBlocks) {
        if (!shouldApplySyncRow(db, "planned_blocks", row.syncId, row.updatedAt)) {
          skipped++; continue
        }
        if (!shouldApplySlotRow(db, "planned_blocks", row.date, row.minute, row.syncId, row.updatedAt)) {
          skipped++; continue
        }
        val planNodeId = lookupIdBySync(db, "plan_nodes", row.planNodeSyncId)
        if (planNodeId == null) { skipped++; continue }
        db.execSQL(
          "DELETE FROM planned_blocks WHERE sync_id = ? AND NOT (date = ? AND minute = ?)",
          arrayOf(row.syncId, row.date, row.minute),
        )
        db.execSQL(
          """INSERT INTO planned_blocks
               (sync_id, date, minute, plan_node_id, note, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(date, minute) DO UPDATE SET
               sync_id=excluded.sync_id, plan_node_id=excluded.plan_node_id, note=excluded.note,
               created_at=excluded.created_at, updated_at=excluded.updated_at,
               deleted_at=excluded.deleted_at""".trimIndent(),
          arrayOf(row.syncId, row.date, row.minute, planNodeId, row.note,
                  row.createdAt, row.updatedAt, row.deletedAt),
        )
        pBlocks++
      }

      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }

    return ImportResult(cats, tags, blocks, pNodes, pBlocks, skipped)
  }

  // ── LWW helpers ──
  private fun shouldApplySyncRow(
    db: SQLiteDatabase, table: String, syncId: String, incomingUpdatedAt: String,
  ): Boolean {
    val local = queryString(db, "SELECT updated_at FROM $table WHERE sync_id = ?", arrayOf(syncId))
    return local == null || incomingUpdatedAt > local
  }

  private fun shouldApplyExistingId(
    db: SQLiteDatabase, table: String, id: Long, incomingUpdatedAt: String,
  ): Boolean {
    val local = queryString(db, "SELECT updated_at FROM $table WHERE id = ?", arrayOf(id))
    return local == null || incomingUpdatedAt > local
  }

  private fun shouldApplySlotRow(
    db: SQLiteDatabase, table: String, date: String, minute: Int,
    incomingSyncId: String, incomingUpdatedAt: String,
  ): Boolean {
    return db.rawQuery(
      "SELECT sync_id, updated_at FROM $table WHERE date = ? AND minute = ?",
      arrayOf(date, minute.toString()),
    ).use { c ->
      if (!c.moveToFirst()) return@use true
      val localSyncId = c.getString(0)
      val localUpdatedAt = c.getString(1)
      if (localSyncId == incomingSyncId) return@use true
      incomingUpdatedAt > localUpdatedAt
    }
  }

  private fun lookupIdBySync(db: SQLiteDatabase, table: String, syncId: String): Long? {
    return queryLong(db, "SELECT id FROM $table WHERE sync_id = ?", arrayOf(syncId))
  }

  // ── Cascade-aware merge helpers (AUDIT-012) ──
  // categories/tags 段做 UPDATE sync_id 时，若 incoming.syncId 被旁系行占用，
  // 不能裸 DELETE 旁系 —— FK ON DELETE CASCADE 会静默删除它挂的 activity_tags
  // / activity_blocks / plan_nodes / planned_blocks 等本地未同步子数据。
  // 这里把旁系下的子项 FK 迁/合并到 keepId（业务键匹配的权威行），再删空旁系。

  /** 旁系 category 下的 tags 迁到 keepId；同 (cat, full_path) 撞 UNIQUE 时递归合并 tag。 */
  private fun mergeCategoryConflict(db: SQLiteDatabase, syncId: String, keepId: Long) {
    val sideId = queryLong(
      db, "SELECT id FROM activity_categories WHERE sync_id = ? AND id != ?",
      arrayOf(syncId, keepId),
    ) ?: return
    val sideTags = mutableListOf<Pair<Long, String>>()
    db.rawQuery(
      "SELECT id, full_path FROM activity_tags WHERE category_id = ?",
      arrayOf(sideId.toString()),
    ).use { c -> while (c.moveToNext()) sideTags.add(c.getLong(0) to c.getString(1)) }
    for ((sideTagId, fullPath) in sideTags) {
      val targetTagId = queryLong(
        db, "SELECT id FROM activity_tags WHERE category_id = ? AND full_path = ?",
        arrayOf(keepId, fullPath),
      )
      if (targetTagId != null) {
        // 目标 category 下已有同 path tag，进一步合并这两个 tag 的子项
        mergeTagChildren(db, sideTagId, targetTagId)
        db.execSQL("DELETE FROM activity_tags WHERE id = ?", arrayOf(sideTagId))
      } else {
        db.execSQL(
          "UPDATE activity_tags SET category_id = ? WHERE id = ?",
          arrayOf(keepId, sideTagId),
        )
      }
    }
    // 旁系下已无 tag，cascade 此时无子可吞，DELETE 安全
    db.execSQL("DELETE FROM activity_categories WHERE id = ?", arrayOf(sideId))
  }

  /** 旁系 tag 的子 blocks/plan_nodes 迁到 keepId 后删空旁系。 */
  private fun mergeTagConflict(db: SQLiteDatabase, syncId: String, keepId: Long) {
    val sideId = queryLong(
      db, "SELECT id FROM activity_tags WHERE sync_id = ? AND id != ?",
      arrayOf(syncId, keepId),
    ) ?: return
    mergeTagChildren(db, sideId, keepId)
    db.execSQL("DELETE FROM activity_tags WHERE id = ?", arrayOf(sideId))
  }

  /** 把 sideTagId 下的 blocks + plan_nodes 重新挂到 keepTagId。
   *  activity_blocks 同 (date, minute) 槽位冲突时优先保留 keepTagId 那份（业务权威）。 */
  private fun mergeTagChildren(db: SQLiteDatabase, sideTagId: Long, keepTagId: Long) {
    // 先丢掉旁系跟 keep 同 (date,minute) 的 blocks，否则 UPDATE 会撞 UNIQUE(date,minute)
    // AUDIT-013: 用 EXISTS 替代 row-value `(date, minute) IN (...)`，避免 minSdkVersion=24
    // 的 API 24/25 旧 Android SQLite 不支持 row-value SQL 抛 SQLiteException 回滚整事务
    db.execSQL(
      """DELETE FROM activity_blocks WHERE tag_id = ? AND EXISTS (
           SELECT 1 FROM activity_blocks k
           WHERE k.tag_id = ?
             AND k.date = activity_blocks.date
             AND k.minute = activity_blocks.minute
         )""".trimIndent(),
      arrayOf(sideTagId, keepTagId),
    )
    db.execSQL(
      "UPDATE activity_blocks SET tag_id = ? WHERE tag_id = ?",
      arrayOf(keepTagId, sideTagId),
    )
    // plan_nodes 没跟 project_tag_id 复合 UNIQUE，直接迁
    db.execSQL(
      "UPDATE plan_nodes SET project_tag_id = ? WHERE project_tag_id = ?",
      arrayOf(keepTagId, sideTagId),
    )
  }

  private fun queryLong(db: SQLiteDatabase, sql: String, args: Array<Any>): Long? {
    return db.rawQuery(sql, args.map { it.toString() }.toTypedArray()).use { c ->
      if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null
    }
  }

  private fun queryString(db: SQLiteDatabase, sql: String, args: Array<Any>): String? {
    return db.rawQuery(sql, args.map { it.toString() }.toTypedArray()).use { c ->
      if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
    }
  }

  // ── linked_devices CRUD (mobile 主动 pull desktop 时用) ──

  data class LinkedDevice(
    val deviceId: String,
    val alias: String,
    val lastBase: String,
    val lastSyncedAt: String?,
    val createdAt: String,
  )

  fun listLinkedDevices(): List<LinkedDevice> {
    val out = ArrayList<LinkedDevice>()
    readableDatabase.rawQuery(
      """SELECT device_id, alias, last_base, last_synced_at, created_at
         FROM linked_devices ORDER BY created_at""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        out.add(LinkedDevice(
          deviceId = c.getString(0), alias = c.getString(1),
          lastBase = c.getString(2),
          lastSyncedAt = if (c.isNull(3)) null else c.getString(3),
          createdAt = c.getString(4),
        ))
      }
    }
    return out
  }

  /** Upsert linked device。如果对端 device_id 已存在，刷新 alias 和 last_base。 */
  fun addLinkedDevice(deviceId: String, alias: String, lastBase: String): LinkedDevice {
    val now = nowIso()
    writableDatabase.execSQL(
      """INSERT INTO linked_devices (device_id, alias, last_base, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           alias=excluded.alias, last_base=excluded.last_base""".trimIndent(),
      arrayOf(deviceId, alias, lastBase, now),
    )
    return LinkedDevice(deviceId, alias, lastBase, null, now)
  }

  fun removeLinkedDevice(deviceId: String) {
    writableDatabase.execSQL(
      "DELETE FROM linked_devices WHERE device_id = ?", arrayOf(deviceId),
    )
  }

  /** 同步成功后 touch lastSyncedAt + 刷新 lastBase（对端 IP 可能变了）。 */
  fun touchLinkSynced(deviceId: String, lastBase: String) {
    val now = nowIso()
    writableDatabase.execSQL(
      """UPDATE linked_devices SET last_synced_at = ?, last_base = ?
         WHERE device_id = ?""".trimIndent(),
      arrayOf(now, lastBase, deviceId),
    )
  }

  /**
   * 生成跟 desktop db.rs generate_alias 完全一致的"形容词+水果"别名。
   * 算法：FNV-1a hash `solo-leveling-system:alias:v1:<device_id>`，
   * 拆 hex[0..8]/[8..16] 转 u32 取模 ADJECTIVES / FRUITS。
   * 同一个 device_id 在 mobile / desktop 算出来的 alias 完全相同。
   */
  fun generateAlias(deviceId: String): String {
    val input = "solo-leveling-system:alias:v1:$deviceId"
    val hex = fnv1aHex(input)
    val adjIdx = (hex.substring(0, 8).toLong(16) % ALIAS_ADJECTIVES.size).toInt()
    val fruitIdx = (hex.substring(8, 16).toLong(16) % ALIAS_FRUITS.size).toInt()
    return "${ALIAS_ADJECTIVES[adjIdx]}的${ALIAS_FRUITS[fruitIdx]}"
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

    // 必须跟 desktop db.rs local_now_string() 格式严格一致：
    // `yyyy-MM-dd HH:mm:ss` + 本地时区（无 'T' 无 'Z' 无毫秒）
    // 字符串字典序与真实时间顺序在同时区内一致，LWW 才能正确工作。
    // 之前用 UTC ISO 会让字符串比较错乱（空格 0x20 < 'T' 0x54）：
    //   desktop "2026-05-24 12:00:00"  <  mobile "2026-05-24T11:00:00.000Z"
    //   ASCII 比较被误判为 desktop 更早，LWW 错过 desktop 更新
    private val isoFmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).apply {
      timeZone = TimeZone.getDefault()
    }

    fun nowIso(): String = isoFmt.format(Date())

    // 跟 desktop db.rs ALIAS_ADJECTIVES / ALIAS_FRUITS 完全一致的词库
    private val ALIAS_ADJECTIVES = arrayOf(
      "迷人", "美丽", "巨大", "明亮", "干净", "聪明", "帅气", "可爱", "狡猾", "坚定",
      "有活力", "高效", "极好", "快速", "不错", "新鲜", "华丽", "伟大", "英俊", "炽热",
      "善良", "诚实", "神秘", "整洁", "开心", "耐心", "漂亮", "强大", "富有", "秘密",
      "稳固", "特别", "战略", "智慧",
    )
    private val ALIAS_FRUITS = arrayOf(
      "苹果", "鳄梨", "香蕉", "黑莓", "蓝莓", "西兰花", "胡萝卜", "樱桃", "椰子", "葡萄",
      "柠檬", "莴苣", "芒果", "甜瓜", "蘑菇", "洋葱", "橙子", "木瓜", "桃子", "梨",
      "菠萝", "土豆", "南瓜", "覆盆子", "草莓", "番茄",
    )

    /** FNV-1a 64bit hash → 16 字符 hex（跟 desktop db.rs stable_hash_hex 一致）。 */
    private fun fnv1aHex(input: String): String {
      var hash = 0xcbf29ce484222325UL
      for (byte in input.toByteArray(Charsets.UTF_8)) {
        hash = hash xor (byte.toUByte().toULong())
        hash = (hash * 0x100000001b3UL)
      }
      return hash.toString(16).padStart(16, '0')
    }
  }
}
