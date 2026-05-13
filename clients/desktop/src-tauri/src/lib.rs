// ══════════════════════════════════════════════
// SOLO LEVELING SYSTEM — Tauri 后端入口
// ══════════════════════════════════════════════

use tauri::Emitter;

mod db;
mod api;
mod fish_tts;
mod perception;
mod qwen_asr;
mod qwen_omni;
mod qwen_video;
mod bili_download;
mod ffmpeg;
#[cfg(windows)]
mod gpu_pref;
#[cfg(windows)]
mod hotkey;

use std::sync::Arc;
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
  await fetch('http://localhost:49733/api/bilibili/nav_result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ok:d})});
}catch(e){
  await fetch('http://localhost:49733/api/bilibili/nav_result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({error:e.message||String(e)})});
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
  await fetch('http://localhost:49733/api/bilibili/result',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{ok:d}})}});
}}catch(e){{
  await fetch('http://localhost:49733/api/bilibili/result',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{error:e.message||String(e)}})}});
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
    {
        let mut guard = bailian.pending_account.lock().await;
        if guard.is_some() {
            return Err("BAILIAN_ACCOUNT_BUSY".to_string());
        }
        *guard = Some(tx);
    }

    let js = r#"(async()=>{
const post = async (payload) => {
  await fetch('http://localhost:49733/api/bailian/account_result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
})();"#;

    if let Err(e) = win.eval(js) {
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
    {
        let mut guard = bailian.pending_quota.lock().await;
        if guard.is_some() {
            return Err("BAILIAN_QUOTA_BUSY".to_string());
        }
        *guard = Some(tx);
    }

    let model_codes_json = serde_json::to_string(&model_codes).map_err(|e| e.to_string())?;
    let js = format!(r#"(async()=>{{
const modelCodes = {model_codes_json};
const BASE = 'https://bailian.console.aliyun.com/cn-beijing/?tab=model';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const post = async (payload) => {{
  await fetch('http://localhost:49733/api/bailian/quota_result', {{
    method: 'POST',
    headers: {{ 'Content-Type': 'application/json' }},
    body: JSON.stringify(payload),
  }});
}};
const progress = async (payload) => {{
  try {{
    await fetch('http://localhost:49733/api/bailian/quota_progress', {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify(payload),
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
const waitForQuota = async (code) => {{
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {{
    const body = document.body.textContent || '';
    if (body.includes('免费额度') && body.includes(code)) return true;
    await sleep(500);
  }}
  return false;
}};
const quotaSignature = (code) => {{
  const texts = getLines();
  const tokenText = texts.find((text) => /^[\d,]+\/[\d,]+$/.test(text)) || '';
  const notSupportedText = texts.find((text) => text.includes('不支持')) || '';
  const expireText = texts.find((text) => text.includes('过期')) || '';
  const body = document.body.textContent || '';
  return body.includes(code) && (tokenText || notSupportedText)
    ? [tokenText, notSupportedText, expireText].join('|')
    : '';
}};
const waitForQuotaStable = async (code) => {{
  const deadline = Date.now() + 22000;
  let last = '';
  let stable = 0;
  while (Date.now() < deadline) {{
    const sig = quotaSignature(code);
    if (sig) {{
      if (sig === last) stable += 1;
      else {{
        last = sig;
        stable = 1;
      }}
      if (stable >= 2) return true;
    }}
    await sleep(500);
  }}
  return false;
}};
const parseIntToken = (value) => Number.parseInt(String(value || '0').replace(/,/g, ''), 10) || 0;
const parseCurrent = (code) => {{
  const texts = getLines();
  const anchor = texts.findIndex((t) => t.includes('免费额度'));
  const windowTexts = anchor >= 0 ? texts.slice(anchor, anchor + 30) : texts;
  const tokenText = windowTexts.find((text) => /^[\d,]+\/[\d,]+$/.test(text)) || '0/0';
  const [remainingRaw, totalRaw] = tokenText.split('/');
  const parsedRemaining = parseIntToken(remainingRaw);
  const parsedTotal = parseIntToken(totalRaw);
  const isZeroQuotaExhausted = tokenText.replace(/\s/g, '') === '0/0';
  const remaining = isZeroQuotaExhausted ? 0 : parsedRemaining;
  const total = isZeroQuotaExhausted ? 1000000 : parsedTotal;
  const used = Math.max(0, total - remaining);
  const notSupported = !isZeroQuotaExhausted && windowTexts.some((t) => t.includes('不支持开启'));
  const expireText = windowTexts.find((text) => text.startsWith('过期时间'));
  const scales = new Set(['0%', '10%', '50%', '100%']);
  const usedPercent = windowTexts.find((text) => /^\d+%$/.test(text) && !scales.has(text)) || null;
  return {{
    model_id: code,
    has_free_quota: !notSupported && total > 0,
    not_supported: notSupported,
    used_tokens: used,
    total_tokens: total,
    remaining_tokens: remaining,
    used_percent: usedPercent,
    expire_date: expireText ? expireText.replace(/^过期时间[：:]\s*/, '').trim() : null,
    raw_quota: tokenText,
    scanned_at: new Date().toISOString(),
    error_message: null,
  }};
}};
try {{
  const results = [];
  await progress({{ stage: 'start', total: modelCodes.length, scanned: 0, ok: 0, failed: 0 }});
  await waitForLoginShell();
  if (!pageLooksLoggedIn()) {{
    throw new Error('BAILIAN_NOT_LOGGED_IN');
  }}
  for (let index = 0; index < modelCodes.length; index += 1) {{
    const code = modelCodes[index];
    await progress({{ stage: 'model_start', model_id: code, index: index + 1, total: modelCodes.length }});
    try {{
      window.location.hash = '/model-market/detail/' + encodeURIComponent(code) + '?serviceSite=asia-pacific-china';
      await sleep(1300);
      const ok = await waitForQuotaStable(code);
      if (!ok) throw new Error('timeout waiting for quota section');
      await sleep(600);
      const row = parseCurrent(code);
      results.push(row);
      await progress({{
        stage: row.error_message ? 'model_error' : 'model_done',
        model_id: code,
        index: index + 1,
        total: modelCodes.length,
        row,
        scanned: results.length,
        ok: results.filter((r) => !r.error_message).length,
        failed: results.filter((r) => r.error_message).length,
      }});
    }} catch (error) {{
      const row = {{
        model_id: code,
        has_free_quota: false,
        not_supported: false,
        used_tokens: 0,
        total_tokens: 0,
        remaining_tokens: 0,
        used_percent: null,
        expire_date: null,
        raw_quota: null,
        scanned_at: new Date().toISOString(),
        error_message: error?.message || String(error),
      }};
      results.push(row);
      await progress({{
        stage: 'model_error',
        model_id: code,
        index: index + 1,
        total: modelCodes.length,
        row,
        scanned: results.length,
        ok: results.filter((r) => !r.error_message).length,
        failed: results.filter((r) => r.error_message).length,
        error: row.error_message,
      }});
    }}
    await sleep(400);
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
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &url])
        .spawn()
        .map_err(|e| e.to_string())?;

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
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let db = {
        let g = state.db.read().await;
        g.as_ref().ok_or("数据库未初始化")?.clone()
    };
    db.update_bili_transcript_by_path(&file_path, &kind, &text).await
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
async fn setup_fairy(app: tauri::AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("fairy-window")
        .ok_or_else(|| "fairy-window not found".to_string())?;

    log::info!("[Fairy] setup_fairy 已调用，启动光标监控");
    #[cfg(not(windows))]
    let _ = &win;

    #[cfg(windows)]
    {
        let win_clone = win.clone();
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

                // 窗口 252×252 logical，fairy-core 400×400 缩放 0.7，外圈 360×0.7 = 252px
                // 圆心 = (126, 126) logical px from window origin，r = 126
                let fairy_cx = outer.x as f64 + 126.0 * sf;
                let fairy_cy = outer.y as f64 + 126.0 * sf;
                let fairy_r  = 126.0 * sf;

                let dx = cx as f64 - fairy_cx;
                let dy = cy as f64 - fairy_cy;
                let should_ignore = dx * dx + dy * dy > fairy_r * fairy_r;

                if should_ignore != prev_ignore {
                    prev_ignore = should_ignore;
                    let _ = win_clone.set_ignore_cursor_events(should_ignore);
                }
            }
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
pub fn run() {
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

    // 把 DB 注入到下载状态（用于写资产表）
    if let Some(db_for_dl) = db.clone() {
        let dl = bili_dl_state.clone();
        tauri::async_runtime::block_on(async move {
            dl.set_db(db_for_dl).await;
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
        .manage(state)
        .manage(bili_state.clone())
        .manage(bailian_state.clone())
        .manage(bili_dl_state.clone())
        .setup(move |app| {
            // 启动 HTTP 服务器（在 Tauri runtime 内）
            if let Some(db_clone) = db.clone() {
                let bili_clone = bili_state.clone();
                let bailian_clone = bailian_state.clone();
                let bili_dl_clone = bili_dl_state.clone();
                let db_for_api = db_clone.clone();
                tauri::async_runtime::spawn(async move {
                    api::start_server(db_for_api, bili_clone, bailian_clone, bili_dl_clone, 49733).await;
                });

                #[cfg(windows)]
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
            if std::env::var("SLS_DISABLE_HOTKEY").ok().as_deref() == Some("1") {
                log::warn!("[Hotkey] disabled by SLS_DISABLE_HOTKEY=1");
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
                .tooltip("SOLO LEVELING SYSTEM")
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

            log::info!("[App] SOLO LEVELING SYSTEM 启动完成");
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
            get_bili_transcripts,
            update_bili_transcript,
            qwen_asr::qwen_asr_transcribe,
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
            #[cfg(windows)] get_gpu_pref_status,
            #[cfg(windows)] set_gpu_pref_high_performance,
            restart_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
