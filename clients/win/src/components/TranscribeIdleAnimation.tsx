// ══════════════════════════════════════════════
// TranscribeIdleAnimation — 转录背景粒子动画（idle / uploading / streaming 三态共用）
//
// 同一组 NeuralNode 持续 mount，stage 变化时通过更新 update() 内的目标坐标 / 颜色，
// 经由 lerp(k=0.15) 自然过渡，实现丝滑场景切换。
//
// 三种 stage：
//   idle       —— 原 18s 完整循环（双流 → 球 → 时间戳 → 复位）
//   uploading  —— 持续中央细管柱，紫色，沿 z 向下流（PUT 上传感）
//   streaming  —— 在 progress 0-0.55 之间 ping-pong 循环（双流 ↔ 球，跨模态注意力）
// ══════════════════════════════════════════════

import { useEffect, useRef } from 'react'

const LOOP_DURATION = 18000
const NODE_COUNT = 500
const COLS = 40

const C = {
  video: [125, 249, 255] as RGB,
  audio: [255, 124, 216] as RGB,
  core: [255, 170, 0] as RGB,
  text: [110, 255, 140] as RGB,
  accent: [179, 120, 255] as RGB,
}

type RGB = [number, number, number]

export type AnimStage = 'idle' | 'uploading' | 'streaming'

interface Props {
  stage?: AnimStage
}

function easeInOutExpo(x: number): number {
  return x === 0 ? 0
    : x === 1 ? 1
    : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2
    : (2 - Math.pow(2, -20 * x + 10)) / 2
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t }

class NeuralNode {
  type: 'audio' | 'video'
  textRow: number
  textCol: number
  s1: number; s2: number; s3: number
  x = 0; y = 0; z = 0
  color: RGB
  alpha = 1
  size = 2
  linkAlpha = 0

  constructor(index: number) {
    this.type = (index % 3 === 0) ? 'audio' : 'video'
    this.textRow = Math.floor(index / COLS)
    this.textCol = index % COLS
    this.s1 = Math.random()
    this.s2 = Math.random()
    this.s3 = Math.random()
    this.color = this.type === 'video' ? [...C.video] : [...C.audio]
  }

  update(time: number, S: number, mode: AnimStage) {
    let tx = 0, ty = 0, tz = 0, tsize = 2
    let r = 0, g = 0, b = 0, tLink = 0
    const sizeScale = Math.max(0.5, S)

    // ── uploading：所有节点收束为中央细管柱，沿 z 流动 ──
    if (mode === 'uploading') {
      const radius = 90 * S
      const zFlow = (((this.s2 * 3000 + time * 1.8) % 3000) - 1500) * S
      const angle = this.s3 * Math.PI * 2 + zFlow * 0.003
      tx = Math.cos(angle) * radius
      ty = Math.sin(angle) * radius
      tz = zFlow
      tsize = (2 + this.s1 * 1.6) * sizeScale
      r = C.accent[0]; g = C.accent[1]; b = C.accent[2]

      const k = 0.12
      this.x += (tx - this.x) * k
      this.y += (ty - this.y) * k
      this.z += (tz - this.z) * k
      this.size += (tsize - this.size) * k
      this.color[0] += (r - this.color[0]) * k
      this.color[1] += (g - this.color[1]) * k
      this.color[2] += (b - this.color[2]) * k
      this.linkAlpha += (0 - this.linkAlpha) * 0.1
      return
    }

    // ── idle / streaming 共用 progress 驱动的 4 阶段，streaming 仅 ping-pong 在 0-0.55 ──
    let progress: number
    if (mode === 'streaming') {
      const t = (time % 12000) / 12000
      const pp = t < 0.5 ? t * 2 : (1 - t) * 2
      progress = pp * 0.55
    } else {
      progress = (time % LOOP_DURATION) / LOOP_DURATION
    }

    if (progress < 0.3) {
      // —— 阶段1：多模态洪流（双圆柱） ——
      const radius = (this.type === 'video' ? 600 + this.s1 * 200 : 200 + this.s1 * 100) * S
      const zFlow = (((this.s2 * 3000 + time * 1.5) % 3000) - 1500) * S
      const angle = this.s3 * Math.PI * 2 + (this.type === 'audio' ? zFlow * 0.01 : zFlow * 0.002)
      const p = progress / 0.3
      const pinch = 1 - Math.pow(p, 4)
      tx = Math.cos(angle) * radius * pinch
      ty = Math.sin(angle) * radius * pinch
      tz = zFlow
      tsize = (this.type === 'video' ? 12 * this.s1 + 4 : 4) * sizeScale
      const sc = this.type === 'video' ? C.video : C.audio
      r = sc[0]; g = sc[1]; b = sc[2]

    } else if (progress < 0.6) {
      // —— 阶段2：注意力核心（球体 + 连线） ——
      const p = (progress - 0.3) / 0.3
      const phi = Math.acos(2 * this.s1 - 1)
      const theta = this.s2 * Math.PI * 2
      const pulse = Math.sin(time * 0.005 + this.s3 * 10) * 80 * S
      const sphereR = 420 * S + pulse
      tx = sphereR * Math.sin(phi) * Math.cos(theta)
      ty = sphereR * Math.sin(phi) * Math.sin(theta)
      tz = sphereR * Math.cos(phi)
      tsize = (1.6 + this.s1 * 1.8) * sizeScale
      const e = easeInOutExpo(p)
      const sc = this.type === 'video' ? C.video : C.audio
      r = lerp(sc[0], C.core[0], e)
      g = lerp(sc[1], C.core[1], e)
      b = lerp(sc[2], C.core[2], e)
      tLink = (p > 0.1 && p < 0.9) ? 1 : 0

    } else if (progress < 0.9) {
      // —— 阶段3：时间戳阵列（曲面屏） ——
      const p = easeInOutExpo((progress - 0.6) / 0.3)
      const sx = 20 * S
      const sy = 32 * S
      const scrollY = (time * 0.05 * S) % sy
      const destX = (this.textCol - COLS / 2) * sx
      const destY = (this.textRow - (NODE_COUNT / COLS) / 2) * sy - scrollY
      const panelWidth = COLS * sx
      const curveZ = Math.pow(destX / Math.max(panelWidth, 1), 2) * 500 * S
      tx = lerp(this.x, destX, p)
      ty = lerp(this.y, destY, p)
      tz = lerp(this.z, curveZ - 200 * S, p)
      tsize = lerp(this.size, 6 * sizeScale, p)
      r = lerp(C.core[0], C.text[0], p)
      g = lerp(C.core[1], C.text[1], p)
      b = lerp(C.core[2], C.text[2], p)

    } else {
      // —— 阶段4：循环复位 ——
      const p = easeInOutExpo((progress - 0.9) / 0.1)
      const radius = (this.type === 'video' ? 600 + this.s1 * 200 : 200 + this.s1 * 100) * S
      const zFlow = (((this.s2 * 3000 + time * 1.5) % 3000) - 1500) * S
      const angle = this.s3 * Math.PI * 2 + (this.type === 'audio' ? zFlow * 0.01 : zFlow * 0.002)
      tx = lerp(this.x, Math.cos(angle) * radius, p)
      ty = lerp(this.y, Math.sin(angle) * radius, p)
      tz = lerp(this.z, zFlow, p)
      tsize = lerp(this.size, (this.type === 'video' ? 12 * this.s1 + 4 : 4) * sizeScale, p)
      const sc = this.type === 'video' ? C.video : C.audio
      r = lerp(C.text[0], sc[0], p)
      g = lerp(C.text[1], sc[1], p)
      b = lerp(C.text[2], sc[2], p)
    }

    const k = 0.15
    this.x += (tx - this.x) * k
    this.y += (ty - this.y) * k
    this.z += (tz - this.z) * k
    this.size += (tsize - this.size) * k
    this.color[0] += (r - this.color[0]) * k
    this.color[1] += (g - this.color[1]) * k
    this.color[2] += (b - this.color[2]) * k
    this.linkAlpha += (tLink - this.linkAlpha) * 0.1
  }
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const m = d.getMinutes().toString().padStart(2, '0')
  const s = d.getSeconds().toString().padStart(2, '0')
  const ms = Math.floor(d.getMilliseconds() / 10).toString().padStart(2, '0')
  return `${m}:${s}.${ms}`
}

export default function TranscribeIdleAnimation({ stage = 'idle' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<AnimStage>(stage)

  useEffect(() => { stageRef.current = stage }, [stage])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const container = canvas.parentElement
    if (!container) return

    let width = 0, height = 0, centerX = 0, centerY = 0, S = 1
    const dpr = window.devicePixelRatio || 1

    const resize = () => {
      const rect = container.getBoundingClientRect()
      width = rect.width
      height = rect.height
      if (width <= 0 || height <= 0) return
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      centerX = width / 2
      centerY = height / 2
      S = Math.min(width, height) / 1100
    }

    const ro = new ResizeObserver(resize)
    ro.observe(container)
    resize()

    const nodes: NeuralNode[] = []
    for (let i = 0; i < NODE_COUNT; i++) nodes.push(new NeuralNode(i))

    const start = Date.now()
    let raf = 0

    type Item = {
      node: NeuralNode
      sx: number; sy: number
      scale: number; depth: number
      r: number; g: number; b: number; a: number
    }

    const animate = () => {
      const now = Date.now() - start
      const mode = stageRef.current

      // 拖影背景
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = 'rgba(1, 1, 3, 0.18)'
      ctx.fillRect(0, 0, width, height)
      ctx.globalCompositeOperation = 'screen'

      const camAngle = now * 0.0003
      const cosC = Math.cos(camAngle)
      const sinC = Math.sin(camAngle)
      const cameraZ = 200 * S
      const fov = 1000

      const renderList: Item[] = []
      for (const n of nodes) {
        n.update(now, S, mode)
        const rx = n.x * cosC - n.z * sinC
        const rz = n.z * cosC + n.x * sinC
        const ry = n.y
        const depth = fov + cameraZ + rz
        if (depth <= 0) continue
        const scale = fov / depth
        renderList.push({
          node: n,
          sx: rx * scale + centerX,
          sy: ry * scale + centerY,
          scale, depth,
          r: n.color[0] | 0, g: n.color[1] | 0, b: n.color[2] | 0,
          a: Math.max(0.05, Math.min(1, depth / 2000)),
        })
      }
      renderList.sort((a, b) => b.depth - a.depth)

      // —— 神经连线（idle 阶段 attention 段 + streaming 全程都画） ——
      const showLinks = mode === 'streaming' || (mode === 'idle' && (() => {
        const p = (now % LOOP_DURATION) / LOOP_DURATION
        return p >= 0.25 && p <= 0.65
      })())
      if (showLinks) {
        ctx.lineWidth = 1
        for (let i = 0; i < renderList.length; i += 28) {
          const p1 = renderList[i]
          if (p1.node.linkAlpha > 0.1 && p1.scale > 0.5) {
            ctx.beginPath()
            ctx.strokeStyle = `rgba(255, 170, 0, ${p1.node.linkAlpha * 0.4})`
            ctx.moveTo(p1.sx, p1.sy)
            for (let j = 1; j < 4; j++) {
              if (i + j < renderList.length) {
                ctx.lineTo(renderList[i + j].sx, renderList[i + j].sy)
              }
            }
            ctx.stroke()
          }
        }
      }

      // —— 时间戳阵列仅在 idle 阶段 0.55-0.95 期间渲染 ——
      const idleProgress = (now % LOOP_DURATION) / LOOP_DURATION
      const isTextPhase = mode === 'idle' && idleProgress > 0.55 && idleProgress < 0.95

      for (const item of renderList) {
        const drawSize = item.node.size * item.scale

        if (item.a > 0.2) {
          ctx.fillStyle = `rgba(${item.r}, ${item.g}, ${item.b}, ${item.a * 0.2})`
          ctx.fillRect(item.sx - drawSize, item.sy - drawSize, drawSize * 2, drawSize * 2)
        }

        if (isTextPhase) {
          if (item.node.textCol === 0) {
            const fs = Math.max(8, 11 * item.scale)
            ctx.font = `bold ${fs}px "JetBrains Mono", monospace`
            ctx.fillStyle = `rgba(255, 255, 255, ${item.a})`
            const rowSecOffset = item.node.textRow * 2.3
            const tStr = `[${formatTimestamp(now + rowSecOffset * 1000)}]`
            ctx.fillText(tStr, item.sx - 26 * item.scale, item.sy + 4)

          } else if (item.node.textCol > 6) {
            ctx.fillStyle = `rgba(${item.r}, ${item.g}, ${item.b}, ${item.a})`
            if (item.node.s1 > 0.85) {
              const fs = Math.max(7, 10 * item.scale)
              ctx.font = `${fs}px "JetBrains Mono", monospace`
              const char = String.fromCharCode(0x30A0 + Math.floor(Math.random() * 96))
              ctx.fillText(char, item.sx, item.sy + 3)
            } else {
              ctx.fillRect(item.sx - drawSize / 2, item.sy - drawSize / 2, drawSize, drawSize * 0.3)
            }
          }
        } else {
          ctx.fillStyle = `rgba(${item.r}, ${item.g}, ${item.b}, ${item.a})`
          if (item.node.type === 'audio') {
            ctx.beginPath()
            ctx.arc(item.sx, item.sy, drawSize / 2, 0, Math.PI * 2)
            ctx.fill()
          } else {
            ctx.fillRect(item.sx - drawSize / 2, item.sy - drawSize / 2, drawSize, drawSize)
          }
        }
      }

      raf = requestAnimationFrame(animate)
    }
    raf = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute', inset: 0,
        display: 'block',
        pointerEvents: 'none',
        background: '#010103',
      }}
    />
  )
}
