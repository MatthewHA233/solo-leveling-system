#!/usr/bin/env python3
"""Materialize app-monitor raw events into compact segments on the host.

This is intentionally a desktop/offline migration:
1. pull solevup_perception.db from the phone with run-as
2. save a timestamped backup on the computer
3. rebuild app_monitor_segments_android for days that still have app-monitor raw
4. delete only app-monitor raw rows (window/power buckets)
5. optionally push the migrated DB back to the phone

The mobile UI should read app_monitor_segments_android only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKUP_ROOT = ROOT / "artifacts" / "app-monitor-db-backups"
PACKAGE = "com.solevup.mobile"
WINDOW_BUCKET_ID = "solevup-watcher-window_android"
POWER_BUCKET_ID = "solevup-watcher-power_android"
DAY_MS = 24 * 60 * 60 * 1000


def run(cmd: list[str], *, input_bytes: bytes | None = None, capture: bool = True) -> subprocess.CompletedProcess:
  return subprocess.run(
    cmd,
    input=input_bytes,
    stdout=subprocess.PIPE if capture else None,
    stderr=subprocess.PIPE if capture else None,
    check=True,
  )


def pick_device(explicit: str | None) -> str:
  if explicit:
    return explicit
  out = run(["adb", "devices"]).stdout.decode("utf-8", "replace").splitlines()
  devices = [line.split()[0] for line in out[1:] if line.strip().endswith("\tdevice")]
  if len(devices) != 1:
    raise SystemExit(f"需要且只需要 1 台 adb device；当前: {devices}")
  return devices[0]


def local_day_key(ms: int) -> str:
  return dt.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")


def local_day_start_ms(day_key: str) -> int:
  d = dt.datetime.strptime(day_key, "%Y-%m-%d")
  return int(d.timestamp() * 1000)


def iso_from_ms(ms: int) -> str:
  return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:23] + "Z"


def ensure_schema(db: sqlite3.Connection) -> None:
  db.executescript(
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
    CREATE INDEX IF NOT EXISTS idx_app_monitor_date_start
      ON app_monitor_segments_android(date_key, start_ms, end_ms);
    CREATE INDEX IF NOT EXISTS idx_app_monitor_kind_start
      ON app_monitor_segments_android(kind, start_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_app_monitor_power_unique
      ON app_monitor_segments_android(kind, event_type, start_ms)
      WHERE kind = 'power';
    """
  )


def is_noise(package_name: str, class_name: str, window_title: str) -> bool:
  title = (window_title or "").strip()
  if not package_name:
    return True
  if package_name in {"com.android.systemui", "com.coloros.smartsidebar"}:
    return True
  if "inputmethod" in package_name or "inputmethodservice.SoftInputWindow" in class_name:
    return True
  if package_name == "com.android.launcher":
    if title.startswith("最近用过的应用") or title.startswith("文件夹已") or title == "应用图标":
      return True
  return title == "应用图标"


def compact_titles_append(titles: list[str], app_label: str, package_name: str, raw_title: str) -> None:
  title = (raw_title or "").strip()
  if not title or title == app_label or title == package_name:
    return
  if not titles or titles[-1] != title:
    titles.append(title)


def insert_app_segment(db: sqlite3.Connection, seg: dict) -> None:
  now = iso_from_ms(int(dt.datetime.now().timestamp() * 1000))
  db.execute(
    """
    INSERT INTO app_monitor_segments_android
      (date_key, kind, start_ms, end_ms, package_name, class_name, app_label,
       window_title, event_type, event_count, titles_json, created_at, updated_at)
    VALUES (?, 'app', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)
    """,
    (
      seg["date_key"],
      seg["start_ms"],
      max(seg["end_ms"], seg["start_ms"]),
      seg["package_name"],
      seg["class_name"],
      seg["app_label"],
      seg["window_title"],
      max(1, seg["event_count"]),
      json.dumps(seg["titles"][-16:], ensure_ascii=False),
      now,
      now,
    ),
  )


def truncate_current_app_segment_at(db: sqlite3.Connection, date_key: str, event_time_ms: int) -> None:
  row = db.execute(
    """
    SELECT id, start_ms, end_ms
    FROM app_monitor_segments_android
    WHERE date_key = ? AND kind = 'app' AND start_ms <= ?
    ORDER BY start_ms DESC, id DESC
    LIMIT 1
    """,
    (date_key, event_time_ms),
  ).fetchone()
  if not row:
    return
  seg_id, start_ms, end_ms = int(row[0]), int(row[1]), int(row[2])
  if start_ms >= event_time_ms or end_ms <= event_time_ms:
    return
  now = iso_from_ms(int(dt.datetime.now().timestamp() * 1000))
  db.execute(
    "UPDATE app_monitor_segments_android SET end_ms = ?, updated_at = ? WHERE id = ?",
    (event_time_ms, now, seg_id),
  )


def insert_power_segment(db: sqlite3.Connection, date_key: str, event_time_ms: int, event: str) -> None:
  if not event or event in {"boot", "shutdown"}:
    return
  if event == "screen_off":
    truncate_current_app_segment_at(db, date_key, event_time_ms)
  now = iso_from_ms(int(dt.datetime.now().timestamp() * 1000))
  db.execute(
    """
    INSERT OR IGNORE INTO app_monitor_segments_android
      (date_key, kind, start_ms, end_ms, package_name, class_name, app_label,
       window_title, event_type, event_count, titles_json, created_at, updated_at)
    VALUES (?, 'power', ?, ?, '', '', '', '', ?, 1, '[]', ?, ?)
    """,
    (date_key, event_time_ms, event_time_ms, event, now, now),
  )


def raw_events(db: sqlite3.Connection, bucket_id: str) -> list[tuple[int, int, dict]]:
  rows: list[tuple[int, int, dict]] = []
  for row_id, raw in db.execute(
    """
    SELECT id, data_json
    FROM perception_events_android
    WHERE bucket_id = ?
    ORDER BY start_at ASC, id ASC
    """,
    (bucket_id,),
  ):
    try:
      obj = json.loads(raw or "{}")
      ts = int(obj.get("event_time_ms") or 0)
      if ts > 0:
        rows.append((int(row_id), ts, obj))
    except Exception:
      continue
  return rows


def materialize(db_path: Path) -> dict[str, int]:
  db = sqlite3.connect(db_path)
  db.row_factory = sqlite3.Row
  ensure_schema(db)
  windows = raw_events(db, WINDOW_BUCKET_ID)
  powers = raw_events(db, POWER_BUCKET_ID)
  raw_days = sorted({local_day_key(ts) for _, ts, _ in windows + powers})
  before_segments = db.execute("SELECT COUNT(*) FROM app_monitor_segments_android").fetchone()[0]

  with db:
    for day_key in raw_days:
      day_start = local_day_start_ms(day_key)
      day_end = day_start + DAY_MS
      day_windows = [(row_id, ts, obj) for row_id, ts, obj in windows if day_start <= ts < day_end]
      day_powers = [(row_id, ts, obj) for row_id, ts, obj in powers if day_start <= ts < day_end]
      raw_min = min([ts for _, ts, _ in day_windows + day_powers], default=day_start)

      current: dict | None = None
      if day_windows:
        seed = db.execute(
          """
          SELECT id, start_ms, end_ms, package_name, class_name, app_label,
            window_title, event_count, titles_json
          FROM app_monitor_segments_android
          WHERE date_key = ? AND kind = 'app' AND start_ms < ?
          ORDER BY start_ms DESC, id DESC
          LIMIT 1
          """,
          (day_key, raw_min),
        ).fetchone()
        if seed:
          db.execute("DELETE FROM app_monitor_segments_android WHERE id = ?", (seed[0],))
          try:
            titles = json.loads(seed[8] or "[]")
          except Exception:
            titles = []
          current = {
            "date_key": day_key,
            "start_ms": int(seed[1]),
            "end_ms": int(seed[2]),
            "package_name": str(seed[3] or ""),
            "class_name": str(seed[4] or ""),
            "app_label": str(seed[5] or ""),
            "window_title": str(seed[6] or ""),
            "event_count": int(seed[7] or 1),
            "titles": [str(t) for t in titles if str(t).strip()],
          }
        db.execute(
          "DELETE FROM app_monitor_segments_android WHERE date_key = ? AND kind = 'app' AND start_ms >= ?",
          (day_key, raw_min),
        )
      if day_powers:
        db.execute(
          "DELETE FROM app_monitor_segments_android WHERE date_key = ? AND kind = 'power' AND start_ms >= ?",
          (day_key, raw_min),
        )

      events = sorted(
        [("window", row_id, ts, obj) for row_id, ts, obj in day_windows]
        + [("power", row_id, ts, obj) for row_id, ts, obj in day_powers],
        key=lambda it: (it[2], it[1]),
      )
      for kind, _, ts, obj in events:
        if kind == "power":
          event = str(obj.get("event") or "")
          if event == "screen_off" and current:
            current["end_ms"] = max(current["start_ms"], ts)
            insert_app_segment(db, current)
            current = None
          insert_power_segment(db, day_key, ts, event)
          continue

        package_name = str(obj.get("package_name") or "")
        class_name = str(obj.get("class_name") or "")
        app_label = str(obj.get("app_label") or package_name)
        window_title = str(obj.get("window_title") or "")
        if is_noise(package_name, class_name, window_title):
          continue
        label = app_label or package_name
        if current and current["package_name"] == package_name and ts <= current["end_ms"]:
          current["end_ms"] = day_end
          current["class_name"] = class_name
          current["app_label"] = label
          current["window_title"] = window_title
          current["event_count"] += 1
          compact_titles_append(current["titles"], label, package_name, window_title)
        else:
          if current:
            if ts <= current["end_ms"]:
              current["end_ms"] = max(current["start_ms"], ts)
            insert_app_segment(db, current)
          current = {
            "date_key": day_key,
            "start_ms": ts,
            "end_ms": day_end,
            "package_name": package_name,
            "class_name": class_name,
            "app_label": label,
            "window_title": window_title,
            "event_count": 1,
            "titles": [],
          }
          compact_titles_append(current["titles"], label, package_name, window_title)
      if current:
        insert_app_segment(db, current)

    if raw_days:
      db.execute(
        "DELETE FROM perception_events_android WHERE bucket_id IN (?, ?)",
        (WINDOW_BUCKET_ID, POWER_BUCKET_ID),
      )
  db.execute("VACUUM")
  after_segments = db.execute("SELECT COUNT(*) FROM app_monitor_segments_android").fetchone()[0]
  raw_left = db.execute(
    "SELECT COUNT(*) FROM perception_events_android WHERE bucket_id IN (?, ?)",
    (WINDOW_BUCKET_ID, POWER_BUCKET_ID),
  ).fetchone()[0]
  db.close()
  return {
    "raw_window": len(windows),
    "raw_power": len(powers),
    "raw_days": len(raw_days),
    "segments_before": before_segments,
    "segments_after": after_segments,
    "raw_left": raw_left,
  }


def pull_db(device: str, out_path: Path) -> None:
  data = run([
    "adb", "-s", device, "exec-out", "run-as", PACKAGE, "cat", "databases/solevup_perception.db"
  ]).stdout
  if not data.startswith(b"SQLite format 3"):
    raise SystemExit("拉取 solevup_perception.db 失败：run-as 输出不是 SQLite DB（需要 debug 包或导出权限）")
  out_path.write_bytes(data)


def push_db(device: str, db_path: Path) -> None:
  run(["adb", "-s", device, "shell", "am", "force-stop", PACKAGE])
  data = db_path.read_bytes()
  run([
    "adb", "-s", device, "shell",
    f"run-as {PACKAGE} sh -c 'mkdir -p files && cat > files/solevup_perception.migrated.db'"
  ], input_bytes=data)
  run([
    "adb", "-s", device, "shell",
    f"run-as {PACKAGE} sh -c 'cp files/solevup_perception.migrated.db databases/solevup_perception.db "
    "&& chmod 600 databases/solevup_perception.db "
    "&& rm -f databases/solevup_perception.db-journal databases/solevup_perception.db-wal databases/solevup_perception.db-shm "
    "files/solevup_perception.migrated.db'"
  ])


def main() -> int:
  p = argparse.ArgumentParser()
  p.add_argument("--device", help="adb serial；不传时要求只有一台 device")
  p.add_argument("--db", type=Path, help="只迁移本地 DB，不从手机 pull")
  p.add_argument("--no-push", action="store_true", help="只生成 migrated DB，不回灌手机")
  args = p.parse_args()

  stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
  backup_dir = BACKUP_ROOT / stamp
  backup_dir.mkdir(parents=True, exist_ok=True)
  before = backup_dir / "perception.before.db"
  migrated = backup_dir / "perception.migrated.db"

  device = None if args.db else pick_device(args.device)
  if args.db:
    shutil.copy2(args.db, before)
  else:
    assert device is not None
    pull_db(device, before)
  shutil.copy2(before, migrated)
  stats = materialize(migrated)

  if device is not None and not args.no_push:
    push_db(device, migrated)

  print(f"backup_dir={backup_dir}")
  for k, v in stats.items():
    print(f"{k}={v}")
  print("pushed=0" if args.no_push or device is None else "pushed=1")
  return 0


if __name__ == "__main__":
  sys.exit(main())
