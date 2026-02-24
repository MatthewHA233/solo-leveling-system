import Foundation

/// 提示词模板 — 复刻 Dayflow 的三级提示词 (中文适配)
enum PromptTemplates {

    // MARK: - Phase 1: Video Transcription

    /// 视频转录 prompt — 逐段描述用户行为
    static func videoTranscriptionPrompt(
        startTimestamp: Int,
        endTimestamp: Int,
        screenshotCount: Int
    ) -> String {
        let startTime = formatTimestamp(startTimestamp)
        let endTime = formatTimestamp(endTimestamp)

        return """
        你是一个屏幕活动分析引擎。你会看到一段延时摄影视频，记录了用户 \(startTime) 到 \(endTime) 的屏幕活动。

        ## 任务
        仔细观察视频中的每一帧，按时间顺序描述用户的屏幕活动。

        ## 输出要求
        - 将视频分成 3-8 个连续的时间段
        - 每个时间段描述用户在做什么
        - 注意观察：应用名称、窗口标题、网页内容、代码编辑、文档编写等
        - 如果用户切换了应用或任务，标记为新的时间段
        - 时间戳基于视频起始时间 \(startTimestamp) (Unix timestamp)
        - 每帧间隔约 10-20 秒，视频以 1fps 播放

        ## 输出格式
        严格 JSON 数组，不要多余文字：
        ```json
        [
          {
            "startTimestamp": \(startTimestamp),
            "endTimestamp": <结束Unix时间戳>,
            "description": "用户在 VS Code 中编辑 Swift 文件 AgentManager.swift，正在修改 performCapture 方法中的 AI 调用逻辑"
          },
          ...
        ]
        ```

        注意：
        - description 要具体，提及应用名称、文件名、网站等可见信息
        - 如果看不清内容，描述可见的 UI 布局和操作
        - 覆盖完整时间线，不要遗漏任何时间段
        """
    }

    // MARK: - Phase 2: Activity Card Generation

    /// 活动卡片生成 prompt
    static func activityCardPrompt(
        transcription: String,
        existingCards: String,
        mainQuest: String = "",
        motivations: [String] = []
    ) -> String {
        let goalContext: String
        if !mainQuest.isEmpty {
            let motStr = motivations.isEmpty ? "" : "（动机：\(motivations.joined(separator: "、"))）"
            goalContext = """

            ## 主人的主线目标
            当前主线：\(mainQuest)\(motStr)

            你需要判断每段活动与主线目标的关系，在 goalAlignment 字段中用一句话说明：
            - 直接推进主线的活动 → 说明具体推进了什么（如"在开发独自升级系统的客户端 overlay 功能"）
            - 间接相关的活动 → 说明如何间接帮助（如"调研 SwiftUI 动画技术，可应用于项目 UI"）
            - 与主线无关的活动 → 如实描述（如"在刷社交媒体，与主线无关"）
            - 休息/放松 → 中性描述（如"短暂休息"）

            摘要也要围绕主线目标来写——不是泛泛地说"在写代码"，而是说"在推进 XX 项目的 XX 功能"。

            """
        } else {
            goalContext = ""
        }

        return """
        你是用户的个人 AI 伙伴。根据屏幕活动转录，生成结构化的活动卡片。
        \(goalContext)
        ## 转录内容
        \(transcription)

        \(existingCards.isEmpty ? "" : """
        ## 已有活动卡片（避免重复，可以合并延续的活动）
        \(existingCards)
        """)

        ## 活动卡片生成规则

        ### 标题指南
        - 具体、简洁、5-10 字
        - 如果跟主线相关，标题要体现项目名
        - 好例子: "开发 SoloAgent 通知系统"、"调研 SwiftUI 动画方案"
        - 坏例子: "写代码"、"上网"

        ### 摘要指南
        - 2-3 句话，第一人称省略"我"
        - 围绕「做了什么 → 对主线目标的意义 → 进展如何」来写
        - 例: "重构了 SoloAgent 的 OverlayManager 通知系统，修复了 toast 不消失的 bug。这是独自升级系统客户端体验优化的一部分。"

        ### 详细时间线指南
        - 逐分钟粒度
        - 格式: `[时:分] 具体操作 [应用] [对象]`

        ### 类别分类
        从以下选择: coding / writing / learning / browsing / media / social / gaming / work / communication / design / reading / research / meeting / idle / unknown

        ### 干扰记录
        记录任何偏离主要活动的行为

        ## 输出格式
        严格 JSON 数组：
        ```json
        [
          {
            "startTime": "10:30 AM",
            "endTime": "11:15 AM",
            "startTs": 1708500600,
            "endTs": 1708503300,
            "category": "coding",
            "subcategory": "refactoring",
            "title": "开发 SoloAgent 通知系统",
            "summary": "重构了通知面板的生命周期管理...",
            "detailedSummary": "[10:30] 打开 OverlayManager.swift [Cursor]\\n[10:32] 修改 showNotification 方法...",
            "goalAlignment": "直接推进：在开发独自升级系统的客户端通知功能",
            "distractions": [
              {"time": "10:45 AM", "description": "切到微信查看消息", "durationSeconds": 60}
            ],
            "appSites": {
              "primary": "Cursor",
              "secondary": "Chrome - GitHub"
            }
          }
        ]
        ```

        注意：
        - 每张卡片时长 15-60 分钟
        - 如果活动连续且一致，合成一张大卡片
        - 如果用户切换了完全不同的任务，分成多张卡片
        """
    }

    // MARK: - Helpers

    private static func formatTimestamp(_ ts: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ts))
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }
}
