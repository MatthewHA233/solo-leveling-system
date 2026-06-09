// ══════════════════════════════════════════════
// TranscribePrepOverlay — 转录等待期 HUD 文字层
//
// 真实流程：
//   1) extracting：本地视频 → FFmpeg 提取音轨
//   2) uploading：本地音频 → DashScope OSS
//   3) streaming：ASR FileTrans 任务处理 → 时间戳段落
//
// 设计：canvas 粒子作中央"反应堆"由 TranscribeIdleAnimation 在父层提供。
// 本组件叠加 HUD 文字 + 顶/底 DOM 粒子流（SOURCE ↓ 反应堆 ↓ SINK），
// 文字带光标闪烁 / 横向扫光 / 点点点，避免静态"油漆感"。
// ══════════════════════════════════════════════

import { theme } from '../theme'

const ACCENT = '#00d7e8'
const SIGNAL = '#00ffe0'
const AMBER = '#ffb454'
const VIDEO_COLOR = '#7df9ff'

interface Props {
  stage: 'extracting' | 'uploading' | 'streaming'
}

export default function TranscribePrepOverlay({ stage }: Props) {
  const isStreaming = stage === 'streaming'
  const srcColor = isStreaming ? SIGNAL : VIDEO_COLOR
  const sinkColor = stage === 'uploading' ? AMBER : ACCENT
  const copy = phaseCopy(stage)

  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column',
      justifyContent: 'space-between',
      padding: '18px 18px 22px',
      pointerEvents: 'none',
      zIndex: 2,
    }}>
      <style>{KEYFRAMES}</style>

      {/* 顶部 SOURCE + 入流 */}
      <div style={{ flexShrink: 0 }}>
        <SrcLabel tag={copy.sourceTag} title={copy.sourceTitle} meta={copy.sourceMeta} color={srcColor} />
        <FlowBar color={srcColor} />
      </div>

      {/* 中央阶段标签（带扫光 + 光标） */}
      <CenterTag label={copy.centerLabel} sub={copy.centerSub} color={stage === 'uploading' ? AMBER : ACCENT} />

      {/* 底部出流 + SINK */}
      <div style={{ flexShrink: 0 }}>
        <FlowBar color={sinkColor} />
        <SinkLabel tag={copy.sinkTag} title={copy.sinkTitle} meta={copy.sinkMeta} color={sinkColor} />
      </div>
    </div>
  )
}

function phaseCopy(stage: Props['stage']) {
  if (stage === 'extracting') {
    return {
      sourceTag: 'SOURCE · LOCAL',
      sourceTitle: '本地视频',
      sourceMeta: 'MP4 / MOV · 读取音轨',
      centerLabel: 'EXTRACT · 音轨提取中',
      centerSub: 'ffmpeg · audio only',
      sinkTag: 'SINK · CACHE',
      sinkTitle: '本地音频缓存',
      sinkMeta: '生成 m4a · 准备上传',
    }
  }
  if (stage === 'uploading') {
    return {
      sourceTag: 'SOURCE · AUDIO',
      sourceTitle: '本地音频',
      sourceMeta: 'M4A · 仅上传音轨',
      centerLabel: 'PUT · 音频上传中',
      centerSub: 'dashscope oss · multipart',
      sinkTag: 'SINK · DASHSCOPE',
      sinkTitle: 'OSS 临时文件',
      sinkMeta: '等待握手 · 准备提交 ASR',
    }
  }
  return {
    sourceTag: 'SOURCE · OSS',
    sourceTitle: 'ASR FILETRANS',
    sourceMeta: '任务已提交 · 等待结果',
    centerLabel: 'ASR · 语音识别中',
    centerSub: 'sentence timestamp · polling',
    sinkTag: 'SINK',
    sinkTitle: '时间戳段落',
    sinkMeta: '等待句级时间轴',
  }
}

interface LabelProps { tag: string; title: string; meta: string; color: string }

function SrcLabel({ tag, title, meta, color }: LabelProps) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        fontFamily: theme.fontMono, fontSize: 8.5, fontWeight: 600,
        letterSpacing: 3, color: theme.textMuted,
      }}>{tag}</div>
      <div style={{
        fontFamily: theme.fontDisplay, fontSize: 13, fontWeight: 700,
        letterSpacing: 4, color,
        textShadow: `0 0 10px ${color}66`,
        marginTop: 3,
      }}>{title}</div>
      <div style={{
        fontFamily: theme.fontMono, fontSize: 9.5, fontWeight: 500,
        letterSpacing: 1.2, color: `${color}AA`,
        marginTop: 2,
      }}>
        [ {meta}<DotsAnim />]
      </div>
    </div>
  )
}

function SinkLabel({ tag, title, meta, color }: LabelProps) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        fontFamily: theme.fontMono, fontSize: 9.5, fontWeight: 500,
        letterSpacing: 1.2, color: `${color}AA`,
      }}>
        [ {meta}<DotsAnim />]
      </div>
      <div style={{
        fontFamily: theme.fontDisplay, fontSize: 13, fontWeight: 700,
        letterSpacing: 4, color,
        textShadow: `0 0 10px ${color}66`,
        marginTop: 2,
      }}>{title}</div>
      <div style={{
        fontFamily: theme.fontMono, fontSize: 8.5, fontWeight: 600,
        letterSpacing: 3, color: theme.textMuted,
        marginTop: 3,
      }}>{tag}</div>
    </div>
  )
}

function CenterTag({ label, sub, color }: { label: string; sub: string; color: string }) {
  return (
    <div style={{
      alignSelf: 'center', textAlign: 'center',
      position: 'relative',
      padding: '6px 16px',
      border: `1px solid ${color}88`,
      background: 'rgba(1, 10, 14, 0.68)',
      backdropFilter: 'blur(2px)',
      WebkitBackdropFilter: 'blur(2px)',
      clipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)',
      WebkitClipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)',
      overflow: 'hidden',
      boxShadow: `0 0 16px ${color}2e`,
    }}>
      {/* 内部横向扫光 */}
      <div style={{
        position: 'absolute', inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute',
          top: 0, bottom: 0,
          width: '40%',
          background: `linear-gradient(90deg, transparent, ${color}2e 50%, transparent)`,
          animation: 'tpx-sweep 1.8s linear infinite',
        }} />
      </div>

      <div style={{
        position: 'relative',
        fontFamily: theme.fontMono, fontSize: 10, fontWeight: 700,
        letterSpacing: 3, color,
        textShadow: `0 0 8px ${color}77`,
        whiteSpace: 'nowrap',
      }}>
        {label}
        <span style={{
          display: 'inline-block', marginLeft: 4, width: 6,
          color,
          animation: 'tpx-blink 0.9s steps(2) infinite',
        }}>▍</span>
      </div>
      <div style={{
        position: 'relative',
        fontFamily: theme.fontMono, fontSize: 8.5, fontWeight: 500,
        letterSpacing: 1.5, color: theme.textMuted,
        marginTop: 3,
      }}>
        {sub}
      </div>
    </div>
  )
}

// 竖向粒子流（4 颗下落，配合渐变光柱）
function FlowBar({ color }: { color: string }) {
  const particles = [0, 1, 2, 3]
  return (
    <div style={{
      position: 'relative',
      width: 2,
      height: 56,
      margin: '8px auto 0',
      background: `linear-gradient(180deg, ${color}99 0%, ${color}22 100%)`,
      boxShadow: `0 0 4px ${color}66`,
      overflow: 'hidden',
    }}>
      {particles.map((i) => (
        <div key={i} style={{
          position: 'absolute',
          left: -2, width: 6, height: 6,
          background: color,
          borderRadius: '50%',
          boxShadow: `0 0 6px ${color}, 0 0 12px ${color}99`,
          animation: `tpx-flow-down 1.6s linear ${-i * 0.4}s infinite`,
        }} />
      ))}
    </div>
  )
}

// 文字尾部"."."."." 流动点
function DotsAnim() {
  return (
    <span style={{ display: 'inline-block', width: 14, textAlign: 'left' }}>
      <span style={{ animation: 'tpx-dots-1 1.4s linear infinite', opacity: 0 }}>.</span>
      <span style={{ animation: 'tpx-dots-2 1.4s linear infinite', opacity: 0 }}>.</span>
      <span style={{ animation: 'tpx-dots-3 1.4s linear infinite', opacity: 0 }}>.</span>
    </span>
  )
}

const KEYFRAMES = `
@keyframes tpx-flow-down {
  0%   { top: -8px; opacity: 0; }
  10%  { opacity: 1; }
  85%  { opacity: 1; }
  100% { top: calc(100% + 4px); opacity: 0; }
}
@keyframes tpx-sweep {
  0%   { left: -40%; }
  100% { left: 100%; }
}
@keyframes tpx-blink {
  0%, 49%   { opacity: 1; }
  50%, 100% { opacity: 0; }
}
@keyframes tpx-dots-1 {
  0%, 14%, 100% { opacity: 0; }
  20%, 80%      { opacity: 1; }
}
@keyframes tpx-dots-2 {
  0%, 28%, 100% { opacity: 0; }
  34%, 80%      { opacity: 1; }
}
@keyframes tpx-dots-3 {
  0%, 42%, 100% { opacity: 0; }
  48%, 80%      { opacity: 1; }
}
`
