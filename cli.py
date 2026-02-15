#!/usr/bin/env python3
"""
独自升级系统 — 命令行工具
用法:
  python3 cli.py status      # 查看状态
  python3 cli.py quests      # 查看任务
  python3 cli.py complete ID  # 完成任务
  python3 cli.py shop        # 查看商店
  python3 cli.py buy ID      # 购买物品
  python3 cli.py skills      # 查看技能
  python3 cli.py report      # 查看报告
  python3 cli.py demo        # 运行演示
"""

import sys
import json
import httpx

API = "http://127.0.0.1:8888"


def fetch(path: str) -> dict:
    try:
        r = httpx.get(f"{API}{path}", timeout=10)
        return r.json()
    except Exception as e:
        print(f"❌ 无法连接系统: {e}")
        print(f"   请确保系统正在运行: pm2 start ecosystem.config.json")
        sys.exit(1)


def post(path: str, data=None) -> dict:
    try:
        r = httpx.post(f"{API}{path}", json=data, timeout=10)
        return r.json()
    except Exception as e:
        print(f"❌ 请求失败: {e}")
        sys.exit(1)


def cmd_status():
    d = fetch("/api/status")
    p = d["player"]
    s = d["system"]

    bar_len = 25
    filled = int(p["exp_progress"] * bar_len)
    bar = "█" * filled + "░" * (bar_len - filled)

    print()
    print(f"  ⚔️  {s['name']} v{s['version']}")
    print(f"  状态: {'🟢 运行中' if s['running'] else '🔴 停止'}")
    print(f"  运行时间: {s.get('uptime', 'N/A')}")
    print()
    print(f"  🎮 {p['name']}  Lv.{p['level']}  [{p['title']}]")
    print(f"  ⭐ [{bar}] {p['exp']}/{p['exp_to_next']} EXP ({round(p['exp_progress']*100)}%)")
    print(f"  🎯 已完成 {p['total_quests_completed']} 个任务")
    print()

    stat_labels = {"focus": "专注力", "productivity": "生产力",
                   "consistency": "持续性", "creativity": "创造力", "wellness": "健康度"}
    print("  📊 属性:")
    for key, label in stat_labels.items():
        v = p["stats"][key]
        sb = "█" * (v // 5) + "░" * (20 - v // 5)
        print(f"     {label}: [{sb}] {v}")

    print()
    if p["active_buffs"]:
        print("  ✨ 活跃效果:")
        for b in p["active_buffs"]:
            icon = "💫" if b["is_debuff"] else "✨"
            print(f"    {icon} {b['name']}")
    else:
        print("  (无活跃效果)")
    print()


def cmd_quests():
    d = fetch("/api/quests")
    quests = d["quests"]
    if not quests:
        print("  暂无活跃任务。")
        return

    print()
    print(f"  ⚔️ 活跃任务 ({len(quests)})")
    print()
    for q in quests:
        print(f"  [{q['difficulty']}] {q['title']}")
        print(f"      {q['description']}")
        print(f"      +{q['exp_reward']} EXP | ID: {q['id']}")
        print()


def cmd_complete(quest_id: str):
    r = post(f"/api/quests/{quest_id}/complete")
    if r.get("success"):
        print(f"  ✅ 任务完成！")
        cmd_status()
    else:
        print(f"  ❌ 失败: {r}")


def cmd_shop():
    d = fetch("/api/shop")
    print()
    print(f"  🛒 系统商店 — 💰 {d['gold']} 金币")
    print()
    for item in d["items"]:
        if not item["available"]:
            continue
        affordable = "✅" if item["affordable"] else "❌"
        print(f"  {affordable} {item['name']} — {item['price']}G")
        print(f"      {item['description']}")
        print(f"      ID: {item['id']}")
        print()


def cmd_buy(item_id: str):
    r = post(f"/api/shop/buy/{item_id}")
    if r.get("success"):
        print(f"  🛒 购买成功: {r['item']}")
        print(f"  💰 剩余金币: {r['gold_remaining']}")
    else:
        print(f"  ❌ {r.get('error', '购买失败')}")


def cmd_skills():
    d = fetch("/api/skills")
    print()
    print("  ⚔️ 技能面板")
    print()
    print("  === 被动技能 ===")
    for s in d["passive"]:
        icon = "✅" if s["unlocked"] else "🔒"
        lvl = f" Lv.{s.get('level', '?')}/{s.get('max_level', '?')}" if s["unlocked"] else ""
        print(f"  {icon} {s['name']}{lvl}")
        print(f"      {s.get('description', '')}")
    print()
    print("  === 主动技能 ===")
    for s in d["active"]:
        icon = "✅" if s["unlocked"] else "🔒"
        cd = f" [冷却中: {s['cooldown_remaining']}min]" if s.get("on_cooldown") else ""
        print(f"  {icon} {s['name']}{cd}")
        print(f"      {s.get('description', '')}")
    print()


def cmd_report():
    d = fetch("/api/report")
    print()
    print(d["summary"])
    print()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return

    cmd = sys.argv[1].lower()

    if cmd == "status":
        cmd_status()
    elif cmd == "quests":
        cmd_quests()
    elif cmd == "complete" and len(sys.argv) >= 3:
        cmd_complete(sys.argv[2])
    elif cmd == "shop":
        cmd_shop()
    elif cmd == "buy" and len(sys.argv) >= 3:
        cmd_buy(sys.argv[2])
    elif cmd == "skills":
        cmd_skills()
    elif cmd == "report":
        cmd_report()
    elif cmd == "demo":
        import asyncio
        from demo import run_demo
        asyncio.run(run_demo())
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
