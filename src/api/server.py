"""
FastAPI Web 服务
提供系统状态查看 API + WebSocket 实时推送
"""

import asyncio
import json
from datetime import datetime

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from pathlib import Path

app = FastAPI(title="独自升级系统", version="0.2.0")

# 全局引用 (在 system.py 启动时注入)
_system_ref = None
_ws_clients: set[WebSocket] = set()

# 注册 Agent API 路由
from .agent_api import router as agent_router, set_system_ref as agent_set_system_ref
app.include_router(agent_router)


def set_system_ref(system):
    global _system_ref
    _system_ref = system
    # 同时注入到 agent_api
    agent_set_system_ref(system)


@app.get("/api/status")
async def get_status():
    """获取系统和玩家状态"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    player = _system_ref.player_mgr.player
    return {
        "system": {
            "name": _system_ref.config.system.name,
            "version": _system_ref.config.system.version,
            "running": _system_ref.running,
            "uptime": str(datetime.now() - _system_ref.start_time) if _system_ref.start_time else None,
        },
        "player": player.to_dict(),
    }


@app.get("/api/quests")
async def get_quests():
    """获取活跃任务列表"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    quests = await _system_ref.db.get_active_quests()
    return {
        "quests": [
            {
                "id": q.id,
                "type": q.type.value,
                "title": q.title,
                "description": q.description,
                "difficulty": q.difficulty.value,
                "status": q.status.value,
                "exp_reward": q.exp_reward,
                "deadline": q.deadline.isoformat() if q.deadline else None,
                "created_at": q.created_at.isoformat() if q.created_at else None,
            }
            for q in quests
        ]
    }


@app.post("/api/quests/{quest_id}/complete")
async def complete_quest(quest_id: str):
    """手动完成任务"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    success = await _system_ref.quest_engine.complete_quest(quest_id)
    return {"success": success}


@app.get("/api/snapshots")
async def get_snapshots(limit: int = 10):
    """获取最近的活动快照"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    snapshots = await _system_ref.db.get_recent_snapshots(limit)
    return {
        "snapshots": [
            {
                "id": s.id,
                "timestamp": s.timestamp.isoformat(),
                "active_window": s.active_window,
                "window_title": s.window_title,
                "activity_category": s.activity_category,
                "ai_analysis": s.ai_analysis,
                "inferred_motive": s.inferred_motive,
                "focus_score": s.focus_score,
            }
            for s in snapshots
        ]
    }


@app.get("/api/notifications")
async def get_notifications():
    """获取待推送通知"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    pending = _system_ref.notification_engine.pop_pending()
    return {"notifications": pending}


@app.get("/api/pattern")
async def get_pattern():
    """获取当前行为模式"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    return _system_ref.pattern_detector.get_current_pattern()


@app.get("/api/exp-stats")
async def get_exp_stats():
    """获取经验引擎统计"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    return _system_ref.exp_engine.get_stats()


@app.post("/api/simulate")
async def simulate_activity(activity: dict):
    """模拟一次活动分析 (调试用)
    POST body: {"category": "coding", "focus_score": 0.8, "activity": "写代码", "motive": "开发项目"}
    """
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    from ..storage.models import ContextSnapshot
    import uuid

    category = activity.get("category", "coding")
    focus_score = activity.get("focus_score", 0.7)
    analysis_text = activity.get("activity", "模拟活动")
    motive_text = activity.get("motive", "")

    # 保存快照
    snapshot = ContextSnapshot(
        id=f"sim_{uuid.uuid4().hex[:8]}",
        timestamp=datetime.now(),
        active_window="simulated",
        window_title="模拟数据",
        ai_analysis=analysis_text,
        inferred_motive=motive_text,
        activity_category=category,
        focus_score=focus_score,
    )
    await _system_ref.db.save_snapshot(snapshot)

    # 触发分析事件 (会自动触发经验计算、buff判断等)
    from ..core.events import EventType
    await _system_ref.bus.emit_simple(
        EventType.CONTEXT_ANALYZED,
        analysis={
            "activity": analysis_text,
            "category": category,
            "motive": motive_text,
            "focus_score": focus_score,
        },
    )

    # 喂数据给动机引擎
    _system_ref.motive_engine.add_activity(category, focus_score, analysis_text)

    # 检测行为模式
    pattern = await _system_ref.pattern_detector.detect()

    player = _system_ref.player_mgr.player
    return {
        "simulated": True,
        "category": category,
        "focus_score": focus_score,
        "pattern_detected": pattern,
        "player_exp": player.exp,
        "player_level": player.level,
        "active_buffs": [b.name for b in player.active_buffs],
    }


@app.get("/api/achievements")
async def get_achievements():
    """获取成就列表"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    return {
        "achievements": _system_ref.achievement_engine.get_all(),
        "progress": _system_ref.achievement_engine.get_progress(),
    }


@app.get("/api/hidden-quests")
async def get_hidden_quest_status():
    """获取隐藏任务检测器状态"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    return _system_ref.hidden_quest_detector.get_status()


@app.get("/api/report")
async def get_daily_report():
    """获取每日报告"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    from ..system.report import ReportGenerator
    reporter = ReportGenerator(_system_ref.db)
    report = await reporter.generate_daily_report(_system_ref.player_mgr.player)
    return report


@app.get("/api/report/weekly")
async def get_weekly_report():
    """获取每周报告"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    from ..system.report import ReportGenerator
    reporter = ReportGenerator(_system_ref.db)
    report = await reporter.generate_weekly_report(_system_ref.player_mgr.player)
    return report


@app.get("/api/motive")
async def get_motive():
    """获取当前动机推断"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    return _system_ref.motive_engine.infer()


@app.get("/api/shop")
async def get_shop():
    """获取商店物品"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    level = _system_ref.player_mgr.player.level
    return {
        "gold": _system_ref.shop.gold,
        "items": _system_ref.shop.get_shop_items(level),
        "stats": _system_ref.shop.get_stats(),
    }


@app.post("/api/shop/buy/{item_id}")
async def buy_item(item_id: str):
    """购买商店物品"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    level = _system_ref.player_mgr.player.level
    result = await _system_ref.shop.purchase(item_id, level)

    # 如果购买成功，应用效果
    if result.get("success"):
        effect = result.get("effect", {})
        if "stat" in effect:
            _system_ref.player_mgr.player.stats.apply_modifier(effect["stat"], effect["value"])
        elif "stats" in effect:
            for stat, val in effect["stats"].items():
                _system_ref.player_mgr.player.stats.apply_modifier(stat, val)
        elif "exp" in effect:
            await _system_ref.player_mgr.gain_exp(effect["exp"], source="shop")

    return result


@app.get("/api/skills")
async def get_skills():
    """获取技能列表"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    level = _system_ref.player_mgr.player.level
    return _system_ref.skill_system.get_available_skills(level)


@app.post("/api/skills/{skill_id}/activate")
async def activate_skill(skill_id: str):
    """激活技能"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    level = _system_ref.player_mgr.player.level
    return await _system_ref.skill_system.activate_skill(skill_id, level)


@app.get("/api/penalty")
async def get_penalty():
    """获取惩罚状态"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    return _system_ref.penalty_system.get_status()


# ── Shadow Army API ────────────────────────────────

@app.get("/api/shadows")
async def get_shadow_army():
    """获取影子军团状态"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    return _system_ref.shadow_army.get_army()


@app.get("/api/shadows/templates")
async def get_shadow_templates():
    """获取可解锁的影子模板"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    level = _system_ref.player_mgr.player.level
    return {"templates": _system_ref.shadow_army.get_unlockable_templates(level)}


@app.post("/api/shadows/extract")
async def extract_shadow(body: dict):
    """抽取影子 (从完成的任务创建自动化)
    POST body: {
        "name": "影子名字",
        "type": "warrior|guardian|scribe|mage|general",
        "rank": "normal|elite|knight|commander|monarch",
        "description": "这个影子做什么",
        "trigger": {"kind": "cron", "interval_minutes": 30},
        "action": {"kind": "shell", "command": "..."},
        "source_quest_id": "可选",
        "source_quest_title": "可选"
    }
    """
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    from ..system.shadow_army import ShadowType, ShadowRank

    try:
        shadow_type = ShadowType(body.get("type", "warrior"))
        rank = ShadowRank(body.get("rank", "normal"))
    except ValueError as e:
        return JSONResponse({"error": f"无效参数: {e}"}, status_code=400)

    level = _system_ref.player_mgr.player.level
    return await _system_ref.shadow_army.extract_shadow(
        source_quest_id=body.get("source_quest_id"),
        source_quest_title=body.get("source_quest_title", ""),
        name=body.get("name", "无名影子"),
        shadow_type=shadow_type,
        rank=rank,
        description=body.get("description", ""),
        trigger=body.get("trigger", {}),
        action=body.get("action", {}),
        player_level=level,
    )


@app.post("/api/shadows/extract-template/{template_id}")
async def extract_shadow_from_template(template_id: str):
    """从预定义模板抽取影子"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    level = _system_ref.player_mgr.player.level
    return await _system_ref.shadow_army.extract_from_template(template_id, level)


@app.post("/api/shadows/{shadow_id}/deploy")
async def deploy_shadow(shadow_id: str):
    """部署影子 (激活)"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    return await _system_ref.shadow_army.deploy_shadow(shadow_id)


@app.post("/api/shadows/{shadow_id}/recall")
async def recall_shadow(shadow_id: str):
    """召回影子 (休眠)"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    return await _system_ref.shadow_army.recall_shadow(shadow_id)


@app.post("/api/shadows/{shadow_id}/destroy")
async def destroy_shadow(shadow_id: str):
    """销毁影子"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    return await _system_ref.shadow_army.destroy_shadow(shadow_id)


@app.get("/api/devices")
async def get_devices():
    """获取所有设备"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    return {
        "devices": _system_ref.device_manager.get_all_devices(),
        "stats": _system_ref.device_manager.get_stats(),
        "openclaw_available": _system_ref.openclaw_bridge._openclaw_available,
    }


@app.get("/api/devices/switches")
async def get_device_switches():
    """获取设备切换历史"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    return {
        "switches": _system_ref.device_manager.get_switch_history(),
    }


@app.get("/api/devices/timeline")
async def get_device_timeline():
    """获取多设备合并时间线"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    return {
        "timeline": _system_ref.device_manager.get_merged_timeline(),
    }


@app.post("/api/devices/{device_id}/notify")
async def notify_device(device_id: str, body: dict):
    """向指定设备发送通知"""
    if not _system_ref:
        return JSONResponse({"error": "系统未初始化"}, status_code=503)

    success = await _system_ref.openclaw_bridge.send_notification(
        device_id,
        body.get("title", "独自升级系统"),
        body.get("message", ""),
    )
    return {"success": success}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket 实时推送"""
    await websocket.accept()
    _ws_clients.add(websocket)
    try:
        while True:
            # 保持连接，接收客户端消息（如手动触发）
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("action") == "complete_quest" and msg.get("quest_id"):
                    if _system_ref:
                        await _system_ref.quest_engine.complete_quest(msg["quest_id"])
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        _ws_clients.discard(websocket)


async def broadcast_ws(message: dict) -> None:
    """向所有 WebSocket 客户端广播消息"""
    if not _ws_clients:
        return
    data = json.dumps(message, default=str)
    disconnected = set()
    for ws in _ws_clients:
        try:
            await ws.send_text(data)
        except Exception:
            disconnected.add(ws)
    _ws_clients -= disconnected


# 挂载静态文件 (Web UI)
ui_dir = Path(__file__).parent.parent / "ui" / "web"
if ui_dir.exists():
    app.mount("/", StaticFiles(directory=str(ui_dir), html=True), name="static")
