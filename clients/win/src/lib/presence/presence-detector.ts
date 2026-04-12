// ══════════════════════════════════════════════
// PresenceDetector — MediaPipe 人脸检测（滑动窗口模式）
// 维护最近 WINDOW_MS 内的检测时间戳，每 EVAL_INTERVAL_MS 评估一次
// 窗口内检测到 >= MIN_PRESENT_COUNT 次人脸 → present，否则 absent
// ══════════════════════════════════════════════

import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'
import type { Detection } from '@mediapipe/tasks-vision'

export type PresenceState = 'present' | 'absent' | 'unknown'

export interface FaceBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly score: number
}

export interface PresenceEvent {
  readonly state: PresenceState
  readonly durationSeconds: number
  readonly confidence: number | null
  readonly changed: boolean
  readonly faces: readonly FaceBox[]
  readonly isPeriod: boolean    // true = 需要写 DB（状态变化 或 定期延长）
}

export type PresenceCallback = (event: PresenceEvent) => void

const WINDOW_MS           = 15_000  // 滑动窗口长度
const DETECT_INTERVAL_MS  = 200     // 人脸检测频率
const EVAL_INTERVAL_MS    = 1_000   // 状态评估频率（每秒）
const EXTEND_INTERVAL_MS  = 15_000  // 同状态时 DB span 延长间隔
const ABSENT_DEBOUNCE_MS  = 15_000  // absent 防抖：连续缺席满此时长才真正切换（< 此值算在席）
const MIN_CONFIDENCE      = 0.40
const MIN_PRESENT_COUNT   = 3       // 窗口内检测到 >= 3 次即视为在席

export class PresenceDetector {
  private detector: FaceDetector | null = null
  private videoEl: HTMLVideoElement | null = null
  private stream: MediaStream | null = null
  private detectIntervalId: ReturnType<typeof setInterval> | null = null
  private evalIntervalId:   ReturnType<typeof setInterval> | null = null
  private stopped = false   // 防止 stop() 后 async start() 继续创建 interval

  private currentState: PresenceState = 'unknown'
  private stateStartTime = Date.now()
  private lastExtendTime = 0
  private firstPresentSeen = false   // 启动后首次 present 之前，不写 absent

  // absent 防抖：记录"评估为 absent"的起始时刻，满 ABSENT_DEBOUNCE_MS 才真正切换
  private absentSinceMs: number | null = null

  // 滑动窗口：记录每次检测到人脸的时间戳
  private detectionTimestamps: number[] = []

  private lastFaces: FaceBox[] = []
  private lastFrameTime = 0
  private lastVideoTime  = -1   // 用于检测视频画面是否卡住
  private startTime      = 0    // 用于预热期（第一个窗口内不写 DB）

  private readonly callback: PresenceCallback

  constructor(callback: PresenceCallback) {
    this.callback = callback
  }

  async init(): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
    this.detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: '/mediapipe/blaze_face_short_range.tflite',
        delegate: 'CPU',
      },
      runningMode: 'VIDEO',
      minDetectionConfidence: MIN_CONFIDENCE,
      minSuppressionThreshold: 0.3,
    })
  }

  async start(videoEl: HTMLVideoElement): Promise<void> {
    this.stopped = false
    if (!this.detector) await this.init()
    if (this.stopped) return   // stop() 在 init 期间被调用

    this.videoEl = videoEl
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: 'user' },
      audio: false,
    })
    if (this.stopped) { this.stream.getTracks().forEach(t => t.stop()); return }

    videoEl.srcObject = this.stream
    await new Promise<void>((resolve) => {
      videoEl.onloadedmetadata = () => { videoEl.play(); resolve() }
    })
    if (this.stopped) return   // stop() 在 video 加载期间被调用

    this.detectionTimestamps = []
    this.lastExtendTime   = Date.now()
    this.lastVideoTime    = -1
    this.startTime        = Date.now()
    this.firstPresentSeen = false
    this.absentSinceMs    = null

    // 检测循环：每 200ms 抓一帧，推送人脸框给预览窗口
    this.detectIntervalId = setInterval(() => this.detect(), DETECT_INTERVAL_MS)

    // 评估循环：每秒基于滑动窗口判断状态
    this.evalIntervalId = setInterval(() => this.evaluate(), EVAL_INTERVAL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.detectIntervalId) { clearInterval(this.detectIntervalId); this.detectIntervalId = null }
    if (this.evalIntervalId)   { clearInterval(this.evalIntervalId);   this.evalIntervalId   = null }
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
    this.videoEl = null
    this.currentState = 'unknown'
    this.lastFaces = []
    this.detectionTimestamps = []
  }

  private detect(): void {
    if (!this.detector || !this.videoEl) return
    if (this.videoEl.readyState < 2) return

    // 视频画面卡住（currentTime 不推进）→ 跳过，不计入检测
    const currentTime = this.videoEl.currentTime
    if (currentTime === this.lastVideoTime) return
    this.lastVideoTime = currentTime

    const nowMs = performance.now()
    if (nowMs === this.lastFrameTime) return
    this.lastFrameTime = nowMs

    let result
    try {
      result = this.detector.detectForVideo(this.videoEl, nowMs)
    } catch { return }

    const detections: Detection[] = result.detections ?? []
    const faces: FaceBox[] = detections
      .map(d => {
        const bb = d.boundingBox
        const score = d.categories?.[0]?.score ?? 0
        if (!bb || score < MIN_CONFIDENCE) return null
        return { x: bb.originX, y: bb.originY, width: bb.width, height: bb.height, score }
      })
      .filter((f): f is FaceBox => f !== null)

    this.lastFaces = faces

    // 有人脸 → 记录时间戳
    if (faces.length > 0) {
      this.detectionTimestamps.push(Date.now())
    }

    // 实时推送人脸框（供预览窗口，不写 DB）
    this.callback({
      state: this.currentState,
      durationSeconds: Math.floor((Date.now() - this.stateStartTime) / 1000),
      confidence: faces[0]?.score ?? null,
      changed: false,
      faces,
      isPeriod: false,
    })
  }

  private evaluate(): void {
    const now = Date.now()

    // 预热期：第一个完整窗口内不写 DB，等数据积累充足
    if (now - this.startTime < WINDOW_MS) return

    const cutoff = now - WINDOW_MS

    // 裁剪滑动窗口：只保留最近 15s 的时间戳
    this.detectionTimestamps = this.detectionTimestamps.filter(t => t > cutoff)

    const count = this.detectionTimestamps.length
    const rawAbsent = count < MIN_PRESENT_COUNT

    // ── absent 防抖 ──
    // present：立即响应，清除防抖计时
    // absent：需持续缺席 ABSENT_DEBOUNCE_MS 才切换，短暂离开仍视为 present
    if (!rawAbsent) {
      this.absentSinceMs = null  // 检测到人脸，重置防抖
    } else if (this.absentSinceMs === null) {
      this.absentSinceMs = now   // 开始计防抖
    }

    const debounced = rawAbsent && (now - (this.absentSinceMs ?? now)) >= ABSENT_DEBOUNCE_MS
    const newState: PresenceState = (!rawAbsent) ? 'present' : debounced ? 'absent' : this.currentState

    // 启动后尚未见到首次 present：跳过 absent，等待用户被检测到
    if (newState === 'present') this.firstPresentSeen = true
    if (newState === 'absent' && !this.firstPresentSeen) return
    // 防抖期间维持当前状态，不写 DB
    if (newState === this.currentState && rawAbsent && !debounced) return

    const changed = newState !== this.currentState

    if (changed) {
      this.currentState   = newState
      this.stateStartTime = now
      this.lastExtendTime = now
      // 状态变化 → 立刻写 DB
      this.callback({
        state: newState,
        durationSeconds: 0,
        confidence: this.lastFaces[0]?.score ?? null,
        changed: true,
        faces: this.lastFaces,
        isPeriod: true,
      })
    } else if (now - this.lastExtendTime >= EXTEND_INTERVAL_MS) {
      // 状态未变，每 15s 延长一次 DB span
      this.lastExtendTime = now
      this.callback({
        state: this.currentState,
        durationSeconds: Math.floor((now - this.stateStartTime) / 1000),
        confidence: this.lastFaces[0]?.score ?? null,
        changed: false,
        faces: this.lastFaces,
        isPeriod: true,
      })
    }
  }

  get state(): PresenceState { return this.currentState }
  get currentDurationSeconds(): number { return Math.floor((Date.now() - this.stateStartTime) / 1000) }
  get latestFaces(): readonly FaceBox[] { return this.lastFaces }
}
