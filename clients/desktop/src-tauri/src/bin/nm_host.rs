// ══════════════════════════════════════════════
// Native Messaging host — 扩展 ↔ 桌面端的桥
//
// Chrome 用 stdio + 4 字节小端长度前缀的 JSON 帧和本进程通信；
// 本进程再用极简 HTTP/1.1 轮询桌面端 127.0.0.1:49733：
//   · GET  /api/focus/rules     → 规则有新 revision 就推给扩展
//   · POST /api/focus/heartbeat → 上报「扩展在线」（本进程存活即扩展已连接，
//                                   扩展被禁用时 Chrome 会杀掉本进程，心跳自然中断）
//
// 不依赖 tokio/reqwest：localhost 小报文，裸 TcpStream 足够，且更轻更稳。
// ══════════════════════════════════════════════

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

const DESKTOP_HOST: &str = "127.0.0.1:49733";
const POLL_INTERVAL: Duration = Duration::from_secs(3);

fn main() {
    let running = Arc::new(AtomicBool::new(true));
    // 已推送给扩展的规则版本；poll 线程据此判断是否需要重推
    let sent_revision = Arc::new(AtomicU64::new(u64::MAX));

    // 读线程：扩展 / Chrome 来的消息。EOF（扩展被禁用、Chrome 关闭通道）→ 退出。
    {
        let running = running.clone();
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin();
            loop {
                match read_frame(&mut stdin) {
                    Some(msg) => handle_ext_message(&msg),
                    None => {
                        running.store(false, Ordering::SeqCst);
                        break;
                    }
                }
            }
        });
    }

    // 主线程：轮询规则 + 上报心跳
    while running.load(Ordering::SeqCst) {
        if let Some(snapshot) = http_get_json("/api/focus/rules") {
            let revision = snapshot
                .get("data")
                .and_then(|d| d.get("revision"))
                .and_then(|r| r.as_u64())
                .unwrap_or(0);

            if revision != sent_revision.load(Ordering::SeqCst) {
                let data = snapshot.get("data").cloned().unwrap_or(serde_json::Value::Null);
                let msg = serde_json::json!({
                    "type": "rules",
                    "revision": revision,
                    "websites": data.get("websites").cloned().unwrap_or(serde_json::json!([])),
                    "exceptions": data.get("exceptions").cloned().unwrap_or(serde_json::json!([])),
                });
                if write_frame(&msg).is_ok() {
                    sent_revision.store(revision, Ordering::SeqCst);
                }
            }
        }

        // 主动给扩展发心跳：扩展收到原生消息会重置 MV3 service worker 的空闲计时器，
        // 让 SW 不被回收 → 通道不断 → 心跳持续。扩展真被移除时本进程会 EOF 退出。
        // 这是“SW 打盹” vs “扩展被移除”能被区分开的关键。
        let _ = write_frame(&serde_json::json!({ "type": "heartbeat" }));

        // 心跳：本进程存活 == 扩展已连接
        let _ = http_post("/api/focus/heartbeat", "{\"ext_ready\":true}");

        std::thread::sleep(POLL_INTERVAL);
    }
}

fn handle_ext_message(msg: &serde_json::Value) {
    // 扩展回报 hello / pong / rules_applied 时，立即补一次心跳，缩短上线感知延迟
    let kind = msg.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if matches!(kind, "hello" | "pong" | "rules_applied") {
        let _ = http_post("/api/focus/heartbeat", "{\"ext_ready\":true}");
    }
}

// ── Native Messaging 帧 ───────────────────────

fn read_frame(stdin: &mut std::io::Stdin) -> Option<serde_json::Value> {
    let mut len_buf = [0u8; 4];
    stdin.read_exact(&mut len_buf).ok()?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > 64 * 1024 * 1024 {
        return None;
    }
    let mut buf = vec![0u8; len];
    stdin.read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn write_frame(msg: &serde_json::Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(msg)?;
    let mut out = std::io::stdout().lock();
    out.write_all(&(bytes.len() as u32).to_le_bytes())?;
    out.write_all(&bytes)?;
    out.flush()
}

// ── 极简 HTTP/1.1（localhost，Connection: close）──

fn http_request(method: &str, path: &str, body: Option<&str>) -> Option<String> {
    let mut stream = TcpStream::connect(DESKTOP_HOST).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok()?;

    let body = body.unwrap_or("");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: {DESKTOP_HOST}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).ok()?;

    let mut resp = String::new();
    stream.read_to_string(&mut resp).ok()?;
    let idx = resp.find("\r\n\r\n")?;
    Some(resp[idx + 4..].to_string())
}

fn http_get_json(path: &str) -> Option<serde_json::Value> {
    let body = http_request("GET", path, None)?;
    serde_json::from_str(&body).ok()
}

fn http_post(path: &str, body: &str) -> Option<String> {
    http_request("POST", path, Some(body))
}
