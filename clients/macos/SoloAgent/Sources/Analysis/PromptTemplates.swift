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
        existingCards: String
    ) -> String {
        """
        你是「独自升级系统」的活动分析引擎。根据屏幕活动转录，生成结构化的活动卡片。

        ## 转录内容
        \(transcription)

        \(existingCards.isEmpty ? "" : """
        ## 已有活动卡片（避免重复，可以合并延续的活动）
        \(existingCards)
        """)

        ## 活动卡片生成规则

        ### 标题指南
        - 具体、简洁、5-10 字
        - 避免模糊词如"工作"、"使用电脑"
        - 好例子: "重构 OAuth 认证模块"、"调研 SwiftUI 动画方案"
        - 坏例子: "写代码"、"上网"

        ### 摘要指南
        - 2-3 句话
        - 第一人称省略"我"
        - 描述做了什么、为什么、进展如何
        - 例: "在 VS Code 中重构了 AgentManager 的截屏流程，将单图分析改为批次视频分析。主要修改了 performCapture 和新增 batchProcessingLoop 方法。"

        ### 详细时间线指南
        - 逐分钟粒度
        - 格式: `[时:分] 具体操作 [应用] [对象]`
        - 例: `[10:32] 打开 AgentManager.swift [VS Code] [solo-leveling-system]`

        ### 类别分类
        从以下选择: coding / writing / learning / browsing / media / social / gaming / work / communication / design / reading / research / meeting / idle / unknown

        ### 干扰记录
        记录任何偏离主要活动的行为（切到社交媒体、查看无关网站等）

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
            "title": "重构截屏分析流程",
            "summary": "在 VS Code 中重构了 AgentManager 的截屏流程...",
            "detailedSummary": "[10:30] 打开 AgentManager.swift [VS Code]\\n[10:32] 修改 performCapture 方法...",
            "distractions": [
              {"time": "10:45 AM", "description": "切到微信查看消息", "durationSeconds": 60}
            ],
            "appSites": {
              "primary": "VS Code",
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
