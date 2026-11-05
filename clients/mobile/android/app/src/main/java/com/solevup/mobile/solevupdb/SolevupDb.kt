package com.solevup.mobile.solevupdb

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * 主数据 SQLite —— 镜像 desktop solevup.db 的同步表 schema，
 * 为 Phase 5 LAN P2P 同步打底。和感知层 solevup_perception.db 分开两个文件，
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
class SolevupDb(context: Context) :
  SQLiteOpenHelper(context.applicationContext, migratedDbName(context.applicationContext), null, DB_VERSION) {

  private val appContext: Context = context.applicationContext

  /** 聊天图片文件（规则见 src/lib/agent/chat-images.ts） */
  val chatImageDir: File get() = File(appContext.filesDir, "chat-images")

  override fun onConfigure(db: SQLiteDatabase) {
    super.onConfigure(db)
    // Android SQLite 默认外键不强制，但 schema 用了 ON DELETE CASCADE。
    // 跟 desktop db.rs 的 `PRAGMA foreign_keys = ON` 保持一致，
    // 避免删 category/tag/plan_node 后残留孤儿行。每个连接都要开。
    db.setForeignKeyConstraintsEnabled(true)
  }

  override fun onOpen(db: SQLiteDatabase) {
    super.onOpen(db)
    // 渐进式建新表：onUpgrade 是破坏式（DROP 全表），bump DB_VERSION 会清掉
    // 已装设备的昼夜表数据。新表一律幂等 IF NOT EXISTS 在每次打开时补建。
    ensureModelTables(db)
    ensureChatTables(db)
    db.execSQL(
      "CREATE TABLE IF NOT EXISTS synced_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);"
    )
    applySchemaRevisions(db)
    ensureProviderActiveKeys(db)
  }

  // onUpgrade 是破坏式的，已有表的结构和数据调整都放这里，按 sync_meta.schema_rev 只跑一次
  private fun applySchemaRevisions(db: SQLiteDatabase) {
    val rev = queryString(db, "SELECT value FROM sync_meta WHERE key = 'schema_rev'", emptyArray())
      ?.toIntOrNull() ?: 0
    if (rev >= SCHEMA_REV) return
    db.beginTransaction()
    try {
      if (rev < 1) applyRevision1(db)
      if (rev < 2) applyRevision2(db)
      if (rev < 3) applyRevision3(db)
      db.execSQL(
        "INSERT OR REPLACE INTO sync_meta (key, value, updated_at) VALUES ('schema_rev', ?, ?)",
        arrayOf(SCHEMA_REV.toString(), nowIso()),
      )
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  private fun applyRevision3(db: SQLiteDatabase) {
    // 同步接口开始要配对令牌，旧链接没有令牌，留着也同步不了，让主人重新配对
    addColumnIfMissing(db, "linked_devices", "auth_token", "auth_token TEXT")
    db.execSQL("DELETE FROM linked_devices WHERE auth_token IS NULL")
  }

  private fun applyRevision2(db: SQLiteDatabase) {
    // revision 1 之后界面仍在往库里写 agent，这些行被导出过滤掉了，而游标已经越过它们，要重新登记才发得出去
    db.execSQL(
      "INSERT OR REPLACE INTO chat_sync_log (kind, entity_id) SELECT 'm', id FROM chat_messages WHERE role = 'agent' ORDER BY timestamp"
    )
    db.execSQL("UPDATE chat_messages SET role = 'assistant' WHERE role = 'agent'")
  }

  private fun applyRevision1(db: SQLiteDatabase) {
    // desktop 从 2026-06 起只在 39733 提供 HTTP，手机存的旧地址已经连不上
    db.execSQL(
      """UPDATE linked_devices SET last_base = substr(last_base, 1, length(last_base) - 6) || ':39733'
         WHERE last_base LIKE '%:49733'""".trimIndent()
    )

    // desktop 390e500：Key 按提供商分开启用，费用分人民币 / 美元。
    // 之前同步下来的行没有 provider，按 Key 前缀先认出 Anthropic，其余下轮由对端补正
    addColumnIfMissing(db, "model_api_keys", "provider", "provider TEXT NOT NULL DEFAULT 'dashscope'")
    db.execSQL("UPDATE model_api_keys SET provider = 'anthropic' WHERE api_key LIKE 'sk-ant-%'")
    addColumnIfMissing(db, "model_call_log", "cost_usd", "cost_usd REAL")

    // 聊天记录进同步协议：删除要能传播（deleted_at），改名不能顶到列表最前（meta_updated_at 与 updated_at 分开）
    addColumnIfMissing(db, "chat_sessions", "deleted_at", "deleted_at TEXT")
    addColumnIfMissing(db, "chat_sessions", "meta_updated_at", "meta_updated_at TEXT")
    db.execSQL("UPDATE chat_messages SET role = 'assistant' WHERE role = 'agent'")
    // 补齐 role 之外的旧数据都处理完，再把存量登记进增量日志（见 ensureChatSyncLog）
    // 旧版只存了总量，desktop 按 ModelCallLog 解析会显示异常
    db.execSQL(
      """UPDATE chat_messages SET usage_json = NULL
         WHERE usage_json IS NOT NULL AND usage_json NOT LIKE '%"model_id"%'""".trimIndent()
    )
    // desktop 的 chat_* 时间是 UTC ISO，手机旧版写的是本地时间，混排会乱序
    val sessions = ArrayList<Triple<String, String, String>>()
    db.rawQuery("SELECT id, created_at, updated_at FROM chat_sessions", null).use { c ->
      while (c.moveToNext()) sessions.add(Triple(c.getString(0), c.getString(1), c.getString(2)))
    }
    for ((id, created, updated) in sessions) {
      db.execSQL(
        "UPDATE chat_sessions SET created_at = ?, updated_at = ? WHERE id = ?",
        arrayOf(localToUtcIso(created), localToUtcIso(updated), id),
      )
    }
    ensureChatSyncLog(db)
    db.execSQL("INSERT OR IGNORE INTO chat_sync_log (kind, entity_id) SELECT 's', id FROM chat_sessions")
    db.execSQL(
      "INSERT OR IGNORE INTO chat_sync_log (kind, entity_id) SELECT 'm', id FROM chat_messages ORDER BY timestamp"
    )
  }

  /**
   * 聊天增量同步的日志，和 desktop db.rs 同一套结构：
   * 写入靠触发器登记，业务代码不用管；AUTOINCREMENT 保证序号不回退，对端按序号存游标。
   * 会话和消息都可能很多，不放进全量 SyncExport，否则每轮都要传整个历史。
   */
  private fun ensureChatSyncLog(db: SQLiteDatabase) {
    db.execSQL(
      """CREATE TABLE IF NOT EXISTS chat_sync_log (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           kind TEXT NOT NULL,
           entity_id TEXT NOT NULL,
           origin TEXT,
           UNIQUE(kind, entity_id)
         )""".trimIndent()
    )
    db.execSQL(
      """CREATE TABLE IF NOT EXISTS chat_sync_cursor (
           peer_device_id TEXT PRIMARY KEY,
           pull_seq INTEGER NOT NULL DEFAULT 0,
           push_seq INTEGER NOT NULL DEFAULT 0
         )""".trimIndent()
    )
    db.execSQL(
      """CREATE TRIGGER IF NOT EXISTS chat_sessions_log_insert AFTER INSERT ON chat_sessions
         BEGIN INSERT OR REPLACE INTO chat_sync_log (kind, entity_id) VALUES ('s', NEW.id); END""".trimIndent()
    )
    db.execSQL(
      """CREATE TRIGGER IF NOT EXISTS chat_sessions_log_update AFTER UPDATE ON chat_sessions
         BEGIN INSERT OR REPLACE INTO chat_sync_log (kind, entity_id) VALUES ('s', NEW.id); END""".trimIndent()
    )
    db.execSQL(
      """CREATE TRIGGER IF NOT EXISTS chat_sessions_log_delete AFTER DELETE ON chat_sessions
         BEGIN DELETE FROM chat_sync_log WHERE kind = 's' AND entity_id = OLD.id; END""".trimIndent()
    )
    db.execSQL(
      """CREATE TRIGGER IF NOT EXISTS chat_messages_log_insert AFTER INSERT ON chat_messages
         BEGIN INSERT OR REPLACE INTO chat_sync_log (kind, entity_id) VALUES ('m', NEW.id); END""".trimIndent()
    )
    db.execSQL(
      """CREATE TRIGGER IF NOT EXISTS chat_messages_log_delete AFTER DELETE ON chat_messages
         BEGIN DELETE FROM chat_sync_log WHERE kind = 'm' AND entity_id = OLD.id; END""".trimIndent()
    )
  }

  private fun addColumnIfMissing(db: SQLiteDatabase, table: String, column: String, definition: String) {
    val exists = db.rawQuery("PRAGMA table_info($table)", null).use { c ->
      val nameIdx = c.getColumnIndexOrThrow("name")
      var found = false
      while (c.moveToNext()) if (c.getString(nameIdx) == column) found = true
      found
    }
    if (!exists) db.execSQL("ALTER TABLE $table ADD COLUMN $definition")
  }

  private fun ensureChatTables(db: SQLiteDatabase) {
    // 与 desktop db.rs 的 chat_sessions / chat_messages 同 schema（含思考链 reasoning）
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '新会话',
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      """.trimIndent()
    )
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        name TEXT,
        timestamp TEXT NOT NULL,
        audio_path TEXT,
        duration_ms INTEGER,
        usage_json TEXT,
        reasoning TEXT
      );
      """.trimIndent()
    )
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at);")
  }

  private fun ensureModelTables(db: SQLiteDatabase) {
    // 与 desktop db.rs 的 model_api_keys / model_call_log / model_free_quota /
    // feature_bindings 同 schema（id 直接作主键，LWW by updated_at）
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS model_api_keys (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        api_key TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      """.trimIndent()
    )
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS model_call_log (
        id TEXT PRIMARY KEY,
        api_key_id TEXT,
        feature TEXT NOT NULL,
        model_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms INTEGER,
        prompt_text_tokens INTEGER NOT NULL DEFAULT 0,
        prompt_image_tokens INTEGER NOT NULL DEFAULT 0,
        prompt_video_tokens INTEGER NOT NULL DEFAULT 0,
        prompt_audio_tokens INTEGER NOT NULL DEFAULT 0,
        completion_text_tokens INTEGER NOT NULL DEFAULT 0,
        completion_audio_tokens INTEGER NOT NULL DEFAULT 0,
        cost_cny REAL,
        free_quota_tokens INTEGER NOT NULL DEFAULT 0,
        free_quota_saved_cny REAL NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 1,
        error_message TEXT,
        metadata TEXT
      );
      """.trimIndent()
    )
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_model_api_keys_active ON model_api_keys(is_active);")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_model_call_log_started ON model_call_log(started_at DESC);")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_call_feature ON model_call_log(feature, started_at DESC);")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_call_model ON model_call_log(model_id, started_at DESC);")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_call_api_key ON model_call_log(api_key_id, started_at DESC);")
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS model_free_quota (
        model_id TEXT PRIMARY KEY,
        has_free_quota INTEGER NOT NULL DEFAULT 0,
        not_supported INTEGER NOT NULL DEFAULT 0,
        used_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        remaining_tokens INTEGER NOT NULL DEFAULT 0,
        used_percent TEXT,
        expire_date TEXT,
        raw_quota TEXT,
        scanned_at TEXT NOT NULL,
        error_message TEXT
      );
      """.trimIndent()
    )
    db.execSQL(
      "CREATE INDEX IF NOT EXISTS idx_model_free_quota_remaining ON model_free_quota(remaining_tokens DESC, scanned_at DESC);"
    )
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS feature_bindings (
        feature TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      """.trimIndent()
    )
    seedFeatureBindings(db)
    // 模型库跟随 desktop（只读）：种子先由 JS 静态表写入，首次同步后整表以 desktop 为准
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS model_registry (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'dashscope',
        display_name TEXT,
        modalities TEXT,
        context_window INTEGER,
        notes TEXT,
        deprecated INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'CNY'
      );
      """.trimIndent()
    )
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS model_pricing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id TEXT NOT NULL REFERENCES model_registry(id) ON DELETE CASCADE,
        tier_min_tokens INTEGER NOT NULL DEFAULT 0,
        tier_max_tokens INTEGER,
        price_input_text REAL,
        price_input_image REAL,
        price_input_video REAL,
        price_input_audio REAL,
        price_output_text REAL,
        price_output_text_thinking REAL,
        price_output_audio REAL
      );
      """.trimIndent()
    )
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_model_pricing_model ON model_pricing(model_id, tier_min_tokens);")
  }

  /**
   * 默认功能绑定，对齐 desktop seed_feature_bindings + jev::seed_decision_models：已有的不动。
   * updated_at 固定写纪元时间：这张表按 updated_at 做 LWW，写 now 的话新装的手机会用默认值盖掉 desktop 上选好的模型。
   */
  private fun seedFeatureBindings(db: SQLiteDatabase) {
    val biliOmniDefault = queryString(db, "SELECT model_id FROM feature_bindings WHERE feature = ?", arrayOf("bili_combined_transcribe"))
      ?: "qwen3.5-omni-plus"
    val seeds = listOf(
      "fairy_chat" to "qwen3.6-flash",
      "fairy_omni_chat" to "qwen3.5-omni-flash-realtime",
      "fairy_voice_asr" to "qwen-audio-3.1-asr-flash-streaming",
      "session_title" to "qwen3.6-flash",
      "bili_omni_transcribe" to biliOmniDefault,
      "bili_visual_transcribe" to "qwen3.6-flash",
      "bili_audio_transcribe" to "qwen3.5-omni-flash",
      "context_anchor" to "qwen3.6-flash",
      "anchor_extract" to "qwen3.6-flash",
      "thought_distill" to "qwen3.6-flash",
      "anchor_cluster_name" to "qwen3.6-flash",
      "anchor_embedding" to "text-embedding-v4",
      "protocol_gray" to "microsoft/microsoft-decision-1",
      "protocol_gray_vision" to "liquid/d1",
    )
    for ((feature, modelId) in seeds) {
      db.execSQL(
        "INSERT OR IGNORE INTO feature_bindings (feature, model_id, updated_at) VALUES (?, ?, ?)",
        arrayOf(feature, modelId, FEATURE_BINDING_SEED_TIME),
      )
    }
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
        created_at TEXT NOT NULL,
        auth_token TEXT
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

  /** Paint：UPSERT 每个 (date, minute) 槽位为 tagId；undelete + bump updated_at。
   *  同时更新 tag.last_used_at 和 category.last_used_at（对齐 desktop paint_blocks
   *  逻辑：拖拽涂色 = 真正"使用"该 tag，LWW 同步到对端，"最近"列表自动跨设备）。
   *  AUDIT-016 防御：tag 已软删时拒绝写入，避免 blocks 引用孤儿 tag。 */
  fun paintBlocks(date: String, minutes: IntArray, tagId: Long) {
    if (minutes.isEmpty()) return
    val db = writableDatabase
    // tag 已软删 / 不存在 → 静默跳过；防止 undo / stale UI 把死 tagId 写回
    val tagOk = db.rawQuery(
      "SELECT 1 FROM activity_tags WHERE id = ? AND deleted_at IS NULL LIMIT 1",
      arrayOf(tagId.toString()),
    ).use { c -> c.moveToFirst() }
    if (!tagOk) return
    val now = nowIso()
    db.beginTransaction()
    try {
      for (m in minutes) {
        if (m < 0 || m >= 1440 || m % 5 != 0) continue
        val sid = UUID.randomUUID().toString()
        db.execSQL(
          """INSERT INTO activity_blocks
               (date, minute, sync_id, tag_id, note, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)
             ON CONFLICT(date, minute) DO UPDATE SET
               tag_id = excluded.tag_id, created_at = excluded.created_at,
               updated_at = excluded.updated_at, deleted_at = NULL""".trimIndent(),
          arrayOf(date, m, sid, tagId, now, now),
        )
      }
      db.execSQL(
        "UPDATE activity_tags SET last_used_at = ?, updated_at = ? WHERE id = ?",
        arrayOf(now, now, tagId),
      )
      db.execSQL(
        """UPDATE activity_categories SET last_used_at = ?, updated_at = ?
           WHERE id = (SELECT category_id FROM activity_tags WHERE id = ?)""".trimIndent(),
        arrayOf(now, now, tagId),
      )
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  /** 软删 tag（设 deleted_at + bump updated_at），同时把它挂的 blocks/plan_nodes 也软删，
   *  保证 LWW 同步能传播到对端。返回受影响的 block 数量。 */
  fun deleteTag(tagId: Long): Int {
    val now = nowIso()
    val db = writableDatabase
    var blocksAffected = 0
    db.beginTransaction()
    try {
      db.execSQL(
        "UPDATE activity_tags SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        arrayOf(now, now, tagId),
      )
      // 关联的 blocks / plan_nodes 也软删，否则 LWW 看不到删除事件
      db.execSQL(
        "UPDATE activity_blocks SET deleted_at = ?, updated_at = ? WHERE tag_id = ? AND deleted_at IS NULL",
        arrayOf(now, now, tagId),
      )
      db.rawQuery("SELECT changes()", null).use { c ->
        if (c.moveToFirst()) blocksAffected = c.getInt(0)
      }
      // 计划块也要软删（对齐 desktop），否则同步过去后留下挂在已删节点上的孤儿计划块
      db.execSQL(
        """UPDATE planned_blocks SET deleted_at = ?, updated_at = ?
           WHERE deleted_at IS NULL AND plan_node_id IN (SELECT id FROM plan_nodes WHERE project_tag_id = ?)""".trimIndent(),
        arrayOf(now, now, tagId),
      )
      db.execSQL(
        "UPDATE plan_nodes SET deleted_at = ?, updated_at = ? WHERE project_tag_id = ? AND deleted_at IS NULL",
        arrayOf(now, now, tagId),
      )
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
    return blocksAffected
  }

  /** 软删 category：连带它下面所有 tags 一并软删。 */
  fun deleteCategory(categoryId: Long): Int {
    val now = nowIso()
    val db = writableDatabase
    var tagsAffected = 0
    db.beginTransaction()
    try {
      db.execSQL(
        "UPDATE activity_categories SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        arrayOf(now, now, categoryId),
      )
      // 把该 category 下所有非删 tag 也软删 + 它们的 blocks/plan_nodes
      val tagIds = mutableListOf<Long>()
      db.rawQuery(
        "SELECT id FROM activity_tags WHERE category_id = ? AND deleted_at IS NULL",
        arrayOf(categoryId.toString()),
      ).use { c -> while (c.moveToNext()) tagIds.add(c.getLong(0)) }
      tagsAffected = tagIds.size
      for (tid in tagIds) {
        db.execSQL(
          "UPDATE activity_tags SET deleted_at = ?, updated_at = ? WHERE id = ?",
          arrayOf(now, now, tid),
        )
        db.execSQL(
          "UPDATE activity_blocks SET deleted_at = ?, updated_at = ? WHERE tag_id = ? AND deleted_at IS NULL",
          arrayOf(now, now, tid),
        )
        db.execSQL(
          """UPDATE planned_blocks SET deleted_at = ?, updated_at = ?
             WHERE deleted_at IS NULL AND plan_node_id IN (SELECT id FROM plan_nodes WHERE project_tag_id = ?)""".trimIndent(),
          arrayOf(now, now, tid),
        )
        db.execSQL(
          "UPDATE plan_nodes SET deleted_at = ?, updated_at = ? WHERE project_tag_id = ? AND deleted_at IS NULL",
          arrayOf(now, now, tid),
        )
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
    return tagsAffected
  }

  /** 改分类名 + 颜色。空字符串 = 不改该字段。返回受影响行数。
   *  AUDIT-030：分类名变化时必须级联更新该分类下所有未删 tags 的 full_path 首段，
   *  否则 buildTagTree 用 `tag.fullPath.split(',')[0]` 查不到分类、子标签全消失；
   *  LAN 同步导出也会数据不一致。整个流程放在单一 transaction，并 bump tag.updated_at
   *  让增量 exportSync(since) 能传播路径修正。 */
  fun renameCategory(categoryId: Long, newName: String?, newColor: String?): Int {
    if (newName.isNullOrEmpty() && newColor.isNullOrEmpty()) return 0
    val now = nowIso()
    val db = writableDatabase
    db.beginTransaction()
    try {
      // 1) 读旧分类名（仅在改名时需要）
      var oldName: String? = null
      val nameChanging = !newName.isNullOrEmpty()
      if (nameChanging) {
        db.rawQuery(
          "SELECT name FROM activity_categories WHERE id = ? AND deleted_at IS NULL",
          arrayOf(categoryId.toString()),
        ).use { c ->
          if (c.moveToFirst()) oldName = c.getString(0)
        }
        if (oldName == null) return 0  // 分类不存在 / 已软删
      }
      // 2) 更新 categories 自身
      val sets = mutableListOf<String>()
      val args = mutableListOf<Any>()
      if (nameChanging) { sets += "name = ?"; args += newName!! }
      if (!newColor.isNullOrEmpty()) { sets += "color = ?"; args += newColor }
      sets += "updated_at = ?"; args += now
      args += categoryId
      db.execSQL(
        "UPDATE activity_categories SET ${sets.joinToString(", ")} WHERE id = ? AND deleted_at IS NULL",
        args.toTypedArray(),
      )
      val catChanged = db.rawQuery("SELECT changes()", null).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }
      // 3) 名字变了 → 级联更新该分类下所有 tag.full_path（首段 oldName → newName）
      //    注意：full_path 半角逗号分隔（createTag 路径），所以替换首段时按精确前缀做
      if (nameChanging && oldName != newName && catChanged > 0) {
        // 用 SUBSTR + length 替换首段，避免误改 "成长,学习" 这种内含的字符串
        // 公式：CASE
        //   WHEN full_path = oldName THEN newName
        //   WHEN full_path LIKE oldName||',%' THEN newName || SUBSTR(full_path, length(oldName)+1)
        //   ELSE full_path END
        db.execSQL(
          """
          UPDATE activity_tags
          SET full_path = CASE
            WHEN full_path = ? THEN ?
            WHEN full_path LIKE ? || ',%' THEN ? || SUBSTR(full_path, LENGTH(?) + 1)
            ELSE full_path
          END,
          leaf_name = CASE WHEN full_path = ? THEN ? ELSE leaf_name END,
          updated_at = ?
          WHERE category_id = ? AND deleted_at IS NULL
            AND (full_path = ? OR full_path LIKE ? || ',%')
          """.trimIndent(),
          arrayOf(
            oldName!!, newName!!,                    // CASE 1: 完全等于旧名
            oldName!!, newName!!, oldName!!,         // CASE 2: 旧名+","+剩余 → 新名+剩余
            oldName!!, newName!!,                    // 顶层标签的叶子就是分类名，对齐 desktop
            now, categoryId,
            oldName!!, oldName!!,                    // WHERE 限定只更新需要的行
          ),
        )
      }
      db.setTransactionSuccessful()
      return catChanged
    } finally {
      db.endTransaction()
    }
  }

  /** 改标签完整路径 newFullPath（含首段分类名，如 "学习,英语,新概念3"）。
   *  首段必须等于已有分类（不存在则抛错，避免误改）。
   *  cascade=true 时所有以旧路径为前缀的后代 tag 一并前缀替换（跟随改名）；
   *  false 时仅改自身，后代保持原路径（独立出来）。 */
  fun renameTagPath(tagId: Long, newFullPath: String, cascade: Boolean = false): Int {
    val segs = newFullPath.split(",").map { it.trim() }.filter { it.isNotEmpty() }
    if (segs.isEmpty()) return 0
    val newCategoryName = segs[0]
    val newLeafName = segs[segs.size - 1]
    val newPathStored = segs.joinToString(",")
    val newDepth = segs.size
    val db = writableDatabase
    // 找首段分类（不存在 → 抛错；改类别 = 必须先建分类）
    val newCategoryId = db.rawQuery(
      "SELECT id FROM activity_categories WHERE name = ? AND deleted_at IS NULL",
      arrayOf(newCategoryName),
    ).use { c -> if (c.moveToFirst()) c.getLong(0) else -1L }
    if (newCategoryId < 0) {
      throw IllegalStateException("分类「$newCategoryName」不存在，请先创建该分类再改路径")
    }
    val oldPath = db.rawQuery(
      "SELECT full_path FROM activity_tags WHERE id = ? AND deleted_at IS NULL",
      arrayOf(tagId.toString()),
    ).use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: return 0
    val now = nowIso()
    db.beginTransaction()
    try {
      db.execSQL(
        "UPDATE activity_tags SET category_id = ?, full_path = ?, leaf_name = ?, depth = ?, updated_at = ? WHERE id = ?",
        arrayOf(newCategoryId, newPathStored, newLeafName, newDepth, now, tagId),
      )
      val selfChanged = db.rawQuery("SELECT changes()", null).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }
      if (cascade && oldPath != newPathStored) {
        // 后代 = full_path 以「旧路径,」开头；前缀替换 + 跟随新分类，depth 平移
        val depthDelta = newDepth - oldPath.split(",").size
        db.execSQL(
          """
          UPDATE activity_tags
          SET full_path = ? || SUBSTR(full_path, LENGTH(?) + 1),
              category_id = ?,
              depth = depth + ?,
              updated_at = ?
          WHERE deleted_at IS NULL AND id != ? AND full_path LIKE ? || ',%'
          """.trimIndent(),
          arrayOf(newPathStored, oldPath, newCategoryId, depthDelta, now, tagId, oldPath),
        )
      }
      db.setTransactionSuccessful()
      return selfChanged
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

  // ── 模型同步行（字段与 desktop db.rs 的 SyncModelApiKey 等完全对齐） ──

  data class SyncModelApiKeyRow(
    val id: String, val label: String, val apiKey: String, val isActive: Int,
    val createdAt: String, val updatedAt: String, val deletedAt: String?,
    val provider: String = PROVIDER_DASHSCOPE,
  )

  data class SyncModelCallLogRow(
    val id: String, val apiKeyId: String?, val feature: String, val modelId: String,
    val startedAt: String, val durationMs: Long?,
    val promptTextTokens: Long, val promptImageTokens: Long,
    val promptVideoTokens: Long, val promptAudioTokens: Long,
    val completionTextTokens: Long, val completionAudioTokens: Long,
    val costCny: Double?, val freeQuotaTokens: Long, val freeQuotaSavedCny: Double,
    val success: Int, val errorMessage: String?, val metadata: String?,
    val costUsd: Double? = null,
  )

  data class SyncModelFreeQuotaRow(
    val modelId: String, val hasFreeQuota: Int, val notSupported: Int,
    val usedTokens: Long, val totalTokens: Long, val remainingTokens: Long,
    val usedPercent: String?, val expireDate: String?, val rawQuota: String?,
    val scannedAt: String, val errorMessage: String?,
  )

  data class SyncFeatureBindingRow(
    val feature: String, val modelId: String, val updatedAt: String,
  )

  data class SyncChatSessionRow(
    val id: String, val title: String, val summary: String?,
    val createdAt: String, val updatedAt: String, val metaUpdatedAt: String, val deletedAt: String?,
  )

  data class SyncChatMessageRow(
    val id: String, val sessionId: String, val role: String, val content: String?,
    val toolCalls: String?, val toolCallId: String?, val name: String?, val timestamp: String,
    val audioPath: String?, val durationMs: Long?, val usageJson: String?, val reasoning: String?,
  )

  data class SyncModelPricingRow(
    val tierMinTokens: Long, val tierMaxTokens: Long?,
    val priceInputText: Double?, val priceInputImage: Double?,
    val priceInputVideo: Double?, val priceInputAudio: Double?,
    val priceOutputText: Double?, val priceOutputTextThinking: Double?, val priceOutputAudio: Double?,
  )

  data class SyncModelDefRow(
    val id: String, val category: String, val provider: String, val displayName: String?,
    val modalities: String?, val contextWindow: Long?, val notes: String?, val deprecated: Int,
    val updatedAt: String, val currency: String, val pricing: List<SyncModelPricingRow>,
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
    val modelApiKeys: List<SyncModelApiKeyRow> = emptyList(),
    val modelCallLog: List<SyncModelCallLogRow> = emptyList(),
    val modelFreeQuota: List<SyncModelFreeQuotaRow> = emptyList(),
    val featureBindings: List<SyncFeatureBindingRow> = emptyList(),
    val modelRegistry: List<SyncModelDefRow> = emptyList(),
    val settings: List<SyncSettingRow> = emptyList(),
  )

  data class SyncSettingRow(val key: String, val value: String, val updatedAt: String)

  /** 聊天增量通道的一页（/api/sync/chat）。seq 是这页覆盖到的本机日志序号，对端存成游标。 */
  data class ChatSyncPage(
    val deviceId: String, val seq: Long, val more: Boolean,
    val sessions: List<SyncChatSessionRow>, val messages: List<SyncChatMessageRow>,
  )

  data class ChatCursor(val pullSeq: Long, val pushSeq: Long)

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
         LEFT JOIN plan_nodes p ON p.id = n.parent_id
         ORDER BY n.project_tag_id, COALESCE(n.parent_id, 0), n.sort_order, n.id""".trimIndent(),
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

    // ── 模型同步四表（对齐 desktop export_sync：tombstone 行 api_key 清空不外泄明文） ──
    val apiKeys = ArrayList<SyncModelApiKeyRow>()
    db.rawQuery(
      "SELECT id, label, api_key, is_active, created_at, updated_at, deleted_at, provider FROM model_api_keys",
      null,
    ).use { c ->
      while (c.moveToNext()) {
        val u = c.getString(5); val d = c.getString(6)
        if (!changed(u, d)) continue
        apiKeys.add(SyncModelApiKeyRow(
          c.getString(0), c.getString(1),
          if (d != null) "" else c.getString(2),
          c.getInt(3), c.getString(4), u, d, c.getString(7),
        ))
      }
    }

    val callLog = ArrayList<SyncModelCallLogRow>()
    db.rawQuery(
      """SELECT id, api_key_id, feature, model_id, started_at, duration_ms,
                prompt_text_tokens, prompt_image_tokens, prompt_video_tokens, prompt_audio_tokens,
                completion_text_tokens, completion_audio_tokens, cost_cny,
                free_quota_tokens, free_quota_saved_cny, success, error_message, metadata, cost_usd
         FROM model_call_log l
         WHERE l.api_key_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM model_api_keys k
              WHERE k.id = l.api_key_id AND k.deleted_at IS NOT NULL
            )""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        // call_log 是 append-only（无 updated_at），增量语义按 started_at 过滤
        val startedAt = c.getString(4)
        if (since != null && startedAt <= since) continue
        callLog.add(SyncModelCallLogRow(
          c.getString(0), if (c.isNull(1)) null else c.getString(1),
          c.getString(2), c.getString(3), startedAt,
          if (c.isNull(5)) null else c.getLong(5),
          c.getLong(6), c.getLong(7), c.getLong(8), c.getLong(9),
          c.getLong(10), c.getLong(11),
          if (c.isNull(12)) null else c.getDouble(12),
          c.getLong(13), c.getDouble(14), c.getInt(15),
          if (c.isNull(16)) null else c.getString(16),
          if (c.isNull(17)) null else c.getString(17),
          if (c.isNull(18)) null else c.getDouble(18),
        ))
      }
    }

    val freeQuota = ArrayList<SyncModelFreeQuotaRow>()
    db.rawQuery(
      """SELECT model_id, has_free_quota, not_supported, used_tokens, total_tokens,
                remaining_tokens, used_percent, expire_date, raw_quota, scanned_at, error_message
         FROM model_free_quota""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        val scannedAt = c.getString(9)
        if (since != null && scannedAt <= since) continue
        freeQuota.add(SyncModelFreeQuotaRow(
          c.getString(0), c.getInt(1), c.getInt(2),
          c.getLong(3), c.getLong(4), c.getLong(5),
          if (c.isNull(6)) null else c.getString(6),
          if (c.isNull(7)) null else c.getString(7),
          if (c.isNull(8)) null else c.getString(8),
          scannedAt,
          if (c.isNull(10)) null else c.getString(10),
        ))
      }
    }

    val bindings = ArrayList<SyncFeatureBindingRow>()
    db.rawQuery("SELECT feature, model_id, updated_at FROM feature_bindings", null).use { c ->
      while (c.moveToNext()) {
        val u = c.getString(2)
        if (since != null && u <= since) continue
        bindings.add(SyncFeatureBindingRow(c.getString(0), c.getString(1), u))
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
      modelApiKeys = apiKeys,
      modelCallLog = callLog,
      modelFreeQuota = freeQuota,
      featureBindings = bindings,
      settings = listSyncedSettings(),
    )
  }

  // ── 在设备间共享的设置（Fish 音色和模型）。规则和 desktop db.rs SYNCED_SETTING_KEYS 相同，改了要同时改：
  //   · 按 updated_at 取新；表很小，每轮全量导出
  //   · 旧配置种进表时用 SEED_SETTING_TIME，比任何一次真正的修改都旧，只有另一边什么都没有时才生效

  fun listSyncedSettings(): List<SyncSettingRow> =
    readableDatabase.rawQuery("SELECT key, value, updated_at FROM synced_settings", null).use { c ->
      val out = ArrayList<SyncSettingRow>(c.count)
      while (c.moveToNext()) out.add(SyncSettingRow(c.getString(0), c.getString(1), c.getString(2)))
      out
    }

  /** seed：只在表里还没有这一项时写，时间比任何修改都旧 */
  fun saveSyncedSetting(key: String, value: String, seed: Boolean) {
    require(key in SYNCED_SETTING_KEYS) { "不认识的设置：$key" }
    if (seed) {
      writableDatabase.execSQL(
        "INSERT OR IGNORE INTO synced_settings (key, value, updated_at) VALUES (?, ?, ?)",
        arrayOf(key, value, SEED_SETTING_TIME),
      )
    } else {
      writableDatabase.execSQL(
        """INSERT INTO synced_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at""",
        arrayOf(key, value, utcNowIso()),
      )
    }
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
    val modelApiKeys: Int = 0,
    val modelCallLog: Int = 0,
    val modelFreeQuota: Int = 0,
    val featureBindings: Int = 0,
    val chatSessions: Int = 0,
    val chatMessages: Int = 0,
    val modelRegistry: Int = 0,
    val settings: Int = 0,
    val chatImages: Int = 0, // 这一轮拉到的聊天图片文件（不进数据库）
    val skipped: Int = 0,
  ) {
    val hasChanges: Boolean
      get() = activityCategories + activityTags + activityBlocks + planNodes + plannedBlocks +
        modelApiKeys + modelCallLog + modelFreeQuota + featureBindings +
        chatSessions + chatMessages + modelRegistry + settings + chatImages > 0
  }

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
      // 子节点可能排在父节点前面（节点移动过，id 就不再是父小子大）。这时 parent_id 先写成 NULL，全部写完再补；
      // 不补的话这一行下一轮 updated_at 相同会被跳过，父子关系就永久丢了。desktop import_sync 同样两遍
      val unresolvedParents = ArrayList<Pair<String, String>>()
      for (row in payload.planNodes) {
        if (!shouldApplySyncRow(db, "plan_nodes", row.syncId, row.updatedAt)) {
          skipped++; continue
        }
        val projectTagId = lookupIdBySync(db, "activity_tags", row.projectTagSyncId)
        if (projectTagId == null) { skipped++; continue }
        val parentId = row.parentSyncId?.let { lookupIdBySync(db, "plan_nodes", it) }
        if (parentId == null && row.parentSyncId != null) unresolvedParents.add(Pair(row.syncId, row.parentSyncId))
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
      for ((syncId, parentSyncId) in unresolvedParents) {
        val parentId = lookupIdBySync(db, "plan_nodes", parentSyncId) ?: continue
        db.execSQL("UPDATE plan_nodes SET parent_id = ? WHERE sync_id = ?", arrayOf(parentId, syncId))
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

      // ── model_api_keys ──（LWW by updated_at；对齐 desktop import_sync 的
      //   tombstone 规则：deleted_at 非空 → api_key 清空 + is_active=0 + 删关联 call_log；
      //   import 活 active 行后，同提供商的其他 active 降级——不分提供商会把别家的 Key 停掉并推回 desktop）
      var mKeys = 0
      for (row in payload.modelApiKeys) {
        val existingUpdated = queryString(
          db, "SELECT updated_at FROM model_api_keys WHERE id = ?", arrayOf(row.id),
        )
        if (existingUpdated != null && existingUpdated >= row.updatedAt) {
          // provider 不可变；升级前同步下来的行没有这一列，靠对端补正
          db.execSQL(
            "UPDATE model_api_keys SET provider = ? WHERE id = ? AND provider <> ?",
            arrayOf(row.provider, row.id, row.provider),
          )
          skipped++
          continue
        }
        val isTombstone = row.deletedAt != null
        val apiKeyToStore = if (isTombstone) "" else row.apiKey
        val isActiveToStore = if (isTombstone) 0 else row.isActive
        db.execSQL(
          """INSERT INTO model_api_keys (id, label, api_key, is_active, created_at, updated_at, deleted_at, provider)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               label=excluded.label, api_key=excluded.api_key, is_active=excluded.is_active,
               created_at=excluded.created_at, updated_at=excluded.updated_at,
               deleted_at=excluded.deleted_at, provider=excluded.provider""".trimIndent(),
          arrayOf(row.id, row.label, apiKeyToStore, isActiveToStore,
                  row.createdAt, row.updatedAt, row.deletedAt, row.provider),
        )
        if (!isTombstone && row.isActive == 1) {
          db.execSQL(
            """UPDATE model_api_keys SET is_active = 0, updated_at = ?
               WHERE id != ? AND is_active = 1 AND deleted_at IS NULL AND provider = ?""".trimIndent(),
            arrayOf(row.updatedAt, row.id, row.provider),
          )
        }
        if (isTombstone) {
          db.execSQL("DELETE FROM model_call_log WHERE api_key_id = ?", arrayOf(row.id))
        }
        mKeys++
      }

      ensureProviderActiveKeys(db)

      // ── model_call_log ──（append-only，按 id 幂等）
      var mLog = 0
      val deletedKeyIds = HashSet<String>()
      db.rawQuery("SELECT id FROM model_api_keys WHERE deleted_at IS NOT NULL", null).use { c ->
        while (c.moveToNext()) deletedKeyIds.add(c.getString(0))
      }
      val knownLogIds = HashSet<String>()
      db.rawQuery("SELECT id FROM model_call_log", null).use { c ->
        while (c.moveToNext()) knownLogIds.add(c.getString(0))
      }
      for (row in payload.modelCallLog) {
        if (row.apiKeyId in deletedKeyIds || !knownLogIds.add(row.id)) { skipped++; continue }
        db.execSQL(
          """INSERT INTO model_call_log
               (id, api_key_id, feature, model_id, started_at, duration_ms,
                prompt_text_tokens, prompt_image_tokens, prompt_video_tokens, prompt_audio_tokens,
                completion_text_tokens, completion_audio_tokens, cost_cny,
                free_quota_tokens, free_quota_saved_cny, success, error_message, metadata, cost_usd)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""".trimIndent(),
          arrayOf(row.id, row.apiKeyId, row.feature, row.modelId, row.startedAt, row.durationMs,
                  row.promptTextTokens, row.promptImageTokens, row.promptVideoTokens, row.promptAudioTokens,
                  row.completionTextTokens, row.completionAudioTokens, row.costCny,
                  row.freeQuotaTokens, row.freeQuotaSavedCny, row.success, row.errorMessage, row.metadata,
                  row.costUsd),
        )
        mLog++
      }

      // ── model_free_quota ──（scanned_at 新者胜）
      var mQuota = 0
      for (row in payload.modelFreeQuota) {
        val existingScanned = queryString(
          db, "SELECT scanned_at FROM model_free_quota WHERE model_id = ?", arrayOf(row.modelId),
        )
        if (existingScanned != null && existingScanned >= row.scannedAt) { skipped++; continue }
        db.execSQL(
          """INSERT OR REPLACE INTO model_free_quota
               (model_id, has_free_quota, not_supported, used_tokens, total_tokens,
                remaining_tokens, used_percent, expire_date, raw_quota, scanned_at, error_message)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""".trimIndent(),
          arrayOf(row.modelId, row.hasFreeQuota, row.notSupported, row.usedTokens, row.totalTokens,
                  row.remainingTokens, row.usedPercent, row.expireDate, row.rawQuota,
                  row.scannedAt, row.errorMessage),
        )
        mQuota++
      }

      // ── feature_bindings ──（LWW by updated_at）
      var mBindings = 0
      for (row in payload.featureBindings) {
        val existingUpdated = queryString(
          db, "SELECT updated_at FROM feature_bindings WHERE feature = ?", arrayOf(row.feature),
        )
        if (existingUpdated != null && existingUpdated >= row.updatedAt) { skipped++; continue }
        db.execSQL(
          """INSERT OR REPLACE INTO feature_bindings (feature, model_id, updated_at)
             VALUES (?, ?, ?)""".trimIndent(),
          arrayOf(row.feature, row.modelId, row.updatedAt),
        )
        mBindings++
      }

      val mRegistry = if (payload.modelRegistry.isEmpty()) 0 else replaceModelCatalog(db, payload.modelRegistry)

      var mSettings = 0
      for (row in payload.settings) {
        if (row.key !in SYNCED_SETTING_KEYS) {
          skipped++
          continue
        }
        val local = queryString(db, "SELECT updated_at FROM synced_settings WHERE key = ?", arrayOf(row.key))
        if (local != null && row.updatedAt <= local) {
          skipped++
          continue
        }
        db.execSQL(
          "INSERT OR REPLACE INTO synced_settings (key, value, updated_at) VALUES (?, ?, ?)",
          arrayOf(row.key, row.value, row.updatedAt),
        )
        mSettings++
      }

      db.setTransactionSuccessful()
      return ImportResult(
        activityCategories = cats, activityTags = tags, activityBlocks = blocks,
        planNodes = pNodes, plannedBlocks = pBlocks,
        modelApiKeys = mKeys, modelCallLog = mLog, modelFreeQuota = mQuota, featureBindings = mBindings,
        modelRegistry = mRegistry,
        settings = mSettings,
        skipped = skipped,
      )
    } finally {
      db.endTransaction()
    }
  }

  // ── 模型配置读写（聊天链路用：active key / 绑定模型 / 本机用量落库） ──

  data class ModelApiKeyInfo(
    val id: String, val label: String, val apiKey: String, val isActive: Boolean, val provider: String,
    val createdAt: String, val updatedAt: String,
  )

  /**
   * 每个提供商都要有一把启用的 Key。以前「全局只启用一把」的规则、同步交错都可能留下一把都没启用的提供商，
   * 这时启用最近更新的一把。不改 updated_at：两端算出同一把，也不会用旧内容盖掉对端的新修改。
   * 规则两端各有一份（db.rs ensure_provider_active_keys）。
   */
  private fun ensureProviderActiveKeys(db: SQLiteDatabase) {
    db.execSQL(
      """UPDATE model_api_keys SET is_active = 1
         WHERE id IN (
           SELECT (SELECT k.id FROM model_api_keys k
                   WHERE k.provider = p.provider AND k.deleted_at IS NULL AND length(k.api_key) > 0
                   ORDER BY k.updated_at DESC, k.created_at DESC, k.id LIMIT 1)
           FROM (SELECT DISTINCT provider FROM model_api_keys) p
           WHERE NOT EXISTS (
             SELECT 1 FROM model_api_keys a
             WHERE a.provider = p.provider AND a.is_active = 1
               AND a.deleted_at IS NULL AND length(a.api_key) > 0
           )
         )""".trimIndent()
    )
  }

  fun getActiveModelApiKey(provider: String = PROVIDER_DASHSCOPE): ModelApiKeyInfo? {
    readableDatabase.rawQuery(
      """SELECT id, label, api_key, provider, created_at, updated_at FROM model_api_keys
         WHERE is_active = 1 AND deleted_at IS NULL AND length(api_key) > 0 AND provider = ?
         ORDER BY updated_at DESC LIMIT 1""".trimIndent(),
      arrayOf(provider),
    ).use { c ->
      if (c.moveToFirst()) {
        return ModelApiKeyInfo(
          c.getString(0), c.getString(1), c.getString(2), true, c.getString(3), c.getString(4), c.getString(5),
        )
      }
    }
    return null
  }

  fun listModelApiKeys(): List<ModelApiKeyInfo> {
    val out = ArrayList<ModelApiKeyInfo>()
    readableDatabase.rawQuery(
      """SELECT id, label, api_key, is_active, provider, created_at, updated_at FROM model_api_keys
         WHERE deleted_at IS NULL ORDER BY provider, is_active DESC, updated_at DESC""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        out.add(ModelApiKeyInfo(
          c.getString(0), c.getString(1), c.getString(2), c.getInt(3) == 1,
          c.getString(4), c.getString(5), c.getString(6),
        ))
      }
    }
    return out
  }

  // ── Key 增删改（语义对齐 desktop：每个提供商各一把启用；变动都 bump updated_at 让对端 LWW 拿到） ──

  private fun normalizeProvider(raw: String?): String {
    val p = raw?.trim().orEmpty().ifEmpty { PROVIDER_DASHSCOPE }
    require(p == PROVIDER_DASHSCOPE || p == PROVIDER_ANTHROPIC || p == PROVIDER_FISH) { "不认识的提供商：$p" }
    return p
  }

  private fun defaultKeyLabel(provider: String) = when (provider) {
    PROVIDER_ANTHROPIC -> "Anthropic API Key"
    PROVIDER_FISH -> "Fish Audio API Key"
    else -> "百炼 API Key"
  }

  fun upsertModelApiKey(id: String?, label: String, apiKey: String, rawProvider: String?, activate: Boolean): ModelApiKeyInfo {
    val keyId = id ?: UUID.randomUUID().toString()
    val provider = normalizeProvider(rawProvider)
    val name = label.trim().ifEmpty { defaultKeyLabel(provider) }
    val key = apiKey.trim()
    require(key.isNotEmpty()) { "API Key 不能为空" }
    val now = utcNowIso()
    val db = writableDatabase
    db.beginTransaction()
    try {
      val activeCount = queryLong(
        db, "SELECT COUNT(*) FROM model_api_keys WHERE is_active = 1 AND deleted_at IS NULL AND provider = ?",
        arrayOf(provider),
      ) ?: 0L
      val shouldActivate = activate || activeCount == 0L
      if (shouldActivate) {
        db.execSQL(
          """UPDATE model_api_keys SET is_active = 0, updated_at = ?
             WHERE is_active = 1 AND deleted_at IS NULL AND provider = ?""".trimIndent(),
          arrayOf(now, provider),
        )
      }
      db.execSQL(
        """INSERT INTO model_api_keys (id, label, api_key, is_active, created_at, updated_at, deleted_at, provider)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT(id) DO UPDATE SET
             label=excluded.label, api_key=excluded.api_key, is_active=excluded.is_active,
             updated_at=excluded.updated_at, deleted_at=NULL""".trimIndent(),
        arrayOf(keyId, name, key, if (shouldActivate) 1 else 0, now, now, provider),
      )
      db.setTransactionSuccessful()
      return ModelApiKeyInfo(keyId, name, key, shouldActivate, provider, now, now)
    } finally {
      db.endTransaction()
    }
  }

  fun setActiveModelApiKey(id: String) {
    val db = writableDatabase
    val provider = queryString(
      db, "SELECT provider FROM model_api_keys WHERE id = ? AND deleted_at IS NULL", arrayOf(id),
    ) ?: throw IllegalArgumentException("API Key 不存在")
    db.execSQL(
      """UPDATE model_api_keys SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = ?
         WHERE deleted_at IS NULL AND provider = ?""".trimIndent(),
      arrayOf(id, utcNowIso(), provider),
    )
  }

  /** 软删留墓碑，明文清空；连带删除这把 Key 的调用记录；删的是启用中的 Key 就顶上最近的一把。 */
  fun deleteModelApiKey(id: String) {
    val db = writableDatabase
    db.beginTransaction()
    try {
      val row = db.rawQuery(
        "SELECT provider, is_active FROM model_api_keys WHERE id = ? AND deleted_at IS NULL", arrayOf(id),
      ).use { c -> if (c.moveToFirst()) c.getString(0) to c.getInt(1) else null }
      if (row != null) {
        val now = utcNowIso()
        db.execSQL("DELETE FROM model_call_log WHERE api_key_id = ?", arrayOf(id))
        db.execSQL(
          """UPDATE model_api_keys SET deleted_at = ?, api_key = '', is_active = 0, updated_at = ?
             WHERE id = ?""".trimIndent(),
          arrayOf(now, now, id),
        )
        if (row.second != 0) {
          val nextId = queryString(
            db, """SELECT id FROM model_api_keys WHERE deleted_at IS NULL AND provider = ?
                   ORDER BY updated_at DESC LIMIT 1""".trimIndent(),
            arrayOf(row.first),
          )
          if (nextId != null) {
            db.execSQL(
              """UPDATE model_api_keys SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = ?
                 WHERE deleted_at IS NULL AND provider = ?""".trimIndent(),
              arrayOf(nextId, now, row.first),
            )
          }
        }
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  // ── 模型库（只读镜像 desktop） ──

  private fun replaceModelCatalog(db: SQLiteDatabase, rows: List<SyncModelDefRow>, source: String = CATALOG_SOURCE_SYNC): Int {
    db.execSQL(
      "INSERT OR REPLACE INTO sync_meta (key, value, updated_at) VALUES ('model_catalog_source', ?, ?)",
      arrayOf(source, nowIso()),
    )
    // desktop 每次启动都会重跑种子刷新 updated_at，比内容才知道有没有真变化
    val hash = rows.map { it.copy(updatedAt = "") }.toString().hashCode().toString()
    val stored = queryString(db, "SELECT value FROM sync_meta WHERE key = 'model_catalog_hash'", emptyArray())
    if (stored == hash) return 0
    db.execSQL("DELETE FROM model_pricing")
    db.execSQL("DELETE FROM model_registry")
    for (m in rows) insertCatalogRow(db, m)
    db.execSQL(
      "INSERT OR REPLACE INTO sync_meta (key, value, updated_at) VALUES ('model_catalog_hash', ?, ?)",
      arrayOf(hash, nowIso()),
    )
    return rows.size
  }

  private fun insertCatalogRow(db: SQLiteDatabase, m: SyncModelDefRow) {
    db.execSQL(
      """INSERT INTO model_registry
           (id, category, provider, display_name, modalities, context_window, notes, deprecated, updated_at, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""".trimIndent(),
      arrayOf(m.id, m.category, m.provider, m.displayName, m.modalities, m.contextWindow, m.notes,
              m.deprecated, m.updatedAt, m.currency),
    )
    for (t in m.pricing) {
      db.execSQL(
        """INSERT INTO model_pricing
             (model_id, tier_min_tokens, tier_max_tokens, price_input_text, price_input_image, price_input_video,
              price_input_audio, price_output_text, price_output_text_thinking, price_output_audio)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""".trimIndent(),
        arrayOf(m.id, t.tierMinTokens, t.tierMaxTokens, t.priceInputText, t.priceInputImage, t.priceInputVideo,
                t.priceInputAudio, t.priceOutputText, t.priceOutputTextThinking, t.priceOutputAudio),
      )
    }
  }

  /**
   * 对齐 desktop 启动时的种子（seed_model_registry / seed_anthropic_models / seed_decision_models），JS 每次启动调一次：
   * - 没同步过（空表或库里还是种子）：整表换成随包种子，新版的价目能跟上
   * - 同步过：已有的行以 desktop 为准不动（随包种子可能比 desktop 旧，不能覆盖），只补库里没有的行。
   *   旧版 desktop 同步来的表可能没有 Claude / 决策模型的行，不补就算不出费用；内容哈希不动，下次同步内容变了仍然整表替换
   */
  fun seedModelCatalogIfEmpty(rows: List<SyncModelDefRow>): Boolean {
    val db = writableDatabase
    db.beginTransaction()
    try {
      val count = queryLong(db, "SELECT COUNT(*) FROM model_registry", emptyArray()) ?: 0L
      val source = queryString(db, "SELECT value FROM sync_meta WHERE key = 'model_catalog_source'", emptyArray())
      val seeded = if (count == 0L || source == CATALOG_SOURCE_SEED) {
        replaceModelCatalog(db, rows, CATALOG_SOURCE_SEED) > 0
      } else {
        var added = 0
        for (m in rows) {
          val exists = queryLong(db, "SELECT 1 FROM model_registry WHERE id = ?", arrayOf(m.id)) != null
          if (!exists) { insertCatalogRow(db, m); added += 1 }
        }
        added > 0
      }
      db.setTransactionSuccessful()
      return seeded
    } finally {
      db.endTransaction()
    }
  }

  fun listModelCatalog(): List<SyncModelDefRow> {
    val db = readableDatabase
    val tiers = HashMap<String, ArrayList<SyncModelPricingRow>>()
    db.rawQuery(
      """SELECT model_id, tier_min_tokens, tier_max_tokens, price_input_text, price_input_image, price_input_video,
                price_input_audio, price_output_text, price_output_text_thinking, price_output_audio
         FROM model_pricing ORDER BY model_id, tier_min_tokens""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        tiers.getOrPut(c.getString(0)) { ArrayList() }.add(pricingRow(c, 1))
      }
    }
    val out = ArrayList<SyncModelDefRow>()
    db.rawQuery(
      """SELECT id, category, provider, display_name, modalities, context_window, notes, deprecated, updated_at, currency
         FROM model_registry ORDER BY category DESC, id DESC""".trimIndent(),
      null,
    ).use { c ->
      fun str(i: Int) = if (c.isNull(i)) null else c.getString(i)
      while (c.moveToNext()) {
        val id = c.getString(0)
        out.add(SyncModelDefRow(
          id, c.getString(1), c.getString(2), str(3), str(4),
          if (c.isNull(5)) null else c.getLong(5), str(6), c.getInt(7), c.getString(8), c.getString(9),
          tiers[id] ?: emptyList(),
        ))
      }
    }
    return out
  }

  private fun pricingRow(c: android.database.Cursor, from: Int): SyncModelPricingRow {
    fun dbl(i: Int) = if (c.isNull(from + i)) null else c.getDouble(from + i)
    return SyncModelPricingRow(
      c.getLong(from), if (c.isNull(from + 1)) null else c.getLong(from + 1),
      dbl(2), dbl(3), dbl(4), dbl(5), dbl(6), dbl(7), dbl(8),
    )
  }

  fun getFeatureBinding(feature: String): String? =
    queryString(readableDatabase, "SELECT model_id FROM feature_bindings WHERE feature = ?", arrayOf(feature))

  fun listFeatureBindings(): List<SyncFeatureBindingRow> {
    val out = ArrayList<SyncFeatureBindingRow>()
    readableDatabase.rawQuery("SELECT feature, model_id, updated_at FROM feature_bindings ORDER BY feature", null).use { c ->
      while (c.moveToNext()) out.add(SyncFeatureBindingRow(c.getString(0), c.getString(1), c.getString(2)))
    }
    return out
  }

  /**
   * 手机端改绑定：updated_at=now → 下轮 LWW 同步推给 desktop。
   * 必须用 UTC ISO：desktop 这张表写的是 to_rfc3339，本地时间格式当天比较永远输（空格 < 'T'）。
   */
  fun setFeatureBinding(feature: String, modelId: String) {
    writableDatabase.execSQL(
      "INSERT OR REPLACE INTO feature_bindings (feature, model_id, updated_at) VALUES (?, ?, ?)",
      arrayOf(feature, modelId, utcNowIso()),
    )
  }

  private fun callLogRow(c: android.database.Cursor) = SyncModelCallLogRow(
    c.getString(0), if (c.isNull(1)) null else c.getString(1),
    c.getString(2), c.getString(3), c.getString(4),
    if (c.isNull(5)) null else c.getLong(5),
    c.getLong(6), c.getLong(7), c.getLong(8), c.getLong(9),
    c.getLong(10), c.getLong(11),
    if (c.isNull(12)) null else c.getDouble(12),
    c.getLong(13), c.getDouble(14), c.getInt(15),
    if (c.isNull(16)) null else c.getString(16),
    if (c.isNull(17)) null else c.getString(17),
    if (c.isNull(18)) null else c.getDouble(18),
  )

  fun getModelCallLog(id: String): SyncModelCallLogRow? =
    readableDatabase.rawQuery("SELECT $CALL_LOG_COLUMNS FROM model_call_log WHERE id = ? LIMIT 1", arrayOf(id)).use { c ->
      if (c.moveToFirst()) callLogRow(c) else null
    }

  /** 对齐 desktop query_call_log：按时间倒序，各条件可选；limit 为 null 时不限条数。 */
  fun queryCallLog(
    timeFrom: String?, timeTo: String?, feature: String?, modelId: String?, apiKeyId: String?, limit: Int?,
  ): List<SyncModelCallLogRow> {
    val sql = StringBuilder("SELECT $CALL_LOG_COLUMNS FROM model_call_log WHERE 1=1")
    val args = ArrayList<String>()
    if (timeFrom != null) { sql.append(" AND started_at >= ?"); args.add(timeFrom) }
    if (timeTo != null) { sql.append(" AND started_at <  ?"); args.add(timeTo) }
    if (feature != null) { sql.append(" AND feature = ?"); args.add(feature) }
    if (modelId != null) { sql.append(" AND model_id = ?"); args.add(modelId) }
    if (apiKeyId != null) { sql.append(" AND api_key_id = ?"); args.add(apiKeyId) }
    sql.append(" ORDER BY started_at DESC")
    if (limit != null) sql.append(" LIMIT ").append(limit.coerceAtLeast(1))
    val out = ArrayList<SyncModelCallLogRow>()
    readableDatabase.rawQuery(sql.toString(), args.toTypedArray()).use { c ->
      while (c.moveToNext()) out.add(callLogRow(c))
    }
    return out
  }

  /** 用量明细（含同步来的 desktop 记录），since 为 ISO 起始时间 */
  fun queryModelCallLog(since: String?, limit: Int): List<SyncModelCallLogRow> =
    queryCallLog(since, null, null, null, null, limit.coerceIn(1, 5000))

  data class CallLogBucketRow(
    val bucket: String, val callCount: Long, val promptTokensTotal: Long, val completionTokensTotal: Long,
    val costCnyTotal: Double, val costUsdTotal: Double,
  )

  /** 对齐 desktop aggregate_call_log：按本地时间分桶（started_at 是 UTC，日历按本地日期取）。 */
  fun aggregateCallLog(
    timeFrom: String, timeTo: String, granularity: String, feature: String?, modelId: String?, apiKeyId: String?,
  ): List<CallLogBucketRow> {
    val bucketExpr = when (granularity) {
      "minute" -> "strftime('%Y-%m-%dT%H:%M:00', started_at, 'localtime')"
      "hour" -> "strftime('%Y-%m-%dT%H:00:00', started_at, 'localtime')"
      else -> "strftime('%Y-%m-%d', started_at, 'localtime')"
    }
    val sql = StringBuilder(
      """SELECT $bucketExpr AS bucket,
                COUNT(*) AS call_count,
                COALESCE(SUM(prompt_text_tokens + prompt_image_tokens + prompt_video_tokens + prompt_audio_tokens), 0) AS p_total,
                COALESCE(SUM(completion_text_tokens + completion_audio_tokens), 0) AS c_total,
                COALESCE(SUM(cost_cny), 0) AS cost_total,
                COALESCE(SUM(cost_usd), 0) AS cost_usd_total
         FROM model_call_log
         WHERE started_at >= ? AND started_at < ?""".trimIndent()
    )
    val args = arrayListOf(timeFrom, timeTo)
    if (feature != null) { sql.append(" AND feature = ?"); args.add(feature) }
    if (modelId != null) { sql.append(" AND model_id = ?"); args.add(modelId) }
    if (apiKeyId != null) { sql.append(" AND api_key_id = ?"); args.add(apiKeyId) }
    sql.append(" GROUP BY bucket ORDER BY bucket ASC")
    val out = ArrayList<CallLogBucketRow>()
    readableDatabase.rawQuery(sql.toString(), args.toTypedArray()).use { c ->
      while (c.moveToNext()) {
        if (c.isNull(0)) continue
        out.add(CallLogBucketRow(c.getString(0), c.getLong(1), c.getLong(2), c.getLong(3), c.getDouble(4), c.getDouble(5)))
      }
    }
    return out
  }

  fun listModelFreeQuota(): List<SyncModelFreeQuotaRow> {
    val out = ArrayList<SyncModelFreeQuotaRow>()
    readableDatabase.rawQuery(
      """SELECT model_id, has_free_quota, not_supported, used_tokens, total_tokens,
                remaining_tokens, used_percent, expire_date, raw_quota, scanned_at, error_message
         FROM model_free_quota
         ORDER BY remaining_tokens DESC, model_id""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        out.add(SyncModelFreeQuotaRow(
          c.getString(0), c.getInt(1), c.getInt(2),
          c.getLong(3), c.getLong(4), c.getLong(5),
          if (c.isNull(6)) null else c.getString(6),
          if (c.isNull(7)) null else c.getString(7),
          if (c.isNull(8)) null else c.getString(8),
          c.getString(9),
          if (c.isNull(10)) null else c.getString(10),
        ))
      }
    }
    return out
  }

  data class LogModelCallRequest(
    val apiKeyId: String?, val feature: String, val modelId: String, val startedAt: String, val durationMs: Long?,
    val promptTextTokens: Long, val promptImageTokens: Long, val promptVideoTokens: Long, val promptAudioTokens: Long,
    val completionTextTokens: Long, val completionAudioTokens: Long,
    val success: Boolean, val errorMessage: String?, val metadata: String?,
  )

  /** 记一次模型调用（对齐 desktop log_model_call：按价目算费用、抵扣免费额度），随下轮同步推给 desktop。 */
  fun logModelCall(req: LogModelCallRequest): SyncModelCallLogRow {
    val db = writableDatabase
    db.beginTransaction()
    try {
      val tiers = ArrayList<SyncModelPricingRow>()
      db.rawQuery(
        """SELECT tier_min_tokens, tier_max_tokens, price_input_text, price_input_image, price_input_video,
                  price_input_audio, price_output_text, price_output_text_thinking, price_output_audio
           FROM model_pricing WHERE model_id = ? ORDER BY tier_min_tokens""".trimIndent(),
        arrayOf(req.modelId),
      ).use { c -> while (c.moveToNext()) tiers.add(pricingRow(c, 0)) }
      val currency = queryString(db, "SELECT currency FROM model_registry WHERE id = ?", arrayOf(req.modelId)) ?: "CNY"

      val gross = computeCost(req, tiers) ?: computeAsrDurationCost(req)
      val billable = if (req.success) billableTokenCount(req, tiers) else 0L
      val freeTokens = if (billable > 0) {
        (queryLong(
          db,
          """SELECT remaining_tokens FROM model_free_quota
             WHERE model_id = ? AND has_free_quota = 1 AND not_supported = 0
               AND total_tokens > 0 AND error_message IS NULL""".trimIndent(),
          arrayOf(req.modelId),
        ) ?: 0L).coerceIn(0L, billable)
      } else 0L
      val freeSaved = if (gross != null && billable > 0 && freeTokens > 0) {
        gross * freeTokens.toDouble() / billable.toDouble()
      } else 0.0
      val cost = gross?.let { (it - freeSaved).coerceAtLeast(0.0) }
      val costCny = if (currency == "USD") null else cost
      val costUsd = if (currency == "USD") cost else null

      val id = UUID.randomUUID().toString()
      db.execSQL(
        """INSERT INTO model_call_log
             (id, api_key_id, feature, model_id, started_at, duration_ms,
              prompt_text_tokens, prompt_image_tokens, prompt_video_tokens, prompt_audio_tokens,
              completion_text_tokens, completion_audio_tokens,
              cost_cny, free_quota_tokens, free_quota_saved_cny, success, error_message, metadata, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""".trimIndent(),
        arrayOf(id, req.apiKeyId, req.feature, req.modelId, req.startedAt, req.durationMs,
                req.promptTextTokens, req.promptImageTokens, req.promptVideoTokens, req.promptAudioTokens,
                req.completionTextTokens, req.completionAudioTokens,
                costCny, freeTokens, freeSaved, if (req.success) 1 else 0, req.errorMessage, req.metadata, costUsd),
      )
      if (freeTokens > 0) {
        db.execSQL(
          """UPDATE model_free_quota
             SET used_tokens = MIN(total_tokens, used_tokens + ?),
                 remaining_tokens = MAX(0, total_tokens - MIN(total_tokens, used_tokens + ?))
             WHERE model_id = ? AND has_free_quota = 1 AND not_supported = 0
               AND total_tokens > 0 AND error_message IS NULL""".trimIndent(),
          arrayOf(freeTokens, freeTokens, req.modelId),
        )
      }
      db.setTransactionSuccessful()
      return SyncModelCallLogRow(
        id, req.apiKeyId, req.feature, req.modelId, req.startedAt, req.durationMs,
        req.promptTextTokens, req.promptImageTokens, req.promptVideoTokens, req.promptAudioTokens,
        req.completionTextTokens, req.completionAudioTokens,
        costCny, freeTokens, freeSaved, if (req.success) 1 else 0, req.errorMessage, req.metadata, costUsd,
      )
    } finally {
      db.endTransaction()
    }
  }

  private fun findTier(req: LogModelCallRequest, tiers: List<SyncModelPricingRow>): SyncModelPricingRow? {
    val promptTotal = req.promptTextTokens + req.promptImageTokens + req.promptVideoTokens + req.promptAudioTokens
    return tiers.find { promptTotal >= it.tierMinTokens && (it.tierMaxTokens == null || promptTotal < it.tierMaxTokens) }
  }

  // 3.5 Omni 输出语音时只按音频计费，3.8 Omni 起文本另计
  private fun billsTextWithAudio(modelId: String) = modelId.startsWith("qwen3.8-omni")

  private fun computeCost(req: LogModelCallRequest, tiers: List<SyncModelPricingRow>): Double? {
    val tier = findTier(req, tiers) ?: return null
    fun price(tok: Long, p: Double?) = if (tok <= 0) 0.0 else tok.toDouble() * (p ?: 0.0) / 1_000_000.0
    var total = price(req.promptTextTokens, tier.priceInputText)
    total += price(req.promptImageTokens, tier.priceInputImage ?: tier.priceInputText)
    total += price(req.promptVideoTokens, tier.priceInputVideo ?: tier.priceInputText)
    total += price(req.promptAudioTokens, tier.priceInputAudio)
    if (req.completionAudioTokens > 0) {
      total += price(req.completionAudioTokens, tier.priceOutputAudio)
      if (billsTextWithAudio(req.modelId)) total += price(req.completionTextTokens, tier.priceOutputText)
    } else {
      total += price(req.completionTextTokens, tier.priceOutputText)
    }
    return total
  }

  /** ASR FileTrans 按音频秒数计费，不走 token 价目（对齐 desktop compute_asr_duration_cost）。 */
  private fun computeAsrDurationCost(req: LogModelCallRequest): Double? {
    if (!req.success || req.modelId != "qwen3-asr-flash-filetrans") return null
    val metadata = req.metadata ?: return null
    val seconds = try {
      org.json.JSONObject(metadata).optDouble("usageSeconds", Double.NaN)
    } catch (_: org.json.JSONException) {
      return null
    }
    if (seconds.isNaN() || seconds.isInfinite() || seconds <= 0.0) return null
    return seconds * QWEN3_ASR_FLASH_FILETRANS_PRICE_PER_SECOND_CNY
  }

  private fun billableTokenCount(req: LogModelCallRequest, tiers: List<SyncModelPricingRow>): Long {
    val tier = findTier(req, tiers) ?: return 0
    fun count(tok: Long, p: Double?) = if (tok > 0 && (p ?: 0.0) > 0.0) tok else 0L
    var total = count(req.promptTextTokens, tier.priceInputText)
    total += count(req.promptImageTokens, tier.priceInputImage ?: tier.priceInputText)
    total += count(req.promptVideoTokens, tier.priceInputVideo ?: tier.priceInputText)
    total += count(req.promptAudioTokens, tier.priceInputAudio)
    if (req.completionAudioTokens > 0) {
      total += count(req.completionAudioTokens, tier.priceOutputAudio)
      if (billsTextWithAudio(req.modelId)) total += count(req.completionTextTokens, tier.priceOutputText)
    } else {
      total += count(req.completionTextTokens, tier.priceOutputText)
    }
    return total
  }

  // ── 聊天增量同步（语义对齐 desktop db.rs chat_sync_page / chat_sync_import） ──

  /** 导出 sinceSeq 之后的一页；peerDeviceId 导入来的行不回传给它自己。 */
  fun exportChatPage(sinceSeq: Long, peerDeviceId: String?, maxBytes: Int): ChatSyncPage {
    val db = readableDatabase
    val maxSeq = queryLong(db, "SELECT COALESCE(MAX(seq), 0) FROM chat_sync_log", emptyArray()) ?: 0L
    data class Entry(val seq: Long, val kind: String, val id: String)
    val entries = ArrayList<Entry>()
    db.rawQuery(
      """SELECT seq, kind, entity_id FROM chat_sync_log
         WHERE seq > ? AND (origin IS NULL OR origin <> ?)
         ORDER BY seq LIMIT $CHAT_PAGE_ROWS""".trimIndent(),
      arrayOf(sinceSeq.toString(), peerDeviceId ?: ""),
    ).use { c -> while (c.moveToNext()) entries.add(Entry(c.getLong(0), c.getString(1), c.getString(2))) }

    val sessionIds = LinkedHashSet<String>()
    val messages = ArrayList<SyncChatMessageRow>()
    var bytes = 0
    var lastSeq = sinceSeq
    var truncated = entries.size >= CHAT_PAGE_ROWS
    for (entry in entries) {
      lastSeq = entry.seq
      if (entry.kind == "s") {
        sessionIds.add(entry.id)
      } else {
        val row = loadSyncChatMessage(db, entry.id) ?: continue
        messages.add(row)
        sessionIds.add(row.sessionId)
        bytes += (row.content?.length ?: 0) + (row.toolCalls?.length ?: 0) +
          (row.usageJson?.length ?: 0) + (row.reasoning?.length ?: 0)
      }
      if (bytes >= maxBytes) {
        truncated = true
        break
      }
    }
    return ChatSyncPage(
      deviceId = deviceId(),
      seq = if (truncated) lastSeq else maxSeq,
      more = truncated,
      sessions = sessionIds.mapNotNull { loadSyncChatSession(db, it) },
      messages = messages,
    )
  }

  private fun loadSyncChatMessage(db: SQLiteDatabase, id: String): SyncChatMessageRow? =
    db.rawQuery(
      """SELECT m.id, m.session_id, m.role, m.content, m.tool_calls, m.tool_call_id, m.name, m.timestamp,
                m.audio_path, m.duration_ms, m.usage_json, m.reasoning
         FROM chat_messages m
         WHERE m.id = ? AND m.role IN ('user', 'assistant', 'tool')""".trimIndent(),
      arrayOf(id),
    ).use { c ->
      if (!c.moveToFirst()) return@use null
      fun str(i: Int) = if (c.isNull(i)) null else c.getString(i)
      SyncChatMessageRow(
        c.getString(0), c.getString(1), c.getString(2), str(3), str(4), str(5), str(6), c.getString(7),
        str(8), if (c.isNull(9)) null else c.getLong(9), str(10), str(11),
      )
    }

  // 空会话不外发：两端都会清理空会话，发出去只会被对方当成新会话再推回来。墓碑要发，否则删除传不过去。
  private fun loadSyncChatSession(db: SQLiteDatabase, id: String): SyncChatSessionRow? =
    db.rawQuery(
      """SELECT s.id, s.title, s.summary, s.created_at, s.updated_at,
                COALESCE(s.meta_updated_at, s.created_at), s.deleted_at
         FROM chat_sessions s
         WHERE s.id = ? AND (s.deleted_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id))""".trimIndent(),
      arrayOf(id),
    ).use { c ->
      if (!c.moveToFirst()) return@use null
      SyncChatSessionRow(
        c.getString(0), c.getString(1), if (c.isNull(2)) null else c.getString(2),
        c.getString(3), c.getString(4), c.getString(5), if (c.isNull(6)) null else c.getString(6),
      )
    }

  private data class LocalChatSession(
    val meta: String, val updatedAt: String, val title: String, val summary: String?, val deletedAt: String?,
  )

  /** 按码点比较。Kotlin 默认按 UTF-16 码元比，emoji 和全角标点的先后和 desktop（UTF-8 字节序）相反，两端就会各选各的。 */
  private fun compareCodePoints(a: String, b: String): Int {
    var i = 0
    var j = 0
    while (i < a.length && j < b.length) {
      val ca = a.codePointAt(i)
      val cb = b.codePointAt(j)
      if (ca != cb) return ca.compareTo(cb)
      i += Character.charCount(ca)
      j += Character.charCount(cb)
    }
    return (a.length - i).compareTo(b.length - j)
  }

  /**
   * 同 id 的消息只有写入它的那台设备会改，而且只会变长（流式途中也落盘，可能先同步出去半截）。
   * 长的赢，等长比内容，两端选同一个。不能「收到就覆盖」：第三台设备转发的旧版本会盖掉新版本。
   * desktop db.rs chat_message_grows 是同一规则。
   */
  private fun chatMessageGrows(row: SyncChatMessageRow, localContent: String?, localReasoning: String?): Boolean {
    val content = row.content.orEmpty()
    val reasoning = row.reasoning.orEmpty()
    val oldContent = localContent.orEmpty()
    val oldReasoning = localReasoning.orEmpty()
    val size = content.codePointCount(0, content.length) + reasoning.codePointCount(0, reasoning.length)
    val oldSize = oldContent.codePointCount(0, oldContent.length) + oldReasoning.codePointCount(0, oldReasoning.length)
    if (size != oldSize) return size > oldSize
    val byContent = compareCodePoints(content, oldContent)
    return if (byContent != 0) byContent > 0 else compareCodePoints(reasoning, oldReasoning) > 0
  }

  /**
   * 会话元数据按 meta_updated_at LWW，时间相同比标题和摘要，两端才会选同一个；
   * 删除优先且不可撤销；updated_at 取较大值；消息按 id 并集，同 id 只接受变长的版本（见 chatMessageGrows）。
   * desktop db.rs chat_sync_import 是同一套规则，改这里要一起改。
   */
  fun importChatPage(
    fromDeviceId: String,
    sessions: List<SyncChatSessionRow>,
    messages: List<SyncChatMessageRow>,
  ): ImportResult {
    val db = writableDatabase
    db.beginTransaction()
    try {
      val before = queryLong(db, "SELECT COALESCE(MAX(seq), 0) FROM chat_sync_log", emptyArray()) ?: 0L
      var skipped = 0
      var mSessions = 0
      // 合并结果和对方发来的不一样：对方还不知道本地这份，日志不能标成来自对方
      val keepLocal = ArrayList<String>()
      for (row in sessions) {
        val local = db.rawQuery(
          """SELECT COALESCE(meta_updated_at, created_at), updated_at, title, summary, deleted_at
             FROM chat_sessions WHERE id = ?""".trimIndent(),
          arrayOf(row.id),
        ).use { c ->
          if (!c.moveToFirst()) return@use null
          LocalChatSession(
            c.getString(0), c.getString(1), c.getString(2),
            if (c.isNull(3)) null else c.getString(3),
            if (c.isNull(4)) null else c.getString(4),
          )
        }
        if (local == null) {
          db.execSQL(
            """INSERT INTO chat_sessions (id, title, summary, created_at, updated_at, meta_updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""".trimIndent(),
            arrayOf(row.id, row.title, row.summary, row.createdAt, row.updatedAt, row.metaUpdatedAt, row.deletedAt),
          )
          if (row.deletedAt == null) mSessions++
          continue
        }
        var order = compareCodePoints(row.metaUpdatedAt, local.meta)
        if (order == 0) order = compareCodePoints(row.title, local.title)
        if (order == 0) order = compareCodePoints(row.summary.orEmpty(), local.summary.orEmpty())
        val newer = order > 0
        val applyMeta = when {
          local.deletedAt != null && row.deletedAt == null -> false
          local.deletedAt == null && row.deletedAt != null -> true
          else -> newer
        }
        val sameMeta = row.metaUpdatedAt == local.meta && row.title == local.title &&
          row.summary == local.summary && row.deletedAt == local.deletedAt
        if (!(applyMeta || sameMeta) || local.updatedAt > row.updatedAt) keepLocal.add(row.id)
        var changed = false
        if (applyMeta) {
          db.execSQL(
            "UPDATE chat_sessions SET title = ?, summary = ?, meta_updated_at = ?, deleted_at = ? WHERE id = ?",
            arrayOf(row.title, row.summary, row.metaUpdatedAt, row.deletedAt, row.id),
          )
          if (row.deletedAt != null) {
            db.execSQL("DELETE FROM chat_messages WHERE session_id = ?", arrayOf(row.id))
          }
          changed = true
        }
        if (row.updatedAt > local.updatedAt) {
          db.execSQL("UPDATE chat_sessions SET updated_at = ? WHERE id = ?", arrayOf(row.updatedAt, row.id))
          changed = true
        }
        if (changed) mSessions++ else skipped++
      }

      val alive = HashSet<String>()
      db.rawQuery("SELECT id FROM chat_sessions WHERE deleted_at IS NULL", null).use { c ->
        while (c.moveToNext()) alive.add(c.getString(0))
      }
      var mMessages = 0
      for (row in messages) {
        if (row.sessionId !in alive) { skipped++; continue }
        val local = db.rawQuery("SELECT content, reasoning FROM chat_messages WHERE id = ?", arrayOf(row.id)).use { c ->
          if (c.moveToFirst()) {
            Pair(if (c.isNull(0)) null else c.getString(0), if (c.isNull(1)) null else c.getString(1))
          } else {
            null
          }
        }
        if (local == null) {
          db.execSQL(
            """INSERT INTO chat_messages
                 (id, session_id, role, content, tool_calls, tool_call_id, name, timestamp,
                  audio_path, duration_ms, usage_json, reasoning)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""".trimIndent(),
            arrayOf(row.id, row.sessionId, row.role, row.content, row.toolCalls, row.toolCallId, row.name,
                    row.timestamp, row.audioPath, row.durationMs, row.usageJson, row.reasoning),
          )
          mMessages++
          continue
        }
        if (!chatMessageGrows(row, local.first, local.second)) { skipped++; continue }
        db.execSQL(
          """UPDATE chat_messages
             SET content = ?, reasoning = ?, tool_calls = COALESCE(?, tool_calls), tool_call_id = COALESCE(?, tool_call_id),
                 name = COALESCE(?, name), audio_path = COALESCE(?, audio_path), duration_ms = COALESCE(?, duration_ms),
                 usage_json = COALESCE(?, usage_json)
             WHERE id = ?""".trimIndent(),
          arrayOf(row.content, row.reasoning, row.toolCalls, row.toolCallId,
                  row.name, row.audioPath, row.durationMs, row.usageJson, row.id),
        )
        // chat_messages 没有 UPDATE 触发器，手动登记，第三台设备才收得到
        db.execSQL("INSERT OR REPLACE INTO chat_sync_log (kind, entity_id) VALUES ('m', ?)", arrayOf(row.id))
        mMessages++
      }
      db.execSQL("UPDATE chat_sync_log SET origin = ? WHERE seq > ?", arrayOf(fromDeviceId, before))
      for (id in keepLocal) {
        db.execSQL(
          "UPDATE chat_sync_log SET origin = NULL WHERE kind = 's' AND entity_id = ? AND seq > ?",
          arrayOf(id, before),
        )
      }
      db.setTransactionSuccessful()
      return ImportResult(chatSessions = mSessions, chatMessages = mMessages, skipped = skipped)
    } finally {
      db.endTransaction()
    }
  }

  fun chatSyncCursor(peerDeviceId: String): ChatCursor =
    readableDatabase.rawQuery(
      "SELECT pull_seq, push_seq FROM chat_sync_cursor WHERE peer_device_id = ?",
      arrayOf(peerDeviceId),
    ).use { c -> if (c.moveToFirst()) ChatCursor(c.getLong(0), c.getLong(1)) else ChatCursor(0, 0) }

  fun saveChatPullSeq(peerDeviceId: String, seq: Long) {
    writableDatabase.execSQL(
      """INSERT INTO chat_sync_cursor (peer_device_id, pull_seq) VALUES (?, ?)
         ON CONFLICT(peer_device_id) DO UPDATE SET pull_seq = excluded.pull_seq""".trimIndent(),
      arrayOf(peerDeviceId, seq),
    )
  }

  fun saveChatPushSeq(peerDeviceId: String, seq: Long) {
    writableDatabase.execSQL(
      """INSERT INTO chat_sync_cursor (peer_device_id, push_seq) VALUES (?, ?)
         ON CONFLICT(peer_device_id) DO UPDATE SET push_seq = excluded.push_seq""".trimIndent(),
      arrayOf(peerDeviceId, seq),
    )
  }

  // ── 聊天会话 CRUD（语义对齐 desktop api.rs /api/sessions/*） ──

  data class ChatSessionRow(
    val id: String, val title: String, val summary: String?,
    val createdAt: String, val updatedAt: String, val messageCount: Int,
  )

  data class ChatMessageRow(
    val id: String, val role: String, val content: String?,
    val timestamp: String, val audioPath: String?, val durationMs: Long?,
    val usageJson: String?, val reasoning: String?,
    val toolCalls: String? = null, val toolCallId: String? = null, val name: String? = null,
  )

  fun createChatSession(): ChatSessionRow {
    val id = UUID.randomUUID().toString()
    val now = utcNowIso()
    writableDatabase.execSQL(
      """INSERT INTO chat_sessions (id, title, summary, created_at, updated_at, meta_updated_at)
         VALUES (?, '新会话', NULL, ?, ?, ?)""".trimIndent(),
      arrayOf(id, now, now, now),
    )
    return ChatSessionRow(id, "新会话", null, now, now, 0)
  }

  fun listChatSessions(limit: Int): List<ChatSessionRow> {
    val out = ArrayList<ChatSessionRow>()
    readableDatabase.rawQuery(
      """SELECT s.id, s.title, s.summary, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS cnt
         FROM chat_sessions s
         WHERE s.deleted_at IS NULL
         ORDER BY s.updated_at DESC LIMIT ${limit.coerceIn(1, 100)}""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        out.add(ChatSessionRow(
          c.getString(0), c.getString(1),
          if (c.isNull(2)) null else c.getString(2),
          c.getString(3), c.getString(4), c.getInt(5),
        ))
      }
    }
    return out
  }

  private fun readChatMessageRow(c: Cursor) = ChatMessageRow(
    c.getString(0), c.getString(1),
    if (c.isNull(2)) null else c.getString(2),
    c.getString(3),
    if (c.isNull(4)) null else c.getString(4),
    if (c.isNull(5)) null else c.getLong(5),
    if (c.isNull(6)) null else c.getString(6),
    if (c.isNull(7)) null else c.getString(7),
    if (c.isNull(8)) null else c.getString(8),
    if (c.isNull(9)) null else c.getString(9),
    if (c.isNull(10)) null else c.getString(10),
  )

  fun getChatMessages(sessionId: String): List<ChatMessageRow> {
    val out = ArrayList<ChatMessageRow>()
    // 同一毫秒写入的 tool_calls 和工具结果靠 rowid 保持写入顺序（id 是随机串，比它没有意义）
    readableDatabase.rawQuery(
      "SELECT $CHAT_MESSAGE_COLUMNS FROM chat_messages WHERE session_id = ? ORDER BY timestamp, rowid",
      arrayOf(sessionId),
    ).use { c ->
      while (c.moveToNext()) out.add(readChatMessageRow(c))
    }
    return out
  }

  /**
   * 写入消息并 touch 会话 updated_at（对齐 desktop append_chat_messages）。
   * desktop 每条只写一次；手机端界面每次把整个列表回写，流式途中也落盘，所以这里多处理几件事：
   * - 内容没变的行不动，否则增量日志每轮都要重发整个会话；
   * - 已有的行只更新带来的非空字段：回写时没有 tool_calls / usage，角色也可能被界面映射过，不能覆盖；
   * - 空的流式占位不入库，否则第一个字到达前同步一次，对端就多一条空消息。
   * 返回 false = 会话已是墓碑，写入被拒。
   */
  fun appendChatMessages(sessionId: String, rows: List<ChatMessageRow>): Boolean {
    val db = writableDatabase
    db.beginTransaction()
    try {
      // 会话可能刚被同步删掉而界面还开着。写进墓碑的消息谁也看不到，两端也对不上，desktop 同样拒绝。
      // 这里只把结果报给调用方；主人新写的内容由 JS 层接住（solevupdb.ts solevupAppendChatMessages 新建会话接着写）
      val tombstone = db.rawQuery(
        "SELECT 1 FROM chat_sessions WHERE id = ? AND deleted_at IS NOT NULL",
        arrayOf(sessionId),
      ).use { it.moveToFirst() }
      var changed = false
      if (!tombstone) {
        for (r in rows) {
          val local = db.rawQuery(
            "SELECT $CHAT_MESSAGE_COLUMNS FROM chat_messages WHERE id = ?",
            arrayOf(r.id),
          ).use { c -> if (c.moveToFirst()) readChatMessageRow(c) else null }
          if (local == null) {
            // 界面里助手消息叫 agent，库里和 desktop 一样叫 assistant，否则同步导出时会被过滤掉
            val role = if (r.role == "agent") "assistant" else r.role
            if (role == "assistant" && r.content.isNullOrEmpty() && r.reasoning.isNullOrEmpty() && r.toolCalls.isNullOrEmpty()) continue
            db.execSQL(
              """INSERT INTO chat_messages
                   (id, session_id, role, content, timestamp, audio_path, duration_ms, usage_json, reasoning,
                    tool_calls, tool_call_id, name)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""".trimIndent(),
              arrayOf(r.id, sessionId, role, r.content, r.timestamp,
                      r.audioPath, r.durationMs, r.usageJson, r.reasoning,
                      r.toolCalls, r.toolCallId, r.name),
            )
            changed = true
            continue
          }
          val merged = local.copy(
            content = if (r.content.isNullOrEmpty()) local.content else r.content,
            audioPath = r.audioPath ?: local.audioPath,
            durationMs = r.durationMs ?: local.durationMs,
            usageJson = r.usageJson ?: local.usageJson,
            reasoning = r.reasoning ?: local.reasoning,
            toolCalls = r.toolCalls ?: local.toolCalls,
            toolCallId = r.toolCallId ?: local.toolCallId,
            name = r.name ?: local.name,
          )
          if (merged == local) continue
          db.execSQL(
            """UPDATE chat_messages
               SET content = ?, audio_path = ?, duration_ms = ?, usage_json = ?, reasoning = ?,
                   tool_calls = ?, tool_call_id = ?, name = ?
               WHERE id = ?""".trimIndent(),
            arrayOf(merged.content, merged.audioPath, merged.durationMs, merged.usageJson, merged.reasoning,
                    merged.toolCalls, merged.toolCallId, merged.name, r.id),
          )
          // chat_messages 没有 UPDATE 触发器，手动登记才会发给对端（对端按 chatMessageGrows 接受变长的版本）
          db.execSQL("INSERT OR REPLACE INTO chat_sync_log (kind, entity_id) VALUES ('m', ?)", arrayOf(r.id))
          changed = true
        }
      }
      if (changed) {
        // 只增不减：本机时钟偏慢时写小了，对端已有的较大值不会再传回来，两端就一直不一致
        db.execSQL("UPDATE chat_sessions SET updated_at = MAX(updated_at, ?) WHERE id = ?", arrayOf(utcNowIso(), sessionId))
      }
      db.setTransactionSuccessful()
      return !tombstone
    } finally {
      db.endTransaction()
    }
  }

  /** 消息正文开头 [图片:id1,id2] 里引用的所有图片 id（清理本机图片文件用，规则见 src/lib/agent/chat-images.ts） */
  fun chatImageIds(): Set<String> {
    val ids = HashSet<String>()
    readableDatabase.rawQuery(
      "SELECT content FROM chat_messages WHERE content LIKE '[图片:%'", null,
    ).use { c ->
      while (c.moveToNext()) {
        val marker = c.getString(0)?.substringAfter("[图片:", "")?.substringBefore(']') ?: continue
        ids.addAll(marker.split(','))
      }
    }
    return ids
  }

  /** 会话是否已被删除（墓碑）。界面开着的会话被同步删掉时靠它发现；不存在的 id 算没删。 */
  fun isChatSessionDeleted(sessionId: String): Boolean =
    readableDatabase.rawQuery(
      "SELECT 1 FROM chat_sessions WHERE id = ? AND deleted_at IS NOT NULL",
      arrayOf(sessionId),
    ).use { it.moveToFirst() }

  /** 改标题 / 摘要不动 updated_at（它的语义是最后聊天活动，对齐 desktop），只动同步用的 meta_updated_at。墓碑不能改。 */
  fun patchChatSession(sessionId: String, title: String?, summary: String?) {
    val now = utcNowIso()
    if (title != null) {
      writableDatabase.execSQL(
        "UPDATE chat_sessions SET title = ?1, meta_updated_at = $CHAT_META_BUMP_SQL WHERE id = ?3 AND deleted_at IS NULL",
        arrayOf(title, now, sessionId),
      )
    }
    if (summary != null) {
      writableDatabase.execSQL(
        "UPDATE chat_sessions SET summary = ?1, meta_updated_at = $CHAT_META_BUMP_SQL WHERE id = ?3 AND deleted_at IS NULL",
        arrayOf(summary, now, sessionId),
      )
    }
  }

  /** 软删留墓碑让删除能传播；内容立刻清掉。 */
  fun deleteChatSession(sessionId: String) {
    val db = writableDatabase
    val now = utcNowIso()
    db.beginTransaction()
    try {
      db.execSQL("DELETE FROM chat_messages WHERE session_id = ?", arrayOf(sessionId))
      db.execSQL(
        """UPDATE chat_sessions SET title = '', summary = NULL, deleted_at = ?, meta_updated_at = ?
           WHERE id = ? AND deleted_at IS NULL""".trimIndent(),
        arrayOf(now, now, sessionId),
      )
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  /** 清理空会话（对齐 desktop delete_empty_chat_sessions，except 保留当前会话），返回被删的 id。空会话不外发，可以硬删；墓碑不能删。 */
  fun cleanupEmptyChatSessions(exceptId: String?): List<String> {
    val args: Array<String> = if (exceptId != null) arrayOf(exceptId) else emptyArray()
    val where = if (exceptId != null) "AND s.id != ?" else ""
    val db = writableDatabase
    db.beginTransaction()
    try {
      val ids = ArrayList<String>()
      db.rawQuery(
        """SELECT s.id FROM chat_sessions s
           LEFT JOIN chat_messages m ON m.session_id = s.id
           WHERE m.id IS NULL AND s.deleted_at IS NULL $where""".trimIndent(),
        args,
      ).use { c -> while (c.moveToNext()) ids.add(c.getString(0)) }
      for (id in ids) db.delete("chat_sessions", "id = ?", arrayOf(id))
      db.setTransactionSuccessful()
      return ids
    } finally {
      db.endTransaction()
    }
  }

  data class ChatSearchSnippet(val role: String, val excerpt: String, val timestamp: String)
  data class ChatSearchHit(val session: ChatSessionRow, val snippets: List<ChatSearchSnippet>)

  /** 全文搜索（对齐 desktop search_chat_sessions：标题 / 摘要 / 消息内容 LIKE，片段前后约 60 字）。 */
  fun searchChatSessions(query: String, limit: Int): List<ChatSearchHit> {
    val db = readableDatabase
    val q = query.trim()
    if (q.isEmpty()) return emptyList()
    val pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    val sessions = ArrayList<ChatSessionRow>()
    db.rawQuery(
      """SELECT s.id, s.title, s.summary, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id)
         FROM chat_sessions s
         WHERE s.deleted_at IS NULL
           AND (s.title LIKE ?1 ESCAPE '\' OR s.summary LIKE ?1 ESCAPE '\'
                OR EXISTS (SELECT 1 FROM chat_messages m
                           WHERE m.session_id = s.id AND m.content LIKE ?1 ESCAPE '\'))
         ORDER BY s.updated_at DESC LIMIT ${limit.coerceIn(1, 200)}""".trimIndent(),
      arrayOf(pattern),
    ).use { c ->
      while (c.moveToNext()) {
        sessions.add(ChatSessionRow(
          c.getString(0), c.getString(1), if (c.isNull(2)) null else c.getString(2),
          c.getString(3), c.getString(4), c.getInt(5),
        ))
      }
    }
    return sessions.map { s ->
      val snippets = ArrayList<ChatSearchSnippet>()
      db.rawQuery(
        """SELECT role, content, timestamp FROM chat_messages
           WHERE session_id = ?1 AND content LIKE ?2 ESCAPE '\'
           ORDER BY timestamp DESC LIMIT 200""".trimIndent(),
        arrayOf(s.id, pattern),
      ).use { c ->
        while (c.moveToNext()) {
          snippets.add(ChatSearchSnippet(
            c.getString(0), buildExcerpt(if (c.isNull(1)) "" else c.getString(1), q, 60), c.getString(2),
          ))
        }
      }
      ChatSearchHit(s, snippets)
    }
  }

  /** 关键词前后 ctx 个字符的片段，截断处加 ...（对齐 desktop build_excerpt）。按码点算窗口，不切开 emoji。 */
  private fun buildExcerpt(rawContent: String, query: String, ctx: Int): String {
    // 开头的图片标记不算正文（规则见 src/lib/agent/chat-images.ts）
    val content = if (rawContent.startsWith("[图片:")) rawContent.substringAfter(']').trimStart('\n') else rawContent
    val total = content.codePointCount(0, content.length)
    fun head(): String =
      if (total <= ctx * 2) content else content.substring(0, content.offsetByCodePoints(0, ctx * 2))
    if (query.isEmpty() || content.isEmpty()) return head()
    val at = content.indexOf(query, ignoreCase = true)
    if (at < 0) return head()
    val matchAt = content.codePointCount(0, at)
    val start = (matchAt - ctx).coerceAtLeast(0)
    val end = (matchAt + query.codePointCount(0, query.length) + ctx).coerceAtMost(total)
    val body = content.substring(content.offsetByCodePoints(0, start), content.offsetByCodePoints(0, end))
    return (if (start > 0) "..." else "") + body + (if (end < total) "..." else "")
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
    /** 配对时换到的令牌，两台设备各存一份 */
    val authToken: String,
  )

  fun listLinkedDevices(): List<LinkedDevice> {
    val out = ArrayList<LinkedDevice>()
    readableDatabase.rawQuery(
      """SELECT device_id, alias, last_base, last_synced_at, created_at, auth_token
         FROM linked_devices
         ORDER BY COALESCE(last_synced_at, '') DESC, alias ASC""".trimIndent(),
      null,
    ).use { c ->
      while (c.moveToNext()) {
        out.add(LinkedDevice(
          deviceId = c.getString(0), alias = c.getString(1),
          lastBase = c.getString(2),
          lastSyncedAt = if (c.isNull(3)) null else c.getString(3),
          createdAt = c.getString(4),
          authToken = c.getString(5),
        ))
      }
    }
    return out
  }

  /** 令牌属于哪台已链接设备 */
  fun linkedDeviceByToken(token: String): String? =
    queryString(readableDatabase, "SELECT device_id FROM linked_devices WHERE auth_token = ?", arrayOf(token))

  fun linkedDeviceToken(deviceId: String): String? =
    queryString(readableDatabase, "SELECT auth_token FROM linked_devices WHERE device_id = ?", arrayOf(deviceId))

  /** Upsert linked device。如果对端 device_id 已存在（重新配对），刷新 alias、last_base 和令牌。 */
  fun addLinkedDevice(deviceId: String, alias: String, lastBase: String, authToken: String): LinkedDevice {
    val now = nowIso()
    writableDatabase.execSQL(
      """INSERT INTO linked_devices (device_id, alias, last_base, created_at, auth_token)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           alias=excluded.alias, last_base=excluded.last_base, auth_token=excluded.auth_token""".trimIndent(),
      arrayOf(deviceId, alias, lastBase, now, authToken),
    )
    return LinkedDevice(deviceId, alias, lastBase, null, now, authToken)
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

  /** 对方改名后跟着变。只在挑战应答通过后调用 */
  fun updateLinkAlias(deviceId: String, alias: String) {
    writableDatabase.execSQL(
      "UPDATE linked_devices SET alias = ? WHERE device_id = ?", arrayOf(alias, deviceId),
    )
  }

  /** 本机别名：主人改过就用改过的，否则按 device_id 算（对齐 desktop db.rs sync_alias） */
  fun syncAlias(): String =
    queryString(readableDatabase, "SELECT value FROM sync_meta WHERE key = 'device_alias'", emptyArray())
      ?.takeIf { it.isNotBlank() }
      ?: generateAlias(deviceId())

  fun setSyncAlias(alias: String): String {
    val next = alias.trim()
    if (next.isEmpty()) throw IllegalArgumentException("别名不能为空")
    writableDatabase.execSQL(
      "INSERT OR REPLACE INTO sync_meta (key, value, updated_at) VALUES ('device_alias', ?, ?)",
      arrayOf(next, nowIso()),
    )
    return next
  }

  /**
   * 生成跟 desktop db.rs generate_alias 完全一致的"形容词+水果"别名。
   * 算法：FNV-1a hash `solevup:alias:v1:<device_id>`，
   * 拆 hex[0..8]/[8..16] 转 u32 取模 ADJECTIVES / FRUITS。
   * 同一个 device_id 在 mobile / desktop 算出来的 alias 完全相同。
   */
  fun generateAlias(deviceId: String): String {
    val input = "solevup:alias:v1:$deviceId"
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
    private const val DB_NAME = "solevup.db"
    private val LEGACY_DB_NAMES = listOf("solo.db")
    private const val DB_VERSION = 1
    private const val SCHEMA_REV = 3
    private const val CHAT_PAGE_ROWS = 500
    private const val CHAT_MESSAGE_COLUMNS =
      "id, role, content, timestamp, audio_path, duration_ms, usage_json, reasoning, tool_calls, tool_call_id, name"
    // 本机改标题 / 摘要时写入的 meta_updated_at：?2 是当前时间。
    // 本机时钟比已知版本慢时，直接写 now 会让元数据回退：对端已经把序号越过去了，不会再发，两端就永久不一致。
    // 所以取「已知版本 + 1 毫秒」，保证本机的修改总能压过自己见过的版本。desktop db.rs CHAT_META_BUMP_SQL 是同一段 SQL。
    private const val CHAT_META_BUMP_SQL =
      "CASE WHEN COALESCE(meta_updated_at, created_at) >= ?2 " +
        "THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(meta_updated_at, created_at), '+0.001 seconds'), ?2) " +
        "ELSE ?2 END"

    const val PROVIDER_DASHSCOPE = "dashscope"
    const val PROVIDER_ANTHROPIC = "anthropic"
    /** Fish Audio（TTS）。不是聊天模型的提供商，模型中心不列；放这里是为了跟着同步 */
    val SYNCED_SETTING_KEYS = setOf("fish_reference_id", "fish_model")
    const val SEED_SETTING_TIME = "2000-01-01T00:00:00.000Z"
    const val PROVIDER_FISH = "fish"

    private const val FEATURE_BINDING_SEED_TIME = "1970-01-01T00:00:00.000Z"
    private const val CATALOG_SOURCE_SEED = "seed"
    private const val CATALOG_SOURCE_SYNC = "sync"
    private const val QWEN3_ASR_FLASH_FILETRANS_PRICE_PER_SECOND_CNY = 0.00022
    private const val CALL_LOG_COLUMNS =
      "id, api_key_id, feature, model_id, started_at, duration_ms, " +
        "prompt_text_tokens, prompt_image_tokens, prompt_video_tokens, prompt_audio_tokens, " +
        "completion_text_tokens, completion_audio_tokens, cost_cny, " +
        "free_quota_tokens, free_quota_saved_cny, success, error_message, metadata, cost_usd"

    @Volatile private var sharedInstance: SolevupDb? = null

    /** 进程内共用一个 helper：多实例各持连接，同步和聊天并发写时会撞 database is locked。 */
    fun shared(context: Context): SolevupDb =
      sharedInstance ?: synchronized(this) {
        sharedInstance ?: SolevupDb(context).also { sharedInstance = it }
      }

    // 必须跟 desktop db.rs local_now_string() 格式严格一致：
    // `yyyy-MM-dd HH:mm:ss` + 本地时区（无 'T' 无 'Z' 无毫秒）
    // 字符串字典序与真实时间顺序在同时区内一致，LWW 才能正确工作。
    // 之前用 UTC ISO 会让字符串比较错乱（空格 0x20 < 'T' 0x54）：
    //   desktop "2026-05-24 12:00:00"  <  mobile "2026-05-24T11:00:00.000Z"
    //   ASCII 比较被误判为 desktop 更早，LWW 错过 desktop 更新
    // SimpleDateFormat 不是线程安全的，同步线程和 RN 线程会同时调，每次新建
    private fun localFormat() = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).apply {
      timeZone = TimeZone.getDefault()
    }

    private fun utcFormat() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
      timeZone = TimeZone.getTimeZone("UTC")
    }

    fun nowIso(): String = localFormat().format(Date())

    /** desktop 的 chat_* / feature_bindings / Key 表写 to_rfc3339（UTC），这几张表要用同一格式比较。 */
    fun utcNowIso(): String = utcFormat().format(Date())

    private fun localToUtcIso(value: String): String {
      if (value.contains('T')) return value
      return try {
        localFormat().parse(value)?.let { utcFormat().format(it) } ?: value
      } catch (_: Exception) {
        value
      }
    }

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
