use crate::db::{sync_pair_code, Database};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
};
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
}

pub struct SyncDiscoveryState {
    pub peers: Mutex<HashMap<String, SyncPeer>>,
    pub device_id: String,
    pub pair_code: String,
    pub alias: String,
    pub port: u16,
}

impl SyncDiscoveryState {
    pub async fn peers(&self) -> Vec<SyncPeer> {
        let mut peers = self.peers.lock().await.values().cloned().collect::<Vec<_>>();
        peers.sort_by(|a, b| b.last_seen_at.cmp(&a.last_seen_at).then(a.alias.cmp(&b.alias)));
        peers
    }

    pub async fn remember_peer(&self, dto: SyncDiscoveryDto, addr: SocketAddr, source: &'static str) {
        if dto.device_id == self.device_id {
            return;
        }

        let peer = SyncPeer {
            device_id: dto.device_id.clone(),
            pair_code: dto.pair_code,
            alias: dto.alias,
            ip: addr.ip().to_string(),
            port: dto.port,
            protocol: dto.protocol,
            last_seen_at: local_now_string(),
            source: source.to_string(),
        };
        self.peers.lock().await.insert(dto.device_id, peer);
    }

    pub fn dto(&self, announce: bool) -> SyncDiscoveryDto {
        SyncDiscoveryDto {
            alias: self.alias.clone(),
            version: SYNC_DISCOVERY_VERSION.to_string(),
            device_id: self.device_id.clone(),
            pair_code: self.pair_code.clone(),
            port: self.port,
            protocol: "http".to_string(),
            announce,
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

pub async fn start(db: Arc<Database>, port: u16) -> Arc<SyncDiscoveryState> {
    let device_id = db.sync_device_id().await.unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
    let state = Arc::new(SyncDiscoveryState {
        pair_code: sync_pair_code(&device_id),
        device_id,
        alias: default_alias(),
        port,
        peers: Mutex::new(HashMap::new()),
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

fn default_alias() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "SOLO LEVELING SYSTEM".to_string())
}

fn local_now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}
