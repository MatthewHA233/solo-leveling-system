// 微信 parser replay 验证：读 live-mirror 同步的 .cache DB 真实 captures，
// 跑 wechat.ts 的还原逻辑，打印卡片/动作，对照录屏帧人工校验。
// 用 typescript.transpileModule 把 TS 转临时 .mjs（parser 运行时只依赖 types.ts 的 sourceRefsInRange）。
// 用法: node dev-tools/wechat-replay.mjs [HH:MM:SS] [时长秒]
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DB = path.join(__dirname, 'solevup-live-mirror', '.cache', 'solevup_perception.db')
const ts = require('typescript')

function transpile(srcPath) {
  const src = fs.readFileSync(srcPath, 'utf8')
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wxreplay-'))
fs.writeFileSync(path.join(tmp, 'types.mjs'), transpile(path.join(ROOT, 'src/screens/torrent/types.ts')))
let parserJs = transpile(path.join(ROOT, 'src/screens/torrent/parsers/wechat.ts'))
parserJs = parserJs.replace(/from\s+['"]\.\.\/types['"]/g, "from './types.mjs'")
fs.writeFileSync(path.join(tmp, 'wechat.mjs'), parserJs)
const mod = await import(url.pathToFileURL(path.join(tmp, 'wechat.mjs')).href)

const argTs = process.argv[2] || '11:37:45'
const argDur = Number(process.argv[3] || 130)
const [hh, mm, ss] = argTs.split(':').map(Number)
const startMs = new Date(2026, 5, 13, hh, mm, ss).getTime()
const endMs = startMs + argDur * 1000

const sql = `SELECT id, event_time_ms, package_name, window_class, capture_type, text, source_class
  FROM torrent_capture_android
  WHERE package_name='com.tencent.mm' AND event_time_ms BETWEEN ${startMs} AND ${endMs}
  ORDER BY id`
const rows = JSON.parse(execFileSync('sqlite3', ['-json', DB, sql], { maxBuffer: 1 << 28 }).toString() || '[]')
const captures = rows.map((r) => ({
  rowId: r.id, eventTimeMs: r.event_time_ms, packageName: r.package_name,
  windowClass: r.window_class, captureType: r.capture_type, text: r.text, sourceClass: r.source_class,
}))
console.log(`# 窗口 ${argTs} +${argDur}s | 微信 captures: ${captures.length}`)

const fmt = (ms) => new Date(ms).toTimeString().slice(0, 8)
const cards = mod.wechatTorrentParser.buildFeedListItems(captures)
const actions = mod.wechatTorrentParser.buildActionListItems(captures)

console.log(`\n========== 还原动作 (${actions.length}) ==========`)
for (const a of actions) console.log(`  [${a.act}] ${fmt(a.startTs)}~${fmt(a.endTs)}  ${a.targetName ? '@' + a.targetName + ' ' : ''}${a.meta || ''}`)

console.log(`\n========== 还原卡片 (${cards.length}) ==========`)
for (const c of cards) {
  if (c.kind === 'wx_article') {
    console.log(`\n· 文章卡 ${fmt(c.ts)}~${fmt(c.endTs)}`)
    console.log(`    标题: ${c.title}`)
    console.log(`    公众号:${c.account || '—'} 阅读:${c.readCount || '—'} 赞:${c.likeCount || '—'} 分享:${c.shareCount || '—'} 在看:${c.wowCount || '—'}`)
    console.log(`    发布:${c.publishLabel || '—'} ${c.location || ''} ${c.album ? '· ' + c.album : ''}`)
    console.log(`    正文块:${c.body?.length || 0}  评论:${c.comments?.length || 0}/${c.commentCount || '—'}`)
    if (process.env.FULL && c.body) {
      for (const b of c.body) {
        if (b.t === 'heading') console.log(`      ## ${b.text}`)
        else if (b.t === 'image') console.log(`      [图${b.caption ? ':' + b.caption : ''}]`)
        else if (b.t === 'code') console.log(`      \`\`\`${b.text.slice(0, 50)}\`\`\``)
        else console.log(`      ${b.text.slice(0, 70)}`)
      }
      for (const cm of c.comments) console.log(`      💬 ${cm.author}${cm.isAuthor ? '(作者)' : cm.isOA ? '(公众号)' : ''} [${cm.meta || ''}]: ${cm.text.slice(0, 50)}`)
    }
  } else if (c.kind === 'wx_oa_feed') {
    console.log(`\n· 订阅号流卡 ${fmt(c.tsStart)}~${fmt(c.tsEnd)}  ${c.entries.length} 条 (sweep ${c.sweepCount})`)
    for (const e of c.entries) console.log(`    · ${e.account}${e.timeLabel ? ' [' + e.timeLabel + ']' : ''} —《${e.title}》`)
  } else if (c.kind === 'wx_chat') {
    console.log(`\n· 聊天卡 ${fmt(c.tsStart)}~${fmt(c.tsEnd)}  对象:${c.partner || '(未识别)'} 文本:${c.textCount} 图:${c.imageCount} 分享:${c.shares.length}`)
    for (const s of c.shares) console.log(`    分享《${s.title}》${s.source ? ' — ' + s.source : ''}`)
  } else if (c.kind === 'wx_session_list') {
    console.log(`\n· 会话列表卡 ${fmt(c.ts)}  ${c.sessions.length} 个会话`)
    for (const s of c.sessions) console.log(`    · ${s.name}  [${s.timeLabel || ''}]  ${s.preview || ''}`)
  }
}
fs.rmSync(tmp, { recursive: true, force: true })
