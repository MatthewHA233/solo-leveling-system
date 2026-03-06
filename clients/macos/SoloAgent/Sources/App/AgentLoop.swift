import Foundation

// MARK: - Agent Loop Event

enum AgentLoopEvent {
    case textDelta(String)
    case toolCallStarted(name: String, args: String)
    case toolCallResult(name: String, result: String)
    case done
    case error(String)
}

// MARK: - Agent Loop

/// ReAct 循环：推理 → 工具调用 → 观察 → 再推理，直到 AI 不再请求工具或达到最大迭代次数
@MainActor
final class AgentLoop {
    let tools: [any AgentTool]
    let memory: AgentMemory
    weak var manager: AgentManager?

    init(tools: [any AgentTool], memory: AgentMemory, manager: AgentManager) {
        self.tools = tools
        self.memory = memory
        self.manager = manager
    }

    // MARK: - Tool Definitions

    var toolDefinitions: [[String: Any]] {
        tools.map { $0.toolDefinition }
    }

    // MARK: - Run

    func run(
        userMessage: String,
        systemPrompt: String,
        maxIterations: Int = 8,
        onEvent: @escaping (AgentLoopEvent) -> Void
    ) async {
        guard let manager = manager else {
            onEvent(.error("AgentManager 未就绪"))
            onEvent(.done)
            return
        }

        memory.appendUser(userMessage)
        await memory.trimIfNeeded()

        var iterations = 0

        while iterations < maxIterations {
            iterations += 1

            let messages = memory.buildLLMMessages(systemPrompt: systemPrompt)
            let toolDefs = toolDefinitions

            guard let stream = manager.streamAgentTurn(messages: messages, tools: toolDefs) else {
                onEvent(.error("AI 未配置或不可用"))
                onEvent(.done)
                return
            }

            // 累积本轮 text 和 tool_calls
            var accText = ""
            // index -> (id, name, argsAccum)
            var pendingCalls: [Int: (id: String, name: String, args: String)] = [:]
            var finishReason = ""

            do {
                for try await chunk in stream {
                    switch chunk {
                    case .textDelta(let delta):
                        accText += delta
                        onEvent(.textDelta(delta))

                    case .toolCallDelta(let index, let id, let name, let argsDelta):
                        if pendingCalls[index] == nil {
                            pendingCalls[index] = (id: id ?? "", name: name ?? "", args: "")
                        }
                        if let id = id, !id.isEmpty {
                            pendingCalls[index]!.id = id
                        }
                        if let name = name, !name.isEmpty {
                            pendingCalls[index]!.name = name
                        }
                        if let delta = argsDelta {
                            pendingCalls[index]!.args += delta
                        }

                    case .finishReason(let reason):
                        finishReason = reason
                    }
                }
            } catch {
                AIClient.debugLog("[AgentLoop] 流式错误: \(error)")
                onEvent(.error("AI 响应错误: \(error.localizedDescription)"))
                onEvent(.done)
                return
            }

            // 构建 ToolCallRecords
            let sortedCalls = pendingCalls.sorted { $0.key < $1.key }
            let toolCalls: [ToolCallRecord] = sortedCalls.map { _, v in
                ToolCallRecord(id: v.id.isEmpty ? "call_\(UUID().uuidString.prefix(8))" : v.id,
                               name: v.name,
                               arguments: v.args)
            }

            // 保存本轮 assistant 回复到 memory
            memory.appendAssistant(
                text: accText.isEmpty ? nil : accText,
                toolCalls: toolCalls.isEmpty ? nil : toolCalls
            )

            // 如果没有工具调用，AI 已完成（stop）
            if toolCalls.isEmpty || finishReason == "stop" {
                break
            }

            // 执行所有工具调用
            for tc in toolCalls {
                onEvent(.toolCallStarted(name: tc.name, args: tc.arguments))

                let result: String
                do {
                    let args = parseArgs(tc.arguments)
                    if let tool = tools.first(where: { $0.name == tc.name }) {
                        result = try await tool.execute(args: args, manager: manager)
                    } else {
                        result = "未知工具：\(tc.name)"
                    }
                } catch {
                    result = "工具执行失败：\(error.localizedDescription)"
                }

                AIClient.debugLog("[AgentLoop] 工具 \(tc.name) 结果: \(result.prefix(100))")
                onEvent(.toolCallResult(name: tc.name, result: result))
                memory.appendToolResult(toolCallId: tc.id, name: tc.name, result: result)
            }
        }

        memory.save()
        onEvent(.done)
    }

    // MARK: - Helpers

    private func parseArgs(_ jsonString: String) -> [String: Any] {
        guard !jsonString.isEmpty,
              let data = jsonString.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return dict
    }
}
