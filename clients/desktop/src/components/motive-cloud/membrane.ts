// ══════════════════════════════════════════════
// 共振膜 —— 动机云的舞台
//   · 一张二维弹性膜（离散波动方程），画成一片极细的点阵
//   · 敲一下（drop）就有真实的波向外传播、叠加、干涉，边缘一圈海绵层吸波不反弹
//   · 波峰偏冷灰、波谷偏暗琥珀：两道波相遇时是冷暖交织的干涉纹
//   · 点阵沿坡度微微位移，像透过水面看到的折射光
// ══════════════════════════════════════════════

/** 格距（px）：越小越细腻、越费 CPU */
const CELL = 13
/** 波速²（稳定条件 < 0.5）；实际传播约 √C2·CELL·60 ≈ 430 px/s */
const C2 = 0.3
/** 每步能量保留：越接近 1 余波越长（太长会让多个持续声源把整片膜灌满、变成噪点） */
const DAMP = 0.986
/** 边缘海绵层厚度（格）与强度：吸掉撞墙的波，避免格子状反射纹 */
const SPONGE = 7
const SPONGE_DAMP = 0.86
/** 固定步长（秒）：与帧率解耦 */
const STEP_DT = 1 / 60
/** 点阵沿坡度的位移系数（px / 单位坡度） */
const REFRACT = 5.5
/** 亮度分档数：同档合并成一个 Path2D 一次填充 */
const LEVELS = 10

const REST: readonly [number, number, number] = [46, 55, 66]     // #2E3742 静止（要看得见膜，才立得住"共振"）
const CREST: readonly [number, number, number] = [176, 190, 203] // #B0BECB 波峰
const TROUGH: readonly [number, number, number] = [154, 118, 80] // #9A7650 波谷

function mix(a: readonly number[], b: readonly number[], t: number): string {
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`
}

const CREST_COLORS = Array.from({ length: LEVELS }, (_, i) => mix(REST, CREST, (i + 1) / LEVELS))
const TROUGH_COLORS = Array.from({ length: LEVELS }, (_, i) => mix(REST, TROUGH, (i + 1) / LEVELS))
const REST_COLOR = mix(REST, REST, 0)

/** 点阵避让区（画布坐标） */
export interface KeepOut { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

export class Membrane {
  private cols = 0
  private rows = 0
  private cur = new Float32Array(0)
  private prev = new Float32Array(0)
  private damp = new Float32Array(0)
  private acc = 0

  get width(): number { return (this.cols - 1) * CELL }
  get height(): number { return (this.rows - 1) * CELL }

  resize(w: number, h: number): void {
    const cols = Math.max(2, Math.ceil(w / CELL) + 1)
    const rows = Math.max(2, Math.ceil(h / CELL) + 1)
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.cur = new Float32Array(cols * rows)
    this.prev = new Float32Array(cols * rows)
    this.damp = new Float32Array(cols * rows)
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const edge = Math.min(i, j, cols - 1 - i, rows - 1 - j)
        const k = edge >= SPONGE ? 1 : SPONGE_DAMP + (1 - SPONGE_DAMP) * (edge / SPONGE)
        this.damp[j * cols + i] = DAMP * k
      }
    }
  }

  /** 在 (x,y) 敲一下：amplitude > 0 隆起，< 0 下陷；radius 为高斯半径（格） */
  drop(x: number, y: number, amplitude: number, radius = 1.6): void {
    if (this.cols === 0) return
    const ci = x / CELL
    const cj = y / CELL
    const reach = Math.ceil(radius * 3)
    const i0 = Math.max(1, Math.floor(ci - reach))
    const i1 = Math.min(this.cols - 2, Math.ceil(ci + reach))
    const j0 = Math.max(1, Math.floor(cj - reach))
    const j1 = Math.min(this.rows - 2, Math.ceil(cj + reach))
    const s2 = 2 * radius * radius
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d2 = (i - ci) ** 2 + (j - cj) ** 2
        this.cur[j * this.cols + i] += amplitude * Math.exp(-d2 / s2)
      }
    }
  }

  /**
   * 持续声源：每帧调用，在 (x,y) 按正弦注入能量 → 一圈圈连续外扩的波。
   * 多个频率不同的声源叠在一起，就是膜上缓慢流动的干涉纹。
   */
  vibrate(x: number, y: number, amplitude: number, hz: number, phase: number, t: number, dt: number): void {
    this.drop(x, y, amplitude * Math.sin(Math.PI * 2 * hz * t + phase) * dt * 60, 1.3)
  }

  /** 推进 dt 秒（内部固定步长，一帧最多补 3 步防卡顿后爆算） */
  advance(dt: number): void {
    this.acc = Math.min(this.acc + dt, STEP_DT * 3)
    while (this.acc >= STEP_DT) {
      this.stepOnce()
      this.acc -= STEP_DT
    }
  }

  private stepOnce(): void {
    const { cols, rows, cur, prev, damp } = this
    for (let j = 1; j < rows - 1; j++) {
      const row = j * cols
      for (let i = 1; i < cols - 1; i++) {
        const k = row + i
        const lap = cur[k - 1] + cur[k + 1] + cur[k - cols] + cur[k + cols] - 4 * cur[k]
        prev[k] = (2 * cur[k] - prev[k] + C2 * lap) * damp[k]
      }
    }
    // prev 里现在是下一帧 → 交换
    this.prev = cur
    this.cur = prev
  }

  /** 画点阵。keepOut 里的矩形不画点：给文字留一块干净的底，点阵在字周围让开 */
  render(ctx: CanvasRenderingContext2D, keepOut: readonly KeepOut[] = []): void {
    const { cols, rows, cur } = this
    const crest = Array.from({ length: LEVELS }, () => new Path2D())
    const trough = Array.from({ length: LEVELS }, () => new Path2D())
    const rest = new Path2D()
    for (let j = 1; j < rows - 1; j++) {
      const row = j * cols
      for (let i = 1; i < cols - 1; i++) {
        const k = row + i
        const h = cur[k]
        const gx = (cur[k + 1] - cur[k - 1]) * 0.5
        const gy = (cur[k + cols] - cur[k - cols]) * 0.5
        const x = i * CELL + gx * REFRACT
        const y = j * CELL + gy * REFRACT
        let covered = false
        for (const b of keepOut) {
          if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) { covered = true; break }
        }
        if (covered) continue
        const mag = Math.abs(h)
        if (mag < 0.03) {
          rest.rect(x - 0.65, y - 0.65, 1.3, 1.3)
          continue
        }
        const lvl = Math.min(LEVELS - 1, Math.floor(Math.min(1, mag * 0.95) * LEVELS))
        const size = 1.3 + (lvl / LEVELS) * 1.6
        ;(h > 0 ? crest : trough)[lvl].rect(x - size / 2, y - size / 2, size, size)
      }
    }
    ctx.fillStyle = REST_COLOR
    ctx.fill(rest)
    for (let l = 0; l < LEVELS; l++) {
      ctx.fillStyle = CREST_COLORS[l]
      ctx.fill(crest[l])
      ctx.fillStyle = TROUGH_COLORS[l]
      ctx.fill(trough[l])
    }
  }
}
