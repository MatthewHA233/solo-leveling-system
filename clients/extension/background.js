// ══════════════════════════════════════════════
// Service Worker：与桌面端 Native Messaging host 保持连接，
// 把屏蔽规则编译成 declarativeNetRequest 动态规则（主拦截层），
// 并对已打开的存量标签页补刀重定向。
// ══════════════════════════════════════════════

importScripts('matcher.js')

const NM_HOST = 'com.solevup.focus_lock'
const RECONNECT_DELAY_MS = 3000
const KEEPALIVE_ALARM = 'solevup-keepalive'

// blocked.html?host=...&group=... 作为 dNR redirect 目标
const BLOCKED_PAGE = chrome.runtime.getURL('blocked.html')

let port = null
// 最近一次从桌面端收到的规则集 { revision, websites, exceptions }
let currentRules = { revision: 0, websites: [], exceptions: [] }

// ── Native Messaging 连接（断线自动重连） ──────

function connect() {
  try {
    port = chrome.runtime.connectNative(NM_HOST)
  } catch (e) {
    console.warn('[Solevup] connectNative 失败，稍后重试:', e)
    scheduleReconnect()
    return
  }

  port.onMessage.addListener(onHostMessage)
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError
    console.warn('[Solevup] NM 连接断开:', err && err.message)
    port = null
    // 桥断开时不清规则：桌面端会通过自己的兜底（hosts / 心跳超时惩罚）接管，
    // 这里保留现有 dNR 规则避免出现“扩展还在但瞬间放行”的缝隙
    scheduleReconnect()
  })

  // 主动报告就绪，桌面端据此下发当前规则
  send({ type: 'hello', extReady: true })
  // 重连后桌面端不知道现在开着哪页：重报一次
  lastReportedTab = ''
  reportActiveTab()
}

function scheduleReconnect() {
  setTimeout(() => {
    if (!port) connect()
  }, RECONNECT_DELAY_MS)
}

function send(msg) {
  if (!port) return
  try {
    port.postMessage(msg)
  } catch (e) {
    console.warn('[Solevup] postMessage 失败:', e)
  }
}

// ── 桌面端消息处理 ────────────────────────────

function onHostMessage(msg) {
  if (!msg || typeof msg !== 'object') return

  switch (msg.type) {
    case 'rules':
      applyRules(msg)
      break
    case 'heartbeat':
      // 回 pong，桌面端据此确认扩展存活
      send({ type: 'pong', revision: currentRules.revision })
      break
    default:
      break
  }
}

// ── 规则应用 ──────────────────────────────────

async function applyRules(msg) {
  const websites = Array.isArray(msg.websites) ? msg.websites : []
  const exceptions = Array.isArray(msg.exceptions) ? msg.exceptions : []
  currentRules = { revision: msg.revision || 0, websites, exceptions }

  const dnrRules = SolevupMatcher.compileToDnr(websites, exceptions, BLOCKED_PAGE)

  // 全量替换动态规则：先取现有 id 清掉，再加新的
  const existing = await chrome.declarativeNetRequest.getDynamicRules()
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: dnrRules,
  })

  // 持久化一份，SW 重启后无需等桌面端推送即可恢复
  await chrome.storage.session.set({ currentRules })

  // dNR 只拦新请求，对已打开的存量页面无效 → 主动扫描并重定向
  await sweepOpenTabs()

  send({ type: 'rules_applied', revision: currentRules.revision, count: dnrRules.length })
}

async function sweepOpenTabs() {
  const compiledBlock = SolevupMatcher.compileRules(currentRules.websites)
  const compiledAllow = SolevupMatcher.compileRules(currentRules.exceptions)
  if (compiledBlock.length === 0) return

  let tabs = []
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
  } catch {
    return
  }

  for (const tab of tabs) {
    if (!tab.url || !tab.id) continue
    if (SolevupMatcher.shouldBlock(tab.url, compiledBlock, compiledAllow)) {
      const target = BLOCKED_PAGE + '?host=' + encodeURIComponent(hostOf(tab.url))
      chrome.tabs.update(tab.id, { url: target }).catch(() => {})
    }
  }
}

function hostOf(url) {
  const parts = SolevupMatcher.urlParts(url)
  return parts ? parts.host : ''
}

// ── content script 软导航回报（SPA 路由变化）──

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'check_url' && sender.tab && sender.tab.id) {
    const compiledBlock = SolevupMatcher.compileRules(currentRules.websites)
    const compiledAllow = SolevupMatcher.compileRules(currentRules.exceptions)
    const block = SolevupMatcher.shouldBlock(msg.url, compiledBlock, compiledAllow)
    sendResponse({ block })
    return true
  }
  return false
})

// ── 当前标签页上报 ────────────────────────────
// 协议的灰色网站（比如 B 站：学习还是娱乐）要按「现在开着哪一页」判断，桌面端只看得到窗口标题，
// 所以切标签 / 换页 / 切窗口时把当前激活页的网址和标题报上去（只发给本机桌面端）

let lastReportedTab = ''

async function reportActiveTab() {
  try {
    const win = await chrome.windows.getLastFocused()
    if (!win || win.id === undefined) return
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id })
    if (!tab || !tab.url) return
    const key = tab.url + ' ' + (tab.title || '')
    if (key === lastReportedTab) return
    lastReportedTab = key
    send({ type: 'active_tab', url: tab.url, title: tab.title || '' })
  } catch {
    // 窗口刚关之类：下一次切换再报
  }
}

chrome.tabs.onActivated.addListener(() => { reportActiveTab() })
chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (tab.active && (info.url || info.title || info.status === 'complete')) reportActiveTab()
})
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) reportActiveTab()
})

// ── 保活与生命周期 ────────────────────────────

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM && !port) connect()
})

chrome.runtime.onStartup.addListener(restoreAndConnect)
chrome.runtime.onInstalled.addListener(restoreAndConnect)

async function restoreAndConnect() {
  const stored = await chrome.storage.session.get('currentRules')
  if (stored.currentRules) currentRules = stored.currentRules
  connect()
}

// SW 冷启动立即连接
connect()
