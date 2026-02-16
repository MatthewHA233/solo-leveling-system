import Foundation
import os

/// 统一日志系统
enum Logger {
    private static let subsystem = "com.solo-leveling.agent"
    private static let logger = os.Logger(subsystem: subsystem, category: "SoloAgent")
    
    static func info(_ message: String) {
        logger.info("\(message)")
        #if DEBUG
        print("[INFO] \(message)")
        #endif
    }
    
    static func debug(_ message: String) {
        logger.debug("\(message)")
        #if DEBUG
        print("[DEBUG] \(message)")
        #endif
    }
    
    static func warning(_ message: String) {
        logger.warning("\(message)")
        #if DEBUG
        print("[WARN] \(message)")
        #endif
    }
    
    static func error(_ message: String) {
        logger.error("\(message)")
        #if DEBUG
        print("[ERROR] \(message)")
        #endif
    }
}
