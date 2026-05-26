#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.join(__dirname, '.cache', 'web')
const entryPath = path.join(__dirname, 'src', 'main.tsx')

const children = []

function start(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  children.push(child)
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.log(`[sls-live-mirror] ${name} exited (${signal || code})`)
    shutdown(code || 1)
  })
  return child
}

let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 200)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

await mkdir(webRoot, { recursive: true })
await writeFile(path.join(webRoot, 'index.html'), `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SLS 洪流域 Web Mirror</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@fs/${entryPath}"></script>
  </body>
</html>
`)

start('api', process.execPath, ['mirror-server.mjs'], {
  SLS_MIRROR_API_PORT: process.env.SLS_MIRROR_API_PORT || '8767',
})

start('vite', process.platform === 'win32' ? 'npx.cmd' : 'npx', [
  'vite',
  '--host',
  '0.0.0.0',
  '--port',
  process.env.SLS_MIRROR_WEB_PORT || '8766',
])
