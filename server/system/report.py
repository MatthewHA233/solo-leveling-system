"""
报告生成系统
每日报告 + 每周报告 + 趋势分析

Dayflow 灵感: 时间线回顾 + AI 总结
独自升级特色: 游戏化数据展示 + 成长曲线
"""

from datetime import datetime, timedelta
from collections import Counter, defaultdict
from typing import Any

from ..storage.database import Database
from ..core.player import Player


CATEGORY_LABELS = {
    "coding": "💻 编程", "writing": "✍️ 写作", "learning": "📚 学习",
    "work": "💼 工作", "browsing": "🌐 浏览", "social": "💬 社交",
    "media": "🎬 媒体", "gaming": "🎮 游戏", "idle": "💤 空闲",
    "communication": "📱 通讯", "design": "🎨 设计", "reading": "📖 阅读",
    "research": "🔬 研究", "meeting": "🤝 会议", "unknown": "❓ 未知",
}

PRODUCTIVE_CATEGORIES = {"coding", "writing", "work", "learning", "design", "research", "meeting"}
LEISURE_CATEGORIES = {"social", "media", "browsing", "gaming"}


class ReportGenerator:
    """报告生成器 — 每日/每周/自定义时间范围"""

    def __init__(self, db: Database):
        self.db = db

    # ── 每日报告 ────────────────────────────────────────

    async def generate_daily_report(self, player: Player) -> dict:
        """生成今日报告"""
        snapshots = await self.db.get_recent_snapshots(limit=200)

        if not snapshots:
            return {"summary": "今天还没有活动数据。", "details": {}}

        stats = self._compute_stats(snapshots)
        summary = self._format_daily_summary(stats, player)

        return {
            "summary": summary,
            "details": stats,
        }

    def _format_daily_summary(self, stats: dict, player: Player) -> str:
        """格式化每日报告"""
        focus_rating = self._focus_rating(stats["avg_focus"])

        lines = [
            f"📊 **每日报告** — {datetime.now().strftime('%Y年%m月%d日')}",
            "",
            f"⚔️ **玩家状态**: {player.name} Lv.{player.level} [{player.title}]",
            f"⭐ **经验值**: {player.exp}/{player.exp_to_next}",
            f"🎯 **累计完成**: {player.total_quests_completed} 个任务",
            "",
            f"📈 **专注度评分**: {focus_rating} (平均 {stats['avg_focus_pct']}%)",
            f"   最高: {stats['max_focus_pct']}% | 最低: {stats['min_focus_pct']}%",
            "",
            f"⏱️ **时间分配**:",
            f"   生产性活动: {stats['productive_pct']}%",
            f"   休闲/浏览: {stats['leisure_pct']}%",
            f"   其他: {stats['other_pct']}%",
            "",
            f"🏆 **主要活动**:",
        ]

        for cat, pct in stats["top_categories_pct"]:
            label = CATEGORY_LABELS.get(cat, cat)
            lines.append(f"   {label}: {pct}%")

        lines.extend([
            "",
            f"📊 **属性面板**:",
            f"   专注力: {player.stats.focus} | 生产力: {player.stats.productivity}",
            f"   持续性: {player.stats.consistency} | 创造力: {player.stats.creativity}",
            f"   健康度: {player.stats.wellness}",
        ])

        if player.active_buffs:
            lines.append("")
            lines.append("✨ **当前效果**:")
            for b in player.active_buffs:
                icon = "💫" if b.is_debuff else "✨"
                lines.append(f"   {icon} {b.name}")

        return "\n".join(lines)

    # ── 每周报告 ────────────────────────────────────────

    async def generate_weekly_report(self, player: Player) -> dict:
        """
        生成每周报告
        包含: 7 天趋势、对比分析、成长曲线、建议
        """
        # 获取过去 7 天的快照 (尽量多取)
        all_snapshots = await self.db.get_recent_snapshots(limit=2000)

        if not all_snapshots:
            return {"summary": "本周还没有活动数据。", "details": {}}

        now = datetime.now()
        week_ago = now - timedelta(days=7)
        two_weeks_ago = now - timedelta(days=14)

        # 按天分组
        this_week = [s for s in all_snapshots if s.timestamp >= week_ago]
        last_week = [s for s in all_snapshots if two_weeks_ago <= s.timestamp < week_ago]

        # 按日分组统计
        daily_breakdown = self._group_by_day(this_week)

        # 本周总体统计
        this_week_stats = self._compute_stats(this_week)
        last_week_stats = self._compute_stats(last_week) if last_week else None

        # 趋势分析
        trends = self._compute_trends(this_week_stats, last_week_stats)

        # 生成报告
        summary = self._format_weekly_summary(
            this_week_stats, last_week_stats, trends, daily_breakdown, player
        )

        return {
            "summary": summary,
            "details": {
                "this_week": this_week_stats,
                "last_week": last_week_stats,
                "trends": trends,
                "daily_breakdown": daily_breakdown,
            },
        }

    def _format_weekly_summary(
        self,
        this_week: dict,
        last_week: dict | None,
        trends: dict,
        daily: dict,
        player: Player,
    ) -> str:
        """格式化每周报告"""
        now = datetime.now()
        week_start = (now - timedelta(days=6)).strftime("%m/%d")
        week_end = now.strftime("%m/%d")

        lines = [
            f"📋 **周报** — {week_start} ~ {week_end}",
            f"⚔️ {player.name} Lv.{player.level} [{player.title}]",
            "",
            "═══════════════════════════════════════",
            "",
        ]

        # 1. 概览
        focus_rating = self._focus_rating(this_week["avg_focus"])
        lines.extend([
            "📊 **本周概览**",
            f"   记录快照: {this_week['total_snapshots']} 次",
            f"   平均专注: {focus_rating} ({this_week['avg_focus_pct']}%)",
            f"   生产时间: {this_week['productive_pct']}%",
            f"   休闲时间: {this_week['leisure_pct']}%",
            "",
        ])

        # 2. 与上周对比
        if last_week and last_week.get("total_snapshots", 0) > 0:
            lines.append("📈 **与上周对比**")
            
            focus_delta = this_week["avg_focus_pct"] - last_week["avg_focus_pct"]
            prod_delta = this_week["productive_pct"] - last_week["productive_pct"]
            leisure_delta = this_week["leisure_pct"] - last_week["leisure_pct"]

            lines.append(f"   专注度: {self._delta_str(focus_delta)}")
            lines.append(f"   生产性: {self._delta_str(prod_delta)}")
            lines.append(f"   休闲量: {self._delta_str(leisure_delta)}")
            lines.append("")

        # 3. 每日趋势 (简洁图表)
        lines.append("📅 **每日专注度**")
        day_names = ["一", "二", "三", "四", "五", "六", "日"]
        for date_str, day_stats in sorted(daily.items()):
            date_obj = datetime.strptime(date_str, "%Y-%m-%d")
            day_name = day_names[date_obj.weekday()]
            focus_pct = day_stats.get("avg_focus_pct", 0)
            bar = self._bar_chart(focus_pct, width=15)
            lines.append(f"   周{day_name} {bar} {focus_pct}%")
        lines.append("")

        # 4. 时间分配
        lines.append("🏆 **本周主要活动**")
        for cat, pct in this_week.get("top_categories_pct", [])[:5]:
            label = CATEGORY_LABELS.get(cat, cat)
            lines.append(f"   {label}: {pct}%")
        lines.append("")

        # 5. 成长分析
        lines.append("💪 **成长分析**")
        if trends.get("focus_trend") == "up":
            lines.append("   ↗️ 专注度持续提升，保持势头！")
        elif trends.get("focus_trend") == "down":
            lines.append("   ↘️ 专注度有所下降，注意休息和调整。")
        else:
            lines.append("   ➡️ 专注度保持稳定。")

        if trends.get("productive_trend") == "up":
            lines.append("   ↗️ 生产效率提高，干得漂亮！")
        elif trends.get("productive_trend") == "down":
            lines.append("   ↘️ 生产效率下降，可能需要重新规划优先级。")

        if trends.get("best_day"):
            lines.append(f"   🌟 本周最佳: {trends['best_day']} (专注度 {trends['best_day_focus']}%)")
        if trends.get("worst_day"):
            lines.append(f"   💤 本周最弱: {trends['worst_day']} (专注度 {trends['worst_day_focus']}%)")
        lines.append("")

        # 6. 建议
        lines.append("💡 **猎人建议**")
        suggestions = self._generate_suggestions(this_week, trends)
        for s in suggestions:
            lines.append(f"   • {s}")
        lines.append("")

        lines.append("═══════════════════════════════════════")
        lines.append(f"   「变强吧。」—— 系统")

        return "\n".join(lines)

    # ── 统计计算 ────────────────────────────────────────

    def _compute_stats(self, snapshots: list) -> dict:
        """从快照列表计算统计数据"""
        if not snapshots:
            return {
                "total_snapshots": 0, "avg_focus": 0, "avg_focus_pct": 0,
                "max_focus_pct": 0, "min_focus_pct": 0,
                "productive_pct": 0, "leisure_pct": 0, "other_pct": 100,
                "top_categories_pct": [], "category_counts": {},
            }

        categories = [s.activity_category for s in snapshots if s.activity_category]
        cat_counts = Counter(categories)
        total = len(categories) or 1

        focus_scores = [s.focus_score for s in snapshots if s.focus_score > 0]
        avg_focus = sum(focus_scores) / len(focus_scores) if focus_scores else 0
        max_focus = max(focus_scores) if focus_scores else 0
        min_focus = min(focus_scores) if focus_scores else 0

        productive_count = sum(cat_counts.get(c, 0) for c in PRODUCTIVE_CATEGORIES)
        leisure_count = sum(cat_counts.get(c, 0) for c in LEISURE_CATEGORIES)
        productive_pct = round(productive_count / total * 100)
        leisure_pct = round(leisure_count / total * 100)

        top_categories_pct = [
            (cat, round(count / total * 100))
            for cat, count in cat_counts.most_common(5)
        ]

        return {
            "total_snapshots": len(snapshots),
            "avg_focus": round(avg_focus, 3),
            "avg_focus_pct": round(avg_focus * 100),
            "max_focus_pct": round(max_focus * 100),
            "min_focus_pct": round(min_focus * 100),
            "productive_pct": productive_pct,
            "leisure_pct": leisure_pct,
            "other_pct": max(0, 100 - productive_pct - leisure_pct),
            "top_categories_pct": top_categories_pct,
            "category_counts": dict(cat_counts),
        }

    def _group_by_day(self, snapshots: list) -> dict:
        """按天分组并计算每日统计"""
        by_day: dict[str, list] = defaultdict(list)
        for s in snapshots:
            day_key = s.timestamp.strftime("%Y-%m-%d")
            by_day[day_key].append(s)

        result = {}
        for day_key, day_snapshots in sorted(by_day.items()):
            stats = self._compute_stats(day_snapshots)
            result[day_key] = stats

        return result

    def _compute_trends(self, this_week: dict, last_week: dict | None) -> dict:
        """计算趋势"""
        trends: dict[str, Any] = {}

        if last_week and last_week.get("total_snapshots", 0) > 0:
            focus_diff = this_week["avg_focus_pct"] - last_week["avg_focus_pct"]
            prod_diff = this_week["productive_pct"] - last_week["productive_pct"]

            trends["focus_trend"] = "up" if focus_diff > 3 else "down" if focus_diff < -3 else "stable"
            trends["productive_trend"] = "up" if prod_diff > 3 else "down" if prod_diff < -3 else "stable"
            trends["focus_delta"] = focus_diff
            trends["productive_delta"] = prod_diff
        else:
            trends["focus_trend"] = "stable"
            trends["productive_trend"] = "stable"

        return trends

    # ── 建议生成 ────────────────────────────────────────

    def _generate_suggestions(self, stats: dict, trends: dict) -> list[str]:
        """根据数据生成个性化建议"""
        suggestions = []

        avg_focus = stats.get("avg_focus_pct", 0)
        productive = stats.get("productive_pct", 0)
        leisure = stats.get("leisure_pct", 0)

        # 专注度建议
        if avg_focus < 30:
            suggestions.append("专注度偏低。试试番茄工作法: 25 分钟专注 + 5 分钟休息。")
        elif avg_focus < 50:
            suggestions.append("专注度还有提升空间。减少多任务切换可能有帮助。")
        elif avg_focus >= 80:
            suggestions.append("专注度极高！注意适当休息，避免过度疲劳。")

        # 生产/休闲平衡
        if leisure > 40:
            suggestions.append("休闲时间偏多。可以把一些浏览时间转化为学习时间。")
        elif productive > 80:
            suggestions.append("工作狂模式！记得给自己安排放松时间，长期高压不可持续。")
        elif 40 <= productive <= 70 and leisure <= 30:
            suggestions.append("工作与休闲的平衡不错，继续保持！")

        # 趋势建议
        if trends.get("focus_trend") == "down":
            suggestions.append("专注度呈下降趋势。检查是否有新的干扰源，或者需要换个环境。")
        if trends.get("productive_trend") == "up":
            suggestions.append("生产效率在提升！可以考虑挑战更高难度的任务。")

        # 至少给一条建议
        if not suggestions:
            suggestions.append("数据看起来都不错。保持现在的节奏就好！")

        return suggestions[:4]  # 最多 4 条建议

    # ── 辅助方法 ────────────────────────────────────────

    @staticmethod
    def _focus_rating(avg_focus: float) -> str:
        if avg_focus >= 0.7:
            return "🌟 优秀"
        elif avg_focus >= 0.5:
            return "✅ 良好"
        elif avg_focus >= 0.3:
            return "⚠️ 一般"
        else:
            return "❌ 需改善"

    @staticmethod
    def _delta_str(delta: int) -> str:
        if delta > 0:
            return f"↗️ +{delta}%"
        elif delta < 0:
            return f"↘️ {delta}%"
        else:
            return "➡️ 持平"

    @staticmethod
    def _bar_chart(value: int, width: int = 15) -> str:
        """生成简单的文字进度条"""
        filled = round(value / 100 * width)
        filled = min(filled, width)
        return "█" * filled + "░" * (width - filled)
