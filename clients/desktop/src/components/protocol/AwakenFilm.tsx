// 协议志 · 觉醒片：开局时 AI 按你写下的「最近最不如意的事」和「一直想做却没做成的事」做的一段觉醒动画
//   片子本身是 public/films/awaken/ 下的一个独立小页面（canvas 实时画 + 混音，不进打包），这里用 iframe 全幅播放
//   含个人隐私，不进仓库（.gitignore）——本机没有这部片子时入口不出现；Esc / 右上角关闭

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { FILM_DIR } from './use-awaken-film'

export default function AwakenFilm({ onClose }: { readonly onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && (e.data as { type?: string } | null)?.type === 'awaken:close') onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('message', onMessage)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 20, background: '#000' }}>
      <iframe
        ref={frame}
        title="觉醒 · 责任之镜"
        src={`${FILM_DIR}index.html`}
        allow="autoplay"
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        onLoad={() => frame.current?.focus()}
      />
      <button
        type="button"
        className="ti-key"
        aria-label="关闭觉醒片"
        title="关闭（Esc）"
        onClick={onClose}
        style={{ position: 'absolute', top: 12, right: 12, width: 30, height: 30 }}
      >
        <X size={14} />
      </button>
    </div>
  )
}
