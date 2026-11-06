use crate::db::{sync_pair_code, Database};
use futures_util::{future::join_all, stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tauri::AppHandle;
use tokio::{net::UdpSocket, sync::Mutex};

const MULTICAST_GROUP: &str = "224.0.0.167";
const SYNC_DISCOVERY_VERSION: &str = "1.0";

/// 手动链接 / 在线检测的握手超时
const PROBE_TIMEOUT: Duration = Duration::from_millis(2500);
/// 扫网段时单个地址的超时：局域网里活着的设备几十毫秒就回
const SCAN_TIMEOUT: Duration = Duration::from_millis(700);
/// 扫网段并发数
const SCAN_CONCURRENCY: usize = 64;
/// 分阶段发现（同 LocalSend 的 StartSmartScan）：先组播 + 探测已链接设备，
/// 这么久还没确认到任何设备，才退回扫网段
const SCAN_GRACE: Duration = Duration::from_secs(1);

/// 对端 /api/sync/hello 的返回（电脑与手机同一协议）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerHello {
    pub device_id: String,
    #[serde(default)]
    pub pair_code: String,
    #[serde(default)]
    pub server_time: String,
    #[serde(default)]
    pub protocol_version: i32,
    #[serde(default)]
    pub tables: Vec<String>,
    #[serde(default)]
    pub alias: String,
    #[serde(default)]
    pub device_type: String,
    #[serde(default)]
    pub device_model: String,
}

/// 探测结果：实际连通的 base（含端口）+ 对端握手信息
#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub base: String,
    pub hello: PeerHello,
}

#[derive(Deserialize)]
struct HelloEnvelope {
    success: bool,
    data: Option<PeerHello>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPeer {
    pub device_id: String,
    pub pair_code: String,
    pub alias: String,
    pub ip: String,
    pub port: u16,
    pub protocol: String,
    pub last_seen_at: String,
    pub source: String,
    #[serde(default)]
    pub device_type: String,
    #[serde(default)]
    pub device_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncDiscoveryDto {
    pub alias: String,
    pub version: String,
    pub device_id: String,
    pub pair_code: String,
    pub port: u16,
    pub protocol: String,
    pub announce: bool,
    #[serde(default)]
    pub device_type: String,
    #[serde(default)]
    pub device_model: String,
    /// 对端希望多久同步一轮（秒）：手机在后台时发 300，前台和旧版本是 0（按默认冷却）
    #[serde(default)]
    pub sync_after_s: u64,
}

pub struct SyncDiscoveryState {
    pub peers: Mutex<HashMap<String, SyncPeer>>,
    pub device_id: String,
    pub pair_code: String,
    pub alias: std::sync::Mutex<String>,
    pub port: u16,
    pub device_type: &'static str,
    pub device_model: &'static str,
    pub db: Arc<Database>,
    // ⚠️ Arc 包一层避免 AppHandle::clone 触发 Rc<tao::EventLoopRunner>::clone
    // 在非主线程上 UB —— 详见 api.rs::ApiState 注释 / Tauri issue #15408
    pub app_handle: Arc<AppHandle>,
}

impl SyncDiscoveryState {
    pub async fn peers(&self) -> Vec<SyncPeer> {
        // 75 秒陈旧阈值：多播周期 30s + 重传抖动 + 网络抖动留 buffer
        let threshold = (chrono::Local::now() - chrono::Duration::seconds(75))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        let mut peers = self.peers.lock().await.values()
            .filter(|p| p.last_seen_at.as_str() >= threshold.as_str())
            .cloned()
            .collect::<Vec<_>>();
        peers.sort_by(|a, b| b.last_seen_at.cmp(&a.last_seen_at).then(a.alias.cmp(&b.alias)));
        peers
    }

    pub fn alias(&self) -> String {
        self.alias.lock().map(|g| g.clone()).unwrap_or_else(|_| String::new())
    }

    pub fn set_alias(&self, alias: String) {
        if let Ok(mut guard) = self.alias.lock() {
            *guard = alias;
        }
    }

    /// 组播发现到的设备
    pub async fn remember_peer(&self, dto: SyncDiscoveryDto, addr: SocketAddr, source: &'static str) {
        let peer = SyncPeer {
            device_id: dto.device_id,
            pair_code: dto.pair_code,
            alias: dto.alias,
            ip: addr.ip().to_string(),
            port: dto.port,
            protocol: dto.protocol,
            last_seen_at: local_now_string(),
            source: source.to_string(),
            device_type: dto.device_type,
            device_model: dto.device_model,
        };
        self.insert_peer(peer, Duration::from_secs(dto.sync_after_s)).await;
    }

    /// HTTP 探测 / 扫网段发现到的设备
    async fn remember_hello(&self, hello: PeerHello, base: &str) {
        let Ok(url) = reqwest::Url::parse(base) else { return };
        let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else { return };
        let peer = SyncPeer {
            device_id: hello.device_id,
            pair_code: hello.pair_code,
            alias: hello.alias,
            ip: host.to_string(),
            port,
            protocol: url.scheme().to_string(),
            last_seen_at: local_now_string(),
            source: "http".to_string(),
            device_type: hello.device_type,
            device_model: hello.device_model,
        };
        // 探测和扫网段是主人点刷新触发的，按默认冷却
        self.insert_peer(peer, Duration::ZERO).await;
    }

    async fn insert_peer(&self, peer: SyncPeer, sync_after: Duration) {
        if peer.device_id == self.device_id {
            return;
        }
        let peer_base = format!("{}://{}:{}", peer.protocol, peer.ip, peer.port);
        let device_id = peer.device_id.clone();
        self.peers.lock().await.insert(peer.device_id.clone(), peer);

        // 命中已链接设备则自动后台同步
        let db = self.db.clone();
        let app = self.app_handle.clone();
        tokio::spawn(async move {
            crate::sync_engine::maybe_sync_on_discover(db, app, &device_id, &peer_base, sync_after).await;
        });
    }

    /// 探测一个用户输入的地址（纯查询，不登记、不触发同步）。
    /// 带端口就试那个端口；只填 IP 就试主端口。
    pub async fn probe(&self, target: &str) -> Result<ProbeResult, String> {
        let bases = candidate_bases(target, self.port)?;
        let client = lan_client(PROBE_TIMEOUT)?;
        let mut errors = Vec::new();
        for base in &bases {
            match fetch_hello(&client, base).await {
                Ok(hello) if hello.device_id == self.device_id => {
                    return Err("这是本机自己的地址".to_string());
                }
                Ok(hello) => return Ok(ProbeResult { base: base.clone(), hello }),
                Err(e) => errors.push(format!("{base}（{e}）")),
            }
        }
        Err(format!("连不上：{}", errors.join("；")))
    }

    /// 一轮分阶段发现（仿 LocalSend StartSmartScan）：
    /// ① 组播广播 + 直接探测已链接设备；② 宽限期内没确认到任何设备，再扫网段。
    pub async fn discover_round(&self) -> Vec<SyncPeer> {
        let round_start = local_now_string();

        if let Err(e) = self.send_announcement().await {
            log::warn!("[SyncDiscovery] 组播广播失败: {}", e);
        }
        let linked_bases = match self.db.list_linked_devices().await {
            Ok(links) => links.into_iter().map(|l| l.last_base).collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        if let Ok(client) = lan_client(SCAN_TIMEOUT) {
            let probes = linked_bases.iter().map(|base| {
                let client = &client;
                async move { (base, fetch_hello(client, base).await) }
            });
            for (base, result) in join_all(probes).await {
                if let Ok(hello) = result {
                    self.remember_hello(hello, base).await;
                }
            }
        }
        tokio::time::sleep(SCAN_GRACE).await;

        let confirmed = self.peers().await.iter().any(|p| p.last_seen_at >= round_start);
        if !confirmed {
            let subnets = subnets_to_scan(&linked_bases);
            log::info!("[SyncDiscovery] 组播 {:?} 未确认到设备，扫网段: {:?}", SCAN_GRACE, subnets);
            self.scan_subnets(&subnets).await;
        }
        self.peers().await
    }

    /// 把每个 /24 网段的 1–254 各问一遍 /api/sync/hello
    async fn scan_subnets(&self, subnets: &[[u8; 3]]) {
        let Ok(client) = lan_client(SCAN_TIMEOUT) else { return };
        let own = local_ipv4();
        let port = self.port;
        let bases = subnets
            .iter()
            .flat_map(|net| (1..=254u8).map(move |host| Ipv4Addr::new(net[0], net[1], net[2], host)))
            .filter(|ip| Some(*ip) != own)
            .map(|ip| format!("http://{ip}:{port}"))
            .collect::<Vec<_>>();

        let found = stream::iter(bases)
            .map(|base| {
                let client = &client;
                async move { fetch_hello(client, &base).await.ok().map(|hello| (base, hello)) }
            })
            .buffer_unordered(SCAN_CONCURRENCY)
            .filter_map(|hit| async move { hit })
            .collect::<Vec<_>>()
            .await;

        for (base, hello) in found {
            self.remember_hello(hello, &base).await;
        }
    }

    pub fn dto(&self, announce: bool) -> SyncDiscoveryDto {
        SyncDiscoveryDto {
            alias: self.alias(),
            version: SYNC_DISCOVERY_VERSION.to_string(),
            device_id: self.device_id.clone(),
            pair_code: self.pair_code.clone(),
            port: self.port,
            protocol: "http".to_string(),
            announce,
            device_type: self.device_type.to_string(),
            device_model: self.device_model.to_string(),
            sync_after_s: 0,
        }
    }

    pub async fn send_announcement(&self) -> Result<(), String> {
        let socket = UdpSocket::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(&self.dto(true)).map_err(|e| e.to_string())?;
        let target = format!("{}:{}", MULTICAST_GROUP, self.port);
        for wait_ms in [0, 180, 650] {
            if wait_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
            }
            socket.send_to(&bytes, &target).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

pub async fn start(db: Arc<Database>, app_handle: Arc<AppHandle>, port: u16) -> Arc<SyncDiscoveryState> {
    let device_id = db.sync_device_id().await.unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
    let alias = db.sync_alias().await.unwrap_or_else(|_| crate::db::generate_alias(&device_id));
    let state = Arc::new(SyncDiscoveryState {
        pair_code: sync_pair_code(&device_id),
        device_id,
        alias: std::sync::Mutex::new(alias),
        port,
        peers: Mutex::new(HashMap::new()),
        device_type: device_type(),
        device_model: device_model(),
        db: db.clone(),
        app_handle,
    });

    let listener_state = state.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_listener(listener_state, port).await {
            log::warn!("[SyncDiscovery] UDP {} 发现监听未启动: {}", port, e);
        }
    });

    let announce_state = state.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        if let Err(e) = announce_state.send_announcement().await {
            log::warn!("[SyncDiscovery] 启动广播失败: {}", e);
        }
    });

    // 周期性重新广播 + 让对端持续刷新自己的 last_seen_at（用来识别离线）
    let beacon_state = state.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            if let Err(e) = beacon_state.send_announcement().await {
                log::warn!("[SyncDiscovery] 周期广播失败: {}", e);
            }
        }
    });

    state
}

async fn run_listener(state: Arc<SyncDiscoveryState>, listen_port: u16) -> Result<(), String> {
    let std_socket = std::net::UdpSocket::bind(("0.0.0.0", listen_port)).map_err(|e| e.to_string())?;
    std_socket.set_nonblocking(true).map_err(|e| e.to_string())?;
    std_socket
        .join_multicast_v4(&MULTICAST_GROUP.parse::<Ipv4Addr>().map_err(|e| e.to_string())?, &Ipv4Addr::UNSPECIFIED)
        .map_err(|e| e.to_string())?;
    let socket = UdpSocket::from_std(std_socket).map_err(|e| e.to_string())?;
    log::info!(
        "[SyncDiscovery] UDP multicast 发现监听: {}:{}",
        MULTICAST_GROUP,
        listen_port
    );

    let mut buf = vec![0_u8; 2048];
    loop {
        let (len, addr) = socket.recv_from(&mut buf).await.map_err(|e| e.to_string())?;
        let Ok(dto) = serde_json::from_slice::<SyncDiscoveryDto>(&buf[..len]) else {
            continue;
        };
        if dto.device_id == state.device_id {
            continue; // 自己发出的组播回环
        }
        let should_answer = dto.announce;
        // 回复要发到对方声明的端口，而不是本机端口
        let reply_port = dto.port;
        state.remember_peer(dto, addr, "multicast").await;

        if should_answer {
            let response = serde_json::to_vec(&state.dto(false)).map_err(|e| e.to_string())?;
            let target = SocketAddr::new(addr.ip(), reply_port);
            let _ = socket.send_to(&response, target).await;
        }
    }
}

/// 局域网专用 HTTP 客户端：短超时 + 永不走代理（开发机常挂着 http_proxy 环境变量）
fn lan_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout)
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch_hello(client: &reqwest::Client, base: &str) -> Result<PeerHello, String> {
    let url = format!("{}/api/sync/hello", base.trim_end_matches('/'));
    let resp = client.get(&url).send().await.map_err(|e| {
        if e.is_timeout() { "超时无响应".to_string() }
        else if e.is_connect() { "连接被拒绝".to_string() }
        else { e.to_string() }
    })?;
    let envelope: HelloEnvelope = resp.json().await.map_err(|_| "对方不是 Solevup 同步服务".to_string())?;
    match (envelope.success, envelope.data) {
        (true, Some(hello)) if !hello.device_id.is_empty() => Ok(hello),
        _ => Err(envelope.error.unwrap_or_else(|| "握手失败".to_string())),
    }
}

/// 用户输入 → 候选 base 列表。带端口只试那个端口；只填主机就每个发现端口各试一次。
fn candidate_bases(target: &str, default_port: u16) -> Result<Vec<String>, String> {
    let trimmed = target.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("请先输入对方的 IP 或地址".to_string());
    }
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("http://{trimmed}") };
    let url = reqwest::Url::parse(&with_scheme).map_err(|_| format!("地址格式不对：{trimmed}"))?;
    let host = url.host_str().ok_or_else(|| format!("地址里没有主机：{trimmed}"))?;
    let scheme = url.scheme();
    let port = url.port().unwrap_or(default_port);
    Ok(vec![format!("{scheme}://{host}:{port}")])
}

/// 本机主网卡的 IPv4：UDP socket 对外 connect 只选路由、不发包
fn local_ipv4() -> Option<Ipv4Addr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}

/// 要扫的 /24 网段：本机主地址所在网段 + 已链接设备所在网段，只要私有地址。
/// 本机主地址可能是 VPN/Clash TUN 虚拟网卡（如 198.18.x.x，非私有段）→ 自然被过滤，
/// 此时靠已链接设备的网段兜底。
fn subnets_to_scan(linked_bases: &[String]) -> Vec<[u8; 3]> {
    let linked_ips = linked_bases.iter().filter_map(|base| {
        reqwest::Url::parse(base).ok()?.host_str()?.parse::<Ipv4Addr>().ok()
    });
    let mut seen = HashSet::new();
    local_ipv4()
        .into_iter()
        .chain(linked_ips)
        .filter(|ip| ip.is_private())
        .map(|ip| {
            let [a, b, c, _] = ip.octets();
            [a, b, c]
        })
        .filter(|net| seen.insert(*net))
        .collect()
}

pub fn device_type() -> &'static str {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        "mobile"
    } else {
        "desktop"
    }
}

pub fn device_model() -> &'static str {
    if cfg!(target_os = "windows") { "Windows" }
    else if cfg!(target_os = "macos") { "macOS" }
    else if cfg!(target_os = "linux") { "Linux" }
    else if cfg!(target_os = "android") { "Android" }
    else if cfg!(target_os = "ios") { "iOS" }
    else { "Unknown" }
}

fn local_now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}
