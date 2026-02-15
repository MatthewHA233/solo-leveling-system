"""
商店系统
金币可通过完成任务和活动获得，用于购买各种道具
灵感来自原作的系统商店
"""

from datetime import datetime
from ..core.events import EventBus, EventType, Event


# 商店物品
SHOP_ITEMS = {
    # ── 消耗品 ──
    "potion_focus": {
        "name": "🧪 专注药水",
        "description": "立即恢复 15 点专注力",
        "category": "consumable",
        "price": 50,
        "effect": {"stat": "focus", "value": 15},
        "level_req": 1,
    },
    "potion_energy": {
        "name": "⚡ 活力药水",
        "description": "恢复 10 点健康度和 10 点生产力",
        "category": "consumable",
        "price": 60,
        "effect": {"stats": {"wellness": 10, "productivity": 10}},
        "level_req": 1,
    },
    "potion_exp": {
        "name": "✨ 经验晶石",
        "description": "立即获得 50 EXP",
        "category": "consumable",
        "price": 100,
        "effect": {"exp": 50},
        "level_req": 2,
    },
    "scroll_double_exp": {
        "name": "📜 双倍经验卷轴",
        "description": "接下来 30 分钟经验值翻倍",
        "category": "consumable",
        "price": 200,
        "effect": {"buff": "double_exp", "duration_minutes": 30},
        "level_req": 3,
    },
    "elixir_stat_reset": {
        "name": "🔮 属性重置水",
        "description": "将所有属性恢复为 50",
        "category": "consumable",
        "price": 500,
        "effect": {"reset_stats": True},
        "level_req": 5,
    },

    # ── 随机箱 (原作梗) ──
    "blessed_random_box": {
        "name": "🎁 祝福随机箱",
        "description": "获得一件你想要的物品（随机正面效果）",
        "category": "lootbox",
        "price": 150,
        "effect": {"random": "positive"},
        "level_req": 2,
    },
    "cursed_random_box": {
        "name": "📦 诅咒随机箱",
        "description": "获得一件你需要的物品（可能是苦口良药）",
        "category": "lootbox",
        "price": 80,
        "effect": {"random": "needed"},
        "level_req": 1,
    },

    # ── 装备 (永久效果) ──
    "ring_focus": {
        "name": "💍 专注之戒",
        "description": "永久增加 5 点专注力上限",
        "category": "equipment",
        "price": 300,
        "effect": {"permanent_stat": "focus", "value": 5},
        "level_req": 3,
        "one_time": True,
    },
    "pendant_wisdom": {
        "name": "📿 智慧吊坠",
        "description": "永久增加 5 点创造力上限",
        "category": "equipment",
        "price": 300,
        "effect": {"permanent_stat": "creativity", "value": 5},
        "level_req": 3,
        "one_time": True,
    },
}


class ShopSystem:
    """系统商店"""

    def __init__(self, event_bus: EventBus):
        self.bus = event_bus
        self._gold: int = 0
        self._purchased_one_time: set[str] = set()  # 已购买的一次性物品
        self._total_gold_earned: int = 0
        self._total_gold_spent: int = 0

        # 任务完成给金币
        self.bus.on(EventType.QUEST_COMPLETED, self._on_quest_completed)
        # 被动经验也给少量金币
        self.bus.on(EventType.EXP_GAINED, self._on_exp_gained)

    @property
    def gold(self) -> int:
        return self._gold

    def add_gold(self, amount: int, source: str = "") -> None:
        """增加金币"""
        self._gold += amount
        self._total_gold_earned += amount

    def get_shop_items(self, player_level: int) -> list[dict]:
        """获取当前可购买的物品"""
        items = []
        for item_id, item in SHOP_ITEMS.items():
            if player_level >= item["level_req"]:
                available = True
                if item.get("one_time") and item_id in self._purchased_one_time:
                    available = False

                items.append({
                    "id": item_id,
                    "name": item["name"],
                    "description": item["description"],
                    "category": item["category"],
                    "price": item["price"],
                    "level_req": item["level_req"],
                    "available": available,
                    "affordable": self._gold >= item["price"],
                })
        return items

    async def purchase(self, item_id: str, player_level: int) -> dict:
        """购买物品"""
        if item_id not in SHOP_ITEMS:
            return {"success": False, "error": "物品不存在"}

        item = SHOP_ITEMS[item_id]

        if player_level < item["level_req"]:
            return {"success": False, "error": f"需要 Lv.{item['level_req']}"}

        if item.get("one_time") and item_id in self._purchased_one_time:
            return {"success": False, "error": "已购买过"}

        if self._gold < item["price"]:
            return {"success": False, "error": f"金币不足 (需要 {item['price']}，当前 {self._gold})"}

        # 扣金币
        self._gold -= item["price"]
        self._total_gold_spent += item["price"]

        if item.get("one_time"):
            self._purchased_one_time.add(item_id)

        # 通知
        await self.bus.emit_simple(
            EventType.NOTIFICATION_PUSH,
            notification={
                "title": "🛒 购买成功",
                "message": f"获得 {item['name']}\n花费 {item['price']} 金币",
                "style": "shop",
                "timestamp": datetime.now().isoformat(),
            },
        )

        return {
            "success": True,
            "item": item["name"],
            "effect": item["effect"],
            "gold_remaining": self._gold,
        }

    def get_stats(self) -> dict:
        return {
            "gold": self._gold,
            "total_earned": self._total_gold_earned,
            "total_spent": self._total_gold_spent,
        }

    async def _on_quest_completed(self, event: Event) -> None:
        """任务完成给金币"""
        exp = event.data.get("exp_earned", 0)
        gold = max(5, exp // 2)  # 大约是经验的一半
        self.add_gold(gold, "quest")

    async def _on_exp_gained(self, event: Event) -> None:
        """获得经验也给少量金币"""
        amount = event.data.get("amount", 0)
        source = event.data.get("source", "")
        if source.startswith("passive:") and amount >= 3:
            self.add_gold(1, "passive")
