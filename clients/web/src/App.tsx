import { useState } from 'react'
import DayNightChart from './components/DayNightChart'
import { mockActivities } from './mockData'
import { theme } from './theme'

export default function App() {
  const [isExpanded, setIsExpanded] = useState(true)
  const [selectedDate] = useState(new Date())

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
        activities={mockActivities}
        isExpanded={isExpanded}
        selectedDate={selectedDate}
      />
    </div>
  )
}
