// ══════════════════════════════════════════════
// Rule Classifier — 移植自 macOS RuleClassifier.swift
// 零 AI 成本，基于窗口标题/应用名分类
// ══════════════════════════════════════════════

import type { ActivityCategory } from './models'

export interface Classification {
  readonly category: ActivityCategory
  readonly confidence: number
  readonly detail: string
}

// ── Window Rules ──

const WINDOW_RULES: Record<string, readonly string[]> = {
  coding: [
    'visual studio code', 'vscode', 'intellij', 'pycharm', 'webstorm',
    'xcode', 'android studio', 'sublime text', 'vim', 'neovim', 'nvim',
    'terminal', 'iterm', 'warp', 'alacritty', 'cursor', 'windsurf',
    'github desktop', 'sourcetree', 'tower', '终端', 'powershell', 'cmd',
    'windows terminal',
  ],
  writing: [
    'word', 'google docs', 'notion', 'obsidian', 'typora', 'bear',
    'ulysses', 'scrivener', 'overleaf', 'latex',
  ],
  learning: [
    'coursera', 'udemy', 'edx', 'khan academy', 'leetcode',
    'hackerrank', 'duolingo', 'anki',
  ],
  browsing: [
    'chrome', 'firefox', 'safari', 'edge', 'arc', 'brave',
  ],
  media: [
    'youtube', 'netflix', 'bilibili', 'spotify', 'apple music',
    'vlc', 'iina', 'plex', 'disney+', 'hbo', 'potplayer',
  ],
  social: [
    'twitter', 'x.com', 'weibo', 'discord', 'slack', 'telegram',
    'whatsapp', 'wechat', '微信', 'qq', 'line', 'signal',
    'instagram', 'facebook', 'reddit', 'threads',
  ],
  gaming: [
    'steam', 'epic games', 'minecraft', 'genshin', '原神',
    'league of legends', 'valorant', 'cs2',
  ],
  communication: [
    'mail', 'outlook', 'thunderbird', 'gmail', '邮件', 'zoom',
    'teams', 'meet', 'facetime', '飞书', '钉钉', '腾讯会议',
  ],
  design: [
    'figma', 'sketch', 'photoshop', 'illustrator', 'canva',
    'blender', 'cinema 4d', 'after effects', 'premiere',
  ],
  reading: [
    'kindle', 'books', 'pdf', 'calibre', 'readwise',
    'pocket', 'instapaper', '微信读书', '图书',
  ],
}

// ── Browser Title Rules ──

const BROWSER_TITLE_RULES: Record<string, readonly string[]> = {
  coding: [
    'github.com', 'github', 'gitlab.com', 'gitlab', 'stackoverflow.com',
    'stack overflow', 'npm', 'pypi', 'docs.python', 'developer.mozilla',
    'api reference', 'documentation', 'codepen', 'replit',
  ],
  learning: [
    'tutorial', '教程', 'course', 'lecture', 'lesson',
    'how to', 'guide', 'learn', '学习',
  ],
  social: [
    'twitter.com', 'x.com', 'reddit.com', 'weibo.com',
    'discord.com', 'instagram.com', 'facebook.com',
  ],
  media: [
    'youtube.com', 'bilibili.com', 'netflix.com', 'spotify.com',
    'b站', '哔哩哔哩',
  ],
  shopping: [
    'taobao', 'jd.com', 'amazon', '淘宝', '京东', '拼多多',
  ],
  work: [
    'jira', 'confluence', 'asana', 'trello', 'monday.com',
    'linear', 'clickup', 'basecamp',
  ],
}

// ── Focus Score Map ──

const FOCUS_SCORE_MAP: Record<string, number> = {
  coding: 0.8, writing: 0.8, work: 0.7, learning: 0.7,
  design: 0.7, research: 0.7, reading: 0.6, meeting: 0.6,
  communication: 0.5, browsing: 0.4, social: 0.3,
  media: 0.2, gaming: 0.2, idle: 0.0, unknown: 0.3,
  creative: 0.7, shopping: 0.2,
}

// ── Classifier ──

function refineBrowserCategory(title: string): string | null {
  for (const [category, keywords] of Object.entries(BROWSER_TITLE_RULES)) {
    for (const kw of keywords) {
      if (title.includes(kw)) return category
    }
  }
  return null
}

export function classify(appName?: string, windowTitle?: string): Classification {
  const appLower = (appName ?? '').toLowerCase()
  const titleLower = (windowTitle ?? '').toLowerCase()

  // 1. Match app name
  for (const [category, keywords] of Object.entries(WINDOW_RULES)) {
    for (const kw of keywords) {
      if (appLower.includes(kw)) {
        if (category === 'browsing') {
          const refined = refineBrowserCategory(titleLower)
          if (refined) {
            return {
              category: refined as ActivityCategory,
              confidence: 0.75,
              detail: `浏览器访问 ${(windowTitle ?? '').slice(0, 50)}`,
            }
          }
          return {
            category: 'browsing',
            confidence: 0.5,
            detail: `浏览器: ${(windowTitle ?? '').slice(0, 50)}`,
          }
        }
        return {
          category: category as ActivityCategory,
          confidence: 0.8,
          detail: `使用 ${appName ?? ''}`,
        }
      }
    }
  }

  // 2. Match window title
  for (const [category, keywords] of Object.entries(WINDOW_RULES)) {
    for (const kw of keywords) {
      if (titleLower.includes(kw)) {
        return {
          category: category as ActivityCategory,
          confidence: 0.6,
          detail: `标题包含 ${kw}`,
        }
      }
    }
  }

  return {
    category: 'unknown',
    confidence: 0.3,
    detail: `未识别: ${appName ?? ''} - ${(windowTitle ?? '').slice(0, 30)}`,
  }
}

export function focusScore(category: ActivityCategory): number {
  return FOCUS_SCORE_MAP[category] ?? 0.3
}
