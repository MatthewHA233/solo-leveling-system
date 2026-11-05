// ══════════════════════════════════════════════
// 气泡语音回放（桌面端是每个气泡一个 <audio>；手机端全局一个 MediaPlayer）
//
// 原生层换一条播放时不会给上一条发 playback_end，这里记住「谁在放」，
// 别的气泡开始放时把自己复位。
//
// 桌面端录的语音同步过来只有 audio_path，文件不在这台手机上：
// playAudioFile 会 reject。这不是错误，记下来后这条气泡就只显示提示，不再报错。
// ══════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react'
import { DeviceEventEmitter } from 'react-native'
import { playAudioFile, stopAudioPlayback } from '../../lib/voice/voice-native'

export const AUDIO_NOT_ON_DEVICE = '这条语音不在这台设备上'
export const AUDIO_PLAY_FAILED = '播放失败'

type Owner = object

let activeOwner: Owner | null = null
const ownerListeners = new Set<(owner: Owner | null) => void>()
/** 这次运行里已经确认不存在的文件：气泡重新挂载也不用再试一次 */
const missingPaths = new Set<string>()

function setActiveOwner(owner: Owner | null) {
  activeOwner = owner
  for (const fn of ownerListeners) fn(owner)
}

function safeStop() {
  stopAudioPlayback().catch(() => {})
}

/**
 * 从气泡外面停掉正在放的语音（开始录音、关闭面板时用）。
 * 原生 stop 不发 playback_end，直接调 stopAudioPlayback 的话气泡会一直显示「在放」。
 */
export function stopFairyAudio(): void {
  if (activeOwner) setActiveOwner(null)
  safeStop()
}

export interface AudioPlayback {
  readonly playing: boolean
  /** 不能播放的原因（文件不在本机 / 播放失败）；能播放时为 null */
  readonly problem: string | null
  /** 放 / 停切换。桌面端是暂停续播，原生层只有 stop，所以停了再放是从头开始 */
  readonly toggle: (pathOverride?: string) => void
}

export function useAudioPlayback(path: string | null | undefined): AudioPlayback {
  const [playing, setPlaying] = useState(false)
  const [problem, setProblem] = useState<string | null>(
    path && missingPaths.has(path) ? AUDIO_NOT_ON_DEVICE : null,
  )
  const owner = useRef<Owner>({}).current
  const currentPath = useRef<string | null>(null)

  useEffect(() => {
    const onOwner = (next: Owner | null) => {
      if (next !== owner) setPlaying(false)
    }
    ownerListeners.add(onOwner)
    const sub = DeviceEventEmitter.addListener('voice://playback_end', (e: { path?: string; error?: string }) => {
      if (activeOwner !== owner || e?.path !== currentPath.current) return
      activeOwner = null
      setPlaying(false)
      if (e.error) setProblem(AUDIO_PLAY_FAILED)
    })
    return () => {
      ownerListeners.delete(onOwner)
      sub.remove()
      // 气泡卸载（切会话）：自己在放就停掉
      if (activeOwner === owner) {
        activeOwner = null
        safeStop()
      }
    }
  }, [owner])

  const toggle = useCallback((pathOverride?: string) => {
    if (activeOwner === owner) {
      setActiveOwner(null)
      setPlaying(false)
      safeStop()
      return
    }
    const target = pathOverride ?? path
    if (!target || missingPaths.has(target)) {
      setProblem(AUDIO_NOT_ON_DEVICE)
      return
    }
    currentPath.current = target
    setProblem(null)
    setActiveOwner(owner)
    setPlaying(true)
    // 包一层 Promise：native 模块缺失时 requireVoiceNative 是同步抛错
    Promise.resolve()
      .then(() => playAudioFile(target))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        const notHere = message.includes('不存在')
        if (notHere) missingPaths.add(target)
        if (activeOwner === owner) activeOwner = null
        setPlaying(false)
        setProblem(notHere ? AUDIO_NOT_ON_DEVICE : AUDIO_PLAY_FAILED)
      })
  }, [owner, path])

  return { playing, problem, toggle }
}
