// 清单范围：哪些桌面端源码要逐段核对。`only` 表示大文件里只取匹配的段落，其余和 Fairy 无关。
const D = 'clients/desktop/src/'
const R = 'clients/desktop/src-tauri/src/'
const M = 'clients/mobile/src/'
const K = 'clients/mobile/android/app/src/main/java/com/solevup/mobile/'

const CHAT_DB = /chat_|ChatSession|ChatMessage|SessionSearchHit|MessageSnippet|build_excerpt/
const LIB_RS = `${R}lib.rs`
const LOCAL_API = `${D}lib/local-api.ts`
const MODEL_DB = /model_|Model[A-Z]|api_key|ApiKey|provider|PROVIDER|pricing|Pricing|free_quota|FreeQuota|feature_binding|FeatureBinding|call_log|CallLog|compute_cost|billable/

export const SCOPE = [
  {
    id: 'B01-llm',
    title: 'LLM 流式、重试、查询循环、上下文窗口、Anthropic 通道',
    files: [
      { file: `${D}lib/llm/types.ts`, target: `${M}lib/llm/types.ts` },
      { file: `${D}lib/llm/normalize.ts`, target: `${M}lib/llm/normalize.ts` },
      { file: `${D}lib/llm/retry.ts`, target: `${M}lib/llm/retry.ts` },
      { file: `${D}lib/llm/stream.ts`, target: `${M}lib/llm/stream.ts` },
      { file: `${D}lib/llm/api.ts`, target: `${M}lib/llm/api.ts` },
      { file: `${D}lib/llm/query-loop.ts`, target: `${M}lib/llm/query-loop.ts` },
      { file: `${D}lib/llm/context-window.ts`, target: `${M}lib/llm/context-window.ts` },
      { file: `${D}lib/llm/compact.ts`, target: `${M}lib/llm/compact.ts` },
      { file: `${D}lib/llm/anthropic-stream.ts`, target: `${M}lib/llm/anthropic-stream.ts` },
      { file: `${R}anthropic.rs`, target: `${M}lib/llm/anthropic-stream.ts` },
      { file: `${R}anthropic_stream.rs`, target: `${M}lib/llm/anthropic-stream.ts` },
      { file: LIB_RS, only: /anthropic/, target: `${M}lib/llm/anthropic-stream.ts` },
    ],
  },
  {
    id: 'B02-agent',
    title: '提示词、意图分类、工具、配置、会话记忆',
    files: [
      { file: `${D}lib/ai/prompt-templates.ts`, target: `${M}lib/ai/prompt-templates.ts` },
      { file: `${D}lib/ai/context-intent.ts`, target: `${M}lib/ai/context-intent.ts` },
      { file: `${D}lib/agent/agent-config.ts`, target: `${M}lib/agent/agent-config.ts` },
      { file: `${D}lib/agent/agent-memory.ts`, target: `${M}lib/agent/agent-memory.ts` },
      { file: `${D}lib/agent/chat-history.ts`, target: `${M}lib/agent/chat-history.ts` },
      { file: `${D}lib/agent/chat-compaction.ts`, target: `${M}lib/agent/chat-compaction.ts` },
      { file: `${D}lib/agent/agent-tools.ts`, target: `${M}lib/agent/tools/` },
      { file: `${D}lib/agent/index.ts`, target: `${M}lib/agent/index.ts` },
      { file: `${D}lib/bili-transcript.ts`, target: `${M}lib/agent/tools/` },
      { file: `${R}fairy_fs.rs`, target: `${K}fairyfs/` },
      { file: LIB_RS, only: /fairy_fs|fairy_workspace|文件操作命令/, target: `${K}fairyfs/` },
      { file: LOCAL_API, only: /fetchPerceptionSpans|fetchBiliSpans|fetchActivityBlocks|fetchActivityPalette|fetchContextFeed|fetchCardBindings|addContextCard|addBinding|updateContextCard|updateAnchorKeyword|PerceptionSpan|BiliSpan/, target: `${M}lib/agent/tools/` },
      { file: `${D}types.ts`, target: '' },
    ],
  },
  {
    id: 'B03-sessions',
    title: '会话标题、会话选择器、聊天表读写',
    files: [
      { file: `${D}lib/ai/session-title.ts`, target: `${M}lib/ai/session-title.ts` },
      { file: `${D}lib/ai/session-title-flow.ts`, target: `${M}lib/ai/session-title-flow.ts` },
      { file: `${D}components/SessionPicker.tsx`, target: `${M}components/fairy/SessionPicker.tsx` },
      { file: `${R}db.rs`, only: CHAT_DB, target: `${K}solevupdb/SolevupDb.kt` },
      { file: `${R}api.rs`, only: /chat_session|chat_messages|cleanup_empty|search_chat|ChatSession/, target: `${K}solevupdb/SolevupDbModule.kt` },
      { file: LOCAL_API, only: /[Cc]hat|SessionSearch/, target: `${M}lib/solevupdb.ts` },
    ],
  },
  {
    id: 'B04-models',
    title: '模型库、计费、Key 管理、用量界面',
    files: [
      { file: `${D}lib/model-audit.ts`, target: `${M}lib/models/model-audit.ts` },
      { file: `${D}lib/model-display.ts`, target: `${M}lib/models/model-display.ts` },
      { file: `${D}lib/models/models-dev.ts`, target: `${M}lib/models/models-dev.ts` },
      { file: `${D}components/ModelDialog.tsx`, target: `${M}components/models/` },
      { file: `${D}components/ModelUsageBadge.tsx`, target: `${M}components/models/ModelUsageBadge.tsx` },
      { file: `${R}db.rs`, only: MODEL_DB, target: `${K}solevupdb/SolevupDb.kt` },
      { file: LIB_RS, only: /model|Model|api_key|free_quota|feature_binding/, target: `${K}solevupdb/SolevupDbModule.kt` },
      { file: LOCAL_API, only: /Model[A-Z]|[a-z]Model|ApiKey|FreeQuota|FeatureBinding|model_|CallLog/, target: `${M}lib/solevupdb.ts` },
    ],
  },
  {
    id: 'B05-voice',
    title: '原生语音：录音、流式识别、Fish TTS、Omni 实时',
    files: [
      { file: `${D}lib/voice/voice-service.ts`, target: `${M}lib/voice/voice-service.ts` },
      { file: `${D}lib/voice/voice-recorder.ts`, target: `${M}lib/voice/voice-recorder.ts` },
      { file: `${D}lib/voice/asr-hints.ts`, target: `${M}lib/voice/asr-hints.ts` },
      { file: `${D}lib/voice/fish-tts-tauri.ts`, target: `${M}lib/voice/fish-tts.ts` },
      { file: `${D}lib/voice/index.ts`, target: `${M}lib/voice/index.ts` },
      { file: `${R}voice/mod.rs`, target: `${K}voice/` },
      { file: `${R}voice/asr_stream.rs`, target: `${K}voice/AsrStreamClient.kt` },
      { file: `${R}voice/capture.rs`, target: `${K}voice/VoiceCapture.kt` },
      { file: `${R}voice/resample.rs`, target: `${K}voice/VoiceCapture.kt` },
      { file: `${R}fish_tts.rs`, target: `${K}voice/FishTtsClient.kt` },
      { file: `${R}qwen_omni.rs`, target: `${K}omni/` },
      { file: `${D}lib/network-api.ts`, target: `${M}lib/voice/fish-tts.ts` },
      { file: `${R}network.rs`, target: `${K}voice/` },
      { file: LIB_RS, only: /fish_tts|omni_|voice_|voice::|asr_/, target: `${K}voice/` },
      { file: `${D}lib/voice/omni-turn.ts`, target: `${M}lib/voice/omni-turn.ts` },
      { file: `${D}lib/voice/pcm16.ts`, target: `${K}voice/PcmPlayer.kt` },
    ],
  },
  {
    id: 'B06-chat-ui',
    title: '聊天面板、气泡、Markdown、调试弹窗',
    files: [
      { file: `${D}components/ChatPanel.tsx`, target: `${M}components/fairy/` },
      { file: `${D}components/FairyMarkdown.tsx`, target: `${M}components/fairy/FairyMarkdown.tsx` },
      { file: `${D}components/DebugRequestModal.tsx`, target: `${M}components/fairy/DebugRequestModal.tsx` },
      { file: `${D}components/OmniDebugModal.tsx`, target: `${M}components/fairy/DebugRequestModal.tsx` },
      { file: `${D}components/HudSelect.tsx`, target: '' },
      { file: `${D}components/NeonUI.tsx`, target: '' },
      { file: `${D}components/Tooltip.tsx`, target: '' },
      { file: `${D}components/ui/IconButton.tsx`, target: '' },
      { file: `${D}components/ui/LedSegments.tsx`, target: '' },
      { file: `${D}theme.ts`, target: '' },
      { file: `${D}lib/agent/chat-images.ts`, target: `${M}lib/agent/chat-images.ts` },
      { file: LIB_RS, only: /chat_image/, target: `${K}chatimage/` },
    ],
  },
  {
    id: 'B07-fairy-flow',
    title: 'Fairy 窗口与 App 主流程（发送、语音、压缩、中断、设置）',
    files: [
      { file: `${D}components/FairyWindow.tsx`, target: `${M}components/AgentPanel.tsx` },
      { file: `${D}components/FairyHUD.tsx`, target: `${M}components/FairyOrb.tsx` },
      { file: `${D}App.tsx`, target: `${M}lib/agent/chat-controller.ts` },
    ],
  },
  {
    id: 'B08-distill',
    title: '后台提炼：想法卡、语境锚点、片段定位',
    files: [
      { file: `${D}lib/thought-distill.ts`, target: `${M}lib/ai/thought-distill.ts` },
      { file: `${D}lib/anchor-to-context.ts`, target: `${M}lib/ai/anchor-to-context.ts` },
      { file: `${D}lib/segment-locate.ts`, target: `${M}lib/ai/segment-locate.ts` },
      { file: `${D}lib/anchor-taxonomy.ts`, target: `${M}lib/ai/anchor-taxonomy.ts` },
      { file: `${D}lib/anchor-extract.ts`, target: `${M}lib/ai/anchor-extract.ts` },
      { file: `${D}lib/anchor-embedding.ts`, target: `${M}lib/ai/anchor-embedding.ts` },
      { file: LOCAL_API, only: /Thought|thought|Anchor|anchor|Embedding|embedding/, target: `${M}lib/ai/thought-distill.ts` },
      { file: `${R}db.rs`, only: /context_feed|context_card|ContextCard|anchor|Anchor|card_binding|CardBinding|thought|Thought/, target: `${M}lib/ai/thought-distill.ts` },
      { file: `${R}api.rs`, only: /context_feed|context_card|ContextCard|anchor|Anchor|card_binding|CardBinding|thought|Thought/, target: `${M}lib/ai/thought-distill.ts` },
    ],
  },
  {
    id: 'B09-sync',
    title: '局域网同步协议（主线程已实现，逐段核对）',
    files: [
      { file: `${R}sync_engine.rs`, target: `${K}sync/SyncCoordinator.kt` },
      { file: `${R}sync_discovery.rs`, target: `${K}sync/SyncDiscovery.kt` },
      { file: `${R}db.rs`, only: /sync|Sync|linked|Linked|device_id|pair_code|generate_alias/, target: `${K}solevupdb/SolevupDb.kt` },
      { file: `${R}api.rs`, only: /sync_|SyncHello|create_router|SYNC_BODY/, target: `${K}syncserver/SyncHttpServer.kt` },
      { file: LOCAL_API, only: /[Ss]ync|Linked|linked|Peer|peer/, target: `${M}lib/syncclient.ts` },
      { file: `${R}sync_auth.rs`, target: `${K}sync/SyncPairing.kt` },
      { file: `${D}components/SyncPeerDialog.tsx`, target: `${M}components/sync/PairingCard.tsx` },
      { file: `${D}lib/agent/synced-settings.ts`, target: `${M}lib/agent/synced-settings.ts` },
    ],
  },
  {
    id: 'B10-settings',
    title: '设置面板（人设、语音、模型、Fairy 相关项）',
    files: [
      { file: `${D}components/SettingsPanel.tsx`, target: `${M}components/fairy/FairySettingsSheet.tsx` },
    ],
  },
]

// 看代码内容判断，不看符号名：相邻小段合并后，符号名可能以「导入」开头却混着常量和类型
function onlyImports(body) {
  const rest = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\bimport\b[^;'"]*?from\s*['"][^'"]+['"];?/g, '')
    .replace(/\bimport\s*['"][^'"]+['"];?/g, '')
    .replace(/^\s*(pub\s+)?use\s[^;]*;/gm, '')
    .replace(/^\s*#\[[^\]]*\]\s*$/gm, '')
  return rest.trim() === ''
}

export const AUTO_SKIP = [
  {
    test: (row) => onlyImports(row.body),
    reason: '模块导入，随手机端实现调整',
  },
  {
    test: (row) => /components\/(HudSelect|NeonUI|Tooltip)\.tsx$|components\/ui\/(IconButton|LedSegments)\.tsx$|src\/theme\.ts$/.test(row.file),
    reason: '桌面端钛合金视觉基础件，手机端用浅色主题和原生控件',
  },
  {
    test: (row) => /src\/types\.ts$/.test(row.file),
    reason: '活动记录和计划节点的类型，不属于 Fairy；手机端已有 src/types.ts',
  },
]
