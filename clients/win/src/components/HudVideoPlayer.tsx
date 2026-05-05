// ══════════════════════════════════════════════
// HudVideoPlayer — 详情面板内嵌的本地视频播放器
//
// 流程：
//   1) mount/换 filePath 时先调 invoke('ensure_h264_playable')
//      让 Rust 端嗅 codec、必要时 ffmpeg 转封到 sibling _h264.mp4
//   2) 期间监听 transcode-progress::<eventId> 事件，显示 HUD 风格进度
//   3) 拿到最终可播放路径后再用 convertFileSrc 喂 <video>
// ══════════════════════════════════════════════

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import PrepOverlay from './PrepOverlay'

// 走 axum 49733 的 /api/local-video，不用 Tauri asset.localhost
// （asset.localhost 响应漏 Accept-Ranges 头，Chromium 不肯走流式播放，会卡死在初始 buffered 末端）
const VIDEO_API_BASE = 'http://localhost:49733'
const buildVideoSrc = (path: string) =>
  `${VIDEO_API_BASE}/api/local-video?path=${encodeURIComponent(path)}`

// 父级若直接传 inline () => {...} 会让 useEffect 反复 fire，
// 用 ref 把 onError 稳住，effect 只依赖 filePath

export interface HudVideoHandle {
  seek: (sec: number) => void
  play: () => void
  pause: () => void
  el: () => HTMLVideoElement | null
}

interface Props {
  filePath: string
  onTimeUpdate?: (sec: number) => void
  onError?: (msg: string) => void
}

interface ProgressEvent {
  phase: 'probe' | 'encoding' | 'done' | 'error'
  encoder: string | null
}

type Stage = 'idle' | 'preparing' | 'ready' | 'failed'

const HudVideoPlayer = forwardRef<HudVideoHandle, Props>(function HudVideoPlayer(
  { filePath, onTimeUpdate, onError }, ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const onErrorRef = useRef(onError)
  useEffect(() => { onErrorRef.current = onError }, [onError])
  const [stage, setStage] = useState<Stage>('idle')
  const [encoder, setEncoder] = useState<string | null>(null)
  const [phase, setPhase] = useState<ProgressEvent['phase']>('probe')
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [resolvedPath, setResolvedPath] = useState<string | null>(null)

  useImperativeHandle(ref, () => ({
    seek(sec) {
      const v = videoRef.current
      if (!v) return
      v.currentTime = Math.max(0, sec)
      v.play().catch(() => {})
    },
    play() { videoRef.current?.play().catch(() => {}) },
    pause() { videoRef.current?.pause() },
    el: () => videoRef.current,
  }), [])

  // 触发 prep + 监听进度
  useEffect(() => {
    let cancelled = false
    let unlisten: UnlistenFn | null = null

    const eventId = `hud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const topic = `transcode-progress::${eventId}`

    setStage('preparing')
    setEncoder(null)
    setPhase('probe')
    setErrMsg(null)
    setResolvedPath(null)

    listen<ProgressEvent>(topic, (e) => {
      if (cancelled) return
      setPhase(e.payload.phase)
      if (e.payload.encoder) setEncoder(e.payload.encoder)
    }).then((un) => {
      unlisten = un
    })

    invoke<string>('ensure_h264_playable', {
      inputPath: filePath,
      eventId,
    }).then((path) => {
      if (cancelled) return
      console.log('[HudVideo] resolved playable path:', path)
      setResolvedPath(path)
      setStage('ready')
    }).catch((e) => {
      if (cancelled) return
      const msg = String(e)
      console.error('[HudVideo] ensure_h264_playable failed:', msg)
      setErrMsg(msg)
      setStage('failed')
      onErrorRef.current?.(msg)
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [filePath])

  // resolvedPath 变化 → reload <video>
  useEffect(() => {
    const v = videoRef.current
    if (!v || !resolvedPath) return
    v.load()
  }, [resolvedPath])

  const handleLoadedMetadata = () => {
    const v = videoRef.current
    if (!v) return
    console.log('[HudVideo] loadedmetadata', {
      videoWidth: v.videoWidth, videoHeight: v.videoHeight,
      duration: v.duration, src: resolvedPath,
    })
    if (v.videoHeight === 0 || v.videoWidth === 0) {
      const msg = '播放时仍无画面（videoHeight=0）。转封后的 H.264 也未能解码，可能 codec 标记异常或文件损坏。'
      console.warn('[HudVideo]', msg)
      setErrMsg(msg)
      setStage('failed')
      onErrorRef.current?.(msg)
    }
  }

  const handleError = () => {
    const v = videoRef.current
    const code = v?.error?.code
    const msg = `视频加载失败 code=${code ?? '?'} (1=ABORT 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED)`
    console.error('[HudVideo]', msg, v?.error)
    setErrMsg(msg)
    setStage('failed')
    onErrorRef.current?.(msg)
  }

  // 检测当前进程是否处于"已配高性能但还在集显"——由 App.tsx 启动时写 sessionStorage
  const gpuPendingRestart = typeof window !== 'undefined'
    && window.sessionStorage.getItem('solo:gpuPendingRestart') === '1'

  return (
    <div style={{
      width: '100%', aspectRatio: '16 / 9',
      background: '#000',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {resolvedPath && (
        <video
          ref={videoRef}
          src={buildVideoSrc(resolvedPath)}
          controls
          preload="metadata"
          onLoadedMetadata={handleLoadedMetadata}
          onTimeUpdate={(e) => onTimeUpdate?.(e.currentTarget.currentTime)}
          onError={handleError}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      )}

      {(stage === 'preparing' || stage === 'idle') && (
        <PrepOverlay phase={phase} encoder={encoder} />
      )}

      {gpuPendingRestart && stage === 'ready' && (
        <div style={{
          position: 'absolute', top: 8, left: 8, right: 8,
          padding: '6px 10px',
          background: 'rgba(255,170,30,0.88)',
          color: '#1a0d00',
          fontSize: 11, fontFamily: 'monospace', fontWeight: 700,
          letterSpacing: 0.3, lineHeight: 1.5,
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ flex: 1 }}>当前还在集显模式，重启应用后会自动切换到独显，视频会更流畅</span>
          <button
            onClick={() => { invoke('restart_app').catch(() => {}) }}
            style={{
              padding: '3px 10px',
              background: 'rgba(26,13,0,0.9)',
              color: 'rgba(255,200,80,0.95)',
              border: '1px solid rgba(26,13,0,0.6)',
              fontSize: 10, fontFamily: 'monospace', fontWeight: 800,
              letterSpacing: 0.5, cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            立即重启
          </button>
        </div>
      )}

      {stage === 'failed' && errMsg && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 16, textAlign: 'center',
          background: 'rgba(40,8,16,0.85)', color: '#fff',
          fontSize: 11, fontFamily: 'monospace', lineHeight: 1.5,
        }}>
          {errMsg}
        </div>
      )}
    </div>
  )
})

export default HudVideoPlayer
