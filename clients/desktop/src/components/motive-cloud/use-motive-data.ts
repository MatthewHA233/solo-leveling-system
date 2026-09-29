// ══════════════════════════════════════════════
// 动机云数据：动机（来自锚点域的「动机」锚点句）+ 去向/蓝图 + 语义向量
//   · 动机从锚点绑定里汇总：引用次数、被记录时的语境片段（用户原话优先）
//   · 洪流域有变动（solevup:context-updated）→ 自动重拉；聊天里新沉淀的动机也从这条路进来
// ══════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchAllBindings, fetchAnchorEmbeddings, fetchMotiveProtocols } from '../../lib/local-api'
import type { MotiveProtocol } from '../../lib/local-api'

export interface Motive {
  readonly id: string
  readonly text: string
  /** 被多少段语境引用过 */
  readonly refs: number
  /** 记录这条动机时的语境片段（去重） */
  readonly contexts: readonly string[]
}

export type LoadStatus = 'loading' | 'ready' | 'error'

const RELOAD_DEBOUNCE_MS = 300

export function useMotiveData() {
  const [motives, setMotives] = useState<readonly Motive[]>([])
  const [protocols, setProtocols] = useState<ReadonlyMap<string, MotiveProtocol>>(new Map())
  const [vectors, setVectors] = useState<ReadonlyMap<string, number[]>>(new Map())
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const loadedOnce = useRef(false)

  const load = useCallback(async () => {
    if (!loadedOnce.current) setStatus('loading')
    try {
      const [bindings, protocolRows, embeddings] = await Promise.all([
        fetchAllBindings(),
        fetchMotiveProtocols(),
        // 向量只影响摆位，拿不到也能用（退回散布）
        fetchAnchorEmbeddings().catch(() => []),
      ])

      const acc = new Map<string, Motive>()
      for (const b of bindings) {
        const context = (b.user_speech || b.selected_text || '').trim()
        for (const a of b.anchors) {
          if (a.category !== 'motive') continue
          const prev = acc.get(a.id)
          const contexts = prev?.contexts ?? []
          acc.set(a.id, {
            id: a.id,
            text: a.keyword,
            refs: (prev?.refs ?? 0) + 1,
            contexts: context && !contexts.includes(context) ? [...contexts, context] : contexts,
          })
        }
      }

      const vecs = new Map<string, number[]>()
      for (const e of embeddings) {
        if (!acc.has(e.anchor_id)) continue
        try {
          const v = JSON.parse(e.vector) as unknown
          if (Array.isArray(v) && v.every((x) => typeof x === 'number')) vecs.set(e.anchor_id, v as number[])
        } catch { /* 坏向量跳过，退回散布 */ }
      }

      setMotives([...acc.values()])
      setProtocols(new Map(protocolRows.map((p) => [p.anchor_id, p])))
      setVectors(vecs)
      setStatus('ready')
      setError(null)
      loadedOnce.current = true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(loadedOnce.current ? 'ready' : 'error')
    }
  }, [])

  useEffect(() => {
    void load()
    let timer: ReturnType<typeof setTimeout> | null = null
    const onUpdated = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(), RELOAD_DEBOUNCE_MS)
    }
    window.addEventListener('solevup:context-updated', onUpdated)
    return () => {
      window.removeEventListener('solevup:context-updated', onUpdated)
      if (timer) clearTimeout(timer)
    }
  }, [load])

  /** 本地先行更新某条动机的去向/蓝图（保存请求在调用方发） */
  const putProtocol = useCallback((p: MotiveProtocol) => {
    setProtocols((prev) => new Map(prev).set(p.anchor_id, p))
  }, [])

  return { motives, protocols, vectors, status, error, reload: load, putProtocol }
}
