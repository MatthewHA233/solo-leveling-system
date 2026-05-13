import Foundation
import ScreenCaptureKit
import CoreGraphics

/// 屏幕捕捉服务 — 使用 ScreenCaptureKit
class ScreenCaptureService {
    private var stream: SCStream?
    private var streamOutput: CaptureStreamOutput?
    private var availableContent: SCShareableContent?
    
    // MARK: - Permission
    
    /// 请求屏幕捕捉权限
    func requestPermission() async -> Bool {
        do {
            // 尝试获取可共享内容，会触发系统权限弹窗
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true
            )
            self.availableContent = content
            Logger.info("✅ 屏幕捕捉权限已获取，显示器: \(content.displays.count)")
            return true
        } catch {
            Logger.error("❌ 屏幕捕捉权限请求失败: \(error)")
            return false
        }
    }
    
    // MARK: - Capture
    
    /// 捕捉当前屏幕截图
    func captureScreen() async -> CGImage? {
        do {
            // 刷新可用内容
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true
            )
            
            guard let display = content.displays.first else {
                Logger.warning("没有找到显示器")
                return nil
            }
            
            // 创建捕捉过滤器 — 捕捉整个屏幕
            let filter = SCContentFilter(display: display, excludingWindows: [])
            
            // 配置捕捉参数
            let config = SCStreamConfiguration()
            config.width = display.width
            config.height = display.height
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = false
            config.capturesAudio = false
            
            // 单帧截图
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
            
            Logger.debug("📸 截屏完成: \(display.width)x\(display.height)")
            return image
            
        } catch {
            Logger.error("截屏失败: \(error)")
            return nil
        }
    }
    
    /// 捕捉指定窗口的截图
    func captureWindow(_ window: SCWindow) async -> CGImage? {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true
            )
            
            guard let display = content.displays.first else { return nil }
            
            let filter = SCContentFilter(
                display: display,
                including: [window]
            )
            
            let config = SCStreamConfiguration()
            config.width = Int(window.frame.width)
            config.height = Int(window.frame.height)
            config.pixelFormat = kCVPixelFormatType_32BGRA
            
            return try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
        } catch {
            Logger.error("窗口截图失败: \(error)")
            return nil
        }
    }
    
    /// 获取当前所有可见窗口
    func getVisibleWindows() async -> [SCWindow] {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true
            )
            return content.windows.filter { $0.isOnScreen }
        } catch {
            return []
        }
    }
}

/// Stream Output Handler (用于连续捕捉模式，未来可能需要)
class CaptureStreamOutput: NSObject, SCStreamOutput {
    var onFrame: ((CGImage) -> Void)?
    
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        
        let ciImage = CIImage(cvImageBuffer: imageBuffer)
        let context = CIContext()
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return }
        
        onFrame?(cgImage)
    }
}
