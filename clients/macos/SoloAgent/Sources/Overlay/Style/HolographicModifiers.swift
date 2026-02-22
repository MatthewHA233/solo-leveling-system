import SwiftUI

// MARK: - Holographic Panel Modifier

struct HolographicPanelModifier: ViewModifier {
    var cornerRadius: CGFloat = HolographicTheme.cornerRadius

    func body(content: Content) -> some View {
        content
            .background(
                ZStack {
                    // Deep background
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .fill(HolographicTheme.panelGradient)

                    // Subtle noise/texture overlay
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .fill(.ultraThinMaterial.opacity(0.15))
                }
            )
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .stroke(HolographicTheme.borderGradient, lineWidth: HolographicTheme.borderWidth)
            )
            .shadow(color: HolographicTheme.primaryBlue.opacity(0.3), radius: 20, x: 0, y: 0)
            .shadow(color: HolographicTheme.accentPurple.opacity(0.15), radius: 40, x: 0, y: 0)
    }
}

// MARK: - Glow Border Modifier

struct GlowBorderModifier: ViewModifier {
    var color: Color = HolographicTheme.primaryBlue
    var radius: CGFloat = 8
    var cornerRadius: CGFloat = HolographicTheme.cornerRadius

    func body(content: Content) -> some View {
        content
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .stroke(color.opacity(0.6), lineWidth: 1)
            )
            .shadow(color: color.opacity(0.4), radius: radius, x: 0, y: 0)
    }
}

// MARK: - Scanline Overlay

struct ScanlineOverlay: View {
    @State private var offset: CGFloat = 0
    let lineSpacing: CGFloat = 3
    let lineOpacity: Double = 0.03

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

// MARK: - Glow Text Modifier

struct GlowTextModifier: ViewModifier {
    var color: Color = HolographicTheme.primaryBlue

    func body(content: Content) -> some View {
        content
            .foregroundColor(HolographicTheme.textPrimary)
            .shadow(color: color.opacity(0.8), radius: 4, x: 0, y: 0)
            .shadow(color: color.opacity(0.4), radius: 12, x: 0, y: 0)
    }
}

// MARK: - Pulse Animation Modifier

struct PulseModifier: ViewModifier {
    @State private var isPulsing = false
    var minOpacity: Double = 0.6
    var maxOpacity: Double = 1.0
    var duration: Double = 2.0

    func body(content: Content) -> some View {
        content
            .opacity(isPulsing ? maxOpacity : minOpacity)
            .animation(
                .easeInOut(duration: duration).repeatForever(autoreverses: true),
                value: isPulsing
            )
            .onAppear { isPulsing = true }
    }
}

// MARK: - Slide-in Modifier

struct SlideInModifier: ViewModifier {
    var edge: Edge = .trailing
    @Binding var isVisible: Bool
    var duration: Double = 0.35

    func body(content: Content) -> some View {
        content
            .offset(x: offsetX, y: 0)
            .opacity(isVisible ? 1 : 0)
            .animation(.easeInOut(duration: duration), value: isVisible)
    }

    private var offsetX: CGFloat {
        guard !isVisible else { return 0 }
        switch edge {
        case .trailing: return 100
        case .leading: return -100
        default: return 0
        }
    }
}

// MARK: - View Extensions

extension View {
    func holographicPanel(cornerRadius: CGFloat = HolographicTheme.cornerRadius) -> some View {
        modifier(HolographicPanelModifier(cornerRadius: cornerRadius))
    }

    func glowBorder(color: Color = HolographicTheme.primaryBlue, radius: CGFloat = 8, cornerRadius: CGFloat = HolographicTheme.cornerRadius) -> some View {
        modifier(GlowBorderModifier(color: color, radius: radius, cornerRadius: cornerRadius))
    }

    func glowText(color: Color = HolographicTheme.primaryBlue) -> some View {
        modifier(GlowTextModifier(color: color))
    }

    func pulse(min: Double = 0.6, max: Double = 1.0, duration: Double = 2.0) -> some View {
        modifier(PulseModifier(minOpacity: min, maxOpacity: max, duration: duration))
    }

    func slideIn(from edge: Edge = .trailing, isVisible: Binding<Bool>, duration: Double = 0.35) -> some View {
        modifier(SlideInModifier(edge: edge, isVisible: isVisible, duration: duration))
    }
}
