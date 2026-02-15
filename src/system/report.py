"""
每日报告生成器
基于一天的数据生成总结报告
"""

from datetime import datetime, timedelta
from collections import Counter

from ..storage.database import Database
from ..core.player import Player


class ReportGenerator:
    """每日/每周报告生成器"""

    def __init__(self, db: Database):
        self.db = db

    async def generate_daily_report(self, player: Player) -> dict:
        """生成今日报告"""
        snapshots = await self.db.get_recent_snapshots(limit=200)

        if not snapshots:
            return {"summary": "今天还没有活动数据。", "details": {}}

        # 活动分类统计
        categories = [s.activity_category for s in snapshots if s.activity_category]
        cat_counts = Counter(categories)
        total = len(categories) or 1

        # 专注度统计
        focus_scores = [s.focus_score for s in snapshots if s.focus_score > 0]
        avg_focus = sum(focus_scores) / len(focus_scores) if focus_scores else 0
        max_focus = max(focus_scores) if focus_scores else 0
        min_focus = min(focus_scores) if focus_scores else 0

        # 时间分布 (粗略)
        productive_categories = {"coding", "writing", "work", "learning"}
        productive_count = sum(cat_counts.get(c, 0) for c in productive_categories)
        distraction_categories = {"social", "media", "browsing"}
        distraction_count = sum(cat_counts.get(c, 0) for c in distraction_categories)

        productive_pct = round(productive_count / total * 100)
        distraction_pct = round(distraction_count / total * 100)

        # 主要活动
        top_activities = cat_counts.most_common(3)

        # 生成文字总结
        focus_rating = "优秀" if avg_focus >= 0.7 else "良好" if avg_focus >= 0.5 else "一般" if avg_focus >= 0.3 else "需要改善"

        summary_lines = [
            f"📊 **每日报告** — {datetime.now().strftime('%Y年%m月%d日')}",
            "",
            f"⚔️ **玩家状态**: {player.name} Lv.{player.level} [{player.title}]",
            f"⭐ **经验值**: {player.exp}/{player.exp_to_next}",
            f"🎯 **累计完成**: {player.total_quests_completed} 个任务",
            "",
            f"📈 **专注度评分**: {focus_rating} (平均 {round(avg_focus*100)}%)",
            f"   最高: {round(max_focus*100)}% | 最低: {round(min_focus*100)}%",
            "",
            f"⏱️ **时间分配**:",
            f"   生产性活动: {productive_pct}%",
            f"   休闲/浏览: {distraction_pct}%",
            f"   其他: {100 - productive_pct - distraction_pct}%",
            "",
            f"🏆 **主要活动**:",
        ]

        category_labels = {
            "coding": "💻 编程", "writing": "✍️ 写作", "learning": "📚 学习",
            "work": "💼 工作", "browsing": "🌐 浏览", "social": "💬 社交",
            "media": "🎬 媒体", "gaming": "🎮 游戏", "idle": "💤 空闲",
        }

        for cat, count in top_activities:
            pct = round(count / total * 100)
            label = category_labels.get(cat, cat)
            summary_lines.append(f"   {label}: {pct}%")

        summary_lines.extend([
            "",
            f"📊 **属性面板**:",
            f"   专注力: {player.stats.focus} | 生产力: {player.stats.productivity}",
            f"   持续性: {player.stats.consistency} | 创造力: {player.stats.creativity}",
            f"   健康度: {player.stats.wellness}",
        ])

        # Buff 统计
        if player.active_buffs:
            summary_lines.append("")
            summary_lines.append("✨ **当前效果**:")
            for b in player.active_buffs:
                icon = "💫" if b.is_debuff else "✨"
                summary_lines.append(f"   {icon} {b.name}")

        return {
            "summary": "\n".join(summary_lines),
            "details": {
                "total_snapshots": len(snapshots),
                "avg_focus": round(avg_focus, 2),
                "productive_pct": productive_pct,
                "distraction_pct": distraction_pct,
                "top_categories": dict(top_activities),
                "player_level": player.level,
                "player_exp": player.exp,
            },
        }
