// ══════════════════════════════════════════════
// Solevup — Tauri 后端入口
// ══════════════════════════════════════════════

use tauri::Emitter;

mod db;
mod api;
mod sync_discovery;
mod sync_engine;
mod fish_tts;
mod perception;
mod qwen_asr;
mod qwen_omni;
mod qwen_video;
mod bili_download;
mod transcribe_queue;
mod ffmpeg;
mod ocr;
mod focus_lock;
#[cfg(windows)]
mod gpu_pref;
#[cfg(windows)]
mod hotkey;

use std::sync::{Arc, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::{Mutex, RwLock};
use fish_tts::{FishTTSConfig, FishTTSConnection};
use db::Database;
use api::{BailianState, BiliState};
use bili_download::BiliDownloadState;
use tauri::Manager;
use base64::Engine as _;

// ── 全局状态 ──

struct AppState {
    fish_tts: Arc<Mutex<Option<FishTTSConnection>>>,
    omni: qwen_omni::OmniState,
    db: Arc<RwLock<Option<Arc<Database>>>>,
    db_path: Arc<RwLock<String>>,
}

const FAIRY_CURSOR_RADIUS_DEFAULT: f64 = 126.0;
static FAIRY_CURSOR_RADIUS_BITS: OnceLock<Arc<AtomicU64>> = OnceLock::new();
static FAIRY_CURSOR_MENU_OPEN: AtomicBool = AtomicBool::new(false);
static FAIRY_CURSOR_MONITOR_RUNNING: AtomicBool = AtomicBool::new(false);

fn fairy_cursor_radius_state() -> Arc<AtomicU64> {
    FAIRY_CURSOR_RADIUS_BITS
        .get_or_init(|| Arc::new(AtomicU64::new(FAIRY_CURSOR_RADIUS_DEFAULT.to_bits())))
        .clone()
}

fn sanitize_fairy_cursor_radius(radius: f64) -> f64 {
    if radius.is_finite() {
        radius.clamp(70.0, 220.0)
    } else {
        FAIRY_CURSOR_RADIUS_DEFAULT
    }
}

// ── Tauri 命令 ──

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn fish_tts_connect(
    api_key: String,
    reference_id: String,
    sample_rate: u32,
    proxy_port: u16,
    model: String,
    event_id: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let config = FishTTSConfig {
        api_key,
        reference_id,
        sample_rate,
        proxy_port,
        model,
        event_id,
    };

    let conn = FishTTSConnection::start(config, app_handle)?;

    let mut guard = state.fish_tts.lock().await;
    *guard = Some(conn);

    log::info!("[FishTTS] 连接已建立");
    Ok(())
}

#[tauri::command]
async fn fish_tts_send_text(
    text: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let guard = state.fish_tts.lock().await;
    if let Some(conn) = guard.as_ref() {
        conn.send_text(text).await
    } else {
        Err("Fish TTS 未连接".to_string())
    }
}

#[tauri::command]
async fn fish_tts_flush(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let guard = state.fish_tts.lock().await;
    if let Some(conn) = guard.as_ref() {
        conn.flush().await
    } else {
        Err("Fish TTS 未连接".to_string())
    }
}

#[tauri::command]
async fn fish_tts_stop(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut guard = state.fish_tts.lock().await;
    if let Some(conn) = guard.take() {
        conn.stop().await
    } else {
        Ok(())
    }
}

// ── B站命令 ──

#[tauri::command]
async fn open_bili_login(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("bili-login") {
        // 窗口已存在（后台隐藏中），显示并聚焦让用户登录
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    } else {
        // 极少数情况（窗口被关掉了），重新创建并显示
        tauri::WebviewWindowBuilder::new(
            &app,
            "bili-login",
            tauri::WebviewUrl::External(
                "https://www.bilibili.com".parse().map_err(|e: url::ParseError| e.to_string())?
            ),
        )
        .title("B站 — 登录后可关闭此窗口")
        .inner_size(1200.0, 800.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct BiliSyncResult {
    upserted: usize,
    cursor_max: i64,
    cursor_view_at: i64,
    items: Vec<BiliSyncItem>,
}

#[derive(serde::Serialize)]
struct BiliSyncItem {
    bvid: String,
    cover: String,
    view_at: i64,
    title: String,
    author_name: String,
    progress: i64,   // -1 = 看完哨兵 / 0 = 点开 / 正数 = 已看秒数
    duration: i64,   // 视频总时长（秒）
}

#[derive(serde::Serialize)]
struct BiliNavInfo {
    is_login: bool,
    uname: Option<String>,
    mid: Option<i64>,
}

#[derive(serde::Serialize)]
struct BailianAccountInfo {
    is_login: bool,
    display_name: Option<String>,
}

#[tauri::command]
async fn bili_get_nav(
    app: tauri::AppHandle,
    bili: tauri::State<'_, Arc<BiliState>>,
) -> Result<BiliNavInfo, String> {
    // 窗口不存在 → 返回错误，让前端保留之前的判定（不要把"窗口被关"误判为"已登出"）
    let win = app.get_webview_window("bili-login")
        .ok_or_else(|| "BILI_WIN_NOT_OPEN".to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut guard = bili.pending_nav.lock().await;
        if guard.is_some() {
            // 已有 nav 请求在飞 → 不要覆盖（覆盖会让旧请求拿到 Err"请求已取消"）
            return Err("BILI_NAV_BUSY".to_string());
        }
        *guard = Some(tx);
    }

    let js = r#"(async()=>{
try{
  const r=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'});
  const d=await r.json();
  await fetch('http://localhost:39733/api/bilibili/nav_result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ok:d})});
}catch(e){
  await fetch('http://localhost:39733/api/bilibili/nav_result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({error:e.message||String(e)})});
}
})();"#;

    if let Err(e) = win.eval(js) {
        // eval 失败时清掉占位，避免后续请求一直拿到 BUSY
        bili.pending_nav.lock().await.take();
        return Err(e.to_string());
    }

    let raw = match tokio::time::timeout(std::time::Duration::from_secs(8), rx).await {
        Ok(Ok(result)) => result?,
        Ok(Err(_)) => {
            bili.pending_nav.lock().await.take();
            return Err("BILI_NAV_BUSY".to_string());
        }
        Err(_) => {
            bili.pending_nav.lock().await.take();
            return Err("请求超时".to_string());
        }
    };

    let data = raw.get("data");
    let is_login = data.and_then(|d| d.get("isLogin")).and_then(|v| v.as_bool()).unwrap_or(false);
    let uname    = data.and_then(|d| d.get("uname")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let mid      = data.and_then(|d| d.get("mid")).and_then(|v| v.as_i64());

    Ok(BiliNavInfo { is_login, uname, mid })
}

#[tauri::command]
async fn fetch_bili_history(
    app: tauri::AppHandle,
    bili: tauri::State<'_, Arc<BiliState>>,
    ps: Option<u32>,
    cursor_max: Option<i64>,
    cursor_view_at: Option<i64>,
) -> Result<BiliSyncResult, String> {
    let win = app.get_webview_window("bili-login")
        .ok_or_else(|| "BILI_WIN_CLOSED".to_string())?;

    let ps  = ps.unwrap_or(20).min(50);
    let max = cursor_max.unwrap_or(0);
    let vat = cursor_view_at.unwrap_or(0);

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut guard = bili.pending.lock().await;
        if guard.is_some() {
            // 已有 history 请求在飞 → 拒绝新请求（覆盖会让旧请求拿到 Err"请求已取消"）
            return Err("BILI_HISTORY_BUSY".to_string());
        }
        *guard = Some(tx);
    }

    let js = format!(
        r#"(async()=>{{
try{{
  const r=await fetch('https://api.bilibili.com/x/web-interface/history/cursor?max={max}&view_at={vat}&ps={ps}&business=archive',{{credentials:'include'}});
  const d=await r.json();
  await fetch('http://localhost:39733/api/bilibili/result',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{ok:d}})}});
}}catch(e){{
  await fetch('http://localhost:39733/api/bilibili/result',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{error:e.message||String(e)}})}});
}}
}})();"#
    );

    if let Err(e) = win.eval(&js) {
        bili.pending.lock().await.take();
        return Err(e.to_string());
    }

    let raw = match tokio::time::timeout(std::time::Duration::from_secs(15), rx).await {
        Ok(Ok(result)) => result?,
        Ok(Err(_)) => {
            bili.pending.lock().await.take();
            return Err("BILI_HISTORY_BUSY".to_string());
        }
        Err(_) => {
            bili.pending.lock().await.take();
            return Err("请求超时".to_string());
        }
    };

    // 提取 cursor（供前端加载更早历史时使用）
    let cursor_max_out  = raw.get("data").and_then(|d| d.get("cursor")).and_then(|c| c.get("max")).and_then(|v| v.as_i64()).unwrap_or(0);
    let cursor_vat_out  = raw.get("data").and_then(|d| d.get("cursor")).and_then(|c| c.get("view_at")).and_then(|v| v.as_i64()).unwrap_or(0);
    let list_arr        = raw.get("data").and_then(|d| d.get("list")).and_then(|l| l.as_array());
    let upserted        = list_arr.map(|a| a.len()).unwrap_or(0);

    // 把这一页里的 bvid + 封面 + view_at + 标题 + UP主 + 进度 + 时长 抽出来回传给前端（深度扫描瀑布卡片）
    let items: Vec<BiliSyncItem> = list_arr
        .map(|a| {
            a.iter().filter_map(|it| {
                let history = it.get("history");
                let bvid = history.and_then(|h| h.get("bvid")).and_then(|v| v.as_str()).map(|s| s.to_string())?;
                let cover = it.get("cover").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let view_at = it.get("view_at").and_then(|v| v.as_i64()).unwrap_or(0);
                let title = it.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let author_name = it.get("author_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let progress = it.get("progress").and_then(|v| v.as_i64()).unwrap_or(0);
                let duration = it.get("duration").and_then(|v| v.as_i64()).unwrap_or(0);
                Some(BiliSyncItem { bvid, cover, view_at, title, author_name, progress, duration })
            }).collect()
        })
        .unwrap_or_default();

    Ok(BiliSyncResult { upserted, cursor_max: cursor_max_out, cursor_view_at: cursor_vat_out, items })
}

#[tauri::command]
async fn open_bailian_login(app: tauri::AppHandle) -> Result<(), String> {
    let url = "https://bailian.console.aliyun.com/cn-beijing/?tab=model#/model-market/all";
    if let Some(win) = app.get_webview_window("bailian-login") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        win.eval(&format!("window.location.href = {:?};", url))
            .map_err(|e| e.to_string())?;
    } else {
        tauri::WebviewWindowBuilder::new(
            &app,
            "bailian-login",
            tauri::WebviewUrl::External(
                url.parse().map_err(|e: url::ParseError| e.to_string())?
            ),
        )
        .title("Bailian - login and quota scanner")
        .inner_size(1280.0, 860.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn open_bailian_model_detail(app: tauri::AppHandle, model_code: String) -> Result<(), String> {
    let model_code = model_code.trim();
    if model_code.is_empty() {
        return Err("MODEL_CODE_EMPTY".to_string());
    }
    let encoded_model = url::form_urlencoded::byte_serialize(model_code.as_bytes()).collect::<String>();
    let url = format!(
        "https://bailian.console.aliyun.com/cn-beijing/?tab=model#/model-market/detail/{}?serviceSite=asia-pacific-china",
        encoded_model
    );

    if let Some(win) = app.get_webview_window("bailian-login") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        win.eval(&format!("window.location.href = {:?};", url))
            .map_err(|e| e.to_string())?;
    } else {
        tauri::WebviewWindowBuilder::new(
            &app,
            "bailian-login",
            tauri::WebviewUrl::External(
                url.parse().map_err(|e: url::ParseError| e.to_string())?
            ),
        )
        .title("Bailian - model quota detail")
        .inner_size(1280.0, 860.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn bailian_get_account(
    app: tauri::AppHandle,
    bailian: tauri::State<'_, Arc<BailianState>>,
) -> Result<BailianAccountInfo, String> {
    let win = app.get_webview_window("bailian-login")
        .ok_or_else(|| "BAILIAN_WIN_NOT_OPEN".to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    let token = uuid::Uuid::new_v4().to_string();
    {
        let mut guard = bailian.pending_account.lock().await;
        if guard.is_some() {
            return Err("BAILIAN_ACCOUNT_BUSY".to_string());
        }
        *guard = Some(api::PendingAccount { token: token.clone(), tx });
    }

    let token_json = serde_json::to_string(&token).map_err(|e| e.to_string())?;
    let js = r#"(async()=>{
const TOKEN = __TOKEN__;
const post = async (payload) => {
  await fetch('http://localhost:39733/api/bailian/account_result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, token: TOKEN }),
  });
};
const pickName = () => {
  const candidates = [];
  const badName = (s) => {
    if (!s) return true;
    if (/^\d{6,}$/.test(s)) return true;
    return /^(账号|账户|账号 ID|主账号|头像|退出登录|个人认证|企业认证|控制台|费用|工单|备案|帮助|消息|购物车)$/.test(s);
  };
  const push = (v, score = 0) => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s && s.length <= 80 && !/^https?:\/\//i.test(s) && !badName(s)) candidates.push({ value: s, score });
    }
  };
  const visit = (v, depth = 0) => {
    if (!v || depth > 4) return;
    if (typeof v === 'string') {
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) push(v);
      return;
    }
    if (Array.isArray(v)) {
      v.slice(0, 20).forEach((x) => visit(x, depth + 1));
      return;
    }
    if (typeof v === 'object') {
      for (const key of ['displayName','display_name','nickName','nickname','userName','username','loginName','login_name','accountName','account_name','email','mail']) {
        push(v[key], /mail|email/i.test(key) ? 20 : 30);
      }
      Object.keys(v).slice(0, 50).forEach((key) => visit(v[key], depth + 1));
    }
  };
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) || '';
      if (!/(user|account|profile|aliyun|console|login|session)/i.test(key)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try { visit(JSON.parse(raw)); } catch { visit(raw); }
    }
  } catch {}
  const text = document.body.innerText || '';
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  push(email, 20);
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const marker of ['退出登录', '头像']) {
    const idx = lines.findIndex((s) => s === marker || s.includes(marker));
    if (idx >= 0) {
      for (let i = idx + 1; i <= Math.min(lines.length - 1, idx + 4); i += 1) {
        push(lines[i], marker === '退出登录' ? 120 : 100);
      }
    }
  }
  for (const marker of ['用户名', '用户名称', '登录名']) {
    const idx = lines.findIndex((s) => s.includes(marker));
    if (idx >= 0) {
      push(lines[idx + 1], 80);
      const inline = lines[idx].replace(/^(用户名|用户名称|登录名)[：:\s]*/, '').trim();
      if (inline !== lines[idx]) push(inline, 80);
    }
  }
  const mainAccountIdx = lines.findIndex((s) => s === '主账号' || s.includes('主账号'));
  if (mainAccountIdx > 0) {
    push(lines[mainAccountIdx - 1], 140);
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.value || null;
};
try {
  const name = pickName();
  await post({ ok: { is_login: !!name, display_name: name } });
} catch (error) {
  await post({ error: error?.message || String(error) });
}
})();"#.replace("__TOKEN__", &token_json);

    if let Err(e) = win.eval(&js) {
        bailian.pending_account.lock().await.take();
        return Err(e.to_string());
    }

    let raw = match tokio::time::timeout(std::time::Duration::from_secs(8), rx).await {
        Ok(Ok(result)) => result?,
        Ok(Err(_)) => {
            bailian.pending_account.lock().await.take();
            return Err("BAILIAN_ACCOUNT_BUSY".to_string());
        }
        Err(_) => {
            bailian.pending_account.lock().await.take();
            return Err("请求超时".to_string());
        }
    };

    let is_login = raw.get("is_login").and_then(|v| v.as_bool()).unwrap_or(false);
    let display_name = raw.get("display_name").and_then(|v| v.as_str()).map(|s| s.to_string());
    Ok(BailianAccountInfo { is_login, display_name })
}

#[tauri::command]
async fn bailian_take_quota_progress(
    bailian: tauri::State<'_, Arc<BailianState>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut progress = bailian.quota_progress.lock().await;
    Ok(progress.drain(..).collect())
}

#[tauri::command]
async fn scan_bailian_free_quota(
    app: tauri::AppHandle,
    bailian: tauri::State<'_, Arc<BailianState>>,
    model_codes: Vec<String>,
) -> Result<Vec<db::ModelFreeQuota>, String> {
    if model_codes.is_empty() {
        return Ok(Vec::new());
    }

    let win = match app.get_webview_window("bailian-login") {
        Some(win) => win,
        None => {
            open_bailian_login(app.clone()).await?;
            app.get_webview_window("bailian-login")
                .ok_or_else(|| "BAILIAN_WIN_NOT_OPEN".to_string())?
        }
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    let token = uuid::Uuid::new_v4().to_string();
    {
        let mut guard = bailian.pending_quota.lock().await;
        if guard.is_some() {
            return Err("BAILIAN_QUOTA_BUSY".to_string());
        }
        *guard = Some(api::PendingQuota { token: token.clone(), tx });
    }

    let model_codes_json = serde_json::to_string(&model_codes).map_err(|e| e.to_string())?;
    let token_json = serde_json::to_string(&token).map_err(|e| e.to_string())?;
    // 走控制台「免费额度」页同款网关接口（queryFreeTierQuotaAsyn，两段式：提交任务→轮询），
    // 按类目一次拉全量再内存匹配，几秒扫完全部模型；不再逐模型开详情页解析 DOM。
    let js = format!(r#"(async()=>{{
const modelCodes = {model_codes_json};
const TOKEN = {token_json};
// 五个合法枚举（2026-06-11 从免费额度页五个 tab 的 URL hash 逐一确认）：
// 大语言=Text / 视觉=Vision / 全模态=Multimodal / 语音=Audio / 向量=Embedding
const MODEL_TYPES = ['Text', 'Multimodal', 'Audio', 'Embedding', 'Vision'];
const GW = 'https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.freeTrial.queryFreeTierQuotaAsyn&_v=undefined';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const post = async (payload) => {{
  await fetch('http://localhost:39733/api/bailian/quota_result', {{
    method: 'POST',
    headers: {{ 'Content-Type': 'application/json' }},
    body: JSON.stringify({{ ...payload, token: TOKEN }}),
  }});
}};
const progress = async (payload) => {{
  try {{
    await fetch('http://localhost:39733/api/bailian/quota_progress', {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{ ...payload, token: TOKEN }}),
    }});
  }} catch {{}}
}};
const getLines = () => (document.body.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
const pageReadyForLoginCheck = () => {{
  const body = document.body.innerText || '';
  return body.includes('模型广场') || body.includes('登录') || body.includes('退出登录') || body.includes('主账号') || body.includes('账号 ID');
}};
const waitForLoginShell = async () => {{
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {{
    if (pageReadyForLoginCheck()) return true;
    await sleep(500);
  }}
  return false;
}};
const pageLooksLoggedIn = () => {{
  const texts = getLines();
  const body = document.body.innerText || '';
  if (body.includes('退出登录') || body.includes('主账号') || body.includes('账号 ID')) return true;
  if (!body.trim()) return false;
  return !texts.some((text) => text === '登录') && !body.includes('请登录');
}};
const gwCall = async (secToken, reqData) => {{
  const params = {{
    Api: 'zeldaEasy.broadscope-bailian.freeTrial.queryFreeTierQuotaAsyn',
    V: '1.0',
    Data: {{
      queryFreeTierQuotaRequest: reqData,
      cornerstoneParam: {{
        feTraceId: crypto.randomUUID(),
        feURL: location.href,
        protocol: 'V2',
        console: 'ONE_CONSOLE',
        productCode: 'p_efm',
        domain: 'bailian.console.aliyun.com',
        consoleSite: 'BAILIAN_ALIYUN',
        xsp_lang: 'zh-CN',
      }},
    }},
  }};
  const body = 'params=' + encodeURIComponent(JSON.stringify(params)) + '&region=cn-beijing&sec_token=' + encodeURIComponent(secToken);
  const r = await fetch(GW, {{
    method: 'POST',
    credentials: 'include',
    headers: {{ 'content-type': 'application/x-www-form-urlencoded' }},
    body,
  }});
  const j = await r.json();
  return (j && j.data && j.data.DataV2 && j.data.DataV2.data && j.data.DataV2.data.data) || null;
}};
const fetchQuotaType = async (secToken, modelType) => {{
  const submit = await gwCall(secToken, {{ modelType, needOverviewInfo: true, needFreeTierOnlyStatus: true }});
  const taskId = submit && submit.taskId;
  if (!taskId) return null;
  for (let i = 0; i < 20; i += 1) {{
    await sleep(700);
    const poll = await gwCall(secToken, {{ taskId }});
    if (poll && poll.freeTierQuotas) return poll.freeTierQuotas;
  }}
  return null;
}};
const fmtDate = (ms) => {{
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());
}};
const rowFromQuota = (code, q) => {{
  const now = new Date().toISOString();
  if (!q) {{
    return {{
      model_id: code, has_free_quota: false, not_supported: false,
      used_tokens: 0, total_tokens: 0, remaining_tokens: 0,
      used_percent: null, expire_date: null, raw_quota: null,
      scanned_at: now, error_message: '额度接口未返回该模型（五个类目均无）',
    }};
  }}
  if (q.quotaStatus !== 'VALID') {{
    return {{
      model_id: code, has_free_quota: false, not_supported: true,
      used_tokens: 0, total_tokens: 0, remaining_tokens: 0,
      used_percent: null, expire_date: null, raw_quota: JSON.stringify(q),
      scanned_at: now, error_message: null,
    }};
  }}
  const total = Math.round(q.quotaInitTotal || 0);
  const remaining = Math.round(q.quotaTotal || 0);
  const used = Math.max(0, total - remaining);
  const usedPercent = typeof q.quotaTotalPercentage === 'number'
    ? Math.max(0, Math.min(100, Math.round(100 - q.quotaTotalPercentage))) + '%'
    : null;
  return {{
    model_id: code, has_free_quota: total > 0, not_supported: false,
    used_tokens: used, total_tokens: total, remaining_tokens: remaining,
    used_percent: usedPercent,
    expire_date: q.quotaValidityPeriod ? fmtDate(q.quotaValidityPeriod) : null,
    raw_quota: JSON.stringify(q),
    scanned_at: now, error_message: null,
  }};
}};
try {{
  await progress({{ stage: 'start', total: modelCodes.length, scanned: 0, ok: 0, failed: 0 }});
  await waitForLoginShell();
  if (!pageLooksLoggedIn()) {{
    throw new Error('BAILIAN_NOT_LOGGED_IN');
  }}
  const secToken = (window.ALIYUN_CONSOLE_CONFIG && window.ALIYUN_CONSOLE_CONFIG.SEC_TOKEN) || null;
  if (!secToken) {{
    throw new Error('BAILIAN_SEC_TOKEN_MISSING');
  }}
  // 按类目拉全量额度，合并成 model -> quota 映射
  const quotaByModel = new Map();
  for (const type of MODEL_TYPES) {{
    await progress({{ stage: 'model_start', model_id: '类目 ' + type, index: 0, total: modelCodes.length }});
    const list = await fetchQuotaType(secToken, type);
    if (list) {{
      for (const q of list) {{
        if (q && q.model && !quotaByModel.has(q.model)) quotaByModel.set(q.model, q);
      }}
    }}
  }}
  if (quotaByModel.size === 0) {{
    throw new Error('额度接口未返回任何模型（接口结构可能已变化）');
  }}
  const results = [];
  for (const code of modelCodes) {{
    const row = rowFromQuota(code, quotaByModel.get(code));
    results.push(row);
    await progress({{
      stage: row.error_message ? 'model_error' : 'model_done',
      model_id: code,
      index: results.length,
      total: modelCodes.length,
      row,
      scanned: results.length,
      ok: results.filter((r) => !r.error_message).length,
      failed: results.filter((r) => r.error_message).length,
    }});
  }}
  await progress({{
    stage: 'finish',
    total: modelCodes.length,
    scanned: results.length,
    ok: results.filter((r) => !r.error_message).length,
    failed: results.filter((r) => r.error_message).length,
  }});
  await post({{ ok: results }});
}} catch (error) {{
  await progress({{ stage: 'fatal', error: error?.message || String(error) }});
  await post({{ error: error?.message || String(error) }});
}}
}})();"#);

    if let Err(e) = win.eval(&js) {
        bailian.pending_quota.lock().await.take();
        return Err(e.to_string());
    }

    match tokio::time::timeout(std::time::Duration::from_secs(60 * 20), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            bailian.pending_quota.lock().await.take();
            Err("BAILIAN_QUOTA_BUSY".to_string())
        }
        Err(_) => {
            bailian.pending_quota.lock().await.take();
            Err("Bailian quota scan timeout".to_string())
        }
    }
}

// ── 数据库命令 ──

#[tauri::command]
async fn get_db_info(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DbInfo, String> {
    let path = state.db_path.read().await.clone();

    let size = {
        let db_guard = state.db.read().await;
        if let Some(db) = db_guard.as_ref() {
            db.get_db_size().unwrap_or(0)
        } else {
            0
        }
    };

    Ok(DbInfo { path, size })
}

#[derive(serde::Serialize)]
struct DbInfo {
    path: String,
    size: u64,
}

#[tauri::command]
fn get_screenshot_settings() -> perception::ScreenshotSettings {
    perception::load_screenshot_settings()
}

#[tauri::command]
fn update_screenshot_settings(
    settings: perception::ScreenshotSettings,
) -> Result<perception::ScreenshotSettings, String> {
    perception::save_screenshot_settings(settings)
}

#[tauri::command]
fn get_screenshot_storage_info() -> Result<perception::ScreenshotStorageInfo, String> {
    perception::screenshot_storage_info()
}

#[tauri::command]
fn open_screenshot_folder() -> Result<(), String> {
    perception::open_screenshot_folder()
}

#[tauri::command]
fn clear_screenshot_data() -> Result<perception::ScreenshotStorageInfo, String> {
    perception::clear_screenshot_data()
}

#[tauri::command]
fn get_window_blacklist() -> Vec<perception::WindowBlacklistEntry> {
    perception::load_window_blacklist()
}

#[tauri::command]
fn add_window_blacklist(app: String, title: Option<String>) -> Result<Vec<perception::WindowBlacklistEntry>, String> {
    perception::add_window_blacklist(app, title)
}

#[tauri::command]
fn remove_window_blacklist(app: String, title: Option<String>) -> Result<Vec<perception::WindowBlacklistEntry>, String> {
    perception::remove_window_blacklist(app, title)
}

#[tauri::command]
fn get_tracking_settings() -> perception::TrackingSettings {
    perception::load_tracking_settings()
}

#[tauri::command]
fn update_tracking_settings(settings: perception::TrackingSettings) -> Result<perception::TrackingSettings, String> {
    perception::save_tracking_settings(settings)
}

#[tauri::command]
async fn open_url_in_browser(url: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn migrate_database(
    new_path: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    log::info!("[Database] 收到迁移请求: {}", new_path);

    // 获取旧数据库
    let old_db = {
        let db_guard = state.db.read().await;
        db_guard.as_ref()
            .ok_or("数据库未初始化")?
            .clone()
    };

    let new_data_dir = std::path::PathBuf::from(&new_path);

    // 执行迁移
    let new_db = Database::migrate_to(new_data_dir, &old_db)?;
    let new_db_path = new_db.get_db_path().to_string_lossy().to_string();

    // 更新状态
    {
        let mut db_guard = state.db.write().await;
        *db_guard = Some(Arc::new(new_db));
    }

    {
        let mut path_guard = state.db_path.write().await;
        *path_guard = new_db_path.clone();
    }

    log::info!("[Database] 迁移完成: {}", new_db_path);
    Ok(new_db_path)
}

// ── B 站视频资产 ──

#[tauri::command]
async fn get_bili_assets_by_bvid(
    bvid: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<db::BiliVideoAsset>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.get_bili_assets_by_bvid(&bvid).await
}

#[derive(serde::Serialize)]
struct DeleteBiliResult {
    deleted_files: usize,
    deleted_assets: usize,
}

/// 给定主下载文件路径，返回它 + 全部衍生文件（h264 转码、抽取音轨）的候选路径。
/// download_path 形如 `<dir>/<safe>_<bvid>.mp4`；衍生物：
///   `<stem>_h264.mp4`（ffmpeg::ensure_h264_playable）、`<stem>_audio.m4a`（qwen_video 抽音轨）
fn bili_derivative_paths(download_path: &str) -> Vec<std::path::PathBuf> {
    use std::path::Path;
    let p = Path::new(download_path);
    let mut out = vec![p.to_path_buf()];
    if let (Some(parent), Some(stem)) = (p.parent(), p.file_stem().and_then(|s| s.to_str())) {
        out.push(parent.join(format!("{stem}_h264.mp4")));
        out.push(parent.join(format!("{stem}_audio.m4a")));
    }
    out
}

/// 删除某 bvid 的全部本地痕迹：下载文件 + 衍生（h264/音轨）+ DB 资产 & 转录历史。
#[tauri::command]
async fn delete_bili_download(
    bvid: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DeleteBiliResult, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    let assets = db.get_bili_assets_by_bvid(&bvid).await?;

    let mut deleted_files = 0usize;
    let mut seen: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();
    for a in &assets {
        if let Some(p) = a.download_path.as_ref() {
            for path in bili_derivative_paths(p) {
                if !seen.insert(path.clone()) {
                    continue;
                }
                match tokio::fs::remove_file(&path).await {
                    Ok(_) => deleted_files += 1,
                    Err(e) => {
                        if e.kind() != std::io::ErrorKind::NotFound {
                            log::warn!("[BiliDelete] 删除文件失败 {}: {}", path.display(), e);
                        }
                    }
                }
            }
        }
    }

    let deleted_assets = db.delete_bili_assets_by_bvid(&bvid).await?;
    log::info!(
        "[BiliDelete] bvid={} 删除文件 {} 个 / 资产 {} 条",
        bvid, deleted_files, deleted_assets
    );
    Ok(DeleteBiliResult { deleted_files, deleted_assets })
}

#[tauri::command]
async fn set_bili_favorite(
    bvid: String,
    favorite: bool,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.set_bili_favorite(&bvid, favorite).await
}

#[tauri::command]
async fn get_bili_transcripts(
    file_path: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<db::BiliTranscriptCache, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.get_bili_transcripts_by_path(&file_path).await
}

#[tauri::command]
async fn update_bili_transcript(
    file_path: String,
    kind: String,
    text: String,
    model_id: Option<String>,
    prompt_type: Option<String>,
    source: Option<String>,
    save_history: Option<bool>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<db::BiliTranscriptRun>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.update_bili_transcript_by_path(
        &file_path,
        &kind,
        &text,
        model_id,
        prompt_type,
        source,
        save_history.unwrap_or(true),
    ).await
}

// ── 模型审计：registry / bindings / call_log ──

#[tauri::command]
async fn list_models(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<db::ModelDef>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.list_models().await
}

#[tauri::command]
async fn upsert_model(
    def: db::ModelDef,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.upsert_model(def).await
}

#[tauri::command]
async fn delete_model(
    model_id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.delete_model(&model_id).await
}

#[tauri::command]
async fn list_feature_bindings(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<db::FeatureBinding>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.list_feature_bindings().await
}

#[tauri::command]
async fn set_feature_binding(
    feature: String,
    model_id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.set_feature_binding(&feature, &model_id).await
}

#[tauri::command]
async fn get_feature_model(
    feature: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.get_feature_model(&feature).await
}

#[tauri::command]
async fn list_model_api_keys(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<db::ModelApiKey>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.list_model_api_keys().await
}

#[tauri::command]
async fn get_active_model_api_key(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<db::ModelApiKey>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.get_active_model_api_key().await
}

#[tauri::command]
async fn upsert_model_api_key(
    req: db::UpsertModelApiKeyRequest,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<db::ModelApiKey, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.upsert_model_api_key(req).await
}

#[tauri::command]
async fn set_active_model_api_key(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.set_active_model_api_key(&id).await
}

#[tauri::command]
async fn delete_model_api_key(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.delete_model_api_key(&id).await
}

#[tauri::command]
async fn log_model_call(
    req: db::LogModelCallRequest,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.log_model_call(req).await
}

#[tauri::command]
async fn get_model_call_log(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<db::ModelCallLog>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.get_model_call_log(&id).await
}

#[tauri::command]
async fn query_call_log(
    time_from: Option<String>,
    time_to: Option<String>,
    feature: Option<String>,
    model_id: Option<String>,
    api_key_id: Option<String>,
    limit: Option<i64>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<db::ModelCallLog>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.query_call_log(time_from, time_to, feature, model_id, api_key_id, limit).await
}

#[tauri::command]
async fn aggregate_call_log(
    time_from: String,
    time_to: String,
    granularity: String,
    feature: Option<String>,
    model_id: Option<String>,
    api_key_id: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<db::CallLogBucket>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.aggregate_call_log(time_from, time_to, granularity, feature, model_id, api_key_id).await
}

#[tauri::command]
async fn list_model_free_quotas(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<db::ModelFreeQuota>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.list_model_free_quotas().await
}

#[tauri::command]
async fn get_recent_bili_assets(
    limit: Option<i64>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<db::BiliVideoAsset>, String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.get_recent_bili_assets(limit.unwrap_or(50)).await
}

// ── Qwen Omni Realtime 命令 ──

#[tauri::command]
async fn omni_connect(
    api_key: String,
    model: String,
    voice: String,
    system_prompt: String,
    tools: Option<serde_json::Value>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // 关闭旧连接
    {
        let mut guard = state.omni.lock().await;
        if let Some(old) = guard.take() {
            old.stop();
        }
    }

    let tools_val = tools.unwrap_or_else(|| serde_json::json!([]));
    let session = qwen_omni::connect(api_key, model, voice, system_prompt, tools_val, app_handle).await?;

    let mut guard = state.omni.lock().await;
    *guard = Some(session);
    Ok(())
}

#[tauri::command]
async fn omni_send_audio(
    pcm_base64: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(&pcm_base64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let guard = state.omni.lock().await;
    if let Some(session) = guard.as_ref() {
        session.send_audio(&pcm);
        Ok(())
    } else {
        Err("Omni 未连接".to_string())
    }
}

#[tauri::command]
async fn omni_commit(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let guard = state.omni.lock().await;
    if let Some(session) = guard.as_ref() {
        session.commit();
        Ok(())
    } else {
        Err("Omni 未连接".to_string())
    }
}

#[tauri::command]
async fn omni_send_text(
    text: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let guard = state.omni.lock().await;
    if let Some(session) = guard.as_ref() {
        session.send_text(&text);
        Ok(())
    } else {
        Err("Omni 未连接".to_string())
    }
}

#[tauri::command]
async fn omni_stop(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut guard = state.omni.lock().await;
    if let Some(session) = guard.take() {
        session.stop();
    }
    Ok(())
}

#[tauri::command]
async fn omni_tool_result(
    call_id: String,
    output: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let guard = state.omni.lock().await;
    if let Some(session) = guard.as_ref() {
        session.send_tool_result(&call_id, &output);
        Ok(())
    } else {
        Err("Omni 未连接".to_string())
    }
}

// ── Fairy 子窗口 ──

/// 获取系统光标物理像素坐标（仅内部使用）
#[cfg(windows)]
fn cursor_pos_phys() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut pt) } != 0 { Some((pt.x, pt.y)) } else { None }
}

/// 读取当前 Windows 图形偏好状态（HKCU UserGpuPreferences 注册表）
#[cfg(windows)]
#[tauri::command]
async fn get_gpu_pref_status() -> gpu_pref::GpuPrefStatus {
    gpu_pref::read_status()
}

/// 写入 / 清除本应用 exe + msedgewebview2.exe 的"高性能"图形偏好
#[cfg(windows)]
#[tauri::command]
async fn set_gpu_pref_high_performance(enable: bool) -> Result<gpu_pref::GpuPrefStatus, String> {
    gpu_pref::apply(enable)
}

/// 重启应用（图形偏好首次配置后让用户立刻享受新 GPU）
///
/// axum listener socket 在 bind 后已通过 SetHandleInformation 禁用句柄继承
/// （见 api.rs::start_server），主进程 process::exit 后 OS 会立即释放端口。
/// 所以这里只要 spawn 一份新进程再退出即可，不需要 helper 脚本。
#[tauri::command]
fn restart_app(_app: tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("读取 exe 路径失败: {}", e))?;
    log::info!("[Restart] spawning new instance: {}", exe.display());
    std::process::Command::new(&exe)
        .spawn()
        .map_err(|e| format!("spawn 新进程失败: {}", e))?;
    std::process::exit(0);
}

/// JS 创建完 fairy-window 后调用此命令，启动 Rust 侧光标监控
/// （JS 创建保证 Tauri IPC bridge 正常注入，Rust 监控保证点击穿透精准）
#[tauri::command]
async fn update_fairy_cursor_radius(radius: f64) -> Result<(), String> {
    let radius = sanitize_fairy_cursor_radius(radius);
    fairy_cursor_radius_state().store(radius.to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn set_fairy_cursor_menu_open(open: bool) -> Result<(), String> {
    FAIRY_CURSOR_MENU_OPEN.store(open, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn setup_fairy(app: tauri::AppHandle, radius: Option<f64>) -> Result<(), String> {
    let win = app.get_webview_window("fairy-window")
        .ok_or_else(|| "fairy-window not found".to_string())?;
    let radius_state = fairy_cursor_radius_state();
    if let Some(radius) = radius {
        radius_state.store(sanitize_fairy_cursor_radius(radius).to_bits(), Ordering::Relaxed);
    }

    log::info!("[Fairy] setup_fairy 已调用，启动光标监控");
    #[cfg(not(windows))]
    let _ = &win;

    #[cfg(windows)]
    {
        if FAIRY_CURSOR_MONITOR_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            log::info!("[Fairy] 光标监控已在运行，仅更新半径");
            return Ok(());
        }

        let win_clone = win.clone();
        let radius_state = radius_state.clone();
        let _ = win_clone.set_ignore_cursor_events(true);
        tauri::async_runtime::spawn(async move {
            let mut prev_ignore = true;
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;

                let Some((cx, cy)) = cursor_pos_phys() else { continue };
                let (outer, sf) = match (win_clone.outer_position(), win_clone.scale_factor()) {
                    (Ok(p), Ok(s)) => (p, s),
                    _ => break, // 窗口已关闭
                };

                // fairy 的视觉大小由前端配置驱动；Rust 只保留“圆心 + 半径”的点击穿透模型。
                let fairy_r_logical = f64::from_bits(radius_state.load(Ordering::Relaxed));
                let fairy_cx = outer.x as f64 + fairy_r_logical * sf;
                let fairy_cy = outer.y as f64 + fairy_r_logical * sf;
                let fairy_r  = fairy_r_logical * sf;

                let dx = cx as f64 - fairy_cx;
                let dy = cy as f64 - fairy_cy;
                let should_ignore = if FAIRY_CURSOR_MENU_OPEN.load(Ordering::Relaxed) {
                    false
                } else {
                    dx * dx + dy * dy > fairy_r * fairy_r
                };

                if should_ignore != prev_ignore {
                    prev_ignore = should_ignore;
                    let _ = win_clone.set_ignore_cursor_events(should_ignore);
                }
            }
            FAIRY_CURSOR_MONITOR_RUNNING.store(false, Ordering::SeqCst);
            FAIRY_CURSOR_MENU_OPEN.store(false, Ordering::Relaxed);
            log::info!("[Fairy] 光标监控退出");
        });
    }

    Ok(())
}

// ── 音频文件持久化 ──

/// 返回音频根目录（{data_local}/应用数据目录/audio/）
fn audio_root() -> std::path::PathBuf {
    Database::default_data_dir().join("audio")
}

/// 保存一条语音消息 WAV 到磁盘（接收原始字节，无需 base64）
/// 返回相对路径 "{session_id}/{filename}"，供 DB 存储
#[tauri::command]
async fn save_audio_file(
    session_id: String,
    wav_bytes: Vec<u8>,
    timestamp: String,
) -> Result<String, String> {
    let safe_ts = timestamp.replace([':', '.'], "-");
    let filename = format!("{}.wav", safe_ts);

    let dir = audio_root().join(&session_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let file_path = dir.join(&filename);
    std::fs::write(&file_path, &wav_bytes).map_err(|e| format!("写入失败: {}", e))?;

    Ok(format!("{}/{}", session_id, filename))
}

/// 返回音频根目录的绝对路径（前端用于拼接 asset:// URL）
#[tauri::command]
fn get_audio_dir() -> String {
    audio_root().to_string_lossy().into_owned()
}

// ── 文件操作命令（供 AI 工具调用） ──

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    // 如父目录不存在则创建
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("写入失败: {}", e))
}

// ── 入口 ──

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 写一行到 panic.log（不依赖 logger，崩溃语境下也安全）
fn write_panic_log(line: &str) {
    let path = Database::default_data_dir().join("panic.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = writeln!(f, "{line}");
        let _ = f.flush();
    }
}

/// 用 Win32 `RtlCaptureStackBackTrace` 抓原始返回地址 —— 不依赖 DbgHelp，async-signal-safe
/// 同时计算每帧相对本 exe 模块基址的 RVA，便于 `addr2line --exe=...exe 0xRVA` 还原符号
#[cfg(windows)]
fn capture_raw_backtrace(skip: u32) -> String {
    use std::ptr;
    const MAX_FRAMES: usize = 62;
    let mut buf: [*mut core::ffi::c_void; MAX_FRAMES] = [ptr::null_mut(); MAX_FRAMES];
    let captured = unsafe {
        windows_sys::Win32::System::Diagnostics::Debug::RtlCaptureStackBackTrace(
            skip,
            MAX_FRAMES as u32,
            buf.as_mut_ptr(),
            ptr::null_mut(),
        )
    };
    let n = captured as usize;
    if n == 0 {
        return String::from("    <RtlCaptureStackBackTrace returned 0 frames>");
    }
    // 主 exe 模块基址（ASLR 加过偏移），用来把绝对地址换成 RVA
    let module_base = unsafe {
        windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(ptr::null())
    } as usize;
    let mut out = String::new();
    out.push_str(&format!("    raw stack (module base 0x{:016x}, rva for addr2line):\n", module_base));
    for i in 0..n {
        let addr = buf[i] as usize;
        if addr == 0 { break; }
        // 计算 RVA：addr - base。如果 addr 落在外部模块（不在 exe 内），RVA 是个
        // 很大的数；可以通过这种异常值快速判断它属于哪个模块
        let rva = addr.wrapping_sub(module_base);
        out.push_str(&format!("    [{:>2}] 0x{:016x}  rva=0x{:08x}\n", i, addr, rva));
    }
    out
}

#[cfg(not(windows))]
fn capture_raw_backtrace(_skip: u32) -> String {
    String::new()
}

fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // 先把关键信息落盘 —— 即使后续 backtrace 二次崩溃，至少有定位线索
        let location = info.location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".into());
        let payload = info.payload();
        let msg = if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic>".into()
        };
        let thread_name = std::thread::current().name().unwrap_or("<unnamed>").to_string();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

        write_panic_log("═══════════════════════════════════════════════════════════════");
        write_panic_log(&format!("[{now}] PANIC thread '{thread_name}' at {location}"));
        write_panic_log(&format!("    {msg}"));
        eprintln!("[PANIC {now}] thread '{thread_name}' panicked at {location}: {msg}");

        // 第一优先：Win32 RtlCaptureStackBackTrace 拿原始 PC 地址。这条路径不走
        // DbgHelp，几乎不会二次崩溃。skip=2 跳过 panic hook 自身的两个栈帧
        write_panic_log(&capture_raw_backtrace(2));

        // 第二优先：尝试 `backtrace` crate 拿符号化栈。这条路径走 DbgHelp 可能崩，
        // catch_unwind 兜底，捕到错就不再升级
        let bt_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let bt = backtrace::Backtrace::new();
            format!("{:?}", bt)
        }));
        match bt_result {
            Ok(bt) => write_panic_log(&format!("    symbolicated backtrace:\n{bt}")),
            Err(_) => write_panic_log("    <symbolicated backtrace capture itself panicked>"),
        }

        prev(info);
    }));
}

#[cfg(windows)]
fn install_seh_handler() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Win32::System::Diagnostics::Debug::{SetUnhandledExceptionFilter, EXCEPTION_POINTERS};

    static FIRED: AtomicBool = AtomicBool::new(false);

    unsafe extern "system" fn filter(info: *const EXCEPTION_POINTERS) -> i32 {
        // 只触发一次，避免无限递归
        if FIRED.swap(true, Ordering::SeqCst) {
            return 0; // EXCEPTION_CONTINUE_SEARCH
        }
        let (code, addr) = if !info.is_null() {
            let record = (*info).ExceptionRecord;
            if record.is_null() {
                (0u32, 0usize)
            } else {
                ((*record).ExceptionCode as u32, (*record).ExceptionAddress as usize)
            }
        } else {
            (0u32, 0usize)
        };
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let thread_name = std::thread::current().name().unwrap_or("<unnamed>").to_string();
        write_panic_log("═══════════════════════════════════════════════════════════════");
        write_panic_log(&format!(
            "[{now}] NATIVE thread '{thread_name}' exception=0x{code:08x} addr=0x{addr:016x}"
        ));
        match code {
            0xC0000005 => write_panic_log("    (ACCESS_VIOLATION)"),
            0xC000001D => write_panic_log("    (ILLEGAL_INSTRUCTION)"),
            0xC0000409 => write_panic_log("    (STACK_BUFFER_OVERRUN / fastfail — usually Rust abort)"),
            0xC00000FD => write_panic_log("    (STACK_OVERFLOW)"),
            _ => {}
        }
        // 原始栈：SEH 上下文里 DbgHelp 风险大，只走 Win32 直采
        write_panic_log(&capture_raw_backtrace(0));
        0 // EXCEPTION_CONTINUE_SEARCH 让 Windows 接管（崩溃 + 写 dump）
    }

    unsafe {
        SetUnhandledExceptionFilter(Some(filter));
    }
}

#[cfg(not(windows))]
fn install_seh_handler() {}

pub fn run() {
    install_panic_hook();
    install_seh_handler();
    // 初始化数据库
    let app_data_dir = Database::default_data_dir();
    let db = match Database::new(app_data_dir.clone()) {
        Ok(d) => Some(Arc::new(d)),
        Err(e) => {
            log::error!("[App] 数据库初始化失败: {}", e);
            None
        }
    };

    let db_path = db.as_ref()
        .map(|d| d.get_db_path().to_string_lossy().to_string())
        .unwrap_or_default();

    let state = Arc::new(AppState {
        fish_tts: Arc::new(Mutex::new(None)),
        omni: Arc::new(Mutex::new(None)),
        db: Arc::new(RwLock::new(db.clone())),
        db_path: Arc::new(RwLock::new(db_path)),
    });

    let bili_state = Arc::new(BiliState::new());
    let bailian_state = Arc::new(BailianState::new());
    let bili_dl_state = Arc::new(BiliDownloadState::new());
    let transcribe_q_state = Arc::new(transcribe_queue::TranscribeQueueState::new());
    let focus_lock_state = Arc::new(focus_lock::FocusLockState::new());

    // 把 DB 注入到下载状态 + 转录队列（用于写资产/转录表）
    if let Some(db_for_dl) = db.clone() {
        let dl = bili_dl_state.clone();
        let tq = transcribe_q_state.clone();
        let db_for_tq = db_for_dl.clone();
        tauri::async_runtime::block_on(async move {
            dl.set_db(db_for_dl).await;
            tq.set_db(db_for_tq).await;
        });
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已有实例运行时，聚焦主窗口
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(state)
        .manage(bili_state.clone())
        .manage(bailian_state.clone())
        .manage(bili_dl_state.clone())
        .manage(transcribe_q_state.clone())
        .manage(focus_lock_state)
        .setup(move |app| {
            // 注册专注锁 Native Messaging host（幂等；失败只降级，不阻断启动）
            focus_lock::register_native_host();
            // 启动扩展掉线阶梯惩罚监控（常驻；无活跃网站组时近乎零开销）
            focus_lock::spawn_enforcement_watcher(app.handle().clone());

            // 启动 HTTP 服务器（在 Tauri runtime 内）
            if let Some(db_clone) = db.clone() {
                let bili_clone = bili_state.clone();
                let bailian_clone = bailian_state.clone();
                let bili_dl_clone = bili_dl_state.clone();
                let db_for_api = db_clone.clone();
                // 关键：包 Arc 后整个项目共享同一份 AppHandle，避免 AppHandle::clone
                // 透传到内部 Rc<EventLoopRunner>::clone 在非主线程上 UB（Tauri #15408）
                let app_handle_for_api: std::sync::Arc<tauri::AppHandle> =
                    std::sync::Arc::new(app.handle().clone());
                let app_handle_for_startup = app_handle_for_api.clone();
                tauri::async_runtime::spawn(async move {
                    api::start_server(db_for_api, bili_clone, bailian_clone, bili_dl_clone, app_handle_for_api, 39733).await;
                });

                // 启动后台同步：等 HTTP server 起来 + 多播广播完成，再扫一遍已链接设备
                let db_for_startup_sync = db_clone.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    sync_engine::run_startup_sync(db_for_startup_sync, app_handle_for_startup).await;
                });

                #[cfg(any(windows, target_os = "macos"))]
                {
                    let db_for_window = db_clone.clone();
                    tauri::async_runtime::spawn(async move {
                        perception::run_window_watcher(db_for_window).await;
                    });

                    let db_for_status = db_clone.clone();
                    tauri::async_runtime::spawn(async move {
                        perception::run_status_watcher(db_for_status).await;
                    });

                    tauri::async_runtime::spawn(async move {
                        perception::run_screenshot_watcher().await;
                    });

                    // 启动时一次性刷新所有 app 主色（用最新的算法重新算一遍）
                    let db_for_color = db_clone;
                    tauri::async_runtime::spawn(async move {
                        perception::refresh_app_colors_from_icons(db_for_color).await;
                    });
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Debug)
                        .build(),
                )?;
            }
            // 启动时在后台静默创建 bilibili WebView（隐藏窗口）
            // WebView2 会复用之前的登录 session（cookies 持久化在用户 profile 目录）
            let bili_win = tauri::WebviewWindowBuilder::new(
                app,
                "bili-login",
                tauri::WebviewUrl::External(
                    "https://www.bilibili.com".parse().expect("valid url")
                ),
            )
            .title("B站 — 登录后可关闭此窗口")
            .inner_size(1200.0, 800.0)
            .visible(false)
            .build();

            match bili_win {
                Ok(_) => log::info!("[Bili] 后台 WebView 已创建"),
                Err(e) => log::warn!("[Bili] 后台 WebView 创建失败: {}", e),
            }

            log::info!("[Bailian] WebView will be created on demand");

            // 全局右 Alt 热键（push-to-talk，无论哪个窗口聚焦都生效）

            #[cfg(windows)]
            if std::env::var("SLU_DISABLE_HOTKEY").ok().as_deref() == Some("1") {
                log::warn!("[Hotkey] disabled by SLU_DISABLE_HOTKEY=1");
            } else {
                hotkey::install(app.handle().clone());
            }

            // 系统托盘
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            use tauri::tray::TrayIconBuilder;

            let show_item = MenuItemBuilder::new("显示主窗口").id("tray_show").build(app)?;
            let quit_item = MenuItemBuilder::new("退出").id("tray_quit").build(app)?;
            let menu = MenuBuilder::new(app).item(&show_item).item(&quit_item).build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Solevup")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray_show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "tray_quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            log::info!("[App] Solevup 启动完成");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.emit("main-close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            exit_app,
            open_url_in_browser,
            fish_tts_connect,
            fish_tts_send_text,
            fish_tts_flush,
            fish_tts_stop,
            omni_connect,
            omni_send_audio,
            omni_send_text,
            omni_commit,
            omni_stop,
            omni_tool_result,
            get_db_info,
            migrate_database,
            get_screenshot_settings,
            update_screenshot_settings,
            get_screenshot_storage_info,
            open_screenshot_folder,
            clear_screenshot_data,
            get_window_blacklist,
            add_window_blacklist,
            remove_window_blacklist,
            get_tracking_settings,
            update_tracking_settings,
            open_bili_login,
            open_bailian_login,
            open_bailian_model_detail,
            bailian_get_account,
            bailian_take_quota_progress,
            fetch_bili_history,
            scan_bailian_free_quota,
            bili_get_nav,
            bili_download::enqueue_bili_download,
            bili_download::probe_bili_qualities,
            get_bili_assets_by_bvid,
            get_recent_bili_assets,
            delete_bili_download,
            set_bili_favorite,
            ocr::extract_video_frames,
            ocr::grab_video_frame,
            ocr::qwen_vl_ocr,
            transcribe_queue::enqueue_transcribe,
            get_bili_transcripts,
            update_bili_transcript,
            qwen_asr::qwen_asr_transcribe,
            qwen_asr::qwen_asr_filetrans,
            qwen_video::qwen_video_upload,
            qwen_video::qwen_audio_extract,
            ffmpeg::ensure_h264_playable,
            list_models,
            upsert_model,
            delete_model,
            list_feature_bindings,
            set_feature_binding,
            get_feature_model,
            list_model_api_keys,
            get_active_model_api_key,
            upsert_model_api_key,
            set_active_model_api_key,
            delete_model_api_key,
            log_model_call,
            get_model_call_log,
            query_call_log,
            aggregate_call_log,
            list_model_free_quotas,
            read_file,
            write_file,
            save_audio_file,
            get_audio_dir,
            setup_fairy,
            update_fairy_cursor_radius,
            set_fairy_cursor_menu_open,
            #[cfg(windows)] get_gpu_pref_status,
            #[cfg(windows)] set_gpu_pref_high_performance,
            restart_app,
            focus_lock::focus_lock_start,
            focus_lock::focus_lock_stop,
            focus_lock::focus_lock_get_active,
            focus_lock::focus_lock_check_capability,
            focus_lock::focus_lock_ext_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
