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
    
    /// 活跃状态: 每 30 秒截一次
    var activeInterval: TimeInterval = 30
    
    /// 空闲状态: 每 2 分钟截一次
    var idleInterval: TimeInterval = 120
    
    /// 深度空闲: 每 5 分钟截一次
    var deepIdleInterval: TimeInterval = 300
    
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
