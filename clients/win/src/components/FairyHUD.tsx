// ══════════════════════════════════════════════
// Fairy HUD — 完整复刻自 Fairy_HUD 设计稿
// 水滴涟漪 + 眼球追踪 + 陀螺仪 + 音频驱动
// ══════════════════════════════════════════════

import { useEffect, useRef, useMemo } from 'react'

export type FairyState = 'idle' | 'listening' | 'thinking' | 'speaking'

interface Props {
  readonly state: FairyState
  readonly text?: string
}

const styles = `
  .fairy-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .fairy-core {
    position: relative;
    width: 400px;
    height: 400px;
    transform: scale(0.7);
    transform-origin: center center;
    pointer-events: auto;
    cursor: grab;
  }
  .fairy-core:active { cursor: grabbing; }

  /* ===== SPEECH BUBBLE ===== */
  .fairy-bubble {
    position: fixed;
    top: 8px;
    right: 8px;
    max-width: 128px;
    padding: 7px 10px;
    background: rgba(4, 12, 35, 0.88);
    border: 1px solid rgba(50, 130, 220, 0.55);
    border-radius: 10px 10px 10px 2px;
    box-shadow:
      0 0 10px rgba(36, 102, 200, 0.35),
      inset 0 0 8px rgba(0, 0, 0, 0.5);
    pointer-events: none;
    z-index: 10000;
  }
  .fairy-bubble-state {
    font-family: 'Exo 2', sans-serif;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 2px;
    color: rgba(80, 185, 255, 0.95);
    text-shadow: 0 0 6px rgba(36, 140, 255, 0.6);
    margin-bottom: 3px;
  }
  .fairy-bubble-text {
    font-family: 'Exo 2', sans-serif;
    font-size: 9px;
    line-height: 1.45;
    color: rgba(160, 215, 255, 0.75);
    word-break: break-all;
  }

  .abs-center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }

  /* ===== GLOW SYSTEM ===== */

  .layer-glow-halo {
    width: 360px; height: 360px; border-radius: 50%;
    background: radial-gradient(circle,
      transparent 78%,
      rgba(20,65,110,0.06) 80%,
      rgba(36,102,157,0.95) 82.6%,
      rgba(28,82,130,0.45) 86%,
      rgba(15,55,100,0.06) 90%,
      transparent 93%);
    filter: blur(10px); z-index: 0;
  }
  .layer-glow-halo2 {
    width: 350px; height: 350px; border-radius: 50%;
    background: radial-gradient(circle at 48% 46%,
      transparent 77%,
      rgba(25,75,120,0.30) 81%,
      rgba(40,110,165,0.50) 83%,
      rgba(20,68,115,0.12) 87%,
      transparent 91%);
    filter: blur(12px); z-index: 0; opacity: 0.7;
  }
  .layer-glow-ring {
    width: 300px; height: 300px; border-radius: 50%;
    background: radial-gradient(circle,
      transparent 91%,
      rgba(60,140,200,1.00) 95%,
      rgba(30,85,140,0.12) 98%,
      transparent 100%);
    filter: blur(3px); z-index: 0;
  }
  .layer-bg-disc {
    position: absolute;
    width: 280px; height: 280px;
    background: rgb(11,46,104);
    border-radius: 50%; z-index: 5;
  }
  .layer-thin-ring {
    width: 280px; height: 280px;
    border: 2px solid #3d78b9; border-radius: 50%;
    box-shadow:
      inset 0 0 10px rgba(0,0,0,0.5),
      0 0 3px 1px rgba(80,150,200,1.00),
      0 0 8px 3px rgba(50,120,175,0.85),
      0 0 18px 6px rgba(36,102,157,0.40);
    z-index: 10;
  }
  .layer-gyro-wrapper {
    width: 280px; height: 280px; z-index: 20;
    filter: drop-shadow(0 0 8px rgba(36,102,157,0.4));
  }
  .layer-thick-white {
    width: 180px; height: 180px;
    background: #ffffff; border-radius: 50%;
    box-shadow:
      0 0 4px 1px rgba(255,255,255,0.80),
      0 0 12px 4px rgba(60,130,190,0.50),
      0 0 25px 8px rgba(36,102,157,0.18);
    z-index: 30;
  }
  .layer-inner-blue {
    width: 136px; height: 136px;
    background: rgb(166,182,219);
    border-radius: 50%; z-index: 35;
  }
  .layer-boundary-line {
    width: 106px; height: 106px;
    background: rgb(182,216,242);
    border-radius: 50%; z-index: 37;
  }
  .layer-iris {
    width: 100px; height: 100px;
    background: rgb(12,97,162);
    border-radius: 50%; z-index: 40;
  }
  .layer-white-outline {
    width: 74px; height: 74px;
    background: rgb(160,185,220);
    border-radius: 50%; z-index: 43;
  }
  .layer-void {
    width: 70px; height: 70px;
    background: rgb(6,53,120);
    border-radius: 50%;
    box-shadow: inset 0 0 20px #000;
    z-index: 50;
  }
  .pupil-ring { border-radius: 50%; border-style: solid; }
  .pupil-1 { width: 92px; height: 92px; border-width: 1px; border-color: rgba(100,180,255,0.15); }
  .pupil-2 { width: 64px; height: 64px; border-width: 2px; border-color: rgba(100,180,255,0.25); }

  .layer-ball-rotator { width: 0; height: 0; z-index: 60; }
  .fairy-ball {
    width: 44px; height: 44px;
    background: #ffffff; border-radius: 50%;
    transform: translate(-50%, -50%) translateY(-36px);
    box-shadow:
      0 0 15px rgba(255,255,255,0.9),
      0 0 35px rgba(36,102,157,0.8);
  }

`

export default function FairyHUD({ state, text = '' }: Props) {
  // ── Element refs ──
  const gyroRef = useRef<HTMLDivElement>(null)
  const ballRotatorRef = useRef<HTMLDivElement>(null)
  const ballRef = useRef<HTMLDivElement>(null)
  const glowRef = useRef<HTMLDivElement>(null)
  const glowHalo2Ref = useRef<HTMLDivElement>(null)
  const glowRingRef = useRef<HTMLDivElement>(null)
  const thickRingRef = useRef<HTMLDivElement>(null)
  const thinRingRef = useRef<HTMLDivElement>(null)
  const innerBlueRef = useRef<HTMLDivElement>(null)
  const voidRef = useRef<HTMLDivElement>(null)
  const irisRef = useRef<HTMLDivElement>(null)
  const boundaryLineRef = useRef<HTMLDivElement>(null)
  const whiteOutlineRef = useRef<HTMLDivElement>(null)
  const bgDiscRef = useRef<HTMLDivElement>(null)
  const pupilRingsRef = useRef<(HTMLDivElement | null)[]>([])

  // ── Audio refs ──
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)

  const requestRef = useRef<number>(0)
  const stateRef = useRef({
    gyroAngle: 0, gyroSpeed: 0.3, targetGyroSpeed: 0.3,
    ballAngle: 142, ballVelocity: 0,
    glowBase: 0.70, targetGlowBase: 0.70,
    halo2Base: 0.7, targetHalo2Base: 0.7,
    ringBase: 0.75, targetRingBase: 0.75,
    thinBright: 0, targetThinBright: 0,
    audioSmooth: 0, audioPeak: 0, prevRawVol: 0,
    ripples: [] as { time: number; intensity: number }[],
    lastRippleTime: 0,
    eyeCurrentX: 0, eyeCurrentY: 0,
    eyeTargetX: 0, eyeTargetY: 0,
    eyeNextMoveTime: 0,
  })

  // ── Water Droplet Ripple Wave ──
  const dropletWave = (age: number, delay: number): number => {
    const t = (age - delay) / 1000
    if (t < 0) return 0
    if (t < 0.40) {
      const p = t / 0.40
      return -(1 - Math.cos(Math.PI * p)) * 0.5 * 0.40
    }
    if (t < 0.55) return -0.40
    if (t < 0.75) {
      const p = (t - 0.55) / 0.20
      return -0.40 + 1.40 * Math.sin(Math.PI * 0.5 * p)
    }
    if (t < 1.50) {
      const dt = t - 0.75
      return Math.exp(-4.5 * dt) * Math.cos(2 * Math.PI * 1.3 * dt)
    }
    return 0
  }

  // ── Main animation loop ──
  useEffect(() => {
    const loop = () => {
      const s = stateRef.current
      const now = Date.now()
      const tSec = now / 1000

      // State targets
      switch (state) {
        case 'idle':
          s.targetGyroSpeed = 0.3; s.targetGlowBase = 0.70
          s.targetHalo2Base = 0.7; s.targetRingBase = 0.75; s.targetThinBright = 0
          break
        case 'listening':
          s.targetGyroSpeed = -0.6; s.targetGlowBase = 0.80
          s.targetHalo2Base = 0.75; s.targetRingBase = 0.85; s.targetThinBright = 0.4
          break
        case 'thinking':
          s.targetGyroSpeed = 4.5; s.targetGlowBase = 0.75
          s.targetHalo2Base = 0.85; s.targetRingBase = 0.90; s.targetThinBright = 1.0
          break
        case 'speaking':
          s.targetGyroSpeed = 1.2; s.targetGlowBase = 0.80
          s.targetHalo2Base = 0.80; s.targetRingBase = 0.85; s.targetThinBright = 0.5
          break
      }

      // Lerp
      const lr = 0.05
      s.gyroSpeed += (s.targetGyroSpeed - s.gyroSpeed) * lr
      s.glowBase += (s.targetGlowBase - s.glowBase) * lr
      s.halo2Base += (s.targetHalo2Base - s.halo2Base) * lr
      s.ringBase += (s.targetRingBase - s.ringBase) * lr
      s.thinBright += (s.targetThinBright - s.thinBright) * lr

      // Audio analysis
      let rawVol = 0
      if ((state === 'listening' || state === 'speaking') && analyserRef.current) {
        const data = new Uint8Array(analyserRef.current.frequencyBinCount)
        analyserRef.current.getByteFrequencyData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i]
        rawVol = sum / data.length / 255
      }
      s.audioSmooth += (rawVol - s.audioSmooth) * 0.25
      if (rawVol > s.audioPeak) s.audioPeak += (rawVol - s.audioPeak) * 0.6
      else s.audioPeak *= 0.95

      // Onset detection + ripple triggering
      const onset = rawVol > 0.08 && rawVol > s.prevRawVol * 1.15 + 0.015
      s.prevRawVol = rawVol

      if (state === 'listening' && onset && now - s.lastRippleTime > 180) {
        s.ripples.push({ time: now, intensity: Math.min(rawVol * 3.5, 1) })
        s.lastRippleTime = now
      }
      if (state === 'speaking' && onset && now - s.lastRippleTime > 120) {
        s.ripples.push({ time: now, intensity: Math.min(rawVol * 4.5, 1) })
        s.lastRippleTime = now
      }
      if ((state === 'listening' || state === 'speaking') && now - s.lastRippleTime > 2000) {
        s.ripples.push({ time: now, intensity: 0.5 })
        s.lastRippleTime = now
      }
      s.ripples = s.ripples.filter(r => now - r.time < 2000)

      // Wave computation
      const stateMul = state === 'listening' ? 2.0 : state === 'speaking' ? 3.0 : 1.0
      const computeWave = (delay: number, amp: number): number => {
        if (state === 'idle' || state === 'thinking') {
          return dropletWave(now % 2500, delay) * amp
        }
        let total = 0
        for (const rip of s.ripples) {
          total += dropletWave(now - rip.time, delay) * rip.intensity
        }
        return total * amp * stateMul
      }

      const wVoid = computeWave(0, 0.08)
      const wIris = computeWave(70, 0.07)
      const wInnerBlue = computeWave(140, 0.055)
      const wThickWht = computeWave(170, 0.045)
      const wThinRing = computeWave(260, 0.03)
      const wGlowRing = computeWave(320, 0.05)
      const wGlowHalo = computeWave(380, 0.04)

      // Ball organic float
      const ballDrift = Math.sin(tSec * 0.3) * 4 + Math.sin(tSec * 0.47) * 2.5 + Math.sin(tSec * 0.71) * 1.5
      s.ballAngle = 142 + ballDrift

      // Saccade-fixation eye model
      let eyeX = 0, eyeY = 0
      if (state === 'listening') {
        if (now > s.eyeNextMoveTime) {
          const angle = Math.random() * Math.PI * 2
          const radius = 18 + Math.random() * 25
          s.eyeTargetX = Math.cos(angle) * radius * 1.3
          s.eyeTargetY = Math.sin(angle) * radius * 0.8
          s.eyeNextMoveTime = now + 600 + Math.random() * 1400
        }
        s.eyeCurrentX += (s.eyeTargetX - s.eyeCurrentX) * 0.15
        s.eyeCurrentY += (s.eyeTargetY - s.eyeCurrentY) * 0.15
        eyeX = s.eyeCurrentX; eyeY = s.eyeCurrentY
      } else {
        s.eyeCurrentX *= 0.92; s.eyeCurrentY *= 0.92
        eyeX = s.eyeCurrentX; eyeY = s.eyeCurrentY
      }

      // Gyroscope
      let effectiveGyroSpeed = s.gyroSpeed
      if (state === 'speaking') effectiveGyroSpeed += s.audioPeak * 1.5
      s.gyroAngle = (s.gyroAngle + effectiveGyroSpeed) % 360

      // Apply transforms
      const set = (ref: React.RefObject<HTMLDivElement | null>, transform: string, extra?: Record<string, string>) => {
        if (!ref.current) return
        ref.current.style.transform = transform
        if (extra) for (const [k, v] of Object.entries(extra)) (ref.current.style as any)[k] = v
      }

      set(gyroRef, `translate(-50%,-50%) rotate(${s.gyroAngle}deg)`)

      set(ballRotatorRef, `translate(-50%,-50%) translate(${eyeX}px,${eyeY}px) rotate(${s.ballAngle}deg)`)

      if (ballRef.current) {
        let bScale = 1.0 + wVoid
        if (state === 'listening') bScale += s.audioPeak * 0.08
        else if (state === 'speaking') bScale += s.audioPeak * 0.15
        ballRef.current.style.transform = `translate(-50%,-50%) translateY(-36px) scale(${bScale}) rotate(${-s.ballAngle}deg)`
      }

      set(voidRef, `translate(-50%,-50%) translate(${eyeX}px,${eyeY}px) scale(${(1 + wVoid).toFixed(4)})`)
      set(whiteOutlineRef, `translate(-50%,-50%) translate(${eyeX}px,${eyeY}px) scale(${(1 + wVoid).toFixed(4)})`)

      const irScale = 1 + wIris
      const irisT = `translate(-50%,-50%) translate(${eyeX}px,${eyeY}px) scale(${irScale.toFixed(4)})`
      set(irisRef, irisT)
      set(boundaryLineRef, irisT)

      set(innerBlueRef, `translate(-50%,-50%) translate(${eyeX * 0.95}px,${eyeY * 0.95}px) scale(${(1 + wInnerBlue).toFixed(4)})`)
      set(thickRingRef, `translate(-50%,-50%) translate(${eyeX * 0.45}px,${eyeY * 0.45}px) scale(${(1 + wThickWht).toFixed(4)})`)

      pupilRingsRef.current.forEach((ring) => {
        if (!ring) return
        ring.style.transform = `translate(-50%,-50%) translate(${eyeX}px,${eyeY}px) scale(${(1 + wVoid).toFixed(4)})`
      })

      // Thin ring + bg disc
      const tScale = 1 + wThinRing
      set(thinRingRef, `translate(-50%,-50%) translate(${eyeX * 0.4}px,${eyeY * 0.4}px) scale(${tScale.toFixed(4)})`)
      set(bgDiscRef, `translate(-50%,-50%) translate(${eyeX * 0.4}px,${eyeY * 0.4}px) scale(${tScale.toFixed(4)})`)

      // Glow opacities
      if (glowRingRef.current) {
        let ringOp = s.ringBase + wGlowRing * 5
        if (state === 'listening') ringOp += s.audioSmooth * 0.15
        if (state === 'speaking') ringOp += s.audioSmooth * 0.25
        glowRingRef.current.style.opacity = String(Math.min(1, ringOp).toFixed(3))
        glowRingRef.current.style.transform = `translate(-50%,-50%) translate(${eyeX * 0.2}px,${eyeY * 0.2}px) scale(${(1 + wGlowRing).toFixed(4)})`
      }
      if (glowRef.current) {
        let haloOp = s.glowBase + wGlowHalo * 4
        if (state === 'speaking') haloOp += s.audioSmooth * 0.2
        glowRef.current.style.opacity = String(Math.min(1, haloOp).toFixed(3))
        glowRef.current.style.transform = `translate(-50%,-50%) translate(${eyeX * 0.1}px,${eyeY * 0.1}px) scale(${(1 + wGlowHalo).toFixed(4)})`
      }
      if (glowHalo2Ref.current) {
        let h2Op = s.halo2Base + wGlowHalo * 3
        glowHalo2Ref.current.style.opacity = String(Math.min(1, h2Op).toFixed(3))
        glowHalo2Ref.current.style.transform = `translate(-50%,-50%) translate(${eyeX * 0.1}px,${eyeY * 0.1}px) scale(${(1 + wGlowHalo * 0.8).toFixed(4)})`
      }

      requestRef.current = requestAnimationFrame(loop)
    }

    requestRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(requestRef.current)
  }, [state])

  // ── Audio: mic for listening ──
  useEffect(() => {
    if (state === 'listening') {
      startMic()
    } else {
      stopAudio()
    }
    return () => stopAudio()
  }, [state])

  const startMic = async () => {
    stopAudio()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      audioCtxRef.current = new AudioContext()
      analyserRef.current = audioCtxRef.current.createAnalyser()
      analyserRef.current.fftSize = 256
      sourceRef.current = audioCtxRef.current.createMediaStreamSource(stream)
      sourceRef.current.connect(analyserRef.current)
    } catch {
      // mic not available — fairy still animates without audio input
    }
  }

  const stopAudio = () => {
    if (sourceRef.current) {
      sourceRef.current.mediaStream.getTracks().forEach(t => t.stop())
      sourceRef.current.disconnect()
      sourceRef.current = null
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close()
    }
    audioCtxRef.current = null
    analyserRef.current = null
  }

  const handleDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().startDragging()
    })
  }

  const stateLabel =
    state === 'listening' ? '正在聆听' :
    state === 'thinking'  ? '思考中'   :
    state === 'speaking'  ? '回应中'   : ''

  const bubbleText = state === 'speaking' && text
    ? text.slice(0, 80) + (text.length > 80 ? '…' : '')
    : ''

  return (
    <div className="fairy-overlay">
      <style>{styles}</style>
      {state !== 'idle' && (
        <div className="fairy-bubble">
          <div className="fairy-bubble-state">{stateLabel}</div>
          {bubbleText && <div className="fairy-bubble-text">{bubbleText}</div>}
        </div>
      )}
      <div className="fairy-core" onMouseDown={handleDrag}>
        <div ref={glowRef} className="abs-center layer-glow-halo" />
        <div ref={glowHalo2Ref} className="abs-center layer-glow-halo2" />
        <div ref={glowRingRef} className="abs-center layer-glow-ring" />
        <div ref={bgDiscRef} className="abs-center layer-bg-disc" />
        <div ref={thinRingRef} className="abs-center layer-thin-ring" />
        <div ref={gyroRef} className="abs-center layer-gyro-wrapper">
          <svg width="280" height="280" viewBox="0 0 340 340" style={{ display: 'block' }}>
            <path
              d="M 151.7 27.4 L 170 5 L 188.3 27.4
                 A 145 145 0 0 1 312.6 151.7
                 L 335 170 L 312.6 188.3
                 A 145 145 0 0 1 188.3 312.6
                 L 170 335 L 151.7 312.6
                 A 145 145 0 0 1 27.4 188.3
                 L 5 170 L 27.4 151.7
                 A 145 145 0 0 1 151.7 27.4 Z"
              fill="rgb(7,22,72)"
            />
          </svg>
        </div>
        <div ref={thickRingRef} className="abs-center layer-thick-white" />
        <div ref={innerBlueRef} className="abs-center layer-inner-blue" />
        <div ref={boundaryLineRef} className="abs-center layer-boundary-line" />
        <div ref={irisRef} className="abs-center layer-iris" />
        <div ref={whiteOutlineRef} className="abs-center layer-white-outline" />
        <div ref={voidRef} className="abs-center layer-void" />
        <div ref={el => { pupilRingsRef.current[0] = el }} className="abs-center pupil-ring pupil-1" />
        <div ref={el => { pupilRingsRef.current[1] = el }} className="abs-center pupil-ring pupil-2" />
        <div ref={ballRotatorRef} className="abs-center layer-ball-rotator">
          <div ref={ballRef} className="abs-center fairy-ball" />
        </div>
      </div>
    </div>
  )
}
