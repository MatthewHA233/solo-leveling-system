import SwiftUI
import CoreImage.CIFilterBuiltins

// MARK: - VisualEffectBackground

/// macOS 原生毛玻璃效果层
struct VisualEffectBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .hudWindow
    var blendingMode: NSVisualEffectView.BlendingMode = .behindWindow
    var state: NSVisualEffectView.State = .active

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blendingMode
        view.state = state
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.material = material
        nsView.blendingMode = blendingMode
        nsView.state = state
    }
}

// MARK: - NoiseOverlay

/// 电影感噪点贴图生成器
/// 使用 CoreImage 动态生成噪点并以 .overlay 模式混合
struct NoiseOverlay: View {
    var opacity: Double = 0.05
    var blendMode: BlendMode = .overlay

    @State private var noiseImage: Image?

    var body: some View {
        GeometryReader { geo in
            if let image = noiseImage {
                image
                    .resizable(resizingMode: .tile)
                    .opacity(opacity)
                    .blendMode(blendMode)
                    .ignoresSafeArea()
            } else {
                Color.clear
                    .onAppear {
                        generateNoise(size: CGSize(width: 256, height: 256))
                    }
            }
        }
        .allowsHitTesting(false)
    }

    private func generateNoise(size: CGSize) {
        let filter = CIFilter.randomGenerator()
        if let outputImage = filter.outputImage {
            // 切割出 256x256 作为平铺基础块
            let cropped = outputImage.cropped(to: CGRect(origin: .zero, size: size))
            // 降低对比度使噪点更柔和
            let colorControls = CIFilter.colorControls()
            colorControls.inputImage = cropped
            colorControls.contrast = 0.5
            colorControls.brightness = 0.0
            
            let context = CIContext(options: [.useSoftwareRenderer: false])
            if let finalOutput = colorControls.outputImage,
               let cgImage = context.createCGImage(finalOutput, from: finalOutput.extent) {
                let nsImage = NSImage(cgImage: cgImage, size: size)
                self.noiseImage = Image(nsImage: nsImage)
            }
        }
    }
}

// MARK: - NeonMagneticButtonStyle

/// 磁吸微回弹按钮特效
struct NeonMagneticButtonStyle: ButtonStyle {
    @State private var isHovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                ZStack {
                    if isHovered {
                        NeonBrutalismTheme.electricBlue.opacity(0.12)
                            .cornerRadius(6)
                            .transition(.opacity.combined(with: .scale(scale: 0.95)))
                    }
                }
            )
            .scaleEffect(isHovered ? 1.03 : (configuration.isPressed ? 0.96 : 1.0))
            .offset(y: isHovered ? -1 : 0) // 轻微上浮
            .animation(.spring(response: 0.3, dampingFraction: 0.55), value: isHovered)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
            .onHover { hovering in
                isHovered = hovering
            }
    }
}
