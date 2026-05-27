import React, { useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import TorrentScreen, { type TorrentScreenDevSource } from '../../../src/screens/TorrentScreen'

const root = document.getElementById('root')!
Object.assign(document.documentElement.style, { width: '100%', height: '100%' })
Object.assign(document.body.style, { width: '100%', height: '100%', margin: '0', overflow: 'hidden' })
Object.assign(root.style, {
  width: '100%',
  height: '100%',
  minHeight: '0',
  display: 'flex',
  flexDirection: 'column',
})

const API_BASE = import.meta.env.VITE_SLS_MIRROR_API_BASE || ''

type CaptureResponse = {
  rows: Array<{
    rowId: number
    eventTimeMs: number
    packageName: string
    windowClass: string
    captureType: string
    text: string
    textHash: string
    sourceClass: string
  }>
  status: { rowCount?: number }
}

async function loadCaptures() {
  const res = await fetch(`${API_BASE}/api/captures?limit=50000`, { cache: 'no-store' })
  if (!res.ok) throw new Error(await res.text())
  const data = await res.json() as CaptureResponse
  return {
    items: data.rows,
    total: data.status.rowCount ?? data.rows.length,
    a11yOn: true,
  }
}

async function syncDb() {
  await fetch(`${API_BASE}/api/sync`, { method: 'POST' })
}

function App() {
  const devSource = useMemo<TorrentScreenDevSource>(() => ({
    pollMs: 2000,
    load: loadCaptures,
    clear: syncDb,
    openAccessibilitySettings: () => {
      syncDb().catch((e) => console.warn('[sls-live-mirror] sync failed', e))
    },
  }), [])

  return <TorrentScreen devSource={devSource} />
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
