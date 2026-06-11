// ══════════════════════════════════════════════
// 内容脚本（document_start）：第二层拦截
// · dNR 处理常规导航；这里覆盖 dNR 触及不到的场景：
//   SPA 软路由（history.pushState / replaceState）切到被屏蔽路径
// · 命中时停止页面渲染并跳到扩展内置拦截页
// ══════════════════════════════════════════════

(function () {
  'use strict'

  let lastChecked = ''

  function requestCheck(url) {
    if (url === lastChecked) return
    lastChecked = url
    try {
      chrome.runtime.sendMessage({ type: 'check_url', url }, (resp) => {
        // SW 未就绪时 lastError 会被设置，忽略即可（dNR 仍在兜底）
        if (chrome.runtime.lastError) return
        if (resp && resp.block) redirectToBlocked(url)
      })
    } catch {
      // 扩展上下文失效（如刚更新）——交给 dNR
    }
  }

  function redirectToBlocked(url) {
    try {
      window.stop()
    } catch {}
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {}
    const target = chrome.runtime.getURL('blocked.html') + '?host=' + encodeURIComponent(host)
    location.replace(target)
  }

  // 首帧立即校验（存量页 / dNR 漏网的 document_start 时机）
  requestCheck(location.href)

  // 拦截 SPA 软导航
  const origPush = history.pushState
  const origReplace = history.replaceState
  history.pushState = function () {
    origPush.apply(this, arguments)
    requestCheck(location.href)
  }
  history.replaceState = function () {
    origReplace.apply(this, arguments)
    requestCheck(location.href)
  }
  window.addEventListener('popstate', () => requestCheck(location.href))
  window.addEventListener('hashchange', () => requestCheck(location.href))
})()
