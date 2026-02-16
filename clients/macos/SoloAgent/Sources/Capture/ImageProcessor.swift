import Foundation
import CoreGraphics
import AppKit

/// 图片处理工具 — 压缩和隐私过滤
enum ImageProcessor {
    
    /// 压缩截图: 缩小 + JPEG 编码
    /// - Parameters:
    ///   - image: 原始 CGImage
    ///   - maxWidth: 最大宽度 (超过则等比缩小)
    ///   - jpegQuality: JPEG 质量 (0.0 - 1.0)
    /// - Returns: 压缩后的 JPEG Data
    static func compress(_ image: CGImage, maxWidth: Int = 1280, jpegQuality: Double = 0.6) -> Data? {
        let nsImage = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
        
        // 计算缩放后尺寸
        let originalWidth = CGFloat(image.width)
        let originalHeight = CGFloat(image.height)
        
        var targetWidth = originalWidth
        var targetHeight = originalHeight
        
        if originalWidth > CGFloat(maxWidth) {
            let scale = CGFloat(maxWidth) / originalWidth
            targetWidth = CGFloat(maxWidth)
            targetHeight = originalHeight * scale
        }
        
        // 创建缩放后的图片
        let targetSize = NSSize(width: targetWidth, height: targetHeight)
        let resizedImage = NSImage(size: targetSize)
        
        resizedImage.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        nsImage.draw(
            in: NSRect(origin: .zero, size: targetSize),
            from: NSRect(origin: .zero, size: nsImage.size),
            operation: .copy,
            fraction: 1.0
        )
        resizedImage.unlockFocus()
        
        // 转换为 JPEG
        guard let tiffData = resizedImage.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData) else {
            Logger.error("图片转换失败")
            return nil
        }
        
        let jpegData = bitmap.representation(
            using: .jpeg,
            properties: [.compressionFactor: NSNumber(value: jpegQuality)]
        )
        
        if let data = jpegData {
            let sizeKB = data.count / 1024
            Logger.debug("🗜️ 压缩: \(Int(originalWidth))x\(Int(originalHeight)) → \(Int(targetWidth))x\(Int(targetHeight)), \(sizeKB)KB")
        }
        
        return jpegData
    }
    
    /// 检测截图中是否包含敏感输入 (密码框等)
    /// 简单实现: 基于窗口标题判断
    static func containsSensitiveContent(windowTitle: String?, bundleId: String?, config: AgentConfig) -> Bool {
        // 检查应用是否在排除列表
        if let bundleId = bundleId, config.excludedApps.contains(bundleId) {
            return true
        }
        
        // 检查窗口标题关键词
        if let title = windowTitle {
            let lowered = title.lowercased()
            for keyword in config.excludedTitleKeywords {
                if lowered.contains(keyword.lowercased()) {
                    return true
                }
            }
        }
        
        return false
    }
}
