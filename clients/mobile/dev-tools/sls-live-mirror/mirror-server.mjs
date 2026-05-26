#!/usr/bin/env node

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.join(__dirname, '.cache')
const DB_PATH = path.join(CACHE_DIR, 'perception.db')
const DB_TMP_PATH = path.join(CACHE_DIR, 'perception.db.tmp')

const PORT = Number(process.env.SLS_MIRROR_API_PORT || process.env.SLS_MIRROR_PORT || 8767)
const SYNC_INTERVAL_MS = Number(process.env.SLS_SYNC_INTERVAL_MS || 2000)
const DEFAULT_LIMIT = Number(process.env.SLS_CAPTURE_LIMIT || 50000)
const PACKAGE_NAME = process.env.SLS_ANDROID_PACKAGE || 'com.sololevelingsystemmobile'
let adbSerial = process.env.SLS_ADB_SERIAL || ''

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
  if (!line) throw new Error('没有找到 adb device；请确认手机/模拟器已连接，或设置 SLS_ADB_SERIAL')
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
        'cat', 'databases/perception.db',
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
      sendJson(res, 200, {
        ...state,
        adbSerial,
        packageName: PACKAGE_NAME,
        port: PORT,
        syncIntervalMs: SYNC_INTERVAL_MS,
      })
      return
    }
    if (url.pathname === '/api/captures') {
      const limit = Number(url.searchParams.get('limit') || DEFAULT_LIMIT)
      const rows = await queryCaptures(limit)
      sendJson(res, 200, { rows, status: { ...state, adbSerial, packageName: PACKAGE_NAME } })
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
pullDb()
setInterval(() => {
  if (!state.syncing) pullDb()
}, SYNC_INTERVAL_MS)

server.listen(PORT, () => {
  console.log(`[sls-live-mirror] http://localhost:${PORT}/`)
  console.log(`[sls-live-mirror] syncing ${PACKAGE_NAME} via adb ${adbSerial || '(auto)'}`)
})
