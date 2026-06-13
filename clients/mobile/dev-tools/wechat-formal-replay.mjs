// 测 formal→ListItem 还原：直接拿设备 DB 的 6-13 formal actions/cards 跑 registry 的
// buildTorrentActionListItemsFromFormal / FeedListItemsFromFormal，看微信是否被还原出来。
// 用法: node dev-tools/wechat-formal-replay.mjs /tmp/dev2.db 2026-06-13
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const ts = require('typescript')
const DB = process.argv[2] || '/tmp/dev2.db'
const DAY = process.argv[3] || '2026-06-13'

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wxf-'))
// types.ts + wechat.ts + bilibili.ts + registry.ts 转译并连起来
for (const f of ['types', 'parsers/bilibili', 'parsers/wechat', 'registry']) {
  const sub = f.includes('/') ? f.split('/')[0] : ''
  if (sub) fs.mkdirSync(path.join(tmp, sub), { recursive: true })
  let js = transpile(path.join(ROOT, 'src/screens/torrent', f + '.ts'))
  js = js.replace(/from\s+['"]\.\.\/\.\.\/\.\.\/lib\/perception['"]/g, "from './__perception.mjs'")
         .replace(/from\s+['"]\.\.\/\.\.\/lib\/perception['"]/g, "from './__perception.mjs'")
  fs.writeFileSync(path.join(tmp, f + '.mjs'), js)
}
// perception 仅类型 → 空 stub
fs.writeFileSync(path.join(tmp, '__perception.mjs'), 'export {}')
// 修 registry 里 import 扩展名（.ts→.mjs 已由相对路径解析，需补 .mjs）
let reg = fs.readFileSync(path.join(tmp, 'registry.mjs'), 'utf8')
reg = reg.replace(/from\s+['"]\.\/parsers\/bilibili['"]/g, "from './parsers/bilibili.mjs'")
         .replace(/from\s+['"]\.\/parsers\/wechat['"]/g, "from './parsers/wechat.mjs'")
         .replace(/from\s+['"]\.\/types['"]/g, "from './types.mjs'")
fs.writeFileSync(path.join(tmp, 'registry.mjs'), reg)
for (const f of ['parsers/wechat', 'parsers/bilibili']) {
  let js = fs.readFileSync(path.join(tmp, f + '.mjs'), 'utf8')
  js = js.replace(/from\s+['"]\.\.\/types['"]/g, "from '../types.mjs'")
  fs.writeFileSync(path.join(tmp, f + '.mjs'), js)
}
const reg2 = await import(url.pathToFileURL(path.join(tmp, 'registry.mjs')).href)

function rows(sql) {
  return JSON.parse(execFileSync('sqlite3', ['-json', DB, sql], { maxBuffer: 1 << 28 }).toString() || '[]')
}
const A = rows(`SELECT id rowId,date_key dateKey,parser_id parserId,parser_version parserVersion,action_key key,package_name packageName,app_label appLabel,kind,start_ms startTs,end_ms endTs,title,up_name upName,is_story isStory,payload_json payloadJson,source_refs_json sourceRefsJson FROM torrent_actions_android WHERE date_key='${DAY}'`)
const C = rows(`SELECT id rowId,date_key dateKey,parser_id parserId,parser_version parserVersion,card_key key,package_name packageName,app_label appLabel,card_kind cardKind,start_ms startTs,end_ms endTs,title,up_name upName,payload_json payloadJson,source_refs_json sourceRefsJson FROM torrent_cards_android WHERE date_key='${DAY}'`)
console.log(`# formal rows: actions=${A.length} cards=${C.length}`)
console.log('  actions by parser:', Object.entries(A.reduce((m,a)=>((m[a.parserId]=(m[a.parserId]||0)+1),m),{})))

const actItems = reg2.buildTorrentActionListItemsFromFormal(A)
const feedItems = reg2.buildTorrentFeedListItemsFromFormal(C)
console.log(`\n=== buildTorrentActionListItemsFromFormal → ${actItems.length} 项 ===`)
console.log('  kinds:', Object.entries(actItems.reduce((m,i)=>((m[i.kind]=(m[i.kind]||0)+1),m),{})))
const fmt=ms=>new Date(ms).toTimeString().slice(0,8)
for (const it of actItems.slice(0,8)) console.log(`   [${it.kind}] ${fmt(it.startTs??it.ts)} ${it.act||''} ${it.targetName||''} ${(it.meta||it.title||'').slice(0,30)}`)
console.log(`\n=== buildTorrentFeedListItemsFromFormal → ${feedItems.length} 项 ===`)
console.log('  kinds:', Object.entries(feedItems.reduce((m,i)=>((m[i.kind]=(m[i.kind]||0)+1),m),{})))
fs.rmSync(tmp, { recursive: true, force: true })
