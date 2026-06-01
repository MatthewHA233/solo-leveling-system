# 洪流域 Parser 模块

洪流域 raw 采集层只负责记录 `TorrentCapture`。具体软件的“还原动作 / 还原卡片 / 正式转译草稿”由 parser 模块负责。

## 模块边界

每个软件一个模块，导出 `TorrentParserModule<TListItem>`：

- `id` / `version`：用于正式表的 `parser_id` / `parser_version`
- `packages`：模块负责的 Android package 列表
- `canParse(capture)`：判断 raw 是否属于该模块
- `buildFeedListItems(raw)`：构建还原卡片 UI 数据
- `buildActionListItems(raw)`：构建还原动作 UI 数据
- `buildFormalActions(raw)`：构建可持久化的动作草稿
- `buildFormalCards(raw)`：构建可持久化的卡片草稿

当前第一个标准模块是 `parsers/bilibili.ts`。后续微信、知乎、公众号等模块应按同一接口新增，并注册到 `registry.ts`。

## 给暗影智能体的约束

未来如果让智能体生成新软件模块，它只应该改动一个新 parser 目录/文件和 fixtures，不直接改 `TorrentScreen.tsx`：

1. 新增 parser module。
2. 给出 raw fixture。
3. 给出 expected actions/cards。
4. 由工作台或测试脚本跑 golden diff。
5. 人确认后再注册到 `registry.ts`。

这样可以让 AI 参与解析规则编写，但不会随意改 UI、数据库或 native 采集层。
