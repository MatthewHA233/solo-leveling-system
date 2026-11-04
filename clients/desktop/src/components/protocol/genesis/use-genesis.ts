// 协议志 · 开局的状态：读最近一次开局、编辑后防抖保存、每一步的 AI（只在按钮里触发，打开页面不会自己花钱）
// 例外：便利贴 / 愿望短笺缺了就自动誊（每条只誊一次，结果存进文档）

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchGenesis, saveGenesis } from '../../../lib/protocol-api'
import { condenseFrustrations, condenseWishes, proposePyramid, proposeTimeline, reflect } from './genesis-ai'
import {
  EMPTY_DOC, mergeNotes, missingNotes, normalizeDoc, stageIndex, type GenesisDoc, type GenesisStage, type InkNote, type Milestone, type Pyramid,
} from './genesis-model'

const SAVE_DEBOUNCE_MS = 600

export type GenesisBusy = 'reflect' | 'pyramid' | 'timeline' | null

/** 要誊上纸的两份清单：镜子上的便利贴、竹枝上的愿望短笺 */
export type NoteField = 'notes' | 'wishNotes'

const NOTE_SOURCES: Record<NoteField, {
  readonly items: (d: GenesisDoc) => readonly string[]
  /** 到了这一步之后才自动誊（还在写清单时不誊） */
  readonly after: GenesisStage
  readonly condense: (items: readonly string[]) => Promise<InkNote[]>
}> = {
  notes: { items: (d) => d.frustrations, after: 'frustrations', condense: condenseFrustrations },
  wishNotes: { items: (d) => d.wishes, after: 'wishes', condense: condenseWishes },
}
const NOTE_FIELDS = Object.keys(NOTE_SOURCES) as NoteField[]
const IDLE: Record<NoteField, boolean> = { notes: false, wishNotes: false }

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 走到 target 这一步；已经在更后面就不动 */
const atLeast = (stage: GenesisStage, target: GenesisStage): GenesisStage => (stageIndex(stage) > stageIndex(target) ? stage : target)

export function useGenesis() {
  const [doc, setDoc] = useState<GenesisDoc | null>(null)   // null = 还在读
  const [busy, setBusy] = useState<GenesisBusy>(null)
  const [error, setError] = useState<string | null>(null)
  const [condensing, setCondensing] = useState(IDLE)
  /** 上次自动誊过的那批原话：失败了不反复重试，清单变了才再誊 */
  const triedRef = useRef<Record<NoteField, string>>({ notes: '', wishNotes: '' })
  const idRef = useRef<string | null>(null)
  const docRef = useRef<GenesisDoc | null>(null)
  const timer = useRef<number | undefined>(undefined)
  /** 第几局：重新开局时加一；AI 回来时局已经换了，结果就扔掉，不写进新的一局 */
  const epochRef = useRef(0)
  /** 正在跑的那一步 AI（ref 版，挡住连点） */
  const busyRef = useRef<GenesisBusy>(null)
  /** 读不出来时的报错：这时不给空本子（一改就会新建一份，把真的那份压在下面） */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadTick, setLoadTick] = useState(0)

  useEffect(() => {
    let alive = true
    setLoadError(null)
    fetchGenesis()
      .then((r) => {
        if (!alive) return
        idRef.current = r?.id ?? null
        const d = r ? normalizeDoc(r.doc) : EMPTY_DOC
        docRef.current = d
        setDoc(d)
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(errorText(e))
      })
    return () => { alive = false }
  }, [loadTick])

  const reload = useCallback(() => setLoadTick((t) => t + 1), [])

  const persist = useCallback(async () => {
    const d = docRef.current
    if (!d) return
    const epoch = epochRef.current
    try {
      const r = await saveGenesis(idRef.current, d)
      // 存的是上一局（存的途中重新开局了）：别把上一局的 id 认给新的一局
      if (epoch === epochRef.current) idRef.current = r.id
    } catch (e) {
      setError(`没存上：${errorText(e)}`)
    }
  }, [])

  // 离开开局页时还有没存的改动：立刻存掉，不丢最后几个字
  useEffect(() => () => {
    if (timer.current === undefined) return
    window.clearTimeout(timer.current)
    void persist()
  }, [persist])

  /** 改文档：立刻生效；immediate = 立刻存，否则防抖 */
  const change = useCallback((fn: (d: GenesisDoc) => GenesisDoc, immediate = false) => {
    const next = fn(docRef.current ?? EMPTY_DOC)
    docRef.current = next
    setDoc(next)
    window.clearTimeout(timer.current)
    timer.current = undefined
    if (immediate) void persist()
    else timer.current = window.setTimeout(() => { timer.current = undefined; void persist() }, SAVE_DEBOUNCE_MS)
  }, [persist])

  /** 跑一步 AI：成功就写进文档；第一次做到这一步就推进到这一步，已经走过了就原地换掉结果，不退回 */
  // 一次只跑一步 AI（照一遍 / 金字塔 / 车票）：同时跑几个，先回来的会把别的转圈灭掉，后回来的旧结果还会盖掉新的
  const run = useCallback(async (kind: Exclude<GenesisBusy, null>) => {
    const d = docRef.current
    if (!d || busyRef.current) return
    const epoch = epochRef.current
    const same = () => epoch === epochRef.current
    busyRef.current = kind
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'reflect') {
        const text = await reflect(d.frustrations, d.wishes)
        if (same()) change((x) => ({ ...x, reflection: text, stage: atLeast(x.stage, 'reflection') }), true)
      } else if (kind === 'pyramid') {
        const pyramid = await proposePyramid(d.frustrations, d.wishes)
        if (same()) change((x) => ({ ...x, pyramid, stage: atLeast(x.stage, 'pyramid') }), true)
      } else if (d.pyramid) {
        const timeline = await proposeTimeline(d.frustrations, d.wishes, d.pyramid)
        if (same()) change((x) => ({ ...x, timeline, stage: atLeast(x.stage, 'timeline') }), true)
      }
    } catch (e) {
      if (same()) setError(errorText(e))
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }, [change])

  /** 誊上纸：默认只誊还没有的；all = 全部重誊 */
  const condense = useCallback(async (field: NoteField, all = false) => {
    const d = docRef.current
    if (!d) return
    const src = NOTE_SOURCES[field]
    const items = src.items(d)
    const todo = all ? items : missingNotes(items, d[field])
    if (todo.length === 0) return
    const epoch = epochRef.current
    setCondensing((c) => ({ ...c, [field]: true }))
    setError(null)
    try {
      const fresh = await src.condense(todo)
      if (epoch === epochRef.current) change((x) => ({ ...x, [field]: mergeNotes(src.items(x), x[field], fresh) }), true)
    } catch (e) {
      if (epoch === epochRef.current) setError(errorText(e))
    } finally {
      setCondensing((c) => ({ ...c, [field]: false }))
    }
  }, [change])

  useEffect(() => {
    if (!doc) return
    for (const field of NOTE_FIELDS) {
      const src = NOTE_SOURCES[field]
      if (condensing[field] || stageIndex(doc.stage) <= stageIndex(src.after)) continue
      const todo = missingNotes(src.items(doc), doc[field])
      const key = todo.join('\n')
      if (todo.length === 0 || key === triedRef.current[field]) continue
      triedRef.current = { ...triedRef.current, [field]: key }
      void condense(field)
    }
  }, [doc, condensing, condense])

  /** 交清单：第一次交就往下走；之后在镜子上就地改，不退回前面的步骤 */
  const submitFrustrations = useCallback((items: string[]) => {
    change((d) => ({ ...d, frustrations: items, stage: d.stage === 'frustrations' ? 'wishes' : d.stage }), true)
  }, [change])

  /** 交愿望：第一次交就让系统照一遍；之后在竹枝上就地改，不退回、也不重照（想重照点「重新照一次」） */
  const submitWishes = useCallback((items: string[]) => {
    const first = docRef.current?.stage === 'wishes'
    change((d) => (first ? { ...d, wishes: items, stage: 'reflection', reflection: null } : { ...d, wishes: items }), true)
    if (first) void run('reflect')
  }, [change, run])

  const toPyramid = useCallback(() => {
    change((d) => ({ ...d, stage: 'pyramid' }), true)
    if (!docRef.current?.pyramid) void run('pyramid')
  }, [change, run])

  const toTimeline = useCallback(() => {
    change((d) => ({ ...d, stage: 'timeline' }), true)
    if (!docRef.current?.timeline) void run('timeline')
  }, [change, run])

  const finish = useCallback(() => change((d) => ({ ...d, stage: 'done' }), true), [change])

  const setPyramid = useCallback((pyramid: Pyramid) => change((d) => ({ ...d, pyramid })), [change])
  const setTimeline = useCallback((timeline: Milestone[]) => change((d) => ({ ...d, timeline })), [change])

  /** 重新开局：另开一份（旧的留在库里） */
  const restart = useCallback(() => {
    // 上一局还有没存的改动先存掉（persist 当场就取走了上一局的文档和 id）
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current)
      timer.current = undefined
      void persist()
    }
    epochRef.current += 1
    idRef.current = null
    triedRef.current = { notes: '', wishNotes: '' }
    change(() => EMPTY_DOC, true)
  }, [change, persist])

  return {
    doc, busy, error, clearError: () => setError(null), loadError, reload, condensing, condense,
    submitFrustrations, submitWishes, toPyramid, toTimeline, finish, setPyramid, setTimeline, restart, run,
  }
}
