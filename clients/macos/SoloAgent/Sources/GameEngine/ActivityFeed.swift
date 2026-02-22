import Foundation

// MARK: - Feed Item Type

enum FeedItemType: String {
    case capture     // 捕获检测
    case exp         // 经验获得
    case quest       // 任务触发/完成
    case levelUp     // 等级提升
    case buff        // Buff/Debuff
    case system      // 系统消息
    case ai          // AI 分析结果
}

// MARK: - Feed Item

struct ActivityFeedItem: Identifiable {
    let id: UUID
    let timestamp: Date
    let type: FeedItemType
    let icon: String          // SF Symbol name
    let title: String         // e.g. "Cursor | coding"
    let subtitle: String      // e.g. "使用 Cursor → 专注度 0.8"
    let expAmount: Int        // 0 = 不显示

    init(
        type: FeedItemType,
        icon: String,
        title: String,
        subtitle: String = "",
        expAmount: Int = 0
    ) {
        self.id = UUID()
        self.timestamp = Date()
        self.type = type
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.expAmount = expAmount
    }

    /// 类型对应的显示颜色名 (在 View 层映射到 HolographicTheme)
    var colorKey: String {
        switch type {
        case .capture:  return "blue"
        case .exp:      return "green"
        case .quest:    return "purple"
        case .levelUp:  return "gold"
        case .buff:     return "purple"
        case .system:   return "secondary"
        case .ai:       return "cyan"
        }
    }
}

// MARK: - Activity Feed

@MainActor
class ActivityFeed: ObservableObject {
    @Published var items: [ActivityFeedItem] = []

    private let maxItems = 50

    func push(_ item: ActivityFeedItem) {
        items.append(item)
        if items.count > maxItems {
            items.removeFirst(items.count - maxItems)
        }
    }

    /// 最新一条的分类图标 (用于迷你条)
    var latestIcon: String? {
        items.last?.icon
    }

    /// 最新一条的颜色 key
    var latestColorKey: String? {
        items.last?.colorKey
    }

    // MARK: - Helpers

    /// 根据 ActivityCategory 返回对应的 SF Symbol
    static func iconForCategory(_ category: String) -> String {
        switch category {
        case "coding":        return "chevron.left.forwardslash.chevron.right"
        case "writing":       return "pencil.line"
        case "learning":      return "book.fill"
        case "reading":       return "book.fill"
        case "browsing":      return "globe"
        case "media":         return "play.rectangle.fill"
        case "social":        return "bubble.left.and.bubble.right.fill"
        case "gaming":        return "gamecontroller.fill"
        case "communication": return "message.fill"
        case "design":        return "paintbrush.fill"
        case "work":          return "briefcase.fill"
        case "creative":      return "sparkles"
        case "shopping":      return "cart.fill"
        case "research":      return "magnifyingglass"
        case "meeting":       return "person.3.fill"
        case "idle":          return "moon.fill"
        default:              return "questionmark.circle"
        }
    }
}
