// ══════════════════════════════════════════════
// CameraWindow — 独立 OS 子窗口中的摄像头预览
// 从主窗口接收人脸框数据（Tauri event: face-data）
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { FaceBox } from '../lib/presence/presence-detector'
import { theme } from '../theme'

const W = 240
const H = 180

export default function CameraWindow() {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const videoRef   = useRef<HTMLVideoElement>(null)
  const facesRef   = useRef<readonly FaceBox[]>([])
  const [faces, setFaces]   = useState<readonly FaceBox[]>([])
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')

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

  // 接收主窗口发来的人脸框数据
  useEffect(() => {
    const p = listen<{ faces: readonly FaceBox[] }>('face-data', e => {
      facesRef.current = e.payload.faces
      setFaces(e.payload.faces)
    })
    return () => { p.then(fn => fn()) }
  }, [])

  // rAF 绘制循环
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf: number

    const draw = () => {
      const video = videoRef.current
      if (video && video.readyState >= 2) {
        const vw = video.videoWidth  || 320
        const vh = video.videoHeight || 240
        const sx = W / vw
        const sy = H / vh

        ctx.save()
        ctx.translate(W, 0)
        ctx.scale(-1, 1)
        ctx.drawImage(video, 0, 0, W, H)
        ctx.restore()

        for (const face of facesRef.current) {
          const rw = face.width  * sx
          const rh = face.height * sy
          const rx = W - (face.x + face.width / 2) * sx - rw / 2 + 62
          const ry = (face.y - face.height / 2) * sy - 10
          const alpha = Math.min(1, face.score * 1.2)

          ctx.save()
          ctx.strokeStyle = `rgba(74,222,128,${alpha})`
          ctx.lineWidth   = 1.5
          ctx.shadowColor = '#4ADE80'
          ctx.shadowBlur  = 8
          ctx.strokeRect(rx, ry, rw, rh)
          ctx.shadowBlur  = 0
          ctx.fillStyle = `rgba(74,222,128,${alpha * 0.9})`
          ctx.font      = '9px JetBrains Mono, monospace'
          ctx.fillText(`${(face.score * 100).toFixed(0)}%`, rx + 2, Math.max(ry - 2, 10))
          ctx.restore()
        }
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
          CAMERA · FACE DETECT
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
        color: faces.length > 0 ? 'rgba(74,222,128,0.8)' : 'rgba(255,255,255,0.25)',
        letterSpacing: 1,
        borderTop: '1px solid rgba(74,222,128,0.1)',
      }}>
        {faces.length > 0
          ? `DETECTED · ${(faces[0].score * 100).toFixed(0)}%`
          : 'NO FACE DETECTED'}
      </div>
    </div>
    </>
  )
}
