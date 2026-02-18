import Foundation
import AppKit

/// 截图文件管理器 — 负责本地截图的写入、缩略图生成、路径解析和磁盘清理
final class ScreenshotStorageManager {
    static let shared = ScreenshotStorageManager()

    /// 截图根目录: ~/.config/solo-agent/screenshots/
    private let screenshotsDir: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config")
            .appendingPathComponent("solo-agent")
            .appendingPathComponent("screenshots")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private let fileManager = FileManager.default
    private let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH-mm-ss"
        return f
    }()

    private init() {}

    // MARK: - Save

    /// 保存截图到本地磁盘，同时生成缩略图
    /// - Parameters:
    ///   - imageData: 压缩后的 JPEG 数据
    ///   - appName: 当前活跃应用名称（用于文件命名）
    /// - Returns: 相对路径（如 "2026-02-18/14-30-22_Safari_abc123.jpg"），失败返回 nil
    func saveScreenshot(imageData: Data, appName: String?) -> String? {
        let now = Date()
        let dateStr = dateFormatter.string(from: now)
        let timeStr = timeFormatter.string(from: now)

        // 确保日期子目录存在
        let dayDir = screenshotsDir.appendingPathComponent(dateStr)
        do {
            try fileManager.createDirectory(at: dayDir, withIntermediateDirectories: true)
        } catch {
            Logger.error("创建截图目录失败: \(error)")
            return nil
        }

        // 构造文件名: HH-mm-ss_AppName_随机ID.jpg
        let sanitizedApp = sanitizeAppName(appName)
        let shortId = String(UUID().uuidString.prefix(6).lowercased())
        let fileName = "\(timeStr)_\(sanitizedApp)_\(shortId).jpg"
        let relativePath = "\(dateStr)/\(fileName)"

        let fullPath = screenshotsDir.appendingPathComponent(relativePath)

        // 写入原图
        do {
            try imageData.write(to: fullPath)
        } catch {
            Logger.error("保存截图失败: \(error)")
            return nil
        }

        // 生成并写入缩略图
        if let thumbData = ImageProcessor.generateThumbnail(imageData) {
            let thumbPath = thumbnailURL(for: relativePath)
            try? thumbData.write(to: thumbPath)
        }

        let sizeKB = imageData.count / 1024
        Logger.debug("📸 截图已保存: \(relativePath) (\(sizeKB)KB)")

        return relativePath
    }

    // MARK: - Path Resolution

    /// 从相对路径获取完整文件 URL
    func fullURL(for relativePath: String) -> URL {
        screenshotsDir.appendingPathComponent(relativePath)
    }

    /// 获取缩略图 URL（在原文件名后加 _thumb 后缀）
    func thumbnailURL(for relativePath: String) -> URL {
        let url = screenshotsDir.appendingPathComponent(relativePath)
        let name = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        return url.deletingLastPathComponent()
            .appendingPathComponent("\(name)_thumb.\(ext)")
    }

    // MARK: - Cleanup

    /// 删除过期截图（默认 48 小时前）
    func cleanupOldScreenshots(olderThanHours: Int = 48) {
        let cutoff = Date().addingTimeInterval(-Double(olderThanHours) * 3600)

        guard let dateDirs = try? fileManager.contentsOfDirectory(
            at: screenshotsDir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        var removedCount = 0

        for dirURL in dateDirs {
            var isDir: ObjCBool = false
            guard fileManager.fileExists(atPath: dirURL.path, isDirectory: &isDir),
                  isDir.boolValue else { continue }

            guard let files = try? fileManager.contentsOfDirectory(
                at: dirURL,
                includingPropertiesForKeys: [.contentModificationDateKey],
                options: [.skipsHiddenFiles]
            ) else { continue }

            for file in files {
                guard let attrs = try? file.resourceValues(forKeys: [.contentModificationDateKey]),
                      let modDate = attrs.contentModificationDate,
                      modDate < cutoff else { continue }

                try? fileManager.removeItem(at: file)
                removedCount += 1
            }

            // 如果日期目录已空，删除目录
            if let remaining = try? fileManager.contentsOfDirectory(atPath: dirURL.path),
               remaining.isEmpty {
                try? fileManager.removeItem(at: dirURL)
            }
        }

        if removedCount > 0 {
            Logger.info("🧹 清理了 \(removedCount) 个过期截图")
        }
    }

    // MARK: - Disk Usage

    /// 返回格式化的磁盘占用量
    func totalDiskUsage() -> String {
        let totalBytes = directorySize(url: screenshotsDir)
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(totalBytes))
    }

    // MARK: - Private Helpers

    private func sanitizeAppName(_ appName: String?) -> String {
        guard let name = appName, !name.isEmpty else { return "Unknown" }
        // 只保留字母、数字、连字符
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-"))
        return String(name.unicodeScalars.filter { allowed.contains($0) }.prefix(20))
    }

    private func directorySize(url: URL) -> Int {
        guard let enumerator = fileManager.enumerator(
            at: url,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return 0 }

        var total = 0
        for case let fileURL as URL in enumerator {
            if let size = try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                total += size
            }
        }
        return total
    }
}
