// ══════════════════════════════════════════════
// PrepOverlay — 视频转封等待动画
//
// 矩阵宏块叙事：BITSTREAM → DECODING → CROPPING → TRANSCODING → 循环
// 16 秒循环，配合激光扫描线 + 数据流 HUD
//
// 调试入口：http://localhost:5172/#debug-prep
// ══════════════════════════════════════════════

import { useEffect, useRef } from 'react'

const LOOP_DURATION = 16000

const C = {
  raw: [120, 120, 120],
  decode: [0, 200, 255],
  yuv: [255, 200, 0],
  crop: [255, 0, 85],
  transcode: [0, 255, 120],
  bg: 'rgba(2, 2, 2, 0.12)',
}

function easeInOutQuart(x: number) {
  return x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2
}

class Macroblock {
  gridX: number; gridY: number
  nx: number; ny: number
  distToCenter: number
  baseSize: number
  isHighFreq: boolean
  randomDepth: number
  mvX: number; mvY: number
  x = 0; y = 0; z = 0
  size = 0
  color = [...C.raw]
  alpha = 1
  rotation = 0

  constructor(gridX: number, gridY: number, totalCols: number, totalRows: number, w: number, h: number) {
    this.gridX = gridX
    this.gridY = gridY
    this.nx = (gridX / totalCols) * 2 - 1
    this.ny = (gridY / totalRows) * 2 - 1
    this.distToCenter = Math.sqrt(this.nx * this.nx + this.ny * this.ny)
    this.baseSize = Math.min(w, h) * 0.6 / totalCols
    this.isHighFreq = this.distToCenter > 0.6 && Math.random() > 0.3
    this.randomDepth = (Math.random() - 0.5) * 800
    this.mvX = (Math.random() - 0.5) * 100
    this.mvY = (Math.random() - 0.5) * 100
  }

  private lerp(a: number, b: number, t: number) { return a + (b - a) * t }

  update(progress: number, width: number, height: number) {
    const spreadX = this.nx * (width * 0.4)
    const spreadY = this.ny * (height * 0.4)

    let targetX: number, targetY: number, targetZ: number
    let targetSize: number, targetRot = 0
    let r: number, g: number, b: number, targetAlpha = 1

    if (progress < 0.1) {
      targetX = this.nx * 50
      targetY = this.ny * 50
      targetZ = this.randomDepth * 1.5
      targetSize = this.baseSize * (Math.random() * 0.5 + 0.5)
      targetRot = this.randomDepth * 0.01
      ;[r, g, b] = C.raw
    } else if (progress < 0.3) {
      const p = easeInOutQuart((progress - 0.1) / 0.2)
      const delayP = Math.max(0, Math.min(1, (p - this.distToCenter * 0.2) / 0.8))
      const mvInfluence = (1 - delayP) * Math.sin(delayP * Math.PI)
      targetX = this.lerp(this.nx * 50, spreadX + this.mvX * mvInfluence, delayP)
      targetY = this.lerp(this.ny * 50, spreadY + this.mvY * mvInfluence, delayP)
      targetZ = this.lerp(this.randomDepth * 1.5, 0, delayP)
      targetSize = this.baseSize * 0.9
      targetRot = this.lerp(this.randomDepth * 0.01, 0, delayP)
      r = this.lerp(C.raw[0], C.decode[0], delayP)
      g = this.lerp(C.raw[1], C.decode[1], delayP)
      b = this.lerp(C.raw[2], C.decode[2], delayP)
    } else if (progress < 0.4) {
      targetX = spreadX; targetY = spreadY; targetZ = 0
      targetSize = this.baseSize * 0.9
      targetRot = 0
      ;[r, g, b] = C.decode
      if (Math.random() > 0.99) [r, g, b] = C.yuv
    } else if (progress < 0.6) {
      const p = (progress - 0.4) / 0.2
      targetX = spreadX; targetY = spreadY; targetZ = 0
      targetRot = 0
      const scanLimit = -height / 2 + height * p
      if (this.isHighFreq && spreadY < scanLimit) {
        const timeSinceScanned = Math.max(0, p - (spreadY + height / 2) / height)
        targetZ = -timeSinceScanned * 500
        targetSize = this.baseSize * 0.9 * Math.max(0, 1 - timeSinceScanned * 3)
        targetRot = timeSinceScanned * 10
        ;[r, g, b] = C.crop
        targetAlpha = Math.max(0, 1 - timeSinceScanned * 2)
      } else {
        targetSize = this.baseSize * 0.9
        ;[r, g, b] = C.decode
      }
    } else if (progress < 0.8) {
      const p = easeInOutQuart((progress - 0.6) / 0.2)
      if (this.isHighFreq) {
        targetAlpha = 0; targetSize = 0
        targetX = 0; targetY = 0; targetZ = 0
        r = 0; g = 0; b = 0
      } else {
        const transX = this.nx * (width * 0.25)
        const transY = this.ny * (height * 0.25)
        targetX = this.lerp(spreadX, transX, p)
        targetY = this.lerp(spreadY, transY, p)
        targetZ = this.lerp(0, (Math.random() * 200 + 50) * Math.sin(progress * 20), p)
        targetSize = this.lerp(this.baseSize * 0.9, this.baseSize * 1.5, p)
        targetRot = 0
        r = this.lerp(C.decode[0], C.transcode[0], p)
        g = this.lerp(C.decode[1], C.transcode[1], p)
        b = this.lerp(C.decode[2], C.transcode[2], p)
      }
    } else if (progress < 0.9) {
      if (this.isHighFreq) {
        targetAlpha = 0; targetSize = 0
        targetX = 0; targetY = 0; targetZ = 0
        r = 0; g = 0; b = 0
      } else {
        targetX = this.nx * (width * 0.25)
        targetY = this.ny * (height * 0.25)
        targetZ = (Math.sin(this.gridX * 0.5 + progress * 20) + Math.cos(this.gridY * 0.5 + progress * 20)) * 100 + 100
        targetSize = this.baseSize * 1.5
        targetRot = 0
        ;[r, g, b] = C.transcode
      }
    } else {
      const p = easeInOutQuart((progress - 0.9) / 0.1)
      const startX = this.isHighFreq ? spreadX : this.nx * (width * 0.25)
      const startY = this.isHighFreq ? spreadY : this.ny * (height * 0.25)
      const startZ = this.isHighFreq ? -500 : 100
      targetX = this.lerp(startX, this.nx * 50, p)
      targetY = this.lerp(startY, this.ny * 50, p)
      targetZ = this.lerp(startZ, this.randomDepth * 1.5, p)
      targetSize = this.lerp(this.isHighFreq ? 0 : this.baseSize * 1.5, this.baseSize * (Math.random() * 0.5 + 0.5), p)
      targetRot = this.lerp(0, this.randomDepth * 0.01, p)
      const startColor = this.isHighFreq ? C.crop : C.transcode
      r = this.lerp(startColor[0], C.raw[0], p)
      g = this.lerp(startColor[1], C.raw[1], p)
      b = this.lerp(startColor[2], C.raw[2], p)
      targetAlpha = this.lerp(this.isHighFreq ? 0 : 1, 1, p)
    }

    this.x += (targetX - this.x) * 0.2
    this.y += (targetY - this.y) * 0.2
    this.z += (targetZ - this.z) * 0.2
    this.size += (targetSize - this.size) * 0.2
    this.rotation += (targetRot - this.rotation) * 0.2
    this.color[0] += (r - this.color[0]) * 0.2
    this.color[1] += (g - this.color[1]) * 0.2
    this.color[2] += (b - this.color[2]) * 0.2
    this.alpha += (targetAlpha - this.alpha) * 0.2
  }

  draw(ctx: CanvasRenderingContext2D, cameraZ: number, time: number, centerX: number, centerY: number) {
    if (this.alpha <= 0.01 || this.size <= 0.1) return

    const camAngle = time * 0.0002
    const cosC = Math.cos(camAngle)
    const sinC = Math.sin(camAngle)
    const rx = this.x * cosC - this.z * sinC
    const rz = this.z * cosC + this.x * sinC
    const ry = this.y

    const fov = 800
    const depth = fov + cameraZ + rz
    if (depth <= 0) return

    const scale = fov / depth
    const screenX = rx * scale + centerX
    const screenY = ry * scale + centerY
    const drawSize = this.size * scale
    const depthFade = Math.max(0.1, Math.min(1, depth / 1500))

    ctx.save()
    ctx.translate(screenX, screenY)
    ctx.rotate(this.rotation)

    const r = this.color[0] | 0
    const g = this.color[1] | 0
    const b = this.color[2] | 0
    const mainAlpha = this.alpha * depthFade

    // Fake glow：双层方块叠加（避开 shadowBlur）
    if (mainAlpha > 0.15 && (r > 100 || g > 100)) {
      const glow1 = drawSize * 0.5
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${mainAlpha * 0.15})`
      ctx.fillRect(-drawSize / 2 - glow1 / 2, -drawSize / 2 - glow1 / 2, drawSize + glow1, drawSize + glow1)
      const glow2 = drawSize * 1.0
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${mainAlpha * 0.05})`
      ctx.fillRect(-drawSize / 2 - glow2 / 2, -drawSize / 2 - glow2 / 2, drawSize + glow2, drawSize + glow2)
    }

    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${mainAlpha})`
    const gap = drawSize * 0.1
    ctx.fillRect(-drawSize / 2 + gap, -drawSize / 2 + gap, drawSize - gap * 2, drawSize - gap * 2)

    if (scale > 0.8 && this.alpha > 0.5) {
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'
      ctx.lineWidth = 1 * scale
      ctx.strokeRect(-drawSize / 2 + gap, -drawSize / 2 + gap, drawSize - gap * 2, drawSize - gap * 2)
    }

    ctx.restore()
  }
}

export type PrepPhase = 'probe' | 'encoding' | 'done' | 'error'

interface Props {
  // 当前 caller 仍传 phase/encoder，保留接口但本组件以自循环动画为主
  phase?: PrepPhase
  encoder?: string | null
}

export default function PrepOverlay(_props: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const subtitleRef = useRef<HTMLDivElement>(null)
  const laserRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const stateRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let width = 0, height = 0, centerX = 0, centerY = 0
    let blocks: Macroblock[] = []
    const cols = 28, rows = 28

    const rebuild = () => {
      blocks = []
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          blocks.push(new Macroblock(x, y, cols, rows, width, height))
        }
      }
    }

    const resize = () => {
      const rect = container.getBoundingClientRect()
      width = canvas.width = rect.width
      height = canvas.height = rect.height
      centerX = width / 2
      centerY = height / 2
      rebuild()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)

    let currentStateText = ''
    let currentTitle = ''

    const setPhaseText = (title: string, subtitle: string) => {
      const t = titleRef.current, s = subtitleRef.current
      if (!t || !s) return
      if (currentTitle !== title) {
        currentTitle = title
        t.style.opacity = '0'
        s.style.opacity = '0'
        setTimeout(() => {
          if (!titleRef.current || !subtitleRef.current) return
          titleRef.current.innerText = title
          subtitleRef.current.innerText = subtitle
          titleRef.current.style.opacity = '1'
          subtitleRef.current.style.opacity = '1'
        }, 400)
      }
    }

    const updateUI = (progress: number) => {
      const laser = laserRef.current
      let newState = ''
      if (progress < 0.1 || progress > 0.9) {
        setPhaseText('原始视频', '[ HEVC 流 · 浏览器不支持直接播放 ]')
        if (laser) laser.style.opacity = '0'
        newState = '状态: 读取源文件'
      } else if (progress < 0.4) {
        setPhaseText('硬件解码', '[ GPU 还原视频帧 ]')
        if (laser) laser.style.opacity = '0'
        newState = '状态: 硬件解码中 (HEVC)'
      } else if (progress < 0.6) {
        setPhaseText('重新编码', '[ 转换为 H.264 ]')
        const p = (progress - 0.4) / 0.2
        if (laser) {
          laser.style.opacity = '0.8'
          laser.style.top = `${p * 100}%`
        }
        newState = '状态: 编码 H.264\n操作: 量化压缩'
      } else {
        setPhaseText('封装输出', '[ 写入 MP4· 即将就绪 ]')
        if (laser) laser.style.opacity = '0'
        newState = '状态: 写入 MP4 容器\n输出: 已就绪'
      }
      if (newState !== currentStateText) {
        currentStateText = newState
        if (stateRef.current) stateRef.current.innerText = newState
      }
    }

    const updateTime = () => {
      const now = new Date()
      const ms = now.getMilliseconds().toString().padStart(3, '0')
      if (timeRef.current) {
        timeRef.current.textContent = now.toLocaleTimeString('en-US', { hour12: false }) + '.' + ms
      }
    }

    const drawGrid = (time: number) => {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = 'rgba(0, 255, 204, 0.03)'
      ctx.lineWidth = 1
      const gridSize = 50
      const offset = (time * 0.05) % gridSize
      ctx.beginPath()
      for (let x = offset; x < width; x += gridSize) { ctx.moveTo(x, 0); ctx.lineTo(x, height) }
      for (let y = offset; y < height; y += gridSize) { ctx.moveTo(0, y); ctx.lineTo(width, y) }
      ctx.stroke()
    }

    const startTime = Date.now()
    let raf = 0

    const animate = () => {
      const now = Date.now()
      const elapsed = (now - startTime) % LOOP_DURATION
      const progress = elapsed / LOOP_DURATION

      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = C.bg
      ctx.fillRect(0, 0, width, height)
      ctx.globalCompositeOperation = 'screen'

      updateUI(progress)
      updateTime()

      let cameraZ = 0
      if (progress < 0.1) cameraZ = -300
      else if (progress > 0.6 && progress < 0.9) cameraZ = 150

      blocks.sort((a, b) => b.z - a.z)
      for (let i = 0; i < blocks.length; i++) {
        blocks[i].update(progress, width, height)
        blocks[i].draw(ctx, cameraZ, now, centerX, centerY)
      }

      drawGrid(now)
      raf = requestAnimationFrame(animate)
    }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute', inset: 0, overflow: 'hidden',
        background: '#020202',
        fontFamily: '"Courier New", Courier, monospace',
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

      {/* 顶部数据流 HUD */}
      <div style={{
        position: 'absolute', top: '5%', left: '5%',
        color: 'rgba(255,255,255,0.3)',
        fontSize: 12, letterSpacing: 2, lineHeight: 1.5,
        whiteSpace: 'pre-line',
        pointerEvents: 'none',
      }}>
        系统时间: <span ref={timeRef} /><br />
        <span ref={stateRef}>状态: 准备转封 H.264 ...</span>
      </div>

      {/* 激光扫描线 */}
      <div ref={laserRef} style={{
        position: 'absolute',
        width: '100%', height: 3,
        background: 'linear-gradient(90deg, transparent 0%, #ff0055 50%, transparent 100%)',
        boxShadow: '0 0 20px #ff0055, 0 0 40px #ff0055',
        top: '-10%', opacity: 0,
        zIndex: 5, mixBlendMode: 'screen',
        pointerEvents: 'none',
      }} />

      {/* 中下方阶段标题 */}
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        justifyContent: 'center', alignItems: 'center',
        pointerEvents: 'none', zIndex: 10,
      }}>
        <div style={{ position: 'absolute', bottom: '12%', textAlign: 'center' }}>
          <div ref={titleRef} style={{
            color: '#fff', fontSize: 28, letterSpacing: 15,
            fontWeight: 'bold', opacity: 0,
            transition: 'opacity 0.4s ease',
            textShadow: '0 0 10px rgba(255,255,255,0.5)',
            marginBottom: 10,
          }} />
          <div ref={subtitleRef} style={{
            color: '#00ffcc', fontSize: 14, letterSpacing: 8,
            opacity: 0,
            transition: 'opacity 0.4s ease',
            textShadow: '0 0 5px rgba(0,255,204,0.5)',
          }} />
        </div>
      </div>
    </div>
  )
}
