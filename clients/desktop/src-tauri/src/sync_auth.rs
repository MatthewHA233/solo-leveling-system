// ══════════════════════════════════════════════
// SyncAuth — 局域网同步的配对和访问控制（对应手机端 sync/SyncPairing.kt）
//
// 39733 监听所有网卡，同步接口能读到 API Key 和聊天记录，所以：
//   · 配对：被链接的一方生成 6 位配对码，发起方输入一次，换到长期令牌，两边各存一份，之后不用再输
//   · 局域网来的请求：除 hello 和配对外都要带令牌
//   · 本机页面：不用令牌，但要挡住网页（Origin）和 DNS 重绑定（Host）
//   · 发令牌和数据之前：先用挑战应答确认对面持有同一个令牌。发现广播谁都能发，
//     不校验的话，有人冒充已链接设备的 device_id 就能骗走令牌和全量数据
//
// 流量本身还是明文 HTTP：能抓包的人看得到内容，这里防的是局域网里其他设备直接来读写。
// ══════════════════════════════════════════════

use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

pub const PAIR_CODE_TTL: Duration = Duration::from_secs(300);
/// 输错这么多次作废：百万分之五的猜中概率，且要主人再次点生成才会有新码
const MAX_PAIR_FAILURES: u32 = 5;

const HMAC_BLOCK: usize = 64;
const PROOF_PREFIX: &str = "solevup-sync-proof:v1";

/// 桌面端页面的来源。Windows 是 tauri.localhost，macOS 是 tauri://localhost，开发时是 vite
const TRUSTED_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:5172",
    "http://127.0.0.1:5172",
];

/// 登录窗口里注入的脚本回传结果（lib.rs、bili_download.rs）。页面在 B 站、阿里云域名下，
/// 只写结果不返回数据，所以按路径放行这些来源
const LOGIN_CALLBACK_PATHS: &[&str] = &[
    "/api/bilibili/result",
    "/api/bilibili/nav_result",
    "/api/bilibili/qualities_result",
    "/api/bilibili/playurl_result",
    "/api/bailian/account_result",
    "/api/bailian/quota_result",
];

/// 不用令牌：hello 只有设备名和型号；配对靠配对码
const PUBLIC_PATHS: &[&str] = &["/api/sync/hello", "/api/sync/pair"];

/// 只给本机页面：已配对的设备也不需要替别人生成配对码
const LOCAL_ONLY_PATHS: &[&str] = &["/api/sync/pair-code"];

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Access {
    Allow,
    /// 局域网来的，没带有效令牌
    Unauthorized,
    /// 网页或重绑定过来的，有令牌也不放
    Forbidden,
}

pub fn origin_allowed(origin: &str, path: &str) -> bool {
    TRUSTED_ORIGINS.contains(&origin) || LOGIN_CALLBACK_PATHS.contains(&path)
}

fn host_is_local(host: Option<&str>) -> bool {
    let Some(host) = host else { return false };
    // 去掉端口；IPv6 字面量带方括号
    let name = match host.rfind(':') {
        Some(i) if !host.ends_with(']') => &host[..i],
        _ => host,
    };
    matches!(name.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "[::1]")
}

pub fn check_access(path: &str, is_loopback: bool, host: Option<&str>, origin: Option<&str>, token_valid: bool) -> Access {
    if PUBLIC_PATHS.contains(&path) {
        return Access::Allow;
    }
    if let Some(origin) = origin {
        if !origin_allowed(origin, path) {
            return Access::Forbidden;
        }
    }
    if LOCAL_ONLY_PATHS.contains(&path) {
        return if is_loopback && host_is_local(host) { Access::Allow } else { Access::Forbidden };
    }
    if token_valid || (is_loopback && host_is_local(host)) {
        return Access::Allow;
    }
    Access::Unauthorized
}

pub fn bearer_token(header: Option<&str>) -> Option<&str> {
    let token = header?.strip_prefix("Bearer ")?.trim();
    if token.is_empty() { None } else { Some(token) }
}

// ── 配对码 ──

struct ActiveCode {
    code: String,
    expires_at: Instant,
    failures: u32,
}

/// 同一时间只有一个有效码，主人点生成才有；配对成功、过期或输错太多次就作废
#[derive(Default)]
pub struct PairingState {
    active: Option<ActiveCode>,
}

impl PairingState {
    pub fn generate(&mut self) -> String {
        let bytes = uuid::Uuid::new_v4().into_bytes();
        let n = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) % 1_000_000;
        let code = format!("{n:06}");
        self.active = Some(ActiveCode { code: code.clone(), expires_at: Instant::now() + PAIR_CODE_TTL, failures: 0 });
        code
    }

    pub fn verify(&mut self, input: &str) -> Result<(), &'static str> {
        self.verify_at(input, Instant::now())
    }

    pub(crate) fn verify_at(&mut self, input: &str, now: Instant) -> Result<(), &'static str> {
        let Some(active) = self.active.as_mut() else {
            return Err("对方还没有生成配对码");
        };
        if now >= active.expires_at {
            self.active = None;
            return Err("配对码已过期，请在对方设备上重新生成");
        }
        if constant_time_eq(active.code.as_bytes(), input.trim().as_bytes()) {
            self.active = None;
            return Ok(());
        }
        active.failures += 1;
        if active.failures >= MAX_PAIR_FAILURES {
            self.active = None;
            return Err("配对码输错次数太多已作废，请在对方设备上重新生成");
        }
        Err("配对码不对")
    }
}

// ── 令牌和挑战应答 ──

fn random_hex(uuids: usize) -> String {
    (0..uuids).map(|_| uuid::Uuid::new_v4().simple().to_string()).collect()
}

/// uuid v4 来自系统随机源，每个 122 位
pub fn new_token() -> String {
    random_hex(2)
}

pub fn new_challenge() -> String {
    random_hex(1)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; HMAC_BLOCK];
    if key.len() > HMAC_BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let inner = Sha256::new()
        .chain_update(block.map(|b| b ^ 0x36))
        .chain_update(message)
        .finalize();
    Sha256::new()
        .chain_update(block.map(|b| b ^ 0x5c))
        .chain_update(inner)
        .finalize()
        .into()
}

/// 持有令牌才算得出来；绑上应答方的 device_id，别人的应答不能拿来冒充这台
pub fn peer_proof(token: &str, challenge: &str, device_id: &str) -> String {
    let message = format!("{PROOF_PREFIX}:{challenge}:{device_id}");
    hmac_sha256(token.as_bytes(), message.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn verify_proof(token: &str, challenge: &str, device_id: &str, proof: &str) -> bool {
    constant_time_eq(peer_proof(token, challenge, device_id).as_bytes(), proof.as_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
