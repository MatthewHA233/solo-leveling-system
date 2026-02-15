"""
SQLite 数据库管理
异步 SQLite 操作，存储玩家状态、任务、快照等
"""

import json
import aiosqlite
from pathlib import Path
from datetime import datetime
from typing import Any

from .models import Quest, QuestStatus, QuestType, QuestDifficulty, ContextSnapshot


class Database:
    """异步 SQLite 数据库"""

    def __init__(self, db_path: str = "data/system.db"):
        self.db_path = db_path
        self._db: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        """连接数据库并初始化表"""
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(self.db_path)
        self._db.row_factory = aiosqlite.Row
        await self._init_tables()

    async def close(self) -> None:
        if self._db:
            await self._db.close()

    async def _init_tables(self) -> None:
        """创建数据库表"""
        await self._db.executescript("""
            CREATE TABLE IF NOT EXISTS player (
                id INTEGER PRIMARY KEY DEFAULT 1,
                name TEXT NOT NULL,
                level INTEGER DEFAULT 1,
                exp INTEGER DEFAULT 0,
                title TEXT DEFAULT '觉醒者',
                stats_json TEXT DEFAULT '{}',
                titles_unlocked_json TEXT DEFAULT '[]',
                total_quests_completed INTEGER DEFAULT 0,
                created_at TEXT,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS quests (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                difficulty TEXT DEFAULT 'C',
                status TEXT DEFAULT 'pending',
                objectives_json TEXT DEFAULT '[]',
                rewards_json TEXT DEFAULT '{}',
                deadline TEXT,
                source TEXT DEFAULT 'auto',
                context TEXT DEFAULT '',
                exp_reward INTEGER DEFAULT 0,
                created_at TEXT,
                completed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS snapshots (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                screenshot_path TEXT,
                active_window TEXT,
                window_title TEXT,
                ai_analysis TEXT,
                inferred_motive TEXT,
                activity_category TEXT,
                focus_score REAL DEFAULT 0,
                raw_data_json TEXT DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS activity_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                event_type TEXT NOT NULL,
                data_json TEXT DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS buff_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                buff_id TEXT NOT NULL,
                buff_name TEXT NOT NULL,
                is_debuff INTEGER DEFAULT 0,
                effects_json TEXT DEFAULT '{}',
                activated_at TEXT,
                expired_at TEXT
            );
        """)
        await self._db.commit()

    # ── Player ────────────────────────────────────────

    async def save_player(self, player_data: dict[str, Any]) -> None:
        """保存玩家状态"""
        now = datetime.now().isoformat()
        await self._db.execute("""
            INSERT OR REPLACE INTO player
            (id, name, level, exp, title, stats_json, titles_unlocked_json,
             total_quests_completed, created_at, updated_at)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, COALESCE(
                (SELECT created_at FROM player WHERE id=1), ?
            ), ?)
        """, (
            player_data["name"],
            player_data["level"],
            player_data["exp"],
            player_data["title"],
            json.dumps(player_data["stats"]),
            json.dumps(player_data["titles_unlocked"]),
            player_data["total_quests_completed"],
            now, now,
        ))
        await self._db.commit()

    async def load_player(self) -> dict[str, Any] | None:
        """加载玩家状态"""
        async with self._db.execute("SELECT * FROM player WHERE id=1") as cursor:
            row = await cursor.fetchone()
            if not row:
                return None
            return {
                "name": row["name"],
                "level": row["level"],
                "exp": row["exp"],
                "title": row["title"],
                "stats": json.loads(row["stats_json"]),
                "titles_unlocked": json.loads(row["titles_unlocked_json"]),
                "total_quests_completed": row["total_quests_completed"],
            }

    # ── Quests ────────────────────────────────────────

    async def save_quest(self, quest: Quest) -> None:
        """保存任务"""
        await self._db.execute("""
            INSERT OR REPLACE INTO quests
            (id, type, title, description, difficulty, status,
             objectives_json, rewards_json, deadline, source, context,
             exp_reward, created_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            quest.id, quest.type.value, quest.title, quest.description,
            quest.difficulty.value, quest.status.value,
            json.dumps(quest.objectives), json.dumps(quest.rewards),
            quest.deadline.isoformat() if quest.deadline else None,
            quest.source, quest.context, quest.exp_reward,
            quest.created_at.isoformat() if quest.created_at else None,
            quest.completed_at.isoformat() if quest.completed_at else None,
        ))
        await self._db.commit()

    async def get_active_quests(self) -> list[Quest]:
        """获取所有活跃任务"""
        async with self._db.execute(
            "SELECT * FROM quests WHERE status IN ('pending', 'active') ORDER BY created_at DESC"
        ) as cursor:
            rows = await cursor.fetchall()
            return [self._row_to_quest(row) for row in rows]

    async def get_quest(self, quest_id: str) -> Quest | None:
        async with self._db.execute(
            "SELECT * FROM quests WHERE id=?", (quest_id,)
        ) as cursor:
            row = await cursor.fetchone()
            return self._row_to_quest(row) if row else None

    def _row_to_quest(self, row) -> Quest:
        return Quest(
            id=row["id"],
            type=QuestType(row["type"]),
            title=row["title"],
            description=row["description"] or "",
            difficulty=QuestDifficulty(row["difficulty"]),
            status=QuestStatus(row["status"]),
            objectives=json.loads(row["objectives_json"]),
            rewards=json.loads(row["rewards_json"]),
            deadline=datetime.fromisoformat(row["deadline"]) if row["deadline"] else None,
            source=row["source"],
            context=row["context"] or "",
            exp_reward=row["exp_reward"],
            created_at=datetime.fromisoformat(row["created_at"]) if row["created_at"] else None,
            completed_at=datetime.fromisoformat(row["completed_at"]) if row["completed_at"] else None,
        )

    # ── Snapshots ─────────────────────────────────────

    async def save_snapshot(self, snapshot: ContextSnapshot) -> None:
        """保存快照"""
        await self._db.execute("""
            INSERT OR REPLACE INTO snapshots
            (id, timestamp, screenshot_path, active_window, window_title,
             ai_analysis, inferred_motive, activity_category, focus_score,
             raw_data_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            snapshot.id, snapshot.timestamp.isoformat(),
            snapshot.screenshot_path, snapshot.active_window,
            snapshot.window_title, snapshot.ai_analysis,
            snapshot.inferred_motive, snapshot.activity_category,
            snapshot.focus_score, json.dumps(snapshot.raw_data),
        ))
        await self._db.commit()

    async def get_recent_snapshots(self, limit: int = 10) -> list[ContextSnapshot]:
        """获取最近的快照"""
        async with self._db.execute(
            "SELECT * FROM snapshots ORDER BY timestamp DESC LIMIT ?", (limit,)
        ) as cursor:
            rows = await cursor.fetchall()
            return [
                ContextSnapshot(
                    id=row["id"],
                    timestamp=datetime.fromisoformat(row["timestamp"]),
                    screenshot_path=row["screenshot_path"],
                    active_window=row["active_window"] or "",
                    window_title=row["window_title"] or "",
                    ai_analysis=row["ai_analysis"] or "",
                    inferred_motive=row["inferred_motive"] or "",
                    activity_category=row["activity_category"] or "",
                    focus_score=row["focus_score"] or 0,
                    raw_data=json.loads(row["raw_data_json"]) if row["raw_data_json"] else {},
                )
                for row in rows
            ]

    # ── Activity Log ──────────────────────────────────

    async def log_activity(self, event_type: str, data: dict[str, Any]) -> None:
        """记录活动日志"""
        await self._db.execute(
            "INSERT INTO activity_log (timestamp, event_type, data_json) VALUES (?, ?, ?)",
            (datetime.now().isoformat(), event_type, json.dumps(data, default=str)),
        )
        await self._db.commit()
