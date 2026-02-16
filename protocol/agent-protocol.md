# Agent Protocol — 客户端 ↔ 服务器通信协议

> 版本: 1.0.0  
> 更新: 2026-02-16

## 概述

所有平台客户端 (macOS / Windows / Android) 通过统一的 HTTP + WebSocket 协议与后端服务器通信。

## 认证

所有请求携带 `Authorization: Bearer <api_key>` header (未来实现)。

---

## HTTP Endpoints

### 1. 上报感知数据

```
POST /api/v1/agent/report
Content-Type: application/json
```

**Request Body:**
```json
{
  "device_id": "mac-a1b2c3d4",
  "timestamp": "2026-02-16T10:30:00+08:00",
  "snapshot": {
    "screenshot_b64": "<base64 encoded JPEG>",
    "active_window": {
      "app_name": "Visual Studio Code",
      "window_title": "main.py — solo-leveling-system",
      "bundle_id": "com.microsoft.VSCode"
    },
    "idle_seconds": 0,
    "is_screen_locked": false,
    "battery_level": 85,
    "network_type": "wifi"
  }
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Report received",
  "data": {
    "next_interval": 30,
    "pending_notifications": 0
  }
}
```

### 2. 设备心跳

```
POST /api/v1/agent/heartbeat
Content-Type: application/json
```

**Request Body:**
```json
{
  "device_id": "mac-a1b2c3d4",
  "timestamp": "2026-02-16T10:30:00+08:00",
  "agent_version": "0.1.0",
  "platform": "macOS",
  "platform_version": "15.2"
}
```

**Response (200):**
```json
{
  "success": true,
  "is_focused": true,
  "server_time": "2026-02-16T10:30:00+08:00"
}
```

### 3. 注册设备

```
POST /api/v1/agent/register
Content-Type: application/json
```

**Request Body:**
```json
{
  "device_id": "mac-a1b2c3d4",
  "device_name": "CC 的 MacBook Pro",
  "device_type": "mac",
  "platform": "macOS",
  "platform_version": "15.2",
  "agent_version": "0.1.0"
}
```

### 4. 获取设备状态

```
GET /api/v1/agent/status?device_id=mac-a1b2c3d4
```

### 5. 获取待处理通知

```
GET /api/v1/agent/notifications?device_id=mac-a1b2c3d4&limit=10
```

---

## WebSocket

### 连接

```
WS /ws/agent/{device_id}
```

### 服务器 → 客户端

**通知推送:**
```json
{
  "type": "notification",
  "payload": {
    "title": "⚔️ 新任务！",
    "body": "[B级] 完成项目架构设计",
    "actions": ["接受", "稍后"],
    "quest_id": "quest_001",
    "priority": "normal"
  }
}
```

**Buff/Debuff 变化:**
```json
{
  "type": "buff_change",
  "payload": {
    "name": "专注光环",
    "action": "activated",
    "duration_minutes": 60,
    "description": "连续编程超过 30 分钟，效率 +20%"
  }
}
```

**系统消息:**
```json
{
  "type": "system_message",
  "payload": {
    "message": "「你已达到今日经验上限的 50%。继续前进。」",
    "style": "info"
  }
}
```

### 客户端 → 服务器

**任务响应:**
```json
{
  "type": "quest_response",
  "payload": {
    "quest_id": "quest_001",
    "action": "accept"
  }
}
```

**手动报告:**
```json
{
  "type": "manual_report",
  "payload": {
    "activity": "完成了 Solo Agent 的 UI 设计",
    "category": "development"
  }
}
```

---

## 数据大小预估

| 项目 | 大小 |
|------|------|
| 单次报告 (含截图) | ~50-100 KB |
| 心跳 | < 1 KB |
| 每日总上传量 (30s间隔) | ~150-300 MB |
| 每日总上传量 (60s间隔) | ~75-150 MB |
| WebSocket 消息 | < 1 KB / 条 |

## 错误码

| HTTP 状态码 | 含义 |
|------------|------|
| 200 | 成功 |
| 400 | 请求格式错误 |
| 401 | 未认证 |
| 429 | 请求过频 |
| 500 | 服务器错误 |
