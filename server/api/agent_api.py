"""
Agent API — 处理客户端 (macOS/Windows/Android) 的数据上报和通信

这些端点遵循 protocol/agent-protocol.md 定义的统一协议。
"""

import base64
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel

router = APIRouter(prefix="/api/v1/agent", tags=["Agent"])

# 全局引用 (在 server.py 启动时注入)
_system_ref = None
# 设备 WebSocket 连接池
_agent_ws_clients: dict[str, WebSocket] = {}


def set_system_ref(system):
    global _system_ref
    _system_ref = system


# ── Pydantic Models ────────────────────────────────

class ActiveWindow(BaseModel):
    app_name: Optional[str] = None
    window_title: Optional[str] = None
    bundle_id: Optional[str] = None


class Snapshot(BaseModel):
    screenshot_b64: Optional[str] = None
    active_window: ActiveWindow = ActiveWindow()
    idle_seconds: float = 0
    is_screen_locked: bool = False
    battery_level: Optional[int] = None
    network_type: Optional[str] = None


class AgentReport(BaseModel):
    device_id: str
    timestamp: str
    snapshot: Snapshot


class HeartbeatRequest(BaseModel):
    device_id: str
    timestamp: str
    agent_version: Optional[str] = None
    platform: Optional[str] = None
    platform_version: Optional[str] = None


class RegisterRequest(BaseModel):
    device_id: str
    device_name: str
    device_type: str  # mac / windows / android
    platform: str
    platform_version: Optional[str] = None
    agent_version: Optional[str] = None


# ── 内存存储 (后续迁移到 SQLite) ──────────────────

# 设备注册表
_devices: dict[str, dict] = {}
# 最近的 report (每设备保留最近 100 条)
_reports: dict[str, list] = {}
# 设备最后心跳
_last_heartbeat: dict[str, datetime] = {}
# 焦点设备
_focused_device: Optional[str] = None


# ── Endpoints ──────────────────────────────────────

@router.post("/report")
async def receive_report(report: AgentReport):
    """接收客户端上报的感知数据"""
    device_id = report.device_id
    
    # 确保设备已注册 (自动注册)
    if device_id not in _devices:
        _devices[device_id] = {
            "device_id": device_id,
            "device_name": device_id,
            "device_type": _infer_device_type(device_id),
            "registered_at": datetime.now().isoformat(),
        }
    
    # 更新设备最后活动时间
    _devices[device_id]["last_seen"] = datetime.now().isoformat()
    _devices[device_id]["is_online"] = True
    _last_heartbeat[device_id] = datetime.now()
    
    # 保存 report
    if device_id not in _reports:
        _reports[device_id] = []
    
    report_data = {
        "id": f"rpt_{uuid.uuid4().hex[:8]}",
        "timestamp": report.timestamp,
        "active_window": report.snapshot.active_window.dict(),
        "idle_seconds": report.snapshot.idle_seconds,
        "is_screen_locked": report.snapshot.is_screen_locked,
        "has_screenshot": report.snapshot.screenshot_b64 is not None,
        "battery_level": report.snapshot.battery_level,
    }
    _reports[device_id].append(report_data)
    
    # 保留最近 100 条
    if len(_reports[device_id]) > 100:
        _reports[device_id] = _reports[device_id][-100:]
    
    # 更新焦点设备
    _update_focus(device_id, report.snapshot.idle_seconds)
    
    # 如果系统已初始化，触发分析
    if _system_ref:
        await _trigger_analysis(device_id, report)
    
    return {
        "success": True,
        "message": "Report received",
        "data": {
            "next_interval": _get_recommended_interval(device_id),
            "pending_notifications": 0,
            "is_focused": _focused_device == device_id,
        }
    }


@router.post("/heartbeat")
async def receive_heartbeat(req: HeartbeatRequest):
    """接收设备心跳"""
    device_id = req.device_id
    
    # 自动注册
    if device_id not in _devices:
        _devices[device_id] = {
            "device_id": device_id,
            "device_name": device_id,
            "device_type": _infer_device_type(device_id),
            "platform": req.platform,
            "platform_version": req.platform_version,
            "agent_version": req.agent_version,
            "registered_at": datetime.now().isoformat(),
        }
    
    _devices[device_id]["last_seen"] = datetime.now().isoformat()
    _devices[device_id]["is_online"] = True
    _devices[device_id]["agent_version"] = req.agent_version
    _last_heartbeat[device_id] = datetime.now()
    
    return {
        "success": True,
        "is_focused": _focused_device == device_id,
        "server_time": datetime.now().isoformat(),
    }


@router.post("/register")
async def register_device(req: RegisterRequest):
    """注册新设备"""
    _devices[req.device_id] = {
        "device_id": req.device_id,
        "device_name": req.device_name,
        "device_type": req.device_type,
        "platform": req.platform,
        "platform_version": req.platform_version,
        "agent_version": req.agent_version,
        "registered_at": datetime.now().isoformat(),
        "is_online": True,
        "is_focused": False,
    }
    
    return {
        "success": True,
        "message": f"Device {req.device_id} registered",
        "device": _devices[req.device_id],
    }


@router.get("/status")
async def get_device_status(device_id: str):
    """获取设备状态"""
    if device_id not in _devices:
        return JSONResponse({"error": "Device not found"}, status_code=404)
    
    device = _devices[device_id]
    recent_reports = _reports.get(device_id, [])[-10:]
    
    return {
        "device": device,
        "recent_reports": recent_reports,
        "is_focused": _focused_device == device_id,
        "total_reports": len(_reports.get(device_id, [])),
    }


@router.get("/devices")
async def list_devices():
    """列出所有已注册设备"""
    # 标记离线设备 (超过 2 分钟无心跳)
    now = datetime.now()
    for device_id, last_hb in _last_heartbeat.items():
        if (now - last_hb).total_seconds() > 120:
            _devices[device_id]["is_online"] = False
    
    return {
        "devices": list(_devices.values()),
        "focused_device": _focused_device,
        "total_devices": len(_devices),
    }


@router.get("/notifications")
async def get_pending_notifications(device_id: str, limit: int = 10):
    """获取待处理通知"""
    # TODO: 从通知引擎获取
    return {
        "notifications": [],
        "count": 0,
    }


@router.get("/timeline")
async def get_timeline(device_id: Optional[str] = None, limit: int = 50):
    """获取活动时间线 (可按设备过滤)"""
    if device_id:
        reports = _reports.get(device_id, [])[-limit:]
    else:
        # 合并所有设备的 report
        all_reports = []
        for did, reps in _reports.items():
            for r in reps:
                r["device_id"] = did
                all_reports.append(r)
        all_reports.sort(key=lambda x: x["timestamp"], reverse=True)
        reports = all_reports[:limit]
    
    return {
        "timeline": reports,
        "count": len(reports),
    }


# ── WebSocket (Agent) ─────────────────────────────

@router.websocket("/ws/{device_id}")
async def agent_websocket(websocket: WebSocket, device_id: str):
    """Agent WebSocket 连接 — 服务器推送通知到客户端"""
    await websocket.accept()
    _agent_ws_clients[device_id] = websocket
    
    try:
        while True:
            # 接收客户端消息
            data = await websocket.receive_json()
            msg_type = data.get("type", "")
            
            if msg_type == "quest_response":
                # 处理任务响应
                payload = data.get("payload", {})
                quest_id = payload.get("quest_id")
                action = payload.get("action")
                if quest_id and action == "accept" and _system_ref:
                    # TODO: 处理任务接受
                    pass
                    
            elif msg_type == "manual_report":
                # 手动活动报告
                payload = data.get("payload", {})
                # TODO: 处理手动报告
                
    except WebSocketDisconnect:
        _agent_ws_clients.pop(device_id, None)
        if device_id in _devices:
            _devices[device_id]["is_online"] = False


async def push_to_device(device_id: str, message: dict):
    """向指定设备推送消息"""
    ws = _agent_ws_clients.get(device_id)
    if ws:
        try:
            await ws.send_json(message)
            return True
        except Exception:
            _agent_ws_clients.pop(device_id, None)
            return False
    return False


async def broadcast_to_agents(message: dict):
    """向所有连接的 Agent 广播消息"""
    disconnected = []
    for device_id, ws in _agent_ws_clients.items():
        try:
            await ws.send_json(message)
        except Exception:
            disconnected.append(device_id)
    for did in disconnected:
        _agent_ws_clients.pop(did, None)


# ── Internal Helpers ───────────────────────────────

def _infer_device_type(device_id: str) -> str:
    """从设备 ID 推断设备类型"""
    if device_id.startswith("mac-"):
        return "mac"
    elif device_id.startswith("win-"):
        return "windows"
    elif device_id.startswith("android-"):
        return "android"
    return "unknown"


def _update_focus(device_id: str, idle_seconds: float):
    """更新焦点设备"""
    global _focused_device
    
    if idle_seconds < 60:  # 1 分钟内有活动
        _focused_device = device_id


def _get_recommended_interval(device_id: str) -> int:
    """根据当前状态推荐下次上报间隔"""
    reports = _reports.get(device_id, [])
    if not reports:
        return 30
    
    last_report = reports[-1]
    idle = last_report.get("idle_seconds", 0)
    
    if idle > 300:
        return 300  # 深度空闲: 5 分钟
    elif idle > 60:
        return 120  # 空闲: 2 分钟
    else:
        return 30   # 活跃: 30 秒


async def _trigger_analysis(device_id: str, report: AgentReport):
    """触发 AI 分析 (如果系统已初始化)"""
    if not _system_ref:
        return
    
    # 构造快照数据，触发现有分析管线
    from ..storage.models import ContextSnapshot
    
    snapshot = ContextSnapshot(
        id=f"agent_{uuid.uuid4().hex[:8]}",
        timestamp=datetime.now(),
        active_window=report.snapshot.active_window.app_name or "unknown",
        window_title=report.snapshot.active_window.window_title or "",
        ai_analysis=None,
        inferred_motive=None,
        activity_category=None,
        focus_score=None,
        device_id=device_id,
    )
    
    # 保存快照到数据库
    await _system_ref.db.save_snapshot(snapshot)
    
    # 触发 Level 1 分析 (规则引擎, 零成本)
    if hasattr(_system_ref, 'analyzer'):
        analysis = await _system_ref.analyzer.analyze_level1(
            app_name=report.snapshot.active_window.app_name,
            window_title=report.snapshot.active_window.window_title,
            bundle_id=report.snapshot.active_window.bundle_id,
        )
        
        if analysis:
            snapshot.activity_category = analysis.get("category")
            snapshot.ai_analysis = analysis.get("summary")
            snapshot.focus_score = analysis.get("focus_score")
            await _system_ref.db.save_snapshot(snapshot)
            
            # 触发事件
            from ..core.events import EventType
            await _system_ref.bus.emit_simple(
                EventType.CONTEXT_ANALYZED,
                analysis={
                    "activity": analysis.get("summary", ""),
                    "category": analysis.get("category", "other"),
                    "motive": "",
                    "focus_score": analysis.get("focus_score", 0.5),
                    "device_id": device_id,
                },
            )
