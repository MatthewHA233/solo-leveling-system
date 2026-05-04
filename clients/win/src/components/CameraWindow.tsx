// ══════════════════════════════════════════════
// CameraWindow — 独立 OS 子窗口中的摄像头预览
// 仅展示本地摄像头画面，未来给 AI 实时视频对话用
// （历史里挂过 face-data 事件做人脸框装饰，已随 presence detection 一起清掉）
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { theme } from '../theme'

const W = 240
const H = 180

export default function CameraWindow() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')

  // Alt 键中继：此窗口聚焦时 WebView2 拦截系统键，需 DOM 捕获后转发给主窗口
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code === 'AltRight') { e.preventDefault(); import('@tauri-apps/api/event').then(({ emit }) => emit('ralt-keydown', null)) }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'AltRight') { e.preventDefault(); import('@tauri-apps/api/event').then(({ emit }) => emit('ralt-keyup', null)) }
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
  }, [])

  // 独立开摄像头（仅用于显示）
  useEffect(() => {
    let stream: MediaStream | null = null
    navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: 'user' },
    }).then(s => {
      stream = s
      const v = videoRef.current
      if (v) { v.srcObject = s; v.play(); setStatus('ok') }
    }).catch(() => setStatus('error'))
    return () => { stream?.getTracks().forEach(t => t.stop()) }
  }, [])

  // rAF 绘制循环（左右镜像，便于看自己）
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf: number

    const draw = () => {
      const video = videoRef.current
      if (video && video.readyState >= 2) {
        ctx.save()
        ctx.translate(W, 0)
        ctx.scale(-1, 1)
        ctx.drawImage(video, 0, 0, W, H)
        ctx.restore()
      } else {
        ctx.clearRect(0, 0, W, H)
      }
      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  const handleClose = () => getCurrentWindow().close()
  const handleDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    getCurrentWindow().startDragging()
  }

  return (
    <>
      <style>{`html,body,#root{margin:0;padding:0;overflow:hidden;background:#000}`}</style>
      <div
        onMouseDown={handleDragStart}
        style={{
          width: '100vw', height: '100vh',
          display: 'flex', flexDirection: 'column',
          background: '#000', userSelect: 'none',
          border: '1px solid rgba(74,222,128,0.25)',
          boxSizing: 'border-box', cursor: 'move',
        }}
      >
      {/* 标题栏 */}
      <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 8px', height: 22, flexShrink: 0,
          background: 'rgba(4,8,18,0.95)',
          borderBottom: '1px solid rgba(74,222,128,0.15)',
        }}
      >
        <span style={{
          fontSize: 9, fontFamily: theme.fontDisplay,
          color: 'rgba(74,222,128,0.7)', letterSpacing: 1.5,
          pointerEvents: 'none',
        }}>
          CAMERA
        </span>
        <button
          onClick={handleClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.4)', fontSize: 11, lineHeight: 1,
            padding: '0 2px',
          }}
        >✕</button>
      </div>

      {/* 摄像头画布 — flex:1 撑满剩余空间 */}
      <div style={{ position: 'relative', flex: 1, background: '#0a0a0a', overflow: 'hidden' }}>
        <video ref={videoRef} style={{ display: 'none' }} muted playsInline />
        <canvas ref={canvasRef} width={W} height={H}
          style={{ display: 'block', width: '100%', height: '100%' }} />
        {status === 'error' && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'rgba(255,80,80,0.7)', fontSize: 10, fontFamily: theme.fontDisplay,
          }}>
            CAMERA ERROR
          </div>
        )}
      </div>

      {/* 底部状态 */}
      <div style={{
        padding: '3px 8px', flexShrink: 0,
        background: 'rgba(4,8,18,0.85)',
        fontSize: 9, fontFamily: theme.fontDisplay,
        color: status === 'ok' ? 'rgba(74,222,128,0.8)' : 'rgba(255,255,255,0.25)',
        letterSpacing: 1,
        borderTop: '1px solid rgba(74,222,128,0.1)',
      }}>
        {status === 'ok' ? 'STREAMING' : status === 'error' ? 'CAMERA ERROR' : 'INIT'}
      </div>
    </div>
    </>
  )
}
