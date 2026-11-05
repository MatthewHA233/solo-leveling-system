// ══════════════════════════════════════════════
// 语音条（对应 desktop ChatPanel AudioBubble）：播放键 + 波形 + 时长
//
// 和桌面端的差异（原生层没有对应能力）：
//   · 没有暂停，只有停止：再点从头放
//   · 进度按时长估算（桌面端读 <audio>.currentTime），时长来自消息字段（DB duration_ms）
//   · 波形优先用 audio.waveform（刚录完时可由 waveformFromWavBase64 算出来），
//     没有就用按路径生成的稳定占位（JS 里没法解码本地文件）
//   · 文件不在这台设备（桌面端录的语音同步过来只有路径）：不报错，气泡里提示一行，转写文字照常显示
// ══════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { alpha, theme } from '../../theme'
import { IconPlay, IconStop } from './icons'
import { WAVEFORM_BARS, fmtSec, ledHeight, placeholderWaveform, resampleWaveform } from './fairy-format'
import { useAudioPlayback } from './useAudioPlayback'
import type { FairyAudio } from './types'

export default function AudioBubble({ audio, fallbackSeed }: {
  audio: FairyAudio
  /** 没有路径时生成占位波形用的种子（消息 id） */
  fallbackSeed: string
}) {
  const path = audio.path ?? null
  const { playing, problem, toggle } = useAudioPlayback(path)
  const duration = audio.durationMs != null && audio.durationMs > 0 ? audio.durationMs / 1000 : 0
  const [progress, setProgress] = useState(0)          // 0–1
  const [elapsed, setElapsed] = useState(0)            // 秒
  const startedAt = useRef(0)

  // 进度：原生层不回报，按墙钟估算（桌面端 rAF 读 currentTime）
  useEffect(() => {
    if (!playing) {
      setProgress(0)
      setElapsed(0)
      return
    }
    startedAt.current = Date.now()
    const timer = setInterval(() => {
      const sec = (Date.now() - startedAt.current) / 1000
      setElapsed(sec)
      if (duration > 0) setProgress(Math.min(1, sec / duration))
    }, 100)
    return () => clearInterval(timer)
  }, [playing, duration])

  const bars = useMemo(() => {
    const real = audio.waveform && audio.waveform.length > 0 ? resampleWaveform(audio.waveform, WAVEFORM_BARS) : null
    return real ?? placeholderWaveform(path ?? fallbackSeed, WAVEFORM_BARS)
  }, [audio.waveform, path, fallbackSeed])
  const playedBars = Math.round(progress * WAVEFORM_BARS)

  const canPlay = !!path && !problem
  const label = playing ? fmtSec(elapsed) : duration > 0 ? fmtSec(duration) : ''

  return (
    <View>
      <View style={styles.row}>
        <Pressable
          style={[styles.play, !canPlay && !playing && styles.playOff]}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={playing ? '停止' : '播放'}
          disabled={!path}
          onPress={() => toggle()}
        >
          {playing ? <IconStop color="#FFFFFF" /> : <IconPlay color="#FFFFFF" />}
        </Pressable>
        <View style={styles.wave} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {bars.map((amp, i) => (
            <View
              key={i}
              style={[
                styles.bar,
                { height: ledHeight(Math.sqrt(amp), 6) },
                i < playedBars ? styles.barPlayed : styles.barIdle,
              ]}
            />
          ))}
        </View>
        {label !== '' && <Text style={styles.time}>{label}</Text>}
      </View>
      {problem && <Text style={styles.problem}>{problem}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  play: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: theme.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  playOff: { backgroundColor: theme.inkFaint },
  wave: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 18 },
  bar: { width: 3, borderRadius: 1 },
  barPlayed: { backgroundColor: theme.accent },
  barIdle: { backgroundColor: alpha(theme.accent, 0.3) },
  time: { fontSize: 12, fontWeight: '600', color: theme.inkSoft, fontVariant: ['tabular-nums'] },
  problem: { marginTop: 5, fontSize: 11, color: theme.inkFaint },
})
