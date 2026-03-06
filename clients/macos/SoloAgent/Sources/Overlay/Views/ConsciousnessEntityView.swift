import SwiftUI

// MARK: - Fairy Eye Engine

private final class FairyEngine {
    var lastDate: Date?
    var totalTimeMs: Double = 0

    // ── Gyroscope ──
    var gyroAngle: Double = 0
    var gyroSpeed: Double = 0.3
    var targetGyroSpeed: Double = 0.3

    // ── Ball ──
    var ballAngle: Double = 142

    // ── Base values (lerped) ──
    var glowBase: Double = 0.70
    var targetGlowBase: Double = 0.70
    var halo2Base: Double = 0.7
    var targetHalo2Base: Double = 0.7
    var ringBase: Double = 0.75
    var targetRingBase: Double = 0.75
    var thinBright: Double = 0
    var targetThinBright: Double = 0

    // ── Ripple ──
    struct Ripple { let time: Double; let intensity: Double }
    var ripples: [Ripple] = []
    var lastRippleTime: Double = 0

    // ── Eye saccade ──
    var eyeX: Double = 0
    var eyeY: Double = 0
    var eyeTargetX: Double = 0
    var eyeTargetY: Double = 0
    var eyeNextMoveTime: Double = 0

    // ── Wave per layer ──
    var wVoid: Double = 0
    var wIris: Double = 0
    var wInnerBlue: Double = 0
    var wThickWht: Double = 0
    var wThinRing: Double = 0
    var wGlowRing: Double = 0
    var wGlowHalo: Double = 0

    // ── Audio analysis ──
    var audioSmooth: Double = 0   // 低通滤波后的音量
    var audioPeak: Double = 0     // 快攻慢衰峰值
    var prevRawVol: Double = 0    // 上帧音量（用于 onset 检测）

    // ── Display opacity (每帧主动检测，不依赖 onChange / onFinish 回调) ──
    var idleSince: Date? = nil
    var displayOpacity: Double = 0

    // MARK: Droplet wave
    private func dropletWave(age: Double, delay: Double) -> Double {
        let t = (age - delay) / 1000
        guard t >= 0 else { return 0 }
        if t < 0.40 { let p = t / 0.40; return -(1 - cos(.pi * p)) * 0.5 * 0.40 }
        if t < 0.55 { return -0.40 }
        if t < 0.75 { let p = (t - 0.55) / 0.20; return -0.40 + 1.40 * sin(.pi * 0.5 * p) }
        if t < 1.50 { let d = t - 0.75; return exp(-4.5 * d) * cos(2 * .pi * 1.3 * d) }
        return 0
    }

    // MARK: Tick
    func tick(dt: Double, state: ConsciousnessEntityView.EntityState, audioLevel: Float, active: Bool) {
        totalTimeMs += dt * 1000
        let now = totalTimeMs
        let tSec = now / 1000

        // ── State targets ──
        switch state {
        case .idle:
            targetGyroSpeed = 0.3
            targetGlowBase = 0.70; targetHalo2Base = 0.7
            targetRingBase = 0.75; targetThinBright = 0
        case .listening:
            targetGyroSpeed = -0.6
            targetGlowBase = 0.80; targetHalo2Base = 0.75
            targetRingBase = 0.85; targetThinBright = 0.4
        case .thinking:
            targetGyroSpeed = 4.5
            targetGlowBase = 0.75; targetHalo2Base = 0.85
            targetRingBase = 0.90; targetThinBright = 1.0
        case .speaking:
            targetGyroSpeed = 1.2
            targetGlowBase = 0.80; targetHalo2Base = 0.80
            targetRingBase = 0.85; targetThinBright = 0.5
        }

        // ── Lerp ──
        let lr = min(1.0, 3.0 * dt)
        gyroSpeed += (targetGyroSpeed - gyroSpeed) * lr
        glowBase += (targetGlowBase - glowBase) * lr
        halo2Base += (targetHalo2Base - halo2Base) * lr
        ringBase += (targetRingBase - ringBase) * lr
        thinBright += (targetThinBright - thinBright) * lr

        // ── Display opacity: 每帧直接检测，不依赖任何回调 ──
        if active {
            idleSince = nil
            displayOpacity = min(1, displayOpacity + dt * 4) // ~0.25s 淡入
        } else {
            if idleSince == nil { idleSince = Date() }
            let idleSec = Date().timeIntervalSince(idleSince!)
            if idleSec > 2.0 {
                displayOpacity = max(0, displayOpacity - dt * 1.5) // ~0.7s 淡出
            }
        }

        // ── Audio analysis (移植自 App.tsx) ──
        let rawVol = Double(audioLevel)
        audioSmooth += (rawVol - audioSmooth) * 0.25
        if rawVol > audioPeak { audioPeak += (rawVol - audioPeak) * 0.6 }
        else { audioPeak *= 0.95 }
        // Onset detection: 音量突增
        let onset = rawVol > 0.08 && rawVol > prevRawVol * 1.15 + 0.015
        prevRawVol = rawVol

        // ── Ripple triggering ──
        if state == .listening && onset && now - lastRippleTime > 180 {
            ripples.append(Ripple(time: now, intensity: min(rawVol * 3.5, 1)))
            lastRippleTime = now
        }
        if state == .speaking && onset && now - lastRippleTime > 120 {
            ripples.append(Ripple(time: now, intensity: min(rawVol * 4.5, 1)))
            lastRippleTime = now
        }
        // 2s 无声 fallback
        if (state == .listening || state == .speaking) && now - lastRippleTime > 2000 {
            ripples.append(Ripple(time: now, intensity: 0.5))
            lastRippleTime = now
        }
        ripples.removeAll { now - $0.time > 2000 }

        // ── Compute wave ──
        let stateMul: Double = state == .listening ? 2.0 : state == .speaking ? 3.0 : 1.0
        func wave(_ delay: Double, _ amp: Double) -> Double {
            if state == .idle || state == .thinking {
                return dropletWave(age: now.truncatingRemainder(dividingBy: 2500), delay: delay) * amp
            }
            var total: Double = 0
            for rip in ripples { total += dropletWave(age: now - rip.time, delay: delay) * rip.intensity }
            return total * amp * stateMul
        }
        wVoid      = wave(0,   0.08)
        wIris      = wave(70,  0.07)
        wInnerBlue = wave(140, 0.055)
        wThickWht  = wave(170, 0.045)
        wThinRing  = wave(260, 0.03)
        wGlowRing  = wave(320, 0.05)
        wGlowHalo  = wave(380, 0.04)

        // ── Ball organic float ──
        ballAngle = 142 + sin(tSec * 0.3) * 4 + sin(tSec * 0.47) * 2.5 + sin(tSec * 0.71) * 1.5

        // ── Eye saccade（大幅扫视，水平 ±78px 等效）──
        if state == .listening {
            if now > eyeNextMoveTime {
                let a = Double.random(in: 0 ..< .pi * 2)
                let r = 12.0 + .random(in: 0.0...18.0) // 原 6-20 → 25-60，此处按 0.5 比例换算
                eyeTargetX = cos(a) * r * 1.3
                eyeTargetY = sin(a) * r * 0.8
                eyeNextMoveTime = now + 600 + .random(in: 0.0...1400.0)
            }
            eyeX += (eyeTargetX - eyeX) * 0.15
            eyeY += (eyeTargetY - eyeY) * 0.15
        } else {
            eyeX *= 0.92; eyeY *= 0.92
        }

        // ── Gyroscope（speaking 时音频驱动加速）──
        var speed = gyroSpeed
        if state == .speaking { speed += audioPeak * 1.5 }
        gyroAngle = (gyroAngle + speed).truncatingRemainder(dividingBy: 360)
    }
}

// MARK: - View

struct ConsciousnessEntityView: View {
    @ObservedObject var voiceService: VoiceService

    enum EntityState: Equatable { case idle, listening, thinking, speaking }

    var currentState: EntityState {
        if voiceService.isRecording { return .listening }
        if voiceService.isPlaying { return .speaking }
        if voiceService.isThinking { return .thinking }
        return .idle
    }

    @State private var engine = FairyEngine()

    private let viewSize: CGFloat = 280
    private let S: CGFloat = 0.4 // 700 → 280

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, size in
                let now = timeline.date
                let dt: Double
                if let last = engine.lastDate { dt = min(now.timeIntervalSince(last), 0.05) }
                else { dt = 0.016 }
                engine.lastDate = now
                let active = voiceService.isRecording || voiceService.isPlaying || voiceService.isThinking
                engine.tick(dt: dt, state: currentState, audioLevel: voiceService.audioLevel, active: active)

                let e = engine
                guard e.displayOpacity > 0.005 else { return }
                context.opacity = e.displayOpacity

                let cx = size.width / 2
                let cy = size.height / 2
                let ex = CGFloat(e.eyeX) * S / 0.5 // scale eye offset
                let ey = CGFloat(e.eyeY) * S / 0.5

                func R(_ d: CGFloat, _ ox: CGFloat = 0, _ oy: CGFloat = 0, _ w: Double = 0) -> CGRect {
                    let s = d * S * CGFloat(1 + w)
                    return CGRect(x: cx + ox - s / 2, y: cy + oy - s / 2, width: s, height: s)
                }

                // ═══ L1: Glow Halo（视差 0.1x）═══
                context.drawLayer { ctx in
                    var haloOp = e.glowBase + e.wGlowHalo * 4
                    if currentState == .listening { haloOp += e.audioSmooth * 0.1 }
                    if currentState == .speaking  { haloOp += e.audioSmooth * 0.2 }
                    ctx.opacity = min(1, haloOp)
                    let ox = ex * 0.1; let oy = ey * 0.1
                    let rect = R(460, ox, oy, e.wGlowHalo)
                    ctx.fill(Path(ellipseIn: rect), with: .radialGradient(
                        Gradient(stops: [
                            .init(color: .clear, location: 0.78),
                            .init(color: Color(red: 20/255.0, green: 65/255.0, blue: 110/255.0).opacity(0.06), location: 0.80),
                            .init(color: Color(red: 36/255.0, green: 102/255.0, blue: 157/255.0).opacity(0.95), location: 0.826),
                            .init(color: Color(red: 28/255.0, green: 82/255.0, blue: 130/255.0).opacity(0.45), location: 0.86),
                            .init(color: Color(red: 15/255.0, green: 55/255.0, blue: 100/255.0).opacity(0.06), location: 0.90),
                            .init(color: .clear, location: 0.93),
                        ]),
                        center: CGPoint(x: cx + ox, y: cy + oy), startRadius: 0, endRadius: rect.width / 2
                    ))
                    ctx.addFilter(.blur(radius: 4))
                }

                // ═══ L2: Glow Halo 2（视差 0.1x）═══
                context.drawLayer { ctx in
                    ctx.opacity = min(1, e.halo2Base + e.wGlowHalo * 3) * 0.7
                    let ox = ex * 0.1; let oy = ey * 0.1
                    let rect = R(450, ox, oy, e.wGlowHalo * 0.8)
                    ctx.fill(Path(ellipseIn: rect), with: .radialGradient(
                        Gradient(stops: [
                            .init(color: .clear, location: 0.77),
                            .init(color: Color(red: 25/255.0, green: 75/255.0, blue: 120/255.0).opacity(0.30), location: 0.81),
                            .init(color: Color(red: 40/255.0, green: 110/255.0, blue: 165/255.0).opacity(0.50), location: 0.83),
                            .init(color: Color(red: 20/255.0, green: 68/255.0, blue: 115/255.0).opacity(0.12), location: 0.87),
                            .init(color: .clear, location: 0.91),
                        ]),
                        center: CGPoint(x: cx + ox, y: cy + oy), startRadius: 0, endRadius: rect.width / 2
                    ))
                    ctx.addFilter(.blur(radius: 5))
                }

                // ═══ L3: Glow Ring（视差 0.2x）═══
                context.drawLayer { ctx in
                    var ringOp = e.ringBase + e.wGlowRing * 5 + sin(e.totalTimeMs / 2000) * 0.1
                    if currentState == .listening { ringOp += e.audioSmooth * 0.15 }
                    if currentState == .speaking  { ringOp += e.audioSmooth * 0.25 }
                    ctx.opacity = min(1, ringOp)
                    let ox = ex * 0.2; let oy = ey * 0.2
                    let rect = R(400, ox, oy, e.wGlowRing)
                    ctx.fill(Path(ellipseIn: rect), with: .radialGradient(
                        Gradient(stops: [
                            .init(color: .clear, location: 0.91),
                            .init(color: Color(red: 60/255.0, green: 140/255.0, blue: 200/255.0), location: 0.95),
                            .init(color: Color(red: 30/255.0, green: 85/255.0, blue: 140/255.0).opacity(0.12), location: 0.98),
                            .init(color: .clear, location: 1.0),
                        ]),
                        center: CGPoint(x: cx + ox, y: cy + oy), startRadius: 0, endRadius: rect.width / 2
                    ))
                    ctx.addFilter(.blur(radius: 1.5))
                }

                // ═══ L4: BG Disc（视差 0.4x）═══
                context.fill(
                    Path(ellipseIn: R(380, ex * 0.4, ey * 0.4, e.wThinRing)),
                    with: .color(Color(red: 11/255.0, green: 46/255.0, blue: 104/255.0))
                )

                // ═══ L5: Thin Ring（视差 0.4x）═══
                let thinRect = R(380, ex * 0.4, ey * 0.4, e.wThinRing)
                let bright = min(1.0, e.thinBright)
                let thinColor = Color(
                    red: (61 + 61 * bright) / 255,
                    green: (120 + 64 * bright) / 255,
                    blue: (185 + 47 * bright) / 255
                )
                context.drawLayer { ctx in
                    ctx.stroke(Path(ellipseIn: thinRect),
                               with: .color(Color(red: 80/255.0, green: 150/255.0, blue: 200/255.0)),
                               lineWidth: 2.5)
                    ctx.addFilter(.blur(radius: 5))
                }
                context.stroke(Path(ellipseIn: thinRect), with: .color(thinColor), lineWidth: 1)

                // ═══ L6: Gyroscope ═══
                // SVG: viewBox 340, display 380, arcR=145→162px, tipR=165→184px
                let gyroPath = Self.gyroscopePath(
                    cx: cx, cy: cy, arcR: 162 * S, tipR: 184 * S, angle: e.gyroAngle
                )
                context.drawLayer { ctx in
                    ctx.stroke(gyroPath,
                               with: .color(Color(red: 36/255.0, green: 102/255.0, blue: 157/255.0).opacity(0.4)),
                               lineWidth: 1.5)
                    ctx.addFilter(.blur(radius: 3))
                }
                context.fill(gyroPath, with: .color(Color(red: 7/255.0, green: 22/255.0, blue: 72/255.0)))

                // ═══ L7: Thick White（视差 0.45x）═══
                let thickRect = R(254, ex * 0.45, ey * 0.45, e.wThickWht)
                context.drawLayer { ctx in
                    ctx.fill(Path(ellipseIn: R(264, ex * 0.45, ey * 0.45, e.wThickWht)),
                             with: .color(Color(red: 60/255.0, green: 130/255.0, blue: 190/255.0).opacity(0.4)))
                    ctx.addFilter(.blur(radius: 5))
                }
                context.fill(Path(ellipseIn: thickRect), with: .color(.white))

                // ═══ L8: Inner Blue（视差 0.95x）═══
                context.fill(
                    Path(ellipseIn: R(190, ex * 0.95, ey * 0.95, e.wInnerBlue)),
                    with: .color(Color(red: 166/255.0, green: 182/255.0, blue: 219/255.0))
                )

                // ═══ L9: Boundary Line ═══
                context.fill(
                    Path(ellipseIn: R(148, ex, ey, e.wIris)),
                    with: .color(Color(red: 182/255.0, green: 216/255.0, blue: 242/255.0))
                )

                // ═══ L10: Iris ═══
                context.fill(
                    Path(ellipseIn: R(140, ex, ey, e.wIris)),
                    with: .color(Color(red: 12/255.0, green: 97/255.0, blue: 162/255.0))
                )

                // ═══ L11: White Outline ═══
                context.fill(
                    Path(ellipseIn: R(104, ex, ey, e.wVoid)),
                    with: .color(Color(red: 160/255.0, green: 185/255.0, blue: 220/255.0))
                )

                // ═══ L12: Void ═══
                let voidRect = R(100, ex, ey, e.wVoid)
                context.fill(Path(ellipseIn: voidRect),
                             with: .color(Color(red: 6/255.0, green: 53/255.0, blue: 120/255.0)))
                context.fill(Path(ellipseIn: voidRect), with: .radialGradient(
                    Gradient(colors: [.clear, .black.opacity(0.5)]),
                    center: CGPoint(x: voidRect.midX, y: voidRect.midY),
                    startRadius: voidRect.width * 0.25, endRadius: voidRect.width / 2
                ))

                // ═══ L13: Pupil Rings ═══
                context.stroke(
                    Path(ellipseIn: R(130, ex, ey, e.wVoid)),
                    with: .color(Color(red: 100/255.0, green: 180/255.0, blue: 1.0).opacity(0.15)),
                    lineWidth: 0.5
                )
                context.stroke(
                    Path(ellipseIn: R(90, ex, ey, e.wVoid)),
                    with: .color(Color(red: 100/255.0, green: 180/255.0, blue: 1.0).opacity(0.25)),
                    lineWidth: 1
                )

                // ═══ L14: Ball ═══
                let ballRad = e.ballAngle * .pi / 180
                let ballDist: CGFloat = 50 * S
                let bx = cx + ex + CGFloat(sin(ballRad)) * ballDist
                let by = cy + ey - CGFloat(cos(ballRad)) * ballDist
                // audioPeak 驱动球的缩放（listening +8%, speaking +15%）
                var ballAudioScale: CGFloat = 1.0
                if currentState == .listening { ballAudioScale += CGFloat(e.audioPeak) * 0.08 }
                if currentState == .speaking  { ballAudioScale += CGFloat(e.audioPeak) * 0.15 }
                let ballDiam = 62 * S * CGFloat(1 + e.wVoid) * ballAudioScale
                let ballRect = CGRect(x: bx - ballDiam / 2, y: by - ballDiam / 2,
                                      width: ballDiam, height: ballDiam)
                // 蓝色发光随 audioPeak 扩展
                let glowSpread = 14 * S + CGFloat(e.audioPeak) * 18 * S
                context.drawLayer { ctx in
                    ctx.fill(Path(ellipseIn: ballRect),
                             with: .color(Color(red: 36/255.0, green: 102/255.0, blue: 157/255.0).opacity(0.8)))
                    ctx.addFilter(.blur(radius: glowSpread))
                }
                context.drawLayer { ctx in
                    ctx.fill(Path(ellipseIn: ballRect), with: .color(.white.opacity(0.9)))
                    ctx.addFilter(.blur(radius: 6 * S))
                }
                context.fill(Path(ellipseIn: ballRect), with: .color(.white))
            }
        }
        .frame(width: viewSize, height: viewSize)
        .drawingGroup()
        .allowsHitTesting(false)
    }

    // MARK: - Gyroscope Path

    private static func gyroscopePath(
        cx: CGFloat, cy: CGFloat, arcR: CGFloat, tipR: CGFloat, angle: Double
    ) -> Path {
        let a = angle * .pi / 180 - .pi / 2 // offset so tips start at NSEW
        let nh: Double = 0.127 // ~7.3° notch half-angle

        var p = Path()
        for i in 0..<4 {
            let c = a + Double(i) * .pi / 2
            let pre = CGPoint(x: cx + CGFloat(cos(c - nh)) * arcR, y: cy + CGFloat(sin(c - nh)) * arcR)
            let tip = CGPoint(x: cx + CGFloat(cos(c)) * tipR, y: cy + CGFloat(sin(c)) * tipR)
            let post = CGPoint(x: cx + CGFloat(cos(c + nh)) * arcR, y: cy + CGFloat(sin(c + nh)) * arcR)

            if i == 0 { p.move(to: pre) }
            p.addLine(to: tip)
            p.addLine(to: post)
            p.addArc(center: CGPoint(x: cx, y: cy), radius: arcR,
                     startAngle: .radians(c + nh), endAngle: .radians(a + Double(i + 1) * .pi / 2 - nh),
                     clockwise: false)
        }
        p.closeSubpath()
        return p
    }
}
