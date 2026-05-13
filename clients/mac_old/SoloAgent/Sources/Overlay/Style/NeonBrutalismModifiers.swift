import SwiftUI

// MARK: - Brutal Panel Modifier

struct BrutalPanelModifier: ViewModifier {
    var cornerRadius: CGFloat = NeonBrutalismTheme.cornerRadius

    func body(content: Content) -> some View {
        content
            .background(
                ZStack {
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .fill(NeonBrutalismTheme.panelGradient)
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .fill(.ultraThinMaterial.opacity(0.12))
                }
            )
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .stroke(NeonBrutalismTheme.borderGradient, lineWidth: NeonBrutalismTheme.borderWidth)
            )
            .shadow(color: NeonBrutalismTheme.electricBlue.opacity(0.3), radius: 20)
            .shadow(color: NeonBrutalismTheme.shadowPurple.opacity(0.15), radius: 40)
    }
}

// MARK: - Brutal Section Modifier

struct BrutalSectionModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color.white.opacity(0.02))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(NeonBrutalismTheme.electricBlue.opacity(NeonBrutalismTheme.dividerOpacity), lineWidth: 1)
            )
    }
}

// MARK: - Brutal Glow Text

struct BrutalGlowText: ViewModifier {
    var color: Color = NeonBrutalismTheme.electricBlue

    func body(content: Content) -> some View {
        content
            .foregroundColor(NeonBrutalismTheme.textPrimary)
            .shadow(color: color.opacity(0.9), radius: 6)
            .shadow(color: color.opacity(0.5), radius: 16)
    }
}

// MARK: - Glow Border Modifier

struct NeonGlowBorderModifier: ViewModifier {
    var color: Color = NeonBrutalismTheme.electricBlue
    var radius: CGFloat = 8
    var cornerRadius: CGFloat = NeonBrutalismTheme.cornerRadius

    func body(content: Content) -> some View {
        content
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .stroke(color.opacity(0.6), lineWidth: 1)
            )
            .shadow(color: color.opacity(0.4), radius: radius)
    }
}

// MARK: - Neon Divider

struct NeonDivider: View {
    enum Axis { case horizontal, vertical }
    let axis: Axis

    init(_ axis: Axis = .horizontal) {
        self.axis = axis
    }

    var body: some View {
        switch axis {
        case .horizontal:
            Rectangle()
                .fill(NeonBrutalismTheme.electricBlue.opacity(NeonBrutalismTheme.dividerOpacity))
                .frame(height: 1)
        case .vertical:
            Rectangle()
                .fill(NeonBrutalismTheme.electricBlue.opacity(NeonBrutalismTheme.dividerOpacity))
                .frame(width: 1)
        }
    }
}

// MARK: - Scanline Overlay (reduced)

struct NeonScanlineOverlay: View {
    let lineSpacing: CGFloat = 3
    let lineOpacity: Double = 0.015

    var body: some View {
        SwiftUI.TimelineView(.periodic(from: .now, by: 1.0 / 15.0)) { timeline in
            Canvas { context, size in
                let phase = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.0)
                let yOffset = CGFloat(phase / 2.0) * lineSpacing

                var y = -lineSpacing + yOffset
                while y < size.height + lineSpacing {
                    let rect = CGRect(x: 0, y: y, width: size.width, height: 1)
                    context.fill(Path(rect), with: .color(.white.opacity(lineOpacity)))
                    y += lineSpacing
                }
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Brutal Badge

struct BrutalBadge: View {
    let text: String
    var color: Color = NeonBrutalismTheme.electricBlue

    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .clipShape(RoundedRectangle(cornerRadius: 3))
    }
}

// MARK: - Pulse Modifier

struct NeonPulseModifier: ViewModifier {
    @State private var isPulsing = false
    var minOpacity: Double = 0.6
    var maxOpacity: Double = 1.0

    func body(content: Content) -> some View {
        content
            .opacity(isPulsing ? maxOpacity : minOpacity)
            .animation(.easeInOut(duration: 2.0).repeatForever(autoreverses: true), value: isPulsing)
            .onAppear { isPulsing = true }
    }
}

// MARK: - Cursor Modifier

struct CursorModifier: ViewModifier {
    func body(content: Content) -> some View {
        content.onHover { inside in
            if inside { NSCursor.pointingHand.push() }
            else { NSCursor.pop() }
        }
    }
}

// MARK: - View Extensions

extension View {
    func brutalPanel(cornerRadius: CGFloat = NeonBrutalismTheme.cornerRadius) -> some View {
        modifier(BrutalPanelModifier(cornerRadius: cornerRadius))
    }

    func brutalSection() -> some View {
        modifier(BrutalSectionModifier())
    }

    func brutalGlow(color: Color = NeonBrutalismTheme.electricBlue) -> some View {
        modifier(BrutalGlowText(color: color))
    }

    func neonGlowBorder(color: Color = NeonBrutalismTheme.electricBlue, radius: CGFloat = 8, cornerRadius: CGFloat = NeonBrutalismTheme.cornerRadius) -> some View {
        modifier(NeonGlowBorderModifier(color: color, radius: radius, cornerRadius: cornerRadius))
    }

    func neonPulse(min: Double = 0.6, max: Double = 1.0) -> some View {
        modifier(NeonPulseModifier(minOpacity: min, maxOpacity: max))
    }

    func pointingHand() -> some View {
        modifier(CursorModifier())
    }
}
