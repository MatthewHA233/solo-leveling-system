// ══════════════════════════════════════════════
// 聚焦栏 —— 选中一颗动机时，底部只剩它的原话与几个去向
//   原话用宋体：这是你自己的话；操作是平实的动词，不做发光按钮
// ══════════════════════════════════════════════

import type { MotiveDestiny } from '../../lib/local-api'

export const SERIF = "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif"
const SANS = "'Exo 2', 'Microsoft YaHei', 'PingFang SC', sans-serif"
const MOTIVE = '#FF9933'

interface Props {
  readonly text: string
  readonly contextCount: number
  readonly destiny: MotiveDestiny
  readonly hasBlueprint: boolean
  readonly canAddDirection: boolean
  readonly generating: boolean
  readonly error: string | null
  readonly onExpand: () => void
  readonly onAddDirection: () => void
  readonly onWish: () => void
  readonly onReturnToCloud: () => void
  readonly onRelease: () => void
}

export default function FocusBar({
  text, contextCount, destiny, hasBlueprint, canAddDirection, generating, error,
  onExpand, onAddDirection, onWish, onReturnToCloud, onRelease,
}: Props) {
  const isWish = destiny === 'wish'
  return (
    <div className="mc-focus" onClick={(e) => e.stopPropagation()}>
      <p className="mc-focus-text">{text}</p>
      {contextCount > 0 && (
        <p className="mc-focus-meta">出自 {contextCount} 处记录</p>
      )}

      {generating ? (
        <p className="mc-focus-status">正在展开……</p>
      ) : (
        <div className="mc-focus-actions">
          {isWish && (
            <button type="button" className="mc-act" onClick={onReturnToCloud}>带回云里</button>
          )}
          {!hasBlueprint && (
            <button type="button" className="mc-act mc-primary" onClick={onExpand}>展开成行动</button>
          )}
          {hasBlueprint && (
            <button type="button" className="mc-act" onClick={onExpand}>重新展开</button>
          )}
          {hasBlueprint && canAddDirection && (
            <button type="button" className="mc-act" onClick={onAddDirection}>加一个方向</button>
          )}
          {!isWish && (
            <button type="button" className="mc-act" onClick={onWish}>留作愿望</button>
          )}
          <button type="button" className="mc-act mc-release" onClick={onRelease}>放下</button>
        </div>
      )}
      {error && <p className="mc-focus-error">{error}</p>}

      <style>{`
        .mc-focus {
          position: absolute; left: 50%; bottom: 30px; transform: translateX(-50%);
          width: min(760px, 90%); text-align: center; pointer-events: auto;
        }
        .mc-focus-text {
          margin: 0; font-family: ${SERIF}; font-size: 25px; font-weight: 600; line-height: 1.55;
          color: #F3E9DC; letter-spacing: 0.04em;
          animation: mc-rise 0.7s cubic-bezier(.2,.7,.1,1) both;
        }
        .mc-focus-meta {
          margin: 6px 0 0; font-family: 'JetBrains Mono', monospace; font-size: 11px;
          color: #6F7B86; letter-spacing: 0.08em;
        }
        .mc-focus-actions { margin-top: 18px; display: flex; justify-content: center; gap: 26px; flex-wrap: wrap; }
        .mc-act {
          font-family: ${SANS}; font-size: 13px; color: #BFB3A4; background: transparent;
          border: none; padding: 4px 0; cursor: pointer; border-bottom: 1px solid transparent;
          transition: color 0.15s, border-color 0.15s;
        }
        .mc-act:hover { color: #F3E9DC; border-bottom-color: rgba(243,233,220,0.4); }
        .mc-act:focus-visible { outline: 1px solid #F3E9DC; outline-offset: 4px; }
        .mc-primary { color: ${MOTIVE}; border-bottom-color: rgba(255,153,51,0.45); }
        .mc-primary:hover { color: #FFC58A; border-bottom-color: ${MOTIVE}; }
        .mc-release:hover { color: #E0A07A; border-bottom-color: rgba(224,160,122,0.45); }
        .mc-focus-status {
          margin: 18px 0 0; font-family: ${SANS}; font-size: 13px; color: #8E847A; letter-spacing: 0.1em;
        }
        .mc-focus-error { margin: 12px 0 0; font-family: ${SANS}; font-size: 12px; color: #E0A07A; }
        @keyframes mc-rise { from { opacity: 0; transform: translateY(8px); letter-spacing: 0.3em; } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  )
}
