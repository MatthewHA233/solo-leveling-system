"""
演示模拟器
模拟一整天的用户活动，展示系统完整运作流程
无需真实截屏，用预设场景驱动所有引擎
"""

import asyncio
import random
from datetime import datetime

import httpx


API_BASE = "http://127.0.0.1:8888"

# 一天的活动剧本
DAILY_SCENARIO = [
    # (时间标签, 分类, 专注度, 活动描述, 动机)
    ("08:00 起床", "idle", 0.1, "刚打开电脑，查看通知", "开始新的一天"),
    ("08:15 查邮件", "work", 0.5, "在 Gmail 中查看和回复邮件", "处理工作沟通"),
    ("08:30 刷新闻", "browsing", 0.3, "浏览 Hacker News 和技术博客", "了解行业动态"),
    ("09:00 开始编程", "coding", 0.7, "打开 VS Code，开始写代码", "开始今天的开发任务"),
    ("09:30 深度编程", "coding", 0.85, "实现用户认证模块，编写单元测试", "完成后端核心功能"),
    ("10:00 心流状态", "coding", 0.92, "全神贯注调试复杂逻辑，零干扰", "解决关键技术难题"),
    ("10:30 继续编程", "coding", 0.88, "重构代码结构，优化性能", "提升代码质量"),
    ("11:00 查文档", "learning", 0.75, "阅读 Python asyncio 文档", "理解异步编程最佳实践"),
    ("11:20 回到编码", "coding", 0.8, "应用学到的知识优化异步逻辑", "将理论付诸实践"),
    ("11:45 摸鱼", "social", 0.2, "刷了一会微博和朋友圈", "短暂放松"),
    ("12:00 午休", "idle", 0.05, "离开电脑吃午饭", "休息补充能量"),
    ("13:00 回来了", "browsing", 0.4, "浏览 YouTube 技术视频", "午后恢复状态"),
    ("13:30 写文档", "writing", 0.7, "撰写项目技术文档和 API 说明", "完善项目文档"),
    ("14:00 继续写", "writing", 0.75, "编写 README 和部署指南", "让项目更易使用"),
    ("14:30 编程", "coding", 0.82, "开发前端页面，CSS 调整", "完成 UI 实现"),
    ("15:00 调试", "coding", 0.78, "修复跨浏览器兼容性问题", "确保所有平台可用"),
    ("15:30 分心了", "social", 0.25, "收到消息开始聊天", "社交沟通"),
    ("15:45 继续分心", "social", 0.15, "刷推特看热搜", "无意识浏览"),
    ("16:00 回归", "coding", 0.65, "强迫自己回到工作，重新打开编辑器", "克服拖延"),
    ("16:30 专注编程", "coding", 0.85, "终于进入状态，快速推进功能", "冲刺完成今日目标"),
    ("17:00 收尾", "coding", 0.8, "提交代码，写 commit message", "完成今日开发"),
    ("17:30 学习时间", "learning", 0.7, "阅读《设计模式》电子书", "提升架构设计能力"),
    ("18:00 晚饭", "idle", 0.05, "离开电脑", "休息"),
    ("19:00 轻松浏览", "media", 0.3, "看 B 站视频放松", "晚间娱乐"),
    ("20:00 个人项目", "coding", 0.75, "做自己的开源项目", "个人成长和技术探索"),
    ("20:30 深入开发", "coding", 0.85, "实现新功能，感觉不错", "享受创造的乐趣"),
    ("21:00 准备总结", "writing", 0.6, "写今天的工作总结", "复盘和计划"),
    ("21:30 收工", "browsing", 0.35, "随便看看，准备休息", "结束一天"),
]


async def run_demo():
    """运行完整演示"""
    print("=" * 60)
    print("  🎮 独自升级系统 — 演示模式")
    print("  模拟一整天的用户活动")
    print("=" * 60)
    print()

    async with httpx.AsyncClient(timeout=30) as client:
        # 先检查系统状态
        try:
            resp = await client.get(f"{API_BASE}/api/status")
            status = resp.json()
            print(f"  ⚔️ 系统在线: {status['system']['name']}")
            print(f"  🎯 玩家: {status['player']['name']} Lv.{status['player']['level']}")
            print()
        except Exception as e:
            print(f"  ❌ 系统未运行: {e}")
            print(f"  请先启动系统: python3 -m src.core")
            return

        for i, (time_label, category, focus, activity, motive) in enumerate(DAILY_SCENARIO):
            # 稍微随机化专注度 (±0.05)
            focus = max(0.0, min(1.0, focus + random.uniform(-0.05, 0.05)))

            # 发送模拟数据
            resp = await client.post(f"{API_BASE}/api/simulate", json={
                "category": category,
                "focus_score": round(focus, 2),
                "activity": activity,
                "motive": motive,
            })
            result = resp.json()

            # 格式化输出
            focus_bar = "●" * int(focus * 5) + "○" * (5 - int(focus * 5))
            level = result.get("player_level", "?")
            exp = result.get("player_exp", "?")
            pattern = result.get("pattern_detected", "normal")
            buffs = result.get("active_buffs", [])

            pattern_icon = {
                "deep_focus": "🔥", "distraction": "💫",
                "learning": "📚", "creative": "🎨",
                "fatigue": "😴", "procrastination": "⛓️",
                "normal": "  ",
            }.get(pattern, "  ")

            buff_str = " ".join(buffs) if buffs else ""

            print(f"  {time_label:<16} [{focus_bar}] {category:<10} Lv.{level} EXP:{exp:>4}  {pattern_icon} {buff_str}")

            # 间隔 (加速演示)
            await asyncio.sleep(0.5)

        # 最终状态
        print()
        print("=" * 60)
        resp = await client.get(f"{API_BASE}/api/status")
        p = resp.json()["player"]

        bar_len = 25
        filled = int(p["exp_progress"] * bar_len)
        bar = "█" * filled + "░" * (bar_len - filled)

        print(f"  ⚔️  {p['name']}  Lv.{p['level']}  【{p['title']}】")
        print(f"  ⭐ [{bar}] {p['exp']}/{p['exp_to_next']} EXP")
        print(f"  🎯 已完成 {p['total_quests_completed']} 个任务")
        print()
        print(f"  📊 属性面板:")
        stat_labels = {"focus": "专注力", "productivity": "生产力",
                       "consistency": "持续性", "creativity": "创造力", "wellness": "健康度"}
        for key, label in stat_labels.items():
            v = p["stats"][key]
            sb = "█" * (v // 5) + "░" * (20 - v // 5)
            print(f"     {label}: [{sb}] {v}")

        print()
        if p["active_buffs"]:
            print(f"  ✨ 活跃效果:")
            for b in p["active_buffs"]:
                icon = "💫" if b["is_debuff"] else "✨"
                print(f"    {icon} {b['name']}")
        print()

        # 显示任务
        resp = await client.get(f"{API_BASE}/api/quests")
        quests = resp.json()["quests"]
        if quests:
            print(f"  ⚔️ 活跃任务 ({len(quests)}):")
            for q in quests[:5]:
                print(f"    [{q['difficulty']}] {q['title']} +{q['exp_reward']}EXP")

        print()
        print("=" * 60)
        print("  演示完成！访问 Web 面板查看完整状态")
        print(f"  🌐 http://36.151.148.51/solo/")
        print("=" * 60)


if __name__ == "__main__":
    asyncio.run(run_demo())
