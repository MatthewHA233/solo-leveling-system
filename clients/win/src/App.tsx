import { useState, useEffect } from 'react'
import DayNightChart from './components/DayNightChart'
import { mockActivities } from './mockData'
import { fetchActivities } from './lib/chronos-api'
import { theme } from './theme'
import type { ChronosActivity } from './types'

export default function App() {
  const [isExpanded, setIsExpanded] = useState(true)
  const [selectedDate] = useState(new Date())
  const [activities, setActivities] = useState<ChronosActivity[]>(mockActivities)
  const [dbStatus, setDbStatus] = useState<'loading' | 'live' | 'mock'>('loading')

  useEffect(() => {
    fetchActivities(selectedDate)
      .then((data) => {
        if (data.length > 0) {
          setActivities(data)
          setDbStatus('live')
        } else {
          setDbStatus('mock')
        }
      })
      .catch(() => {
        setDbStatus('mock')
      })
  }, [selectedDate])

  return (
    <div style={{
      minHeight: '100vh',
      background: theme.background,
      color: theme.textPrimary,
      fontFamily: "'Courier New', monospace",
    }}>
      {/* 顶栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '12px 20px',
        borderBottom: `1px solid rgba(0,180,255,0.15)`,
      }}>
        <span style={{ fontSize: 14, fontWeight: 'bold', color: theme.electricBlue, letterSpacing: 2 }}>
          CHRONOS
        </span>
        <span style={{ fontSize: 12, color: theme.textSecondary }}>
          {selectedDate.toLocaleDateString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
          })}
        </span>
        <span style={{
          fontSize: 9, padding: '2px 6px', borderRadius: 3,
          background: dbStatus === 'live' ? 'rgba(0,255,136,0.15)' : 'rgba(255,255,255,0.08)',
          color: dbStatus === 'live' ? theme.expGreen : theme.textSecondary,
        }}>
          {dbStatus === 'loading' ? 'SYNC...' : dbStatus === 'live' ? 'LIVE' : 'MOCK'}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            style={{
              background: 'transparent',
              border: `1px solid rgba(0,180,255,0.3)`,
              color: theme.electricBlue,
              fontFamily: "'Courier New', monospace",
              fontSize: 11,
              padding: '4px 12px',
              cursor: 'pointer',
              borderRadius: 3,
              letterSpacing: 1,
            }}
          >
            {isExpanded ? '◀ 收缩' : '▶ 展开'}
          </button>
        </div>
      </div>

      {/* 昼夜表 */}
      <DayNightChart
        activities={activities}
        isExpanded={isExpanded}
        selectedDate={selectedDate}
      />
    </div>
  )
}
