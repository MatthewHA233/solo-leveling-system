package com.solevup.mobile.solevupdb

import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import java.time.LocalDate
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit
import java.util.UUID

// ══════════════════════════════════════════════
// 昼夜表的计划层：计划任务（plan_nodes）、计划块（planned_blocks）、浮岛与约束（plan_islands / plan_island_checks）
//   逐条对应 desktop：计划任务和计划块是 db.rs 的 add_plan_node / update_plan_node / delete_plan_node /
//   paint_planned_blocks / erase_planned_blocks，浮岛是 islands.rs。
//   浮岛跟着局域网全量同步走，规则两端各有一份（desktop islands.rs 文件头），改要同时改：
//     · 规则按 id 合并，勾选按 (date, island_id, item_id) 合并，updated_at 新的赢
//     · 删规则、取消勾都是软删（deleted_at），对端才知道
//     · 时间戳只到秒：同一行每次本机改动的 updated_at 都比上一次大（同一秒就往后挪一秒）；
//       导入时时间戳相同、对面是删除而本地还在，也采用（删除赢）
// ══════════════════════════════════════════════

data class PlanNodeRow(
  val id: Long, val projectTagId: Long, val parentId: Long?, val title: String, val status: String,
  val sortOrder: Int, val createdAt: String, val updatedAt: String,
  /** 截止日期 YYYY-MM-DD */
  val dueDate: String?,
  /** 0 无 / 1 低 / 2 中 / 3 高 */
  val priority: Int,
  val note: String?, val completedAt: String?,
)

data class PlannedBlockRow(
  val date: String, val minute: Int, val planNodeId: Long, val note: String?, val createdAt: String,
)

/** 一条浮岛规则：doc 是 JSON 文本，结构由 TS 侧定（src/lib/islands/island-model.ts） */
data class IslandRow(
  val id: String, val doc: String, val sortOrder: Long, val createdAt: String, val updatedAt: String,
)

data class IslandCheckRow(val islandId: String, val itemId: String, val doneAt: String)

/** 同步用：规则一行（doc 原样传 JSON 文本），对应 desktop islands.rs SyncIsland */
data class SyncIslandRow(
  val id: String, val doc: String, val sortOrder: Long,
  val createdAt: String, val updatedAt: String, val deletedAt: String?,
)

/** 同步用：某天勾掉的一件事，对应 desktop islands.rs SyncIslandCheck */
data class SyncIslandCheckRow(
  val date: String, val islandId: String, val itemId: String, val doneAt: String,
  val updatedAt: String, val deletedAt: String?,
)

private const val MAX_DOC_BYTES = 32 * 1024
private const val MAX_ID_CHARS = 80
private const val MAX_RANGE_DAYS = 31L

private const val PLAN_NODE_COLUMNS =
  "id, project_tag_id, parent_id, title, status, sort_order, created_at, updated_at, due_date, priority, note, completed_at"

/** 本机改一行时的 updated_at：这一行上次改动就在同一秒或更晚时，往后挪一秒（desktop db.rs BUMPED_UPDATED_AT） */
private fun bumped(column: String, now: String) =
  "CASE WHEN $column >= $now THEN datetime($column, '+1 second') ELSE $now END"

/** 新库和旧库都在打开时补建（不走 onUpgrade，那是破坏式的） */
internal fun ensureIslandTables(db: SQLiteDatabase) {
  db.execSQL(
    """CREATE TABLE IF NOT EXISTS plan_islands (
         id TEXT PRIMARY KEY,
         doc TEXT NOT NULL,
         sort_order INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         deleted_at TEXT
       )""".trimIndent()
  )
  db.execSQL(
    """CREATE TABLE IF NOT EXISTS plan_island_checks (
         date TEXT NOT NULL,
         island_id TEXT NOT NULL,
         item_id TEXT NOT NULL,
         done_at TEXT NOT NULL,
         updated_at TEXT NOT NULL DEFAULT '',
         deleted_at TEXT,
         PRIMARY KEY (date, island_id, item_id)
       )""".trimIndent()
  )
}

/** 截止日期：空 = 清除；否则必须是 YYYY-MM-DD（desktop normalize_due_date） */
private fun normalizeDueDate(raw: String?): String? {
  val s = raw?.trim().orEmpty()
  if (s.isEmpty()) return null
  return try {
    LocalDate.parse(s).toString()
  } catch (_: DateTimeParseException) {
    throw IllegalArgumentException("日期格式不对：$s（要 YYYY-MM-DD）")
  }
}

private fun parseDate(s: String): LocalDate =
  try { LocalDate.parse(s) } catch (_: DateTimeParseException) { throw IllegalArgumentException("日期格式不对：$s") }

private fun validId(id: String) = id.isNotEmpty() && id.length <= MAX_ID_CHARS

/** 规则文档：必须是 JSON 对象、不超过 32KB；返回规范化后的文本 */
private fun docText(doc: String): String {
  if (doc.toByteArray(Charsets.UTF_8).size > MAX_DOC_BYTES) throw IllegalArgumentException("浮岛规则太大了")
  return try { JSONObject(doc).toString() } catch (_: Throwable) { throw IllegalArgumentException("浮岛规则必须是一个 JSON 对象") }
}

private fun docOk(doc: String) =
  doc.toByteArray(Charsets.UTF_8).size <= MAX_DOC_BYTES && runCatching { JSONObject(doc) }.isSuccess

private fun planNodeFrom(c: Cursor) = PlanNodeRow(
  id = c.getLong(0), projectTagId = c.getLong(1),
  parentId = if (c.isNull(2)) null else c.getLong(2),
  title = c.getString(3), status = c.getString(4), sortOrder = c.getInt(5),
  createdAt = c.getString(6), updatedAt = c.getString(7),
  dueDate = c.getString(8), priority = if (c.isNull(9)) 0 else c.getInt(9),
  note = c.getString(10), completedAt = c.getString(11),
)

private fun singleLong(db: SQLiteDatabase, sql: String, args: Array<String>): Long? =
  db.rawQuery(sql, args).use { c -> if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null }

// ── 计划任务 ──

/** projectTagId = null 时返回全部清单的任务 */
fun SolevupDb.listPlanNodes(projectTagId: Long?): List<PlanNodeRow> {
  val out = ArrayList<PlanNodeRow>()
  val (where, args) =
    if (projectTagId == null) "" to emptyArray<String>()
    else "project_tag_id = ? AND " to arrayOf(projectTagId.toString())
  readableDatabase.rawQuery(
    """SELECT $PLAN_NODE_COLUMNS FROM plan_nodes
       WHERE ${where}deleted_at IS NULL
       ORDER BY project_tag_id, COALESCE(parent_id, 0), sort_order ASC, id ASC""".trimIndent(),
    args,
  ).use { c -> while (c.moveToNext()) out.add(planNodeFrom(c)) }
  return out
}

fun SolevupDb.addPlanNode(
  projectTagId: Long, parentId: Long?, rawTitle: String, dueDate: String?, priority: Int?,
): PlanNodeRow {
  val title = rawTitle.trim()
  if (title.isEmpty()) throw IllegalArgumentException("计划节点标题不能为空")
  val db = writableDatabase
  singleLong(db, "SELECT id FROM activity_tags WHERE id = ?", arrayOf(projectTagId.toString()))
    ?: throw IllegalArgumentException("项目标签不存在")
  if (parentId != null) {
    val parentProject = singleLong(db, "SELECT project_tag_id FROM plan_nodes WHERE id = ?", arrayOf(parentId.toString()))
      ?: throw IllegalArgumentException("父计划节点不存在")
    if (parentProject != projectTagId) throw IllegalArgumentException("父计划节点不属于当前项目")
  }
  val now = SolevupDb.nowIso()
  val sortOrder = (
    if (parentId == null) singleLong(
      db, "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM plan_nodes WHERE project_tag_id = ? AND parent_id IS NULL",
      arrayOf(projectTagId.toString()),
    ) else singleLong(
      db, "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM plan_nodes WHERE project_tag_id = ? AND parent_id = ?",
      arrayOf(projectTagId.toString(), parentId.toString()),
    )
  )?.toInt() ?: 0
  val due = normalizeDueDate(dueDate)
  val prio = (priority ?: 0).coerceIn(0, 3)
  val syncId = UUID.randomUUID().toString()
  db.execSQL(
    """INSERT INTO plan_nodes (sync_id, project_tag_id, parent_id, title, status, sort_order, created_at, updated_at, due_date, priority)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)""".trimIndent(),
    arrayOf(syncId, projectTagId, parentId, title, sortOrder, now, now, due, prio),
  )
  val id = singleLong(db, "SELECT id FROM plan_nodes WHERE sync_id = ?", arrayOf(syncId))
    ?: throw IllegalStateException("新增计划节点失败")
  return PlanNodeRow(id, projectTagId, parentId, title, "active", sortOrder, now, now, due, prio, null, null)
}

/**
 * 改任务。每个参数 null = 不改；dueDate / note 传空串 = 清除（desktop update_plan_node 同样的约定）
 */
fun SolevupDb.updatePlanNode(
  id: Long, title: String?, status: String?, dueDate: String?, priority: Int?, note: String?,
) {
  val db = writableDatabase
  val now = SolevupDb.nowIso()
  db.beginTransaction()
  try {
    if (title != null) {
      val t = title.trim()
      if (t.isEmpty()) throw IllegalArgumentException("计划节点标题不能为空")
      db.execSQL("UPDATE plan_nodes SET title = ?, updated_at = ? WHERE id = ?", arrayOf(t, now, id))
    }
    if (status != null) {
      if (status !in setOf("active", "done", "archived")) throw IllegalArgumentException("计划状态不合法")
      // 勾掉记下完成时间；重新打开清掉（已经是 done 的再次 done 不改原时间）
      db.execSQL(
        """UPDATE plan_nodes
           SET completed_at = CASE
                 WHEN ?1 = 'done' THEN COALESCE(CASE WHEN status = 'done' THEN completed_at END, ?2)
                 WHEN ?1 = 'active' THEN NULL
                 ELSE completed_at END,
               status = ?1, updated_at = ?2
           WHERE id = ?3""".trimIndent(),
        arrayOf(status, now, id),
      )
    }
    if (dueDate != null) {
      db.execSQL("UPDATE plan_nodes SET due_date = ?, updated_at = ? WHERE id = ?", arrayOf(normalizeDueDate(dueDate), now, id))
    }
    if (priority != null) {
      db.execSQL("UPDATE plan_nodes SET priority = ?, updated_at = ? WHERE id = ?", arrayOf(priority.coerceIn(0, 3), now, id))
    }
    if (note != null) {
      val n = note.trim().ifEmpty { null }
      db.execSQL("UPDATE plan_nodes SET note = ?, updated_at = ? WHERE id = ?", arrayOf(n, now, id))
    }
    db.setTransactionSuccessful()
  } finally {
    db.endTransaction()
  }
}

/** 删任务：连同子任务、它们的计划块一起软删（desktop delete_plan_node） */
fun SolevupDb.deletePlanNode(id: Long) {
  val db = writableDatabase
  val now = SolevupDb.nowIso()
  val subtree = """WITH RECURSIVE subtree(id) AS (
                     SELECT id FROM plan_nodes WHERE id = ?2
                     UNION ALL
                     SELECT n.id FROM plan_nodes n JOIN subtree s ON n.parent_id = s.id
                   )"""
  db.beginTransaction()
  try {
    db.execSQL(
      "$subtree UPDATE plan_nodes SET deleted_at = ?1, updated_at = ${bumped("updated_at", "?1")} WHERE id IN (SELECT id FROM subtree)",
      arrayOf(now, id),
    )
    db.execSQL(
      "$subtree UPDATE planned_blocks SET deleted_at = ?1, updated_at = ${bumped("updated_at", "?1")} " +
        "WHERE plan_node_id IN (SELECT id FROM subtree) AND deleted_at IS NULL",
      arrayOf(now, id),
    )
    db.setTransactionSuccessful()
  } finally {
    db.endTransaction()
  }
}

// ── 计划块 ──

fun SolevupDb.listPlannedBlocksForDate(date: String): List<PlannedBlockRow> {
  val out = ArrayList<PlannedBlockRow>()
  readableDatabase.rawQuery(
    """SELECT date, minute, plan_node_id, note, created_at FROM planned_blocks
       WHERE date = ? AND deleted_at IS NULL ORDER BY minute ASC""".trimIndent(),
    arrayOf(date),
  ).use { c ->
    while (c.moveToNext()) out.add(PlannedBlockRow(c.getString(0), c.getInt(1), c.getLong(2), c.getString(3), c.getString(4)))
  }
  return out
}

/** 涂计划块；同时更新清单标签和分类的 last_used_at（desktop paint_planned_blocks）。返回写入格数 */
fun SolevupDb.paintPlannedBlocks(date: String, minutes: IntArray, planNodeId: Long): Int {
  if (minutes.isEmpty()) return 0
  val db = writableDatabase
  val projectTagId = singleLong(
    db, "SELECT project_tag_id FROM plan_nodes WHERE id = ? AND deleted_at IS NULL", arrayOf(planNodeId.toString()),
  ) ?: throw IllegalArgumentException("计划节点不存在")
  val categoryId = singleLong(db, "SELECT category_id FROM activity_tags WHERE id = ?", arrayOf(projectTagId.toString()))
    ?: throw IllegalArgumentException("项目标签不存在")
  val now = SolevupDb.nowIso()
  var affected = 0
  db.beginTransaction()
  try {
    for (m in minutes) {
      if (m < 0 || m >= 1440 || m % 5 != 0) continue
      db.execSQL(
        """INSERT INTO planned_blocks (sync_id, date, minute, plan_node_id, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(date, minute) DO UPDATE SET
             plan_node_id = excluded.plan_node_id,
             created_at = excluded.created_at,
             updated_at = CASE WHEN planned_blocks.updated_at >= excluded.updated_at
               THEN datetime(planned_blocks.updated_at, '+1 second') ELSE excluded.updated_at END,
             deleted_at = NULL""".trimIndent(),
        arrayOf(UUID.randomUUID().toString(), date, m, planNodeId, now, now),
      )
      affected++
    }
    db.execSQL("UPDATE activity_tags SET last_used_at = ?, updated_at = ? WHERE id = ?", arrayOf(now, now, projectTagId))
    db.execSQL("UPDATE activity_categories SET last_used_at = ?, updated_at = ? WHERE id = ?", arrayOf(now, now, categoryId))
    db.setTransactionSuccessful()
  } finally {
    db.endTransaction()
  }
  return affected
}

fun SolevupDb.erasePlannedBlocks(date: String, minutes: IntArray): Int {
  if (minutes.isEmpty()) return 0
  val db = writableDatabase
  val now = SolevupDb.nowIso()
  var affected = 0
  db.beginTransaction()
  try {
    for (m in minutes) {
      db.compileStatement(
        "UPDATE planned_blocks SET deleted_at = ?1, updated_at = ${bumped("updated_at", "?1")} WHERE date = ?2 AND minute = ?3",
      ).use { st ->
        st.bindString(1, now); st.bindString(2, date); st.bindLong(3, m.toLong())
        affected += st.executeUpdateDelete()
      }
    }
    db.setTransactionSuccessful()
  } finally {
    db.endTransaction()
  }
  return affected
}

// ── 浮岛与约束 ──

fun SolevupDb.listIslands(): List<IslandRow> {
  val out = ArrayList<IslandRow>()
  readableDatabase.rawQuery(
    """SELECT id, doc, sort_order, created_at, updated_at FROM plan_islands
       WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC""".trimIndent(),
    null,
  ).use { c ->
    while (c.moveToNext()) {
      val doc = c.getString(1)
      // 一条坏了不拖累其他的：跳过
      if (!docOk(doc)) continue
      out.add(IslandRow(c.getString(0), doc, c.getLong(2), c.getString(3), c.getString(4)))
    }
  }
  return out
}

private fun getIsland(db: SQLiteDatabase, id: String): IslandRow =
  db.rawQuery(
    "SELECT doc, sort_order, created_at, updated_at FROM plan_islands WHERE id = ? AND deleted_at IS NULL",
    arrayOf(id),
  ).use { c ->
    if (!c.moveToFirst()) throw IllegalArgumentException("找不到这条浮岛规则")
    IslandRow(id, c.getString(0), c.getLong(1), c.getString(2), c.getString(3))
  }

fun SolevupDb.createIsland(doc: String): IslandRow {
  val text = docText(doc)
  val id = UUID.randomUUID().toString()
  val now = SolevupDb.nowIso()
  val db = writableDatabase
  val nextOrder = singleLong(db, "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM plan_islands", emptyArray()) ?: 0L
  db.execSQL(
    "INSERT INTO plan_islands (id, doc, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    arrayOf(id, text, nextOrder, now),
  )
  return getIsland(db, id)
}

fun SolevupDb.updateIsland(id: String, doc: String): IslandRow {
  val text = docText(doc)
  val db = writableDatabase
  val n = db.compileStatement(
    "UPDATE plan_islands SET doc = ?3, updated_at = ${bumped("updated_at", "?2")} WHERE id = ?1 AND deleted_at IS NULL",
  ).use { st ->
    st.bindString(1, id); st.bindString(2, SolevupDb.nowIso()); st.bindString(3, text)
    st.executeUpdateDelete()
  }
  if (n == 0) throw IllegalArgumentException("找不到这条浮岛规则")
  return getIsland(db, id)
}

fun SolevupDb.deleteIsland(id: String) {
  val n = writableDatabase.compileStatement(
    "UPDATE plan_islands SET deleted_at = ?2, updated_at = ${bumped("updated_at", "?2")} WHERE id = ?1 AND deleted_at IS NULL",
  ).use { st ->
    st.bindString(1, id); st.bindString(2, SolevupDb.nowIso())
    st.executeUpdateDelete()
  }
  if (n == 0) throw IllegalArgumentException("找不到这条浮岛规则")
}

fun SolevupDb.islandChecksForDate(date: String): List<IslandCheckRow> {
  parseDate(date)
  val out = ArrayList<IslandCheckRow>()
  readableDatabase.rawQuery(
    "SELECT island_id, item_id, done_at FROM plan_island_checks WHERE date = ? AND deleted_at IS NULL",
    arrayOf(date),
  ).use { c -> while (c.moveToNext()) out.add(IslandCheckRow(c.getString(0), c.getString(1), c.getString(2))) }
  return out
}

/** 勾 / 取消勾某天的一件事。已经勾着的再勾不动（保留原来的勾选时刻）；取消是软删 */
fun SolevupDb.setIslandCheck(date: String, islandId: String, itemId: String, done: Boolean) {
  parseDate(date)
  if (!validId(islandId) || !validId(itemId)) throw IllegalArgumentException("浮岛或事项的 id 不对")
  val now = SolevupDb.nowIso()
  val db = writableDatabase
  if (done) {
    db.execSQL(
      """INSERT INTO plan_island_checks (date, island_id, item_id, done_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?4, NULL)
         ON CONFLICT(date, island_id, item_id) DO UPDATE SET
           done_at = excluded.done_at, updated_at = ${bumped("plan_island_checks.updated_at", "?4")}, deleted_at = NULL
         WHERE plan_island_checks.deleted_at IS NOT NULL""".trimIndent(),
      arrayOf(date, islandId, itemId, now),
    )
  } else {
    db.execSQL(
      """UPDATE plan_island_checks SET deleted_at = ?4, updated_at = ${bumped("updated_at", "?4")}
         WHERE date = ?1 AND island_id = ?2 AND item_id = ?3 AND deleted_at IS NULL""".trimIndent(),
      arrayOf(date, islandId, itemId, now),
    )
  }
}

/** 一段日期内的实际记录（含两端，最多 31 天），估「近 7 天平均」用（desktop activity_blocks_range） */
fun SolevupDb.listBlocksInRange(from: String, to: String): List<SolevupDb.BlockRow> {
  val days = ChronoUnit.DAYS.between(parseDate(from), parseDate(to))
  if (days < 0 || days >= MAX_RANGE_DAYS) throw IllegalArgumentException("日期范围要在 1 到 $MAX_RANGE_DAYS 天之间")
  val out = ArrayList<SolevupDb.BlockRow>()
  readableDatabase.rawQuery(
    """SELECT date, minute, sync_id, tag_id, note, created_at, updated_at, deleted_at FROM activity_blocks
       WHERE date >= ? AND date <= ? AND deleted_at IS NULL ORDER BY date ASC, minute ASC""".trimIndent(),
    arrayOf(from, to),
  ).use { c ->
    while (c.moveToNext()) out.add(
      SolevupDb.BlockRow(
        c.getString(0), c.getInt(1), c.getString(2), c.getLong(3),
        c.getString(4), c.getString(5), c.getString(6), c.getString(7),
      ),
    )
  }
  return out
}

// ── 浮岛同步（全量同步里调，规则见文件头） ──

internal object IslandSync {
  fun exportRows(db: SQLiteDatabase, since: String?): Pair<List<SyncIslandRow>, List<SyncIslandCheckRow>> {
    val changed: (String, String?) -> Boolean = { u, d -> since == null || u > since || (d != null && d > since) }
    val islands = ArrayList<SyncIslandRow>()
    db.rawQuery("SELECT id, doc, sort_order, created_at, updated_at, deleted_at FROM plan_islands", null).use { c ->
      while (c.moveToNext()) {
        val u = c.getString(4); val d = c.getString(5)
        if (!changed(u, d)) continue
        islands.add(SyncIslandRow(c.getString(0), c.getString(1), c.getLong(2), c.getString(3), u, d))
      }
    }
    val checks = ArrayList<SyncIslandCheckRow>()
    db.rawQuery(
      "SELECT date, island_id, item_id, done_at, updated_at, deleted_at FROM plan_island_checks", null,
    ).use { c ->
      while (c.moveToNext()) {
        val u = c.getString(4); val d = c.getString(5)
        if (!changed(u, d)) continue
        checks.add(SyncIslandCheckRow(c.getString(0), c.getString(1), c.getString(2), c.getString(3), u, d))
      }
    }
    return islands to checks
  }

  /** 返回 (写进去的规则数, 写进去的勾选数, 跳过数)。调用方负责事务 */
  fun importRows(db: SQLiteDatabase, islands: List<SyncIslandRow>, checks: List<SyncIslandCheckRow>): Triple<Int, Int, Int> {
    var appliedIslands = 0; var appliedChecks = 0; var skipped = 0
    for (row in islands) {
      if (!validId(row.id) || !docOk(row.doc)) { skipped++; continue }
      val n = db.compileStatement(
        """INSERT INTO plan_islands (id, doc, sort_order, created_at, updated_at, deleted_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(id) DO UPDATE SET
             doc = excluded.doc, sort_order = excluded.sort_order, created_at = excluded.created_at,
             updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
           WHERE excluded.updated_at > plan_islands.updated_at
              OR (excluded.updated_at = plan_islands.updated_at
                  AND excluded.deleted_at IS NOT NULL AND plan_islands.deleted_at IS NULL)""".trimIndent(),
      ).use { st ->
        st.bindString(1, row.id); st.bindString(2, row.doc); st.bindLong(3, row.sortOrder)
        st.bindString(4, row.createdAt); st.bindString(5, row.updatedAt)
        if (row.deletedAt == null) st.bindNull(6) else st.bindString(6, row.deletedAt)
        changesAfter(db) { st.execute() }
      }
      if (n > 0) appliedIslands++ else skipped++
    }
    for (row in checks) {
      val dateOk = runCatching { parseDate(row.date) }.isSuccess
      if (!dateOk || !validId(row.islandId) || !validId(row.itemId)) { skipped++; continue }
      val n = db.compileStatement(
        """INSERT INTO plan_island_checks (date, island_id, item_id, done_at, updated_at, deleted_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(date, island_id, item_id) DO UPDATE SET
             done_at = excluded.done_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
           WHERE excluded.updated_at > plan_island_checks.updated_at
              OR (excluded.updated_at = plan_island_checks.updated_at
                  AND excluded.deleted_at IS NOT NULL AND plan_island_checks.deleted_at IS NULL)""".trimIndent(),
      ).use { st ->
        st.bindString(1, row.date); st.bindString(2, row.islandId); st.bindString(3, row.itemId)
        st.bindString(4, row.doneAt); st.bindString(5, row.updatedAt)
        if (row.deletedAt == null) st.bindNull(6) else st.bindString(6, row.deletedAt)
        changesAfter(db) { st.execute() }
      }
      if (n > 0) appliedChecks++ else skipped++
    }
    return Triple(appliedIslands, appliedChecks, skipped)
  }

  /** UPSERT 走 DO UPDATE ... WHERE 没命中时不算改动；executeUpdateDelete 对 INSERT 语句不可靠，用 changes() 读 */
  private inline fun changesAfter(db: SQLiteDatabase, run: () -> Unit): Int {
    run()
    return db.rawQuery("SELECT changes()", null).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }
  }
}
