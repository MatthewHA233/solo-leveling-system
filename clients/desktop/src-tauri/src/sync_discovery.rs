use crate::db::{sync_pair_code, Database};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
};
use tauri::AppHandle;
use tokio::{net::UdpSocket, sync::Mutex};

const MULTICAST_GROUP: &str = "224.0.0.167";
const SYNC_DISCOVERY_VERSION: &str = "1.0";

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

    pub async fn remember_peer(&self, dto: SyncDiscoveryDto, addr: SocketAddr, source: &'static str) {
        if dto.device_id == self.device_id {
            return;
        }

        let ip = addr.ip().to_string();
        let peer_port = dto.port;
        let peer_base = format!("{}://{}:{}", dto.protocol.clone().to_owned().as_str(), &ip, peer_port);
        let peer = SyncPeer {
            device_id: dto.device_id.clone(),
            pair_code: dto.pair_code,
            alias: dto.alias,
            ip,
            port: peer_port,
            protocol: dto.protocol,
            last_seen_at: local_now_string(),
            source: source.to_string(),
            device_type: dto.device_type,
            device_model: dto.device_model,
        };
        let device_id = dto.device_id.clone();
        self.peers.lock().await.insert(dto.device_id, peer);

        // 命中已链接设备则自动后台同步
        let db = self.db.clone();
        let app = self.app_handle.clone();
        tokio::spawn(async move {
            crate::sync_engine::maybe_sync_on_discover(db, app, &device_id, &peer_base).await;
        });
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
        if let Err(e) = run_listener(listener_state).await {
            log::warn!("[SyncDiscovery] UDP 发现监听未启动: {}", e);
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

async fn run_listener(state: Arc<SyncDiscoveryState>) -> Result<(), String> {
    let std_socket = std::net::UdpSocket::bind(("0.0.0.0", state.port)).map_err(|e| e.to_string())?;
    std_socket.set_nonblocking(true).map_err(|e| e.to_string())?;
    std_socket
        .join_multicast_v4(&MULTICAST_GROUP.parse::<Ipv4Addr>().map_err(|e| e.to_string())?, &Ipv4Addr::UNSPECIFIED)
        .map_err(|e| e.to_string())?;
    let socket = UdpSocket::from_std(std_socket).map_err(|e| e.to_string())?;
    log::info!(
        "[SyncDiscovery] UDP multicast 发现监听: {}:{}",
        MULTICAST_GROUP,
        state.port
    );

    let mut buf = vec![0_u8; 2048];
    loop {
        let (len, addr) = socket.recv_from(&mut buf).await.map_err(|e| e.to_string())?;
        let Ok(dto) = serde_json::from_slice::<SyncDiscoveryDto>(&buf[..len]) else {
            continue;
        };
        let should_answer = dto.announce;
        state.remember_peer(dto, addr, "multicast").await;

        if should_answer {
            let response = serde_json::to_vec(&state.dto(false)).map_err(|e| e.to_string())?;
            let target = SocketAddr::new(addr.ip(), state.port);
            let _ = socket.send_to(&response, target).await;
        }
    }
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
