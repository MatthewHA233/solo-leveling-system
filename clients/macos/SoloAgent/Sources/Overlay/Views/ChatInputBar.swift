import SwiftUI

/// 输入栏 — 文本输入 + /命令自动补全
struct ChatInputBar: View {
    @State private var inputText: String = ""
    @State private var showCompletions: Bool = false
    let onSend: (String) -> Void
    let skills: [any AgentSkill]

    var body: some View {
        HStack(spacing: 6) {
            TextField("输入指令...", text: $inputText)
                .textFieldStyle(.plain)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(NeonBrutalismTheme.textPrimary)
                .onSubmit { send() }
                .onChange(of: inputText) {
                    showCompletions = inputText.hasPrefix("/") && !inputText.contains(" ")
                }

            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 16))
                    .foregroundColor(
                        inputText.trimmingCharacters(in: .whitespaces).isEmpty
                            ? NeonBrutalismTheme.textSecondary
                            : NeonBrutalismTheme.electricBlue
                    )
            }
            .buttonStyle(.plain)
            .disabled(inputText.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color.white.opacity(0.03))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(NeonBrutalismTheme.electricBlue.opacity(0.12), lineWidth: 0.5)
                )
        )
        .padding(.horizontal, 8)
        .padding(.bottom, 6)
        .overlay(alignment: .top) {
            if showCompletions {
                CommandCompletionOverlay(
                    prefix: inputText,
                    skills: skills,
                    onSelect: { cmd in
                        inputText = cmd + " "
                        showCompletions = false
                    }
                )
                .offset(y: -4)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .animation(.easeOut(duration: 0.15), value: showCompletions)
    }

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        onSend(text)
        inputText = ""
        showCompletions = false
    }
}

// MARK: - Command Completion Overlay

private struct CommandCompletionOverlay: View {
    let prefix: String
    let skills: [any AgentSkill]
    let onSelect: (String) -> Void

    private var filtered: [any AgentSkill] {
        let query = prefix.lowercased()
        if query == "/" { return skills }
        return skills.filter { $0.command.lowercased().hasPrefix(query) }
    }

    var body: some View {
        if !filtered.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(filtered.enumerated()), id: \.offset) { _, skill in
                    Button(action: { onSelect(skill.command) }) {
                        HStack(spacing: 6) {
                            Image(systemName: skill.icon)
                                .font(.system(size: 10))
                                .foregroundColor(NeonBrutalismTheme.electricBlue)
                                .frame(width: 14)

                            Text(skill.command)
                                .font(.system(size: 10, weight: .bold, design: .monospaced))
                                .foregroundColor(NeonBrutalismTheme.electricBlue)

                            Text(skill.label)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(NeonBrutalismTheme.textSecondary)

                            Spacer()
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .onHover { hovering in
                        if hovering { NSCursor.pointingHand.push() }
                        else { NSCursor.pop() }
                    }
                }
            }
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color(red: 0.06, green: 0.06, blue: 0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(NeonBrutalismTheme.electricBlue.opacity(0.2), lineWidth: 0.5)
                    )
                    .shadow(color: .black.opacity(0.5), radius: 8)
            )
            .padding(.horizontal, 8)
        }
    }
}
