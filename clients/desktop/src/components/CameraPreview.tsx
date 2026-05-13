// ══════════════════════════════════════════════
// CameraPreview — 可拖拽浮动摄像头预览窗口
// position: fixed，可拖出主界面区域
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import type { FaceBox } from '../lib/presence/presence-detector'
import { theme } from '../theme'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  faces: readonly FaceBox[]
  onClose: () => void
}

const W = 240
const H = 180

export default function CameraPreview({ videoRef, faces, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef    = useRef<number>(0)
  const facesRef  = useRef(faces)
  useEffect(() => { facesRef.current = faces }, [faces])

  // 拖拽位置（初始：右上角）
  const [pos, setPos] = useState(() => ({
    x: window.innerWidth - W - 24,
    y: 24,
  }))
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)

  const handleTitleMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y }
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      setPos({
        x: dragRef.current.originX + (e.clientX - dragRef.current.startX),
        y: dragRef.current.originY + (e.clientY - dragRef.current.startY),
      })
    }
    const onUp = () => { dragRef.current = null }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  // rAF 绘制循环
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = () => {
      const video = videoRef.current
      if (!video || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(draw)
        return
      }

      const vw = video.videoWidth  || 320
      const vh = video.videoHeight || 240

      ctx.save()
      ctx.translate(W, 0)
      ctx.scale(-1, 1)
      ctx.drawImage(video, 0, 0, W, H)
      ctx.restore()

      const sx = W / vw
      const sy = H / vh

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

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [videoRef])

  return (
    <div style={{
      position: 'fixed',
      left: pos.x,
      top: pos.y,
      width: W,
      zIndex: 9999,
      background: '#000',
      border: `1px solid rgba(74,222,128,0.3)`,
      borderRadius: 6,
      boxShadow: '0 4px 24px rgba(0,0,0,0.7), 0 0 12px rgba(74,222,128,0.1)',
      overflow: 'hidden',
      userSelect: 'none',
    }}>
      {/* 标题栏 — 拖拽把手 */}
      <div
        onMouseDown={handleTitleMouseDown}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 8px',
          background: 'rgba(4,8,18,0.92)',
          borderBottom: '1px solid rgba(74,222,128,0.15)',
          cursor: dragRef.current ? 'grabbing' : 'grab',
        }}
      >
        <span style={{
          fontSize: 9, fontFamily: theme.fontDisplay,
          color: 'rgba(74,222,128,0.7)', letterSpacing: 1.5,
        }}>
          CAMERA · FACE DETECT
        </span>
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={onClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.4)', fontSize: 11, lineHeight: 1, padding: '0 2px',
          }}
        >✕</button>
      </div>

      <canvas ref={canvasRef} width={W} height={H}
        style={{ display: 'block', width: W, height: H }} />

      {/* 底部状态 */}
      <div style={{
        padding: '3px 8px',
        background: 'rgba(4,8,18,0.85)',
        fontSize: 9, fontFamily: theme.fontDisplay,
        color: faces.length > 0 ? 'rgba(74,222,128,0.8)' : 'rgba(255,255,255,0.25)',
        letterSpacing: 1,
        borderTop: '1px solid rgba(74,222,128,0.1)',
        lineHeight: 1.6,
      }}>
        {faces.length > 0 ? (
          <>
            <div>{`DETECTED · ${(faces[0].score * 100).toFixed(0)}%`}</div>
            <div style={{ color: 'rgba(255,220,80,0.7)', fontSize: 8 }}>
              {`box x=${faces[0].x.toFixed(1)} y=${faces[0].y.toFixed(1)} w=${faces[0].width.toFixed(1)} h=${faces[0].height.toFixed(1)}`}
            </div>
            <div style={{ color: 'rgba(255,220,80,0.7)', fontSize: 8 }}>
              {`video ${videoRef.current?.videoWidth ?? '?'}×${videoRef.current?.videoHeight ?? '?'}`}
            </div>
          </>
        ) : 'NO FACE DETECTED'}
      </div>
    </div>
  )
}
