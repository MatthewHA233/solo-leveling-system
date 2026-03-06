import Foundation

/// 提示词模板 — 复刻 Dayflow 的三级提示词 (中文适配)
enum PromptTemplates {

    // MARK: - Phase 1: Video Transcription

    /// 视频转录 prompt — 逐段描述用户行为，包含帧→时间映射表以提高时间戳精度
    static func videoTranscriptionPrompt(
        videoDurationSeconds: Int,
        frameTimeMapping: String = "",
        contextHint: String = ""
    ) -> String {
        let mappingSection: String
        if !frameTimeMapping.isEmpty {
            mappingSection = """

            ## 帧→真实时间映射表
            以下是视频每一秒对应的真实时间（视频第N秒 = 真实时间）：
            \(frameTimeMapping)

            重要：请在 description 中使用上面映射表中的真实时间来描述事件发生的时刻，
            例如"[10:30] 用户切换到 Chrome"。这样可以确保时间戳精确。

            """
        } else {
            mappingSection = ""
        }

        let contextSection: String
        if !contextHint.isEmpty {
            contextSection = """

            ## 重要上下文（来自系统实时观察）
            \(contextHint)
            请基于以上上下文来理解视频中的活动。

            """
        } else {
            contextSection = ""
        }

        return """
        你是一个屏幕活动分析引擎。你会看到一段延时摄影视频，共 \(videoDurationSeconds) 帧。
        \(mappingSection)\(contextSection)
        ## 任务
        仔细观察视频中的每一帧，按时间顺序描述用户的屏幕活动。

        ## 输出要求
        - 将视频分成若干个连续的时间段
        - 每个时间段描述用户在做什么
        - 注意观察：应用名称、窗口标题、网页内容、代码编辑、文档编写等
        - 如果用户切换了应用或任务，标记为新的时间段
        - 使用视频秒数（0 到 \(videoDurationSeconds)）标记时间段

        ## 输出格式
        严格 JSON 数组，不要多余文字：
        ```json
        [
          {
            "startSecond": 0,
            "endSecond": 15,
            "description": "[10:30] 用户在 VS Code 中编辑 Swift 文件 AgentManager.swift，正在修改 performCapture 方法"
          },
          ...
        ]
        ```

        注意：
        - description 要具体，提及应用名称、文件名、网站等可见信息
        - 如果提供了帧→时间映射表，description 中务必用 [HH:mm] 标注真实时间
        - 如果看不清内容，描述可见的 UI 布局和操作
        - 覆盖完整视频时间线，不要遗漏任何时间段
        - startSecond 和 endSecond 不能超出 0~\(videoDurationSeconds) 范围
        """
    }

    // MARK: - Phase 2: Activity Card Generation

    /// 活动卡片生成 prompt
    static func activityCardPrompt(
        transcription: String,
        existingCards: String,
        mainQuest: String = "",
        motivations: [String] = [],
        contextHint: String = ""
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

        let contextSection: String
        if !contextHint.isEmpty {
            contextSection = """

            ## 重要上下文（来自系统实时观察）
            \(contextHint)
            请基于以上上下文来理解视频中的活动。

            """
        } else {
            contextSection = ""
        }

        return """
        你是用户的个人 AI 伙伴「暗影君主系统」。根据屏幕活动转录，生成结构化的活动卡片。
        \(goalContext)\(contextSection)
        ## 转录内容
        \(transcription)

        \(existingCards.isEmpty ? "" : """
        ## 今日已有活动卡片（重要：你必须理解上下文衔接）
        \(existingCards)

        ### 衔接规则
        - 仔细阅读已有卡片的标题和时间，理解用户今天一直在做什么
        - 如果当前转录是已有活动的延续（同一个项目/任务），不要生成新卡片，而是返回空数组 []
        - 如果当前活动是已有活动的拓展（同项目不同子任务），生成新卡片但标题要体现连续性
        - 只有当用户明显切换到完全不同的任务时，才生成独立的新卡片
        - 绝对不要重复已有卡片的内容
        """)

        ## 核心理解规则（最重要）

        ### 理解上下文，不要字面描述
        - 不要描述"用户在终端输入命令"，要理解用户在做什么项目、解决什么问题
        - 终端窗口标题含 "Claude Code" / "ccrun" → 用户在通过 AI 编程助手开发项目
        - 看到代码编辑器 + 编译输出 → 这是开发活动，标题要用项目名而非"写代码"
        - 看到浏览器访问 API 文档 / 控制台 → 这是配置或调研，是开发过程的一部分
        - 如果多个小操作属于同一个工作流（编码→编译→调试→查文档），合并为一张卡片

        ### 标题指南
        - 具体、简洁、5-10 字
        - 如果跟主线相关，标题要体现项目名
        - 好例子: "开发 SoloAgent 视频循环功能"、"调试 FPS 对齐问题"
        - 坏例子: "写代码"、"上网"、"操作终端"、"查看控制台"

        ### 摘要指南
        - 2-3 句话，第一人称省略"我"
        - 围绕「做了什么 → 对主线目标的意义 → 进展如何」来写
        - 例: "为 SoloAgent 添加了视频循环播放和字幕叠加功能，修复了播放器到达末尾后字幕卡住的 bug。独自升级系统的视频回放体验大幅提升。"

        ### 详细时间线指南
        - 逐分钟粒度
        - 格式: `[HH:mm] 具体操作 [应用名]`
        - 例: `[21:15] 修复视频循环逻辑编译错误 [Terminal]`

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
        - 转录内容的每个段落已包含 startTs、endTs、startTime、endTime 字段，这些是精确的真实时间
        - 你必须直接使用转录中提供的 startTs / endTs 值，不要自己计算或从截图画面中读取时间
        - startTime / endTime 同样从转录中获取，不要自行推断
        - 不要凭空扩展时间范围，只用转录中实际出现的时间戳
        - 如果活动连续且一致，合成一张大卡片（取第一段的 startTs 和最后一段的 endTs）
        - 如果用户切换了完全不同的任务，分成多张卡片
        - 如果当前活动是已有卡片的延续，返回空数组 []
        """
    }

    // MARK: - Reorganize Cards

    /// 一键重新整理卡片 prompt — 聚合、合并、去重
    static func reorganizeCardsPrompt(
        existingCards: String,
        mainQuest: String = "",
        motivations: [String] = []
    ) -> String {
        let goalContext = mainQuest.isEmpty ? "" : """

        ## 主人的主线目标
        当前主线：\(mainQuest)\(motivations.isEmpty ? "" : "（动机：\(motivations.joined(separator: "、"))）")

        """

        return """
        你是用户的个人 AI 伙伴「暗影君主系统」。以下是今日所有零散的活动卡片，请重新整理。
        \(goalContext)
        ## 今日所有活动卡片（需要整理）
        \(existingCards)

        ## 整理规则
        1. **合并同类活动**：如果多张卡片描述的是同一个任务/项目的不同阶段，合并为一张大卡片
        2. **保留时间跨度**：合并后 startTs 取最早的，endTs 取最晚的
        3. **理解而非字面描述**：标题应该反映用户实际在做什么项目/任务，而非"操作终端"
        4. **detailedSummary 合并**：把多张卡片的时间线按时间顺序合并
        5. **去除重复**：如果两张卡片描述了完全相同的事情，只保留一张
        6. **保持 batchId**：合并后的卡片用第一张卡片的 batchId

        ## 输出格式
        严格 JSON 数组，与输入格式一致：
        ```json
        [
          {
            "startTime": "8:30 PM",
            "endTime": "9:30 PM",
            "startTs": 1708500600,
            "endTs": 1708504200,
            "category": "coding",
            "subcategory": "feature-dev",
            "title": "开发 SoloAgent 视频播放功能",
            "summary": "实现了视频循环播放、字幕叠加、FPS 对齐等功能...",
            "detailedSummary": "[20:30] 修复视频循环逻辑 [Terminal]\\n[20:45] 调试 FPS 参数对齐...",
            "goalAlignment": "直接推进：开发独自升级系统的视频回放体验",
            "appSites": { "primary": "Terminal", "secondary": "Chrome" }
          }
        ]
        ```

        注意：
        - 必须使用原有卡片中的 startTs / endTs 值，不要自己编造
        - 合并后的卡片数量应该明显少于原始卡片（通常 2-5 张就够了）
        - 标题要有项目感，例如"开发 SoloAgent 视频播放功能"而非"写代码"
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
