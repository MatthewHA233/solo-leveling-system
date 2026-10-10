// 协议志 · 协议：灰色地带的 AI 判断——填 Key、换渠道、拿一个窗口标题试判一次
// Key 只存本机数据库，读回来只有后四位；默认走 Vercel AI Gateway（国内直连）；用哪个模型在模型库里绑定

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  fetchJevConfig, testJev, updateJevConfig, type JevConfig, type JevConfigPatch, type JevVerdict,
} from '../../../lib/protocol-api'
import { decisionModelName, RELATION_LABELS } from './lock-model'

const SAMPLE_TITLE = 'Tauri 2 无边框透明窗口完整教程 - 哔哩哔哩'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function JevSettings() {
  const [cfg, setCfg] = useState<JevConfig | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [title, setTitle] = useState('')
  const [verdict, setVerdict] = useState<JevVerdict | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)

  useEffect(() => {
    let alive = true
    fetchJevConfig()
      .then((c) => { if (alive) setCfg(c) })
      .catch((e) => { if (alive) setError(errorText(e)) })
    return () => { alive = false }
  }, [])

  /** 返回是否成功（失败的错误已经显示出来了） */
  const run = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await work()
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = (patch: JevConfigPatch) => run(async () => { setCfg(await updateJevConfig(patch)) })
  const saveKey = () => {
    const key = keyDraft.trim()
    if (!key) return
    void save({ apiKey: key }).then((ok) => { if (ok) setKeyDraft('') })
  }
  const test = () => run(async () => {
    setVerdict(null)
    setVerdict(await testJev({ title: title.trim() || undefined }))
  })

  const ranked = verdict
    ? Object.entries(verdict.probabilities).sort((a, b) => b[1] - a[1])
    : []

  return (
    <div>
      <div className="pl-live-label">灰色地带</div>
      <div className="pl-live-name" style={{ fontSize: 22 }}>AI 判断</div>
      <div className="pl-hint" style={{ marginTop: 8, lineHeight: 1.6, maxWidth: 560 }}>
        白名单里标成「灰」的条目（比如 B 站：可能是学习也可能是娱乐），开局后由决策模型按协议用意实时判断。
        决策模型只做选择题，单次几百毫秒、一次不到十万分之一美元；只有灰色条目在前台时，窗口标题才会发出去。
      </div>
      {error && <div className="pl-error" style={{ marginTop: 12 }}>{error}</div>}

      <div className="pl-section">
        <div className="pl-section-head">
          <span className="pl-section-title">KEY</span>
          <span className="pl-hint">
            {cfg?.hasKey ? `已填（尾号 ${cfg.keyTail}）` : '还没填'} · 只存在本机
          </span>
        </div>
        <div className="pl-add">
          <input
            className="pl-input"
            type="password"
            autoComplete="off"
            value={keyDraft}
            placeholder={cfg?.hasKey ? '换一个 Key' : 'Vercel AI Gateway 的 Key（vck_…）'}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveKey() }}
          />
          <button type="button" className="ti-key" disabled={busy || !keyDraft.trim()} style={{ height: 30, padding: '0 14px', fontSize: 12.5 }} onClick={saveKey}>
            保存
          </button>
          {cfg?.hasKey && (
            <button type="button" className="ti-key" disabled={busy} style={{ height: 30, padding: '0 14px', fontSize: 12.5 }} onClick={() => void save({ apiKey: '' })}>
              清掉
            </button>
          )}
        </div>
      </div>

      {cfg && (
        <div className="pl-section">
          <div className="pl-section-head">
            <span className="pl-section-title">模型</span>
            <span className="pl-hint">在模型库的「决策判断」里换</span>
          </div>
          <div className="pl-tally" style={{ marginTop: 0 }}>
            <span>按标题判断 <b>{decisionModelName(cfg.model)}</b></span>
            <span>看图判断 <b>{decisionModelName(cfg.visionModel)}</b></span>
          </div>
        </div>
      )}

      <div className="pl-section">
        <button type="button" className="pl-fold" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
          {advanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          渠道
        </button>
        {advanced && cfg && (
          <div style={{ marginTop: 8, display: 'grid', gap: 8, maxWidth: 460 }}>
            <input
              key={`url-${cfg.baseUrl}`}
              className="pl-input"
              defaultValue={cfg.baseUrl}
              aria-label="Jev 地址"
              onBlur={(e) => { if (e.target.value.trim() !== cfg.baseUrl) void save({ baseUrl: e.target.value }) }}
            />
            <div className="pl-hint" style={{ lineHeight: 1.6 }}>
              默认 Vercel AI Gateway。兼容同一套接口（System One）的渠道都能填进来，
              比如 TypeSafe 官方 https://api.typesafe.ai，或本地部署的开源决策模型
            </div>
          </div>
        )}
      </div>

      <div className="pl-rule" />
      <div className="pl-section">
        <div className="pl-section-head">
          <span className="pl-section-title">试判</span>
          <span className="pl-hint">用意按「推进 Solevup 桌面端开发」算</span>
        </div>
        <div className="pl-add">
          <input
            className="pl-input"
            value={title}
            placeholder={`窗口标题（不填用：${SAMPLE_TITLE}）`}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void test() }}
          />
          <button type="button" className="ti-key ti-key-primary" disabled={busy || !cfg?.hasKey} style={{ height: 30, padding: '0 14px', fontSize: 12.5 }} onClick={() => void test()}>
            试判
          </button>
        </div>
        {verdict && (
          <div className="pl-verdict">
            <div className="pl-verdict-choice">{RELATION_LABELS[verdict.choice] ?? verdict.choice}</div>
            {ranked.map(([key, p]) => (
              <div key={key} className="pl-prob">
                <span>{RELATION_LABELS[key] ?? key}</span>
                <span className="pl-prob-track"><span className="pl-prob-fill" style={{ display: 'block', width: `${Math.round(p * 1000) / 10}%` }} /></span>
                <span className="pl-prob-num">{(p * 100).toFixed(1)}%</span>
              </div>
            ))}
            <div className="pl-hint" style={{ marginTop: 10 }}>
              {verdict.latencyMs} ms · {verdict.inputTokens} token · {verdict.model}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
