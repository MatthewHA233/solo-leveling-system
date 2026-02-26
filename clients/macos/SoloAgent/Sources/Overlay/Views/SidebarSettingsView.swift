import SwiftUI

/// 侧栏设置面板 — Neon Brutalism 风格，220px 宽度适配
struct SidebarSettingsView: View {
    @EnvironmentObject var agentManager: AgentManager

    // AI (编辑态，不自动保存)
    @State private var aiProvider: String = "gemini"
    @State private var geminiApiKey: String = ""
    @State private var geminiApiBase: String = ""
    @State private var geminiModel: String = ""
    @State private var openaiApiKey: String = ""
    @State private var openaiApiBase: String = ""
    @State private var openaiModel: String = ""

    // Capture (自动保存)
    @State private var jpegQuality: Double = 0.6
    @State private var screenshotInterval: Double = 10

    // Privacy (自动保存)
    @State private var excludedApps: String = ""

    // UI state
    @State private var aiDirty: Bool = false
    @State private var aiApplied: Bool = false
    @State private var testResult: String?
    @State private var isTesting: Bool = false

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 16) {
                aiSection
                NeonDivider(.horizontal)
                captureSection
                NeonDivider(.horizontal)
                privacySection
            }
            .padding(12)
        }
        .onAppear { loadFromConfig() }
    }

    // MARK: - AI Model Section

    private var aiSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader("AI 模型", icon: "cpu")

            // 当前生效状态
            activeModelBadge

            // Provider picker
            HStack(spacing: 4) {
                providerButton("Gemini", id: "gemini")
                providerButton("OpenAI", id: "openai")
            }

            if aiProvider == "gemini" {
                settingsField("API 密钥", secure: true, text: $geminiApiKey)
                settingsField("接口地址", text: $geminiApiBase)
                settingsField("模型", text: $geminiModel)
            } else {
                settingsField("API 密钥", secure: true, text: $openaiApiKey)
                settingsField("接口地址", text: $openaiApiBase)
                settingsField("模型", text: $openaiModel)
            }

            // 确认并应用 + 测试连接
            HStack(spacing: 4) {
                Button(action: applyAISettings) {
                    Text("确认并应用")
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 5)
                        .background(
                            aiDirty
                                ? NeonBrutalismTheme.expGreen.opacity(0.2)
                                : NeonBrutalismTheme.electricBlue.opacity(0.06)
                        )
                        .foregroundColor(
                            aiDirty
                                ? NeonBrutalismTheme.expGreen
                                : NeonBrutalismTheme.textSecondary
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 3)
                                .stroke(
                                    aiDirty
                                        ? NeonBrutalismTheme.expGreen.opacity(0.5)
                                        : NeonBrutalismTheme.electricBlue.opacity(0.15),
                                    lineWidth: 1
                                )
                        )
                        .cornerRadius(3)
                }
                .buttonStyle(.plain)

                Button(action: testConnection) {
                    HStack(spacing: 3) {
                        if isTesting {
                            ProgressView()
                                .controlSize(.mini)
                        }
                        Text(isTesting ? "..." : "测试")
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                    }
                    .padding(.vertical, 5)
                    .padding(.horizontal, 10)
                    .background(NeonBrutalismTheme.electricBlue.opacity(0.1))
                    .overlay(
                        RoundedRectangle(cornerRadius: 3)
                            .stroke(NeonBrutalismTheme.electricBlue.opacity(0.3), lineWidth: 1)
                    )
                    .cornerRadius(3)
                }
                .buttonStyle(.plain)
                .disabled(isTesting)
            }

            // 状态反馈
            if aiApplied {
                Text("已应用")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundColor(NeonBrutalismTheme.expGreen)
            }

            if let result = testResult {
                Text(result)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(result.contains("成功") ? .green : .red)
                    .lineLimit(2)
            }
        }
    }

    // MARK: - Active Model Badge

    private var activeModelBadge: some View {
        let c = agentManager.config
        let provider = c.aiProvider == "openai" ? "OpenAI" : "Gemini"
        let model = c.aiProvider == "openai" ? c.openaiModel : c.geminiModel
        let hasKey = c.aiProvider == "openai"
            ? (c.openaiApiKey != nil && !c.openaiApiKey!.isEmpty)
            : (c.geminiApiKey != nil && !c.geminiApiKey!.isEmpty)

        return HStack(spacing: 5) {
            Circle()
                .fill(hasKey ? NeonBrutalismTheme.expGreen : NeonBrutalismTheme.dangerRed)
                .frame(width: 6, height: 6)
            Text("\(provider) · \(model)")
                .font(.system(size: 9, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(Color.white.opacity(0.03))
        .cornerRadius(3)
    }

    // MARK: - Capture Section

    private var captureSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader("捕捉", icon: "camera")

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("画质")
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                    Spacer()
                    Text("\(Int(jpegQuality * 100))%")
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.electricBlue)
                }
                Slider(value: $jpegQuality, in: 0.3...1.0, step: 0.1)
                    .controlSize(.mini)
                    .onChange(of: jpegQuality) { _ in saveCaptureAndPrivacy() }
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("间隔")
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.textSecondary)
                    Spacer()
                    Text("\(Int(screenshotInterval))秒")
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .foregroundColor(NeonBrutalismTheme.electricBlue)
                }
                Slider(value: $screenshotInterval, in: 5...60, step: 5)
                    .controlSize(.mini)
                    .onChange(of: screenshotInterval) { _ in saveCaptureAndPrivacy() }
            }
        }
    }

    // MARK: - Privacy Section

    private var privacySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader("隐私", icon: "lock.shield")

            Text("排除应用")
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textSecondary)

            TextEditor(text: $excludedApps)
                .font(.system(size: 9, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textPrimary)
                .scrollContentBackground(.hidden)
                .background(Color.white.opacity(0.03))
                .overlay(
                    RoundedRectangle(cornerRadius: 3)
                        .stroke(NeonBrutalismTheme.electricBlue.opacity(0.15), lineWidth: 1)
                )
                .frame(height: 80)
                .onChange(of: excludedApps) { _ in saveCaptureAndPrivacy() }

            Text("每行一个 Bundle ID")
                .font(.system(size: 8, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textSecondary.opacity(0.6))
        }
    }

    // MARK: - Components

    private func sectionHeader(_ title: String, icon: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundColor(NeonBrutalismTheme.electricBlue)
            Text(title)
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textPrimary)
        }
    }

    private func providerButton(_ label: String, id: String) -> some View {
        Button(action: {
            aiProvider = id
            markAIDirty()
        }) {
            Text(label)
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
                .background(
                    aiProvider == id
                        ? NeonBrutalismTheme.electricBlue.opacity(0.2)
                        : Color.white.opacity(0.03)
                )
                .foregroundColor(
                    aiProvider == id
                        ? NeonBrutalismTheme.electricBlue
                        : NeonBrutalismTheme.textSecondary
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 3)
                        .stroke(
                            aiProvider == id
                                ? NeonBrutalismTheme.electricBlue.opacity(0.5)
                                : NeonBrutalismTheme.electricBlue.opacity(0.1),
                            lineWidth: 1
                        )
                )
                .cornerRadius(3)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func settingsField(
        _ label: String,
        secure: Bool = false,
        text: Binding<String>
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textSecondary)

            Group {
                if secure {
                    SecureField("", text: text)
                } else {
                    TextField("", text: text)
                }
            }
            .textFieldStyle(.plain)
            .font(.system(size: 10, design: .monospaced))
            .foregroundColor(NeonBrutalismTheme.textPrimary)
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(Color.white.opacity(0.03))
            .overlay(
                RoundedRectangle(cornerRadius: 3)
                    .stroke(NeonBrutalismTheme.electricBlue.opacity(0.15), lineWidth: 1)
            )
            .onChange(of: text.wrappedValue) { _ in markAIDirty() }
        }
    }

    // MARK: - Actions

    private func markAIDirty() {
        aiDirty = true
        aiApplied = false
    }

    private func applyAISettings() {
        var c = AgentConfig.load()
        c.aiProvider = aiProvider
        c.geminiApiKey = geminiApiKey.isEmpty ? nil : geminiApiKey
        c.geminiApiBase = geminiApiBase
        c.geminiModel = geminiModel
        c.openaiApiKey = openaiApiKey.isEmpty ? nil : openaiApiKey
        c.openaiApiBase = openaiApiBase
        c.openaiModel = openaiModel
        c.save()
        agentManager.reloadConfig()
        aiDirty = false
        aiApplied = true
        testResult = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            aiApplied = false
        }
    }

    private func saveCaptureAndPrivacy() {
        var c = AgentConfig.load()
        c.captureJpegQuality = jpegQuality
        c.screenshotInterval = screenshotInterval
        c.excludedApps = excludedApps
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        c.save()
        agentManager.reloadConfig()
    }

    // MARK: - Load

    private func loadFromConfig() {
        let c = agentManager.config
        aiProvider = c.aiProvider
        geminiApiKey = c.geminiApiKey ?? ""
        geminiApiBase = c.geminiApiBase
        geminiModel = c.geminiModel
        openaiApiKey = c.openaiApiKey ?? ""
        openaiApiBase = c.openaiApiBase
        openaiModel = c.openaiModel
        jpegQuality = c.captureJpegQuality
        screenshotInterval = c.screenshotInterval
        excludedApps = c.excludedApps.joined(separator: "\n")
    }

    private func testConnection() {
        // 先应用再测试，确保测试的是当前编辑的配置
        applyAISettings()
        isTesting = true
        testResult = nil
        Task {
            let client = AIClient(config: agentManager.config)
            let result = await client.testConnection()
            testResult = result.message
            isTesting = false
        }
    }
}
