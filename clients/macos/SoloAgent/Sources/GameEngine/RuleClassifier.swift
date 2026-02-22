import Foundation

/// Level 1 规则引擎 — 零 AI 成本，基于窗口标题/应用名分类
struct RuleClassifier {

    struct Classification {
        let category: ActivityCategory
        let confidence: Double
        let detail: String
    }

    // MARK: - Window Rules

    static let windowRules: [String: [String]] = [
        "coding": [
            "visual studio code", "vscode", "intellij", "pycharm", "webstorm",
            "xcode", "android studio", "sublime text", "vim", "neovim", "nvim",
            "terminal", "iterm", "warp", "alacritty", "cursor", "windsurf",
            "github desktop", "sourcetree", "tower", "终端",
        ],
        "writing": [
            "word", "google docs", "notion", "obsidian", "typora", "bear",
            "ulysses", "scrivener", "overleaf", "latex",
        ],
        "learning": [
            "coursera", "udemy", "edx", "khan academy", "leetcode",
            "hackerrank", "duolingo", "anki",
        ],
        "browsing": [
            "chrome", "firefox", "safari", "edge", "arc", "brave",
        ],
        "media": [
            "youtube", "netflix", "bilibili", "spotify", "apple music",
            "vlc", "iina", "plex", "disney+", "hbo",
        ],
        "social": [
            "twitter", "x.com", "weibo", "discord", "slack", "telegram",
            "whatsapp", "wechat", "微信", "qq", "line", "signal",
            "instagram", "facebook", "reddit", "threads",
        ],
        "gaming": [
            "steam", "epic games", "minecraft", "genshin", "原神",
            "league of legends", "valorant", "cs2",
        ],
        "communication": [
            "mail", "outlook", "thunderbird", "gmail", "邮件", "zoom",
            "teams", "meet", "facetime", "飞书", "钉钉", "腾讯会议",
        ],
        "design": [
            "figma", "sketch", "photoshop", "illustrator", "canva",
            "blender", "cinema 4d", "after effects", "premiere",
        ],
        "reading": [
            "kindle", "books", "pdf", "calibre", "readwise",
            "pocket", "instapaper", "微信读书", "图书",
        ],
    ]

    // MARK: - Browser Title Rules

    static let browserTitleRules: [String: [String]] = [
        "coding": [
            "github.com", "github", "gitlab.com", "gitlab", "stackoverflow.com",
            "stack overflow", "npm", "pypi", "docs.python", "developer.mozilla",
            "api reference", "documentation", "codepen", "replit",
        ],
        "learning": [
            "tutorial", "教程", "course", "lecture", "lesson",
            "how to", "guide", "learn", "学习",
        ],
        "social": [
            "twitter.com", "x.com", "reddit.com", "weibo.com",
            "discord.com", "instagram.com", "facebook.com",
        ],
        "media": [
            "youtube.com", "bilibili.com", "netflix.com", "spotify.com",
            "b站", "哔哩哔哩",
        ],
        "shopping": [
            "taobao", "jd.com", "amazon", "淘宝", "京东", "拼多多",
        ],
        "work": [
            "jira", "confluence", "asana", "trello", "monday.com",
            "linear", "clickup", "basecamp",
        ],
    ]

    // MARK: - Focus Score Map

    static let focusScoreMap: [String: Double] = [
        "coding": 0.8, "writing": 0.8, "work": 0.7, "learning": 0.7,
        "design": 0.7, "research": 0.7, "reading": 0.6, "meeting": 0.6,
        "communication": 0.5, "browsing": 0.4, "social": 0.3,
        "media": 0.2, "gaming": 0.2, "idle": 0.0, "unknown": 0.3,
        "creative": 0.7, "shopping": 0.2,
    ]

    // MARK: - Classify

    func classify(appName: String?, windowTitle: String?) -> Classification {
        let appLower = (appName ?? "").lowercased()
        let titleLower = (windowTitle ?? "").lowercased()

        // 1. Match app name
        for (category, keywords) in Self.windowRules {
            for kw in keywords {
                if appLower.contains(kw) {
                    if category == "browsing" {
                        if let refined = refineBrowserCategory(titleLower) {
                            return Classification(
                                category: ActivityCategory(rawValue: refined) ?? .browsing,
                                confidence: 0.75,
                                detail: "浏览器访问 \(String((windowTitle ?? "").prefix(50)))"
                            )
                        }
                        return Classification(
                            category: .browsing, confidence: 0.5,
                            detail: "浏览器: \(String((windowTitle ?? "").prefix(50)))"
                        )
                    }
                    return Classification(
                        category: ActivityCategory(rawValue: category) ?? .unknown,
                        confidence: 0.8,
                        detail: "使用 \(appName ?? "")"
                    )
                }
            }
        }

        // 2. Match window title
        for (category, keywords) in Self.windowRules {
            for kw in keywords {
                if titleLower.contains(kw) {
                    return Classification(
                        category: ActivityCategory(rawValue: category) ?? .unknown,
                        confidence: 0.6,
                        detail: "标题包含 \(kw)"
                    )
                }
            }
        }

        return Classification(
            category: .unknown, confidence: 0.3,
            detail: "未识别: \(appName ?? "") - \(String((windowTitle ?? "").prefix(30)))"
        )
    }

    func focusScore(for category: ActivityCategory) -> Double {
        Self.focusScoreMap[category.rawValue] ?? 0.3
    }

    // MARK: - Private

    private func refineBrowserCategory(_ title: String) -> String? {
        for (category, keywords) in Self.browserTitleRules {
            for kw in keywords {
                if title.contains(kw) {
                    return category
                }
            }
        }
        return nil
    }
}
