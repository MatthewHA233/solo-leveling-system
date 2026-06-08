#!/usr/bin/env node

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.join(__dirname, '.cache')
const DB_PATH = path.join(CACHE_DIR, 'solevup_perception.db')
const DB_TMP_PATH = path.join(CACHE_DIR, 'solevup_perception.db.tmp')
// 帧根目录：frames/<videoId>/{meta.json, f%04d.jpg}，手动 ffmpeg 拆好放进去
const FRAMES_ROOT = process.env.SOLEVUP_FRAMES_ROOT || path.join(__dirname, 'frames')
// 工作台布局配置（对照栏列表 / 高度 / 搜索词），随 .cache 一起 gitignore
const BENCH_CONFIG_PATH = path.join(CACHE_DIR, 'bench-config.json')
// 镜像截图独立存文件，json 只存文件名引用 → 配置永远小巧
const SNAPSHOTS_DIR = path.join(CACHE_DIR, 'snapshots')
// AI 可读的对照数据库：把每个对照组拍平为「原始帧 + 前端快照 + 错误批注」自描述记录
const COMPARISONS_PATH = path.join(CACHE_DIR, 'comparisons.json')

const PORT = Number(process.env.SOLEVUP_MIRROR_API_PORT || process.env.SOLEVUP_MIRROR_PORT || 8767)
const DEFAULT_LIMIT = Number(process.env.SOLEVUP_CAPTURE_LIMIT || 50000)
const PACKAGE_NAME = process.env.SOLEVUP_ANDROID_PACKAGE || 'com.solevup.mobile'
let adbSerial = process.env.SOLEVUP_ADB_SERIAL || ''

const state = {
  startedAt: Date.now(),
  lastSyncAt: 0,
  lastSyncOk: false,
  lastSyncMs: 0,
  lastError: '',
  rowCount: 0,
  minEventTimeMs: 0,
  maxEventTimeMs: 0,
  dbBytes: 0,
  syncing: false,
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    const chunks = []
    const errs = []
    child.stdout.on('data', (d) => chunks.push(d))
    child.stderr.on('data', (d) => errs.push(d))
    child.on('error', reject)
    child.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf8')
      const stderr = Buffer.concat(errs).toString('utf8')
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${code})\n${stderr || stdout}`))
    })
  })
}

async function detectDevice() {
  if (adbSerial) return adbSerial
  const { stdout } = await run('adb', ['devices'])
  const line = stdout.split('\n').map((s) => s.trim()).find((s) => s.endsWith('\tdevice'))
  if (!line) throw new Error('没有找到 adb device；请确认手机/模拟器已连接，或设置 SOLEVUP_ADB_SERIAL')
  adbSerial = line.split(/\s+/)[0]
  return adbSerial
}

async function pullDb() {
  await mkdir(CACHE_DIR, { recursive: true })
  const serial = await detectDevice()
  const started = Date.now()
  state.syncing = true
  try {
    await new Promise((resolve, reject) => {
      const out = createWriteStream(DB_TMP_PATH)
      const child = spawn('adb', [
        '-s', serial,
        'exec-out',
        'run-as', PACKAGE_NAME,
        'cat', 'databases/solevup_perception.db',
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      const errs = []
      child.stdout.pipe(out)
      child.stderr.on('data', (d) => errs.push(d))
      child.on('error', reject)
      out.on('error', reject)
      child.on('close', (code) => {
        out.end(async () => {
          if (code === 0) resolve()
          else reject(new Error(`adb pull db failed (${code})\n${Buffer.concat(errs).toString('utf8')}`))
        })
      })
    })
    await rename(DB_TMP_PATH, DB_PATH)
    await refreshDbStats()
    state.lastSyncAt = Date.now()
    state.lastSyncMs = state.lastSyncAt - started
    state.lastSyncOk = true
    state.lastError = ''
  } catch (e) {
    state.lastSyncAt = Date.now()
    state.lastSyncMs = state.lastSyncAt - started
    state.lastSyncOk = false
    state.lastError = e instanceof Error ? e.message : String(e)
  } finally {
    state.syncing = false
  }
}

async function refreshDbStats() {
  const st = await stat(DB_PATH)
  state.dbBytes = st.size
  const sql = "select count(*) as rowCount, min(event_time_ms) as minEventTimeMs, max(event_time_ms) as maxEventTimeMs from torrent_capture_android;"
  const { stdout } = await run('sqlite3', ['-json', DB_PATH, sql])
  const rows = JSON.parse(stdout || '[]')
  const first = rows[0] || {}
  state.rowCount = Number(first.rowCount || 0)
  state.minEventTimeMs = Number(first.minEventTimeMs || 0)
  state.maxEventTimeMs = Number(first.maxEventTimeMs || 0)
}

async function refreshDbStatsIfPresent() {
  try {
    await refreshDbStats()
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      state.rowCount = 0
      state.minEventTimeMs = 0
      state.maxEventTimeMs = 0
      state.dbBytes = 0
    }
  }
}

async function queryCaptures(limit = DEFAULT_LIMIT) {
  await stat(DB_PATH)
  const safeLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 200000))
  const sql = `
    select
      id as rowId,
      event_time_ms as eventTimeMs,
      package_name as packageName,
      window_class as windowClass,
      capture_type as captureType,
      text as text,
      text_hash as textHash,
      source_class as sourceClass
    from torrent_capture_android
    order by id desc
    limit ${safeLimit};
  `
  const { stdout } = await run('sqlite3', ['-json', DB_PATH, sql])
  return JSON.parse(stdout || '[]')
}

function isoFromMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return new Date(0).toISOString()
  return new Date(n).toISOString()
}

async function queryWindowEvents(startMs, endMs, limit = 1000) {
  try { await stat(DB_PATH) } catch { return [] }
  const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, 5000))
  const startIso = isoFromMs(startMs)
  const endIso = isoFromMs(endMs)
  const sql = `
    select
      id as rowId,
      start_at as startAt,
      coalesce(json_extract(data_json, '$.package_name'), '') as packageName,
      coalesce(json_extract(data_json, '$.class_name'), '') as className,
      coalesce(json_extract(data_json, '$.app_label'), '') as appLabel,
      coalesce(json_extract(data_json, '$.window_title'), '') as windowTitle,
      cast(coalesce(json_extract(data_json, '$.event_time_ms'), 0) as integer) as eventTimeMs
    from perception_events_android
    where bucket_id = 'solevup-watcher-window_android'
      and start_at >= '${startIso}' and start_at < '${endIso}'
    order by id asc
    limit ${safeLimit};
  `
  const { stdout } = await run('sqlite3', ['-json', DB_PATH, sql])
  return JSON.parse(stdout || '[]')
}

async function queryPowerEvents(startMs, endMs, limit = 300) {
  try { await stat(DB_PATH) } catch { return [] }
  const safeLimit = Math.max(1, Math.min(Number(limit) || 300, 2000))
  const startIso = isoFromMs(startMs)
  const endIso = isoFromMs(endMs)
  const sql = `
    select
      id as rowId,
      start_at as startAt,
      coalesce(json_extract(data_json, '$.event'), '') as event,
      cast(coalesce(json_extract(data_json, '$.event_time_ms'), 0) as integer) as eventTimeMs
    from perception_events_android
    where bucket_id = 'solevup-watcher-power_android'
      and start_at >= '${startIso}' and start_at < '${endIso}'
    order by id asc
    limit ${safeLimit};
  `
  const { stdout } = await run('sqlite3', ['-json', DB_PATH, sql])
  return JSON.parse(stdout || '[]')
}

async function queryAppMonitorSegments(startMs, endMs, limit = 5000) {
  try { await stat(DB_PATH) } catch { return [] }
  const existsSql = "select name from sqlite_master where type='table' and name='app_monitor_segments_android' limit 1;"
  const exists = await run('sqlite3', ['-noheader', DB_PATH, existsSql]).then((r) => r.stdout.trim()).catch(() => '')
  if (!exists) return []
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5000, 100000))
  const sql = `
    select
      id as rowId,
      date_key as dateKey,
      kind as kind,
      start_ms as startMs,
      end_ms as endMs,
      package_name as packageName,
      class_name as className,
      app_label as appLabel,
      window_title as windowTitle,
      event_type as eventType,
      event_count as eventCount,
      titles_json as titlesJson
    from app_monitor_segments_android
    where end_ms > ${Math.round(startMs)} and start_ms < ${Math.round(endMs)}
    order by start_ms asc, id asc
    limit ${safeLimit};
  `
  const { stdout } = await run('sqlite3', ['-json', DB_PATH, sql])
  return JSON.parse(stdout || '[]').map((row) => {
    let titles = []
    try { titles = JSON.parse(row.titlesJson || '[]') } catch {}
    const { titlesJson, ...rest } = row
    return { ...rest, titles }
  })
}

// 扫描 frames/<videoId>/，返回视频列表 + 每个视频的帧清单
// 帧真实时刻由前端算：startRealTs + n / fps
async function scanVideos() {
  const out = []
  let dirents = []
  try {
    dirents = await readdir(FRAMES_ROOT, { withFileTypes: true })
  } catch {
    return out
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue
    const id = d.name
    const dir = path.join(FRAMES_ROOT, id)
    let files = []
    try {
      files = (await readdir(dir)).filter((f) => /\.(jpe?g|png)$/i.test(f))
    } catch {
      continue
    }
    if (files.length === 0) continue
    let meta = {}
    try {
      meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'))
    } catch {}
    const fps = Number(meta.fps) || 3
    let startRealTs = meta.startRealTs || ''
    if (!startRealTs) {
      const m = id.match(/(\d{1,2})[-:](\d{2})[-:](\d{2})/)
      if (m) startRealTs = `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}`
    }
    const frames = files
      .map((f) => {
        const nm = f.match(/(\d+)/)
        return { n: nm ? Number(nm[1]) : 0, file: f }
      })
      .sort((a, b) => a.n - b.n)
    out.push({
      id,
      label: meta.label || id,
      startRealTs,
      fps,
      frameCount: frames.length,
      frames,
    })
  }
  out.sort((a, b) => a.label.localeCompare(b.label))
  return out
}

// 帧号 → 真实时刻（视频起始 + 帧序号/fps），与前端算法一致
function frameRealTs(startRealTs, fps, n) {
  if (!startRealTs) return ''
  const [h, m, s] = startRealTs.split(':').map(Number)
  const base = h * 3600 + m * 60 + s + Math.floor((n - 1) / (fps || 3))
  const p = (x) => String(x).padStart(2, '0')
  return `${p(Math.floor(base / 3600) % 24)}:${p(Math.floor(base / 60) % 60)}:${p(base % 60)}`
}

// 把 bench-config 与视频帧元数据 join，生成拍平的 AI 可读对照数据库
async function buildComparisons(config) {
  const videos = await scanVideos()
  const byId = new Map(videos.map((v) => [v.id, v]))
  const out = []
  const pbv = config.panelsByVideo || {}
  for (const videoId of Object.keys(pbv)) {
    const v = byId.get(videoId)
    const panels = pbv[videoId] || []
    panels.forEach((p, i) => {
      // 纯多选：frameIdxs 是数据源；旧数据无则迁移 frameIdx
      const idxs = Array.isArray(p.frameIdxs) ? p.frameIdxs : (p.frameIdx != null ? [p.frameIdx] : [])
      const originalFrames = v
        ? idxs
            .filter((fi) => fi >= 0 && fi < v.frames.length)
            .map((fi) => {
              const frame = v.frames[fi]
              return {
                n: frame.n,
                file: frame.file,
                path: `frames/${videoId}/${frame.file}`,
                url: `/frames/${videoId}/${frame.file}`,
                realTs: frameRealTs(v.startRealTs, v.fps, frame.n),
                offsetS: Math.floor((frame.n - 1) / (v.fps || 3)),
              }
            })
        : []
      out.push({
        videoId,
        videoLabel: v ? v.label : videoId,
        panelIndex: i + 1,
        status: p.status || 'unmarked',
        note: p.note || '',
        frameCount: originalFrames.length,
        originalFrames,
        snapshots: (p.snapshots || []).map((s) => ({
          file: typeof s.url === 'string' ? s.url.split('/').pop() : null,
          path: typeof s.url === 'string' ? s.url.replace(/^\//, '') : null,
          url: s.url || null,
          resolved: s.id === p.resolvedSnapId, // 该快照是否为「验证已解决」镜像
        })),
      })
    })
  }
  return {
    generatedAt: new Date().toISOString(),
    total: out.length,
    errorCount: out.filter((c) => c.status === 'error').length,
    comparisons: out,
  }
}

async function serveFrame(res, pathname) {
  const rel = decodeURIComponent(pathname.slice('/frames/'.length))
  const filePath = path.normalize(path.join(FRAMES_ROOT, rel))
  if (!filePath.startsWith(FRAMES_ROOT)) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  try {
    const st = await stat(filePath)
    if (!st.isFile()) throw new Error('not a file')
    const ext = path.extname(filePath).toLowerCase()
    const ct = ext === '.png' ? 'image/png' : 'image/jpeg'
    res.writeHead(200, { 'content-type': ct, 'cache-control': 'public, max-age=3600' })
    createReadStream(filePath).pipe(res)
  } catch {
    sendJson(res, 404, { error: 'frame not found' })
  }
}

// 从录屏文件名解析起始时刻 + videoId 后缀：Record_2026-05-26-10-16-50_xxx → 10:16:50
function parseStartTs(filename) {
  const m = filename.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/)
  if (m) return { startRealTs: `${m[4]}:${m[5]}:${m[6]}`, idSuffix: `${m[4]}-${m[5]}-${m[6]}` }
  const t = filename.match(/(\d{2})[-:](\d{2})[-:](\d{2})/)
  if (t) return { startRealTs: `${t[1]}:${t[2]}:${t[3]}`, idSuffix: `${t[1]}-${t[2]}-${t[3]}` }
  return { startRealTs: '', idSuffix: String(Date.now()) }
}

// 接收上传的视频 → ffmpeg 拆帧到 frames/<videoId>/（长边 1280 / q12 / 3fps）
async function extractVideo(req, res, filename) {
  await mkdir(CACHE_DIR, { recursive: true })
  const { startRealTs, idSuffix } = parseStartTs(filename)
  const videoId = `v-${idSuffix}`
  const tmp = path.join(CACHE_DIR, `upload-${Date.now()}.mp4`)
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(tmp)
    req.pipe(ws)
    ws.on('finish', resolve)
    ws.on('error', reject)
    req.on('error', reject)
  })
  const outDir = path.join(FRAMES_ROOT, videoId)
  await mkdir(outDir, { recursive: true })
  // 重拆覆盖：先清旧帧
  try {
    for (const f of await readdir(outDir)) {
      if (/\.(jpe?g|png)$/i.test(f)) await unlink(path.join(outDir, f))
    }
  } catch {}
  try {
    await run(process.env.SOLEVUP_FFMPEG || 'ffmpeg', [
      '-y', '-i', tmp,
      '-vf', "fps=3,scale='if(gt(a,1),1280,-2)':'if(gt(a,1),-2,1280)'",
      '-q:v', '12',
      path.join(outDir, 'f%04d.jpg'),
    ])
  } catch (e) {
    try { await unlink(tmp) } catch {}
    sendJson(res, 500, { error: `ffmpeg 失败：${e instanceof Error ? e.message : String(e)}` })
    return
  }
  await writeFile(path.join(outDir, 'meta.json'), JSON.stringify({ label: filename, startRealTs, fps: 3 }, null, 2))
  try { await unlink(tmp) } catch {}
  const frameCount = (await readdir(outDir)).filter((f) => /\.jpe?g$/i.test(f)).length
  sendJson(res, 200, { videoId, label: filename, startRealTs, frameCount })
}

// 接收截图二进制（image/jpeg）→ 存 snapshots/<id>.jpg → 返回引用 url
async function saveSnapshot(req, res) {
  await mkdir(SNAPSHOTS_DIR, { recursive: true })
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const file = `${id}.jpg`
  const filePath = path.join(SNAPSHOTS_DIR, file)
  try {
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(filePath)
      req.pipe(ws)
      ws.on('finish', resolve)
      ws.on('error', reject)
      req.on('error', reject)
    })
    sendJson(res, 200, { id, file, url: `/snapshots/${file}` })
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
}

async function serveSnapshot(res, pathname) {
  const rel = decodeURIComponent(pathname.slice('/snapshots/'.length))
  const filePath = path.normalize(path.join(SNAPSHOTS_DIR, rel))
  if (!filePath.startsWith(SNAPSHOTS_DIR)) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  try {
    const st = await stat(filePath)
    if (!st.isFile()) throw new Error('not a file')
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000' })
    createReadStream(filePath).pipe(res)
  } catch {
    sendJson(res, 404, { error: 'snapshot not found' })
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  try {
    if (url.pathname === '/api/status') {
      await refreshDbStatsIfPresent()
      sendJson(res, 200, {
        ...state,
        adbSerial,
        packageName: PACKAGE_NAME,
        port: PORT,
        syncMode: 'manual',
      })
      return
    }
    if (url.pathname === '/api/captures') {
      await refreshDbStatsIfPresent()
      const limit = Number(url.searchParams.get('limit') || DEFAULT_LIMIT)
      const rows = await queryCaptures(limit)
      sendJson(res, 200, { rows, status: { ...state, adbSerial, packageName: PACKAGE_NAME } })
      return
    }
    if (url.pathname === '/api/window-events') {
      await refreshDbStatsIfPresent()
      const startMs = Number(url.searchParams.get('startMs') || 0)
      const endMs = Number(url.searchParams.get('endMs') || Date.now())
      const limit = Number(url.searchParams.get('limit') || 1000)
      const rows = await queryWindowEvents(startMs, endMs, limit)
      sendJson(res, 200, { rows, status: { ...state, adbSerial, packageName: PACKAGE_NAME } })
      return
    }
    if (url.pathname === '/api/app-monitor-segments') {
      await refreshDbStatsIfPresent()
      const startMs = Number(url.searchParams.get('startMs') || 0)
      const endMs = Number(url.searchParams.get('endMs') || Date.now())
      const limit = Number(url.searchParams.get('limit') || 5000)
      const rows = await queryAppMonitorSegments(startMs, endMs, limit)
      sendJson(res, 200, { rows, status: { ...state, adbSerial, packageName: PACKAGE_NAME } })
      return
    }
    if (url.pathname === '/api/power-events') {
      await refreshDbStatsIfPresent()
      const startMs = Number(url.searchParams.get('startMs') || 0)
      const endMs = Number(url.searchParams.get('endMs') || Date.now())
      const limit = Number(url.searchParams.get('limit') || 300)
      const rows = await queryPowerEvents(startMs, endMs, limit)
      sendJson(res, 200, { rows, status: { ...state, adbSerial, packageName: PACKAGE_NAME } })
      return
    }
    if (url.pathname === '/api/videos') {
      const videos = await scanVideos()
      sendJson(res, 200, { videos })
      return
    }
    if (url.pathname === '/api/bench-config') {
      if (req.method === 'GET') {
        try {
          const txt = await readFile(BENCH_CONFIG_PATH, 'utf8')
          sendJson(res, 200, JSON.parse(txt))
        } catch {
          sendJson(res, 200, { panels: [] })
        }
        return
      }
      if (req.method === 'PUT') {
        const body = await readBody(req)
        try {
          const data = JSON.parse(body || '{}')
          await writeFile(BENCH_CONFIG_PATH, JSON.stringify(data, null, 2))
          // 同步刷新 AI 可读对照数据库
          try {
            const cmp = await buildComparisons(data)
            await writeFile(COMPARISONS_PATH, JSON.stringify(cmp, null, 2))
          } catch {}
          sendJson(res, 200, { ok: true })
        } catch (e) {
          sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
        return
      }
    }
    if (url.pathname.startsWith('/frames/')) {
      await serveFrame(res, url.pathname)
      return
    }
    if (url.pathname === '/api/comparisons' && req.method === 'GET') {
      let config = { panelsByVideo: {} }
      try { config = JSON.parse(await readFile(BENCH_CONFIG_PATH, 'utf8')) } catch {}
      const cmp = await buildComparisons(config)
      try { await writeFile(COMPARISONS_PATH, JSON.stringify(cmp, null, 2)) } catch {}
      sendJson(res, 200, cmp)
      return
    }
    if (url.pathname === '/api/snapshot' && req.method === 'POST') {
      await saveSnapshot(req, res)
      return
    }
    if (url.pathname.startsWith('/snapshots/')) {
      await serveSnapshot(res, url.pathname)
      return
    }
    if (url.pathname === '/api/extract' && req.method === 'POST') {
      const filename = url.searchParams.get('filename') || 'video.mp4'
      await extractVideo(req, res, filename)
      return
    }
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      await pullDb()
      sendJson(res, state.lastSyncOk ? 200 : 500, { ...state, adbSerial, packageName: PACKAGE_NAME })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e), status: state })
  }
})

await mkdir(CACHE_DIR, { recursive: true })
await writeFile(path.join(CACHE_DIR, '.gitignore'), '*\n!.gitignore\n')

server.listen(PORT, () => {
  console.log(`[solevup-live-mirror] http://localhost:${PORT}/`)
  console.log(`[solevup-live-mirror] manual snapshot mode for ${PACKAGE_NAME} via adb ${adbSerial || '(auto)'}`)
  console.log('[solevup-live-mirror] no background DB sync; POST /api/sync pulls one snapshot')
})
