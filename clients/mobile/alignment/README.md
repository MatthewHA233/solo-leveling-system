# 手机端 Fairy 对齐清单

把桌面端源码按语法切成连续不重叠的段落，每段记录它在手机端的去向。按段核对，而不是按功能模块核对，这样才能看出漏了什么。

## 命令

```bash
node clients/mobile/alignment/tool.mjs generate   # 按 scope.mjs 切段并写 batches/*.md，已填的状态按「文件+符号」保留
node clients/mobile/alignment/tool.mjs check      # 校验清单和源码一致、状态填写合规、落点文件存在
node clients/mobile/alignment/tool.mjs status     # 各批次进度
node clients/mobile/alignment/tool.mjs excluded   # 列出大文件里未收录的段落，写到 excluded.txt
node clients/mobile/alignment/tool.mjs mark B01.001-B01.013,B01.020 已对齐 clients/mobile/src/lib/llm/types.ts "说明"
```

`mark` 会把哈希刷新成当前源码的值，所以只在真正核对过这一段之后才用。

## 状态

| 状态 | 含义 | 必填 |
|---|---|---|
| 待迁移 | 还没处理 | |
| 已对齐 | 手机端逻辑和这段一致，可以逐条对照 | 落点 |
| 已适配 | 功能保留，但因平台不同换了做法 | 落点 + 差异说明 |
| 不迁移 | 手机端不需要这段 | 原因 |

- 落点写手机端的具体文件路径，最好带符号，例如 `clients/mobile/src/lib/llm/retry.ts:withRetry`。路径要存在，`check` 会验证。
- 不迁移的原因要具体，比如「Windows 独显偏好，手机没有这个概念」。「不需要」这种写法不算原因。
- 只看过没改，也要真正读完手机端对应代码再标已对齐。

## 哈希

每段记录内容哈希。桌面端改了某段，`check` 会报「桌面端已改动」，那一段要重新核对，确认后把哈希改成新值。

## 桌面端也要改的情况

多端一起进化。桌面端写得不合理的地方，直接改桌面端，并在说明里写「桌面端已改：原因」。改完运行 `generate` 刷新行号，再核对被改的段。

## 平台差异的默认做法

- 视觉：功能对齐，外观不抄。手机端是浅色克制主题，不搬桌面端的钛合金、霓虹效果。
- Tauri 命令：换成 Kotlin NativeModule，或直接在 JS 里 fetch。
- 窗口、托盘、全局热键、WebView2：手机没有这些概念，标不迁移，并写清手机端的对应入口（如果有）。
- 第三方 native 包：除非必要不引入。
- 公开仓库：示例和提示词一律用虚构内容，不写真实个人信息；密钥不进仓库。
