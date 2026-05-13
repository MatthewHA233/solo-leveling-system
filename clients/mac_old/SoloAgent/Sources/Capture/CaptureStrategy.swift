import Foundation

/// 智能截屏策略 — 根据用户活动状态动态调整捕捉间隔
class CaptureStrategy {
    
    /// 用户活动状态
    enum ActivityState {
        case active          // 正在操作
        case idle            // 空闲 (可能在阅读/思考)
        case deepIdle        // 深度空闲 (离开电脑)
        case screenLocked    // 锁屏
        case windowSwitched  // 刚切换了窗口 (立即截图)
    }
    
    // MARK: - 间隔配置 (秒)
    
    /// 活跃状态: 每 10 秒截一次 (视频批次分析需要更高频率)
    var activeInterval: TimeInterval = 10

    /// 空闲状态: 停止截屏 (用户没在操作，截了也是重复画面浪费 tokens)
    var idleInterval: TimeInterval = 0

    /// 深度空闲: 停止截屏
    var deepIdleInterval: TimeInterval = 0
    
    /// 空闲阈值 (秒): 超过此时间无输入视为空闲
    var idleThreshold: TimeInterval = 60
    
    /// 深度空闲阈值 (秒)
    var deepIdleThreshold: TimeInterval = 300
    
    // MARK: - Strategy
    
    /// 根据活动状态获取捕捉间隔
    func getInterval(for state: ActivityState) -> TimeInterval {
        switch state {
        case .active:
            return activeInterval
        case .idle:
            return idleInterval
        case .deepIdle:
            return deepIdleInterval
        case .screenLocked:
            return 0  // 不截图
        case .windowSwitched:
            return 1  // 立即截图 (1 秒延迟防抖)
        }
    }
    
    /// 根据空闲时间推断活动状态
    func inferState(idleSeconds: TimeInterval, isScreenLocked: Bool, windowJustSwitched: Bool) -> ActivityState {
        if isScreenLocked {
            return .screenLocked
        }
        if windowJustSwitched {
            return .windowSwitched
        }
        if idleSeconds >= deepIdleThreshold {
            return .deepIdle
        }
        if idleSeconds >= idleThreshold {
            return .idle
        }
        return .active
    }
}
