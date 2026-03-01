import Foundation
import AVFoundation
import AppKit
import CoreGraphics

/// 视频合成服务 — 将截屏序列合成为 MP4 延时摄影视频
actor VideoProcessingService {

    /// 延时摄影视频输出根目录
    private let timelapsesDir: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config")
            .appendingPathComponent("solo-agent")
            .appendingPathComponent("timelapses")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    /// 截图根目录
    private let screenshotsDir: URL = {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config")
            .appendingPathComponent("solo-agent")
            .appendingPathComponent("screenshots")
    }()

    // MARK: - Public API

    /// 视频合成结果
    struct VideoResult {
        let url: URL
        /// 帧→真实时间戳映射：frameTimestamps[i] = 视频第 i 秒对应的 Unix timestamp
        let frameTimestamps: [Int]
    }

    /// 从截图序列生成延时摄影视频
    /// - Returns: VideoResult 包含视频 URL 和帧时间戳映射表
    func generateVideo(
        screenshots: [(path: String, timestamp: Int)],
        outputURL: URL? = nil,
        fps: Int = 1,
        maxHeight: Int = 720,
        bitRate: Int = 300_000,
        frameStride: Int = 2
    ) async throws -> VideoResult {
        // 帧采样
        let sampled = stride(from: 0, to: screenshots.count, by: frameStride).map { screenshots[$0] }
        guard !sampled.isEmpty else {
            throw VideoError.noFrames
        }
        // 预加载可用帧（跳过无法加载的图片），同时保持时间戳同步
        var validFrames: [(image: CGImage, timestamp: Int)] = []
        for shot in sampled {
            if let img = loadImage(relativePath: shot.path) {
                validFrames.append((image: img, timestamp: shot.timestamp))
            }
        }
        guard !validFrames.isEmpty else {
            throw VideoError.noFrames
        }
        let frameTimestamps = validFrames.map(\.timestamp)

        // 确定输出路径
        let output = outputURL ?? generateOutputURL()
        try? FileManager.default.createDirectory(
            at: output.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        // 删除已存在的文件
        if FileManager.default.fileExists(atPath: output.path) {
            try FileManager.default.removeItem(at: output)
        }

        // 从预加载帧确定尺寸
        let firstImage = validFrames[0].image
        let (videoWidth, videoHeight) = computeSize(
            originalWidth: firstImage.width,
            originalHeight: firstImage.height,
            maxHeight: maxHeight
        )

        // 创建 AVAssetWriter
        let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)

        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: videoWidth,
            AVVideoHeightKey: videoHeight,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitRate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264BaselineAutoLevel,
            ] as [String: Any],
        ]

        let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        writerInput.expectsMediaDataInRealTime = false

        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: writerInput,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
                kCVPixelBufferWidthKey as String: videoWidth,
                kCVPixelBufferHeightKey as String: videoHeight,
            ]
        )

        writer.add(writerInput)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)

        // 写入帧（使用预加载的有效帧，时间戳与 frameTimestamps 精确对应）
        let frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps))

        for (index, frame) in validFrames.enumerated() {
            let presentationTime = CMTimeMultiply(frameDuration, multiplier: Int32(index))

            while !writerInput.isReadyForMoreMediaData {
                try await Task.sleep(for: .milliseconds(10))
            }

            guard let pixelBuffer = createPixelBuffer(
                from: frame.image,
                width: videoWidth,
                height: videoHeight,
                pool: adaptor.pixelBufferPool
            ) else { continue }

            adaptor.append(pixelBuffer, withPresentationTime: presentationTime)
        }

        writerInput.markAsFinished()
        await writer.finishWriting()

        guard writer.status == .completed else {
            throw VideoError.writingFailed(writer.error?.localizedDescription ?? "unknown")
        }

        let fileSize = (try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? Int) ?? 0
        let sizeMB = String(format: "%.1f", Double(fileSize) / 1_048_576.0)
        Logger.info("🎬 视频合成完成: \(validFrames.count)/\(sampled.count) 帧, \(sizeMB)MB → \(output.lastPathComponent)")

        return VideoResult(url: output, frameTimestamps: frameTimestamps)
    }

    // MARK: - Helpers

    private func generateOutputURL() -> URL {
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        let dayStr = dateFormatter.string(from: Date())

        let timeFormatter = DateFormatter()
        timeFormatter.dateFormat = "HH-mm-ss"
        let timeStr = timeFormatter.string(from: Date())

        let dayDir = timelapsesDir.appendingPathComponent(dayStr)
        return dayDir.appendingPathComponent("timelapse_\(timeStr).mp4")
    }

    private func loadImage(relativePath: String) -> CGImage? {
        let url = screenshotsDir.appendingPathComponent(relativePath)
        guard let data = try? Data(contentsOf: url),
              let nsImage = NSImage(data: data),
              let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }
        return cgImage
    }

    private func computeSize(originalWidth: Int, originalHeight: Int, maxHeight: Int) -> (Int, Int) {
        if originalHeight <= maxHeight {
            // 确保宽度是偶数 (H.264 要求)
            let w = originalWidth % 2 == 0 ? originalWidth : originalWidth - 1
            let h = originalHeight % 2 == 0 ? originalHeight : originalHeight - 1
            return (w, h)
        }
        let scale = Double(maxHeight) / Double(originalHeight)
        var w = Int(Double(originalWidth) * scale)
        var h = maxHeight
        // H.264 要求宽高为偶数
        w = w % 2 == 0 ? w : w - 1
        h = h % 2 == 0 ? h : h - 1
        return (w, h)
    }

    private func createPixelBuffer(
        from image: CGImage,
        width: Int,
        height: Int,
        pool: CVPixelBufferPool?
    ) -> CVPixelBuffer? {
        var pixelBuffer: CVPixelBuffer?

        if let pool {
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer)
        } else {
            let attrs: [String: Any] = [
                kCVPixelBufferCGImageCompatibilityKey as String: true,
                kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
            ]
            CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32ARGB, attrs as CFDictionary, &pixelBuffer)
        }

        guard let buffer = pixelBuffer else { return nil }

        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
        ) else { return nil }

        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        return buffer
    }

    // MARK: - Cleanup

    func cleanupOldVideos(olderThanDays: Int = 3) {
        let cutoff = Date().addingTimeInterval(-Double(olderThanDays) * 86400)
        let fm = FileManager.default

        guard let dateDirs = try? fm.contentsOfDirectory(
            at: timelapsesDir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        for dirURL in dateDirs {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dirURL.path, isDirectory: &isDir), isDir.boolValue else { continue }
            guard let attrs = try? dirURL.resourceValues(forKeys: [.contentModificationDateKey]),
                  let modDate = attrs.contentModificationDate,
                  modDate < cutoff else { continue }
            try? fm.removeItem(at: dirURL)
        }
    }
}

// MARK: - Errors

enum VideoError: Error, LocalizedError {
    case noFrames
    case cannotLoadImage(String)
    case writingFailed(String)

    var errorDescription: String? {
        switch self {
        case .noFrames: return "没有可用的截屏帧"
        case .cannotLoadImage(let path): return "无法加载图片: \(path)"
        case .writingFailed(let reason): return "视频写入失败: \(reason)"
        }
    }
}
