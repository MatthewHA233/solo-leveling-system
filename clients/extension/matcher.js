// ══════════════════════════════════════════════
// 共享规则匹配（content script 与 service worker 复用）
// 经 importScripts / content_scripts 注入，挂到 globalThis.SolevupMatcher
// ══════════════════════════════════════════════
//
// 规则模型与 Cold Turkey 对齐：
// · 一条 website 规则是带可选 * 通配符的 host[/path] 模式
// · 例外（exceptions）优先于屏蔽，命中例外则放行
// · 裸域默认匹配其全部子域（bilibili.com → live.bilibili.com）
//
// dNR 规则在 service worker 侧由 compileToDnr() 生成；这里的 evaluate()
// 给 content script 做存量页 / SPA 软导航的二次判定。

(function () {
  'use strict'

  // 把用户输入的 host[/path] 规则规整为小写、去协议、去尾部斜杠
  function normalizePattern(raw) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/\/+$/, '')
  }

  // 通配模式 → 锚定的正则。* 匹配任意字符（含空），其余字面量转义。
  function patternToRegExp(pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp('^' + escaped + '$')
  }

  // 把一条规则展开成「需要匹配的候选串」判定函数。
  // 含 / 的规则按 host+path 匹配；纯域名规则匹配域及其子域。
  function compileRule(raw) {
    const pattern = normalizePattern(raw)
    if (!pattern) return null

    if (pattern.includes('/') || pattern.includes('*')) {
      const re = patternToRegExp(pattern)
      return (host, hostPath) => re.test(host) || re.test(hostPath)
    }

    // 纯域名：精确域或其子域
    return (host) => host === pattern || host.endsWith('.' + pattern)
  }

  function compileRules(list) {
    return (list || []).map(compileRule).filter(Boolean)
  }

  // 从完整 URL 取出小写 host 和 host+path（去查询串/锚点用于路径判定，
  // 但保留查询串供含 * 的 query 规则——故同时给两种形态）
  function urlParts(url) {
    try {
      const u = new URL(url)
      const host = u.hostname.toLowerCase()
      const hostPath = (host + u.pathname + u.search).toLowerCase()
      return { host, hostPath }
    } catch {
      return null
    }
  }

  // 命中屏蔽且未命中例外 → true（应拦截）
  function shouldBlock(url, compiledBlock, compiledAllow) {
    const parts = urlParts(url)
    if (!parts) return false
    const { host, hostPath } = parts
    const blocked = compiledBlock.some((fn) => fn(host, hostPath))
    if (!blocked) return false
    const allowed = compiledAllow.some((fn) => fn(host, hostPath))
    return !allowed
  }

  // dNR 动态规则编译：纯域名 → ||domain^（含子域）；带路径/通配 → urlFilter。
  // 例外用 allow 动作，priority 高于 block 以保证覆盖。
  const PRIORITY_BLOCK = 1
  const PRIORITY_ALLOW = 2

  function ruleToUrlFilter(raw) {
    const pattern = normalizePattern(raw)
    if (!pattern) return null
    if (!pattern.includes('/') && !pattern.includes('*')) {
      // 域锚 + 分隔符，dNR 的 || 天然含子域
      return '||' + pattern + '^'
    }
    // 路径/通配规则：用 || 锚定域起点，* 直接交给 urlFilter
    return '||' + pattern
  }

  function compileToDnr(websites, exceptions, redirectUrl) {
    const rules = []
    let id = 1

    ;(websites || []).forEach((raw) => {
      const urlFilter = ruleToUrlFilter(raw)
      if (!urlFilter) return
      rules.push({
        id: id++,
        priority: PRIORITY_BLOCK,
        action: redirectUrl
          ? { type: 'redirect', redirect: { url: redirectUrl } }
          : { type: 'block' },
        condition: { urlFilter, resourceTypes: ['main_frame', 'sub_frame'] },
      })
    })

    ;(exceptions || []).forEach((raw) => {
      const urlFilter = ruleToUrlFilter(raw)
      if (!urlFilter) return
      rules.push({
        id: id++,
        priority: PRIORITY_ALLOW,
        action: { type: 'allow' },
        condition: { urlFilter, resourceTypes: ['main_frame', 'sub_frame'] },
      })
    })

    return rules
  }

  globalThis.SolevupMatcher = {
    normalizePattern,
    compileRules,
    shouldBlock,
    compileToDnr,
    urlParts,
  }
})()
