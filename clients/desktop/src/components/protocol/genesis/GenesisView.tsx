// ══════════════════════════════════════════════
// 协议志 · 开局 —— 梦想记事本：还没有任何协议时，系统先开口
//   ① 责任之镜：最近最不如意的事，AI 誊成便利贴贴在镜子上
//   ② 悬着的愿：一直想做却没做成的事，AI 誊成竖写的七夕短笺挂在竹枝上
//   ③ 照见：系统照一遍，写成一封信（只陈述，不评判）→ 觉醒片（本机有才出现）
//   ④ 人生金字塔：塔顶使命 / 中层领域 / 底层目标 ⑤ 未来车票：有日期的锚点，从今天出发 ⑥ 收下
//   每一章 AI 先提议、人在纸上就地改；改哪一章都不退回前面的步骤
//   下一刀：每周的大石头 → 每天的协议
// ══════════════════════════════════════════════

import { useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import MirrorView from './MirrorView'
import WishStrips from './WishStrips'
import ReflectionLetter from './ReflectionLetter'
import PyramidSheet from './PyramidSheet'
import TicketsView from './TicketsView'
import { System } from './genesis-parts'
import { stageIndex, type GenesisStage } from './genesis-model'
import { INK_VARS } from './notebook-ink'
import { useGenesis } from './use-genesis'
import './genesis.css'

/** 当前这一章做完、往下走的那颗键 */
function Next({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return <div className="gn-actions gn-next"><button type="button" className="ti-key gn-go" onClick={onClick}>{label}</button></div>
}

export default function GenesisView({ filmAvailable, onOpenFilm }: { readonly filmAvailable: boolean; readonly onOpenFilm: () => void }) {
  const g = useGenesis()
  const [confirmRestart, setConfirmRestart] = useState(false)
  const { doc, busy } = g
  if (!doc) {
    return g.loadError
      ? (
        <div className="pl-error">
          <span style={{ flex: 1 }}>开局没读出来：{g.loadError}</span>
          <button type="button" className="pl-chip-btn" onClick={g.reload}>再读一次</button>
        </div>
      )
      : <div className="pl-empty">读取中…</div>
  }
  const at = doc.stage
  const reached = (s: GenesisStage) => stageIndex(at) >= stageIndex(s)
  /** AI 正在跑：别的 AI 按钮、重新开局都先按不了 */
  const working = busy !== null || g.condensing.notes || g.condensing.wishNotes

  return (
    <div className="gn-root" style={INK_VARS}>
      <div className="gn-title-row">
        <div className="pl-section-title">开局 · 梦想记事本</div>
        {stageIndex(at) > 0 && (
          confirmRestart ? (
            <span className="gn-restart-confirm">
              另开一局？旧的会留着
              <button type="button" className="pl-chip-btn" onClick={() => { g.restart(); setConfirmRestart(false) }}>另开</button>
              <button type="button" className="pl-chip-btn" aria-label="不了" onClick={() => setConfirmRestart(false)}><X size={12} /></button>
            </span>
          ) : (
            <button type="button" className="pl-chip-btn" disabled={working} onClick={() => setConfirmRestart(true)}><RotateCcw size={12} />重新开局</button>
          )
        )}
      </div>

      {g.error && (
        <div className="pl-error">
          <span style={{ flex: 1 }}>{g.error}</span>
          <button type="button" className="pl-chip-btn" aria-label="关闭提示" onClick={g.clearError}><X size={12} /></button>
        </div>
      )}

      <MirrorView
        doc={doc}
        now={at === 'frustrations'}
        condensing={g.condensing.notes}
        onSubmit={g.submitFrustrations}
        onRecondense={() => void g.condense('notes', true)}
      />

      {reached('wishes') && (
        <WishStrips
          doc={doc}
          now={at === 'wishes'}
          condensing={g.condensing.wishNotes}
          onSubmit={g.submitWishes}
          onRecondense={() => void g.condense('wishNotes', true)}
        />
      )}

      {reached('reflection') && (
        <ReflectionLetter
          reflection={doc.reflection}
          now={at === 'reflection'}
          busy={busy === 'reflect'}
          locked={busy !== null}
          filmAvailable={filmAvailable}
          onReflect={() => void g.run('reflect')}
          onOpenFilm={onOpenFilm}
          next={at === 'reflection' && <Next label="继续：以终为始" onClick={g.toPyramid} />}
        />
      )}

      {reached('pyramid') && (
        <PyramidSheet
          pyramid={doc.pyramid}
          now={at === 'pyramid'}
          busy={busy === 'pyramid'}
          locked={busy !== null}
          onChange={g.setPyramid}
          onPropose={() => void g.run('pyramid')}
          next={at === 'pyramid' && <Next label="就这样，放到时间上" onClick={g.toTimeline} />}
        />
      )}

      {reached('timeline') && (
        <TicketsView
          timeline={doc.timeline}
          now={at === 'timeline'}
          busy={busy === 'timeline'}
          locked={busy !== null}
          onChange={g.setTimeline}
          onPropose={() => void g.run('timeline')}
          next={at === 'timeline' && <Next label="就这样，收下" onClick={g.finish} />}
        />
      )}

      {at === 'done' && (
        <section className="gn-coda">
          <span className="nb-stamp gn-seal" aria-hidden><span>收</span><span>下</span></span>
          <System>
            收下了。镜子、短笺、金字塔和车票会一直留在这里。<br />
            下一步，系统会从最近的那张车票倒推出这一周的几块「大石头」，再长成每天的协议。（这一步还在做）
          </System>
        </section>
      )}
    </div>
  )
}
