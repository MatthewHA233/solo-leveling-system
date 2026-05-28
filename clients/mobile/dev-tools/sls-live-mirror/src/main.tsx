import React, { useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import TorrentScreen, { type TorrentScreenDevSource } from '../../../src/screens/TorrentScreen'
import DayNightScreen from '../../../src/screens/DayNightScreen'
import type { ActionTimelineSource } from '../../../src/screens/torrent/ActionTimeline'

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

async function loadCaptures(range?: { startTs: number; endTs: number; limit?: number }) {
  const params = new URLSearchParams()
  params.set('limit', String(range?.limit ?? 50000))
  if (range) {
    params.set('startMs', String(Math.floor(range.startTs)))
    params.set('endMs', String(Math.ceil(range.endTs)))
  }
  const res = await fetch(`${API_BASE}/api/captures?${params.toString()}`, { cache: 'no-store' })
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
  const screen = new URLSearchParams(window.location.search).get('screen')
  const devSource = useMemo<TorrentScreenDevSource>(() => ({
    pollMs: 2000,
    load: loadCaptures,
    clear: syncDb,
    openAccessibilitySettings: () => {
      syncDb().catch((e) => console.warn('[sls-live-mirror] sync failed', e))
    },
  }), [])

  const actionSource = useMemo<ActionTimelineSource>(() => ({
    pollMs: 2000,
    load: async (range) => (await loadCaptures(range)).items,
  }), [])

  if (screen === 'torrent') return <TorrentScreen devSource={devSource} />
  return <DayNightScreen mode="torrent" torrentActionSource={actionSource} />
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
