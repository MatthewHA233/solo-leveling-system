// ══════════════════════════════════════════════
// ManicTime — 按需只读访问本地 DB
// 不写入，不同步，直接查询原始数据
// ══════════════════════════════════════════════

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MtSpan {
    pub id:         i64,
    pub track:      String,       // "apps" | "tags"
    pub start_at:   String,       // "2026-04-04 13:00:00"
    pub end_at:     String,
    pub title:      String,       // 窗口标题 / 标签全路径
    pub group_name: Option<String>, // 应用名 / 一级标签
    pub color:      Option<String>, // "#F9BA00"
}

/// 查找本机 ManicTime DB 路径
pub fn find_db() -> Option<PathBuf> {
    let path = dirs::data_local_dir()?
        .join("Finkit")
        .join("ManicTime")
        .join("ManicTimeReports.db");
    if path.exists() { Some(path) } else { None }
}

/// 查询某天的 ManicTime spans（apps + tags 两个轨道）
/// date 格式: "2026-04-04"
pub fn query_spans_for_date(date: &str) -> Result<Vec<MtSpan>, String> {
    let db_path = find_db().ok_or_else(|| "未找到 ManicTime DB".to_string())?;

    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).map_err(|e| format!("打开 ManicTime DB 失败: {}", e))?;

    // 使用 WAL 读模式，不阻塞 ManicTime 自身写入
    let _ = conn.execute_batch("PRAGMA journal_mode=WAL;");

    let next_day = next_day_str(date)?;

    let mut spans = Vec::new();
    spans.extend(query_track(&conn, date, &next_day, 3, "apps")?);
    spans.extend(query_track(&conn, date, &next_day, 1, "tags")?);
    spans.sort_by(|a, b| a.start_at.cmp(&b.start_at));

    Ok(spans)
}

fn query_track(
    conn: &Connection,
    date: &str,
    next_day: &str,
    report_id: i64,
    track: &str,
) -> Result<Vec<MtSpan>, String> {
    // apps(ReportId=3): GroupId 直接关联应用颜色
    // tags(ReportId=1): GroupId 为 null，需按路径第一段匹配 Ar_Group.Name 取一级标签颜色
    let sql = if report_id == 1 {
        r#"
        SELECT
            a.ActivityId,
            a.Name,
            a.StartLocalTime,
            a.EndLocalTime,
            g.Name  AS GroupName,
            g.Color AS GroupColor
        FROM Ar_Activity a
        LEFT JOIN Ar_Group g
            ON g.ReportId = a.ReportId
            AND TRIM(g.Name) = TRIM(
                SUBSTR(a.Name, 1,
                    CASE WHEN INSTR(a.Name, ',') > 0
                         THEN INSTR(a.Name, ',') - 1
                         ELSE LENGTH(a.Name)
                    END
                )
            )
        WHERE a.ReportId = ?
          AND a.StartLocalTime < ?
          AND a.EndLocalTime   > ?
        ORDER BY a.StartLocalTime ASC
        "#
    } else {
        r#"
        SELECT
            a.ActivityId,
            a.Name,
            a.StartLocalTime,
            a.EndLocalTime,
            g.Name  AS GroupName,
            g.Color AS GroupColor
        FROM Ar_Activity a
        LEFT JOIN Ar_Group g
            ON g.ReportId = a.ReportId AND g.GroupId = a.GroupId
        WHERE a.ReportId = ?
          AND a.StartLocalTime < ?
          AND a.EndLocalTime   > ?
        ORDER BY a.StartLocalTime ASC
        "#
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(
        rusqlite::params![report_id, next_day, date],
        |row| Ok(MtSpan {
            id:         row.get::<_, i64>(0)?,
            track:      track.to_string(),
            start_at:   row.get::<_, String>(2)?,
            end_at:     row.get::<_, String>(3)?,
            title:      row.get::<_, String>(1)?,
            group_name: row.get::<_, Option<String>>(4)?,
            color:      row.get::<_, Option<String>>(5)?
                           .map(|c| format!("#{}", c)),
        }),
    ).map_err(|e| e.to_string())?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 查找指定日期时间附近的截图文件路径
/// date: "2026-04-04"，time_str: "13:30:00"
/// 截图存在 E:\ManicTimeScreenshots\YYYY-MM-DD\
/// 文件名格式: 2026-04-06_10-03-15_08-00_1431_842_6557_1.jpg（跳过 .thumbnail.jpg）
pub fn find_screenshot_near(date: &str, time_str: &str) -> Option<std::path::PathBuf> {
    let base = std::path::Path::new("E:\\ManicTimeScreenshots").join(date);
    if !base.exists() { return None; }

    let target_secs = parse_time_secs(time_str)?;

    let mut best: Option<(u64, std::path::PathBuf)> = None;
    for entry in std::fs::read_dir(&base).ok()?.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        // 跳过缩略图
        if name.contains(".thumbnail.") { continue; }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if !matches!(ext.as_str(), "jpg" | "jpeg" | "png") { continue; }
        // 文件名格式: YYYY-MM-DD_HH-MM-SS_...
        // 取第二段 HH-MM-SS
        if let Some(file_secs) = parse_screenshot_filename_secs(name) {
            let diff = file_secs.abs_diff(target_secs);
            if diff <= 300 {  // 5 分钟内
                if best.as_ref().map_or(true, |(d, _)| diff < *d) {
                    best = Some((diff, path));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

fn parse_time_secs(t: &str) -> Option<u64> {
    let p: Vec<&str> = t.split(':').collect();
    let h = p.first()?.parse::<u64>().ok()?;
    let m = p.get(1)?.parse::<u64>().ok()?;
    let s = p.get(2).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    Some(h * 3600 + m * 60 + s)
}

/// 文件名: "2026-04-06_10-03-15_..." → 从第二段 "10-03-15" 解析秒数
fn parse_screenshot_filename_secs(name: &str) -> Option<u64> {
    // 格式: YYYY-MM-DD_HH-MM-SS_...
    let parts: Vec<&str> = name.splitn(3, '_').collect();
    if parts.len() < 2 { return None; }
    let time_part = parts[1]; // "10-03-15"
    let t: Vec<&str> = time_part.split('-').collect();
    if t.len() < 3 { return None; }
    let h = t[0].parse::<u64>().ok()?;
    let m = t[1].parse::<u64>().ok()?;
    let s = t[2].parse::<u64>().ok()?;
    if h < 24 && m < 60 && s < 60 { Some(h * 3600 + m * 60 + s) } else { None }
}

/// 从 ManicTime DB 读取 Ar_Group.Icon32 PNG blob（按 group_name + ReportId=3）
pub fn get_app_icon_png(group_name: &str) -> Option<Vec<u8>> {
    let db_path = find_db()?;
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).ok()?;
    let _ = conn.execute_batch("PRAGMA journal_mode=WAL;");

    // 先尝试 Icon32，再 Icon16
    let sql = "SELECT Icon32, Icon16 FROM Ar_Group WHERE ReportId = 3 AND Name = ? LIMIT 1";
    conn.query_row(sql, rusqlite::params![group_name], |row| {
        let icon32: Option<Vec<u8>> = row.get(0)?;
        let icon16: Option<Vec<u8>> = row.get(1)?;
        Ok(icon32.or(icon16))
    }).ok().flatten()
}

/// "2026-04-04" → "2026-04-05"
fn next_day_str(date: &str) -> Result<String, String> {
    use chrono::NaiveDate;
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|e| format!("日期格式错误: {}", e))?;
    Ok((d + chrono::Duration::days(1)).format("%Y-%m-%d").to_string())
}
