// ══════════════════════════════════════════════
// 笔记的本地 API 客户端（后端 src-tauri/src/notes_api.rs）
//   页面树只拉元信息；正文进页面时单独拉。附件在正文里存 note-asset://{文件名}，显示时才换成 HTTP 地址。
//   锚点 / 想法卡片 / 语境的数据是后端每次存正文时从正文里对出来的（notes_index.rs），这里只读。
// ══════════════════════════════════════════════

import { API_BASE } from './local-api'

/** 页面的种类：普通页 / 锚点页（标题就是那个词）/ 单独写的想法卡片 / 语境页（从某个来源生成） */
/**
 * group = 锚点目录里的结点（最上面一层是领域）：只用来归拢锚点，不能被 # 引用
 * alias = 锚点的分身：目录里的一格，指向某个锚点，让它能同时出现在几个领域里
 */
export type NotePageKind = 'page' | 'anchor' | 'thought' | 'context' | 'group' | 'alias'

export interface NotePageMeta {
  readonly id: string
  readonly parentId: string | null
  /** 见 NotePageKind；后端以后加了新种类，旧界面当普通页看 */
  readonly kind: string
  readonly title: string
  readonly icon: string | null
  readonly sortOrder: number
  readonly favorite: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly deletedAt: string | null
  /** 这一格是哪个锚点的分身；不是分身就是 null */
  readonly aliasOf: string | null
}

export interface NotePage extends NotePageMeta {
  readonly cover: string | null
  readonly fullWidth: boolean
  /** 编辑器的块数组 */
  readonly content: readonly unknown[]
  /** 语境页的来源（比如 'bili' + BV 号）；别的页面是 null */
  readonly sourceKind: string | null
  readonly sourceId: string | null
  /** 单独写的想法卡片关联到的语境页；没关联是 null */
  readonly contextPageId: string | null
}

export interface NoteSearchHit extends NotePageMeta {
  readonly snippet: string
}

export interface NoteAsset {
  readonly url: string
  readonly name: string
  readonly originalName: string
  readonly mime: string
  readonly size: number
}

/** 只改传了的字段；icon / cover 传 '' = 去掉 */
export interface NotePagePatch {
  readonly title?: string
  readonly icon?: string
  readonly cover?: string
  readonly content?: readonly unknown[]
  readonly contentText?: string
  readonly favorite?: boolean
  readonly fullWidth?: boolean
  /** 想法卡片关联到哪个语境页；'' = 取消关联 */
  readonly contextPageId?: string
}

/** 一个锚点被引用了几处、里面有几条写了字的锚点句 */
export interface AnchorStat {
  readonly anchorId: string
  readonly refs: number
  readonly sentences: number
}

export interface AnchorSentence {
  readonly blockId: string
  readonly text: string
  /** 动机 motive / 观点 view / 实践 practice，没标是 '' */
  readonly category: string
  /** 现在是第几版（还没写字是 0） */
  readonly version: number
  /** 有多少处引用点到了这一句 */
  readonly refs: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SentenceVersion {
  readonly version: number
  readonly text: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** 一处引用：哪一页的哪一块指向了这个锚点 */
export interface Backlink {
  readonly pageId: string
  readonly pageTitle: string
  readonly pageIcon: string | null
  readonly pageKind: string
  readonly blockId: string
  readonly blockText: string
  /** 点到了哪一句（'' = 整个锚点） */
  readonly sentenceId: string
  /** 这处引用在某条批注里：批注的 id、原话、涂上的原文（不在批注里都是 ''） */
  readonly thoughtId: string
  readonly thoughtText: string
  readonly thoughtQuote: string
  readonly createdAt: string
}

/** 一张想法卡片。inline = 插在某一页里的批注；page = 单独写的 */
export interface ThoughtCard {
  readonly id: string
  readonly origin: 'inline' | 'page'
  readonly text: string
  /** 涂上的原文（只有批注有） */
  readonly quote: string
  /** 它在哪一页：批注 = 所在的语境页；单独写的 = 它自己 */
  readonly pageId: string
  /** 批注文字所在的块（跳回原处用；单独写的是 ''） */
  readonly blockId: string
  /** 关联的语境页；单独写的可以是 null（未关联语境） */
  readonly contextPageId: string | null
  readonly contextTitle: string
  readonly contextIcon: string | null
  readonly contextKind: string
  readonly anchors: readonly { readonly id: string; readonly title: string }[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ThoughtDay {
  /** 2026-11-23 */
  readonly day: string
  readonly count: number
}

/** 已经生成的语境页 */
export interface ContextPage {
  readonly id: string
  readonly title: string
  readonly icon: string | null
  readonly sourceKind: string
  readonly sourceId: string
  /** 上面留了几条批注 */
  readonly thoughts: number
  readonly createdAt: string
  readonly updatedAt: string
}

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

interface RawMeta {
  id: string
  parent_id: string | null
  kind: string
  title: string
  icon: string | null
  sort_order: number
  favorite: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
  alias_of?: string | null
}

interface RawPage extends RawMeta {
  cover: string | null
  full_width: boolean
  content: unknown
  source_kind?: string | null
  source_id?: string | null
  context_page_id?: string | null
}

interface RawHit extends RawMeta {
  snippet: string
}

interface RawAsset {
  url: string
  name: string
  original_name: string
  mime: string
  size: number
}

const NOTES = `${API_BASE}/api/notes`
const ASSET_SCHEME = 'note-asset://'
/** 浏览器对 keepalive 请求体的上限是 64KB，超了整个请求直接失败 */
const KEEPALIVE_MAX_BODY = 60_000

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new Error('连不上本地服务（应用后端没在运行？）')
  }
  if (!res.ok) throw new Error(`笔记服务出错（${res.status}）`)
  const json = (await res.json()) as ApiResponse<T>
  if (!json.success) throw new Error(json.error ?? '笔记服务出错')
  return json.data as T
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

function mapMeta(r: RawMeta): NotePageMeta {
  return {
    id: r.id,
    parentId: r.parent_id,
    kind: r.kind,
    title: r.title,
    icon: r.icon,
    sortOrder: r.sort_order,
    favorite: r.favorite,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    aliasOf: r.alias_of ?? null,
  }
}

export async function fetchNotePages(): Promise<NotePageMeta[]> {
  return (await call<RawMeta[]>(`${NOTES}/pages`)).map(mapMeta)
}

export async function fetchNotePage(id: string): Promise<NotePage> {
  const r = await call<RawPage>(`${NOTES}/pages/${encodeURIComponent(id)}`)
  return {
    ...mapMeta(r),
    cover: r.cover,
    fullWidth: r.full_width,
    content: Array.isArray(r.content) ? r.content : [],
    sourceKind: r.source_kind ?? null,
    sourceId: r.source_id ?? null,
    contextPageId: r.context_page_id ?? null,
  }
}

export async function createNotePage(
  parentId: string | null,
  init: { title?: string; icon?: string; kind?: NotePageKind; aliasOf?: string } = {},
): Promise<NotePageMeta> {
  const { aliasOf, ...rest } = init
  return mapMeta(await call<RawMeta>(`${NOTES}/pages`, jsonInit('POST', { parent_id: parentId, ...rest, alias_of: aliasOf })))
}

export function notePatchBody(patch: NotePagePatch): Record<string, unknown> {
  return {
    title: patch.title,
    icon: patch.icon,
    cover: patch.cover,
    content: patch.content,
    content_text: patch.contentText,
    favorite: patch.favorite,
    full_width: patch.fullWidth,
    context_page_id: patch.contextPageId,
  }
}

export async function updateNotePage(id: string, patch: NotePagePatch, opts: { keepalive?: boolean } = {}): Promise<void> {
  const init = jsonInit('PATCH', notePatchBody(patch))
  const body = typeof init.body === 'string' ? init.body : ''
  await call<null>(`${NOTES}/pages/${encodeURIComponent(id)}`, {
    ...init,
    // 关窗时的最后一次保存：窗口没了请求也要发完。长文超过 keepalive 上限就只能普通发（尽力而为）
    keepalive: opts.keepalive === true && body.length < KEEPALIVE_MAX_BODY,
  })
}

export async function moveNotePage(id: string, parentId: string | null, index: number): Promise<void> {
  await call<null>(`${NOTES}/pages/${encodeURIComponent(id)}/move`, jsonInit('POST', { parent_id: parentId, index }))
}

export async function trashNotePage(id: string): Promise<void> {
  await call<null>(`${NOTES}/pages/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function restoreNotePage(id: string): Promise<NotePageMeta> {
  return mapMeta(await call<RawMeta>(`${NOTES}/pages/${encodeURIComponent(id)}/restore`, { method: 'POST' }))
}

export async function purgeNotePage(id: string): Promise<void> {
  await call<null>(`${NOTES}/pages/${encodeURIComponent(id)}/purge`, { method: 'DELETE' })
}

export async function fetchNoteTrash(): Promise<NotePageMeta[]> {
  return (await call<RawMeta[]>(`${NOTES}/trash`)).map(mapMeta)
}

export async function emptyNoteTrash(): Promise<number> {
  return call<number>(`${NOTES}/trash`, { method: 'DELETE' })
}

export async function searchNotes(query: string): Promise<NoteSearchHit[]> {
  const rows = await call<RawHit[]>(`${NOTES}/search?q=${encodeURIComponent(query)}`)
  return rows.map((r) => ({ ...mapMeta(r), snippet: r.snippet }))
}

export async function uploadNoteAsset(file: File, pageId: string | null): Promise<NoteAsset> {
  const qs = new URLSearchParams({ name: file.name })
  if (pageId) qs.set('page_id', pageId)
  const r = await call<RawAsset>(`${NOTES}/assets?${qs.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
  return { url: r.url, name: r.name, originalName: r.original_name, mime: r.mime, size: r.size }
}

/** 正文里的 note-asset://xxx → 能直接显示的 HTTP 地址；别的地址原样返回 */
export function resolveNoteAssetUrl(url: string): string {
  if (!url.startsWith(ASSET_SCHEME)) return url
  return `${NOTES}/assets/${encodeURIComponent(url.slice(ASSET_SCHEME.length))}`
}

// ── 锚点 ──

export async function fetchAnchorStats(): Promise<AnchorStat[]> {
  const rows = await call<{ anchor_id: string; refs: number; sentences: number }[]>(`${NOTES}/anchor-stats`)
  return rows.map((r) => ({ anchorId: r.anchor_id, refs: r.refs, sentences: r.sentences }))
}

export async function fetchAnchorSentences(anchorId: string): Promise<AnchorSentence[]> {
  const rows = await call<{
    block_id: string; text: string; category: string; version: number; refs: number; created_at: string; updated_at: string
  }[]>(`${NOTES}/anchors/${encodeURIComponent(anchorId)}/sentences`)
  return rows.map((r) => ({
    blockId: r.block_id, text: r.text, category: r.category, version: r.version, refs: r.refs,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }))
}

export async function fetchAnchorBacklinks(anchorId: string): Promise<Backlink[]> {
  const rows = await call<{
    page_id: string; page_title: string; page_icon: string | null; page_kind: string; block_id: string; block_text: string
    sentence_id: string; thought_id: string; thought_text: string; thought_quote: string; created_at: string
  }[]>(`${NOTES}/anchors/${encodeURIComponent(anchorId)}/backlinks`)
  return rows.map((r) => ({
    pageId: r.page_id, pageTitle: r.page_title, pageIcon: r.page_icon, pageKind: r.page_kind,
    blockId: r.block_id, blockText: r.block_text, sentenceId: r.sentence_id,
    thoughtId: r.thought_id, thoughtText: r.thought_text, thoughtQuote: r.thought_quote, createdAt: r.created_at,
  }))
}

export async function fetchSentenceVersions(pageId: string, blockId: string): Promise<SentenceVersion[]> {
  const rows = await call<{ version: number; text: string; created_at: string; updated_at: string }[]>(
    `${NOTES}/sentences/${encodeURIComponent(pageId)}/${encodeURIComponent(blockId)}/versions`,
  )
  return rows.map((r) => ({ version: r.version, text: r.text, createdAt: r.created_at, updatedAt: r.updated_at }))
}

// ── 想法卡片 ──

interface RawThought {
  id: string
  origin: string
  text: string
  quote: string
  page_id: string
  block_id: string
  context_page_id: string | null
  context_title: string
  context_icon: string | null
  context_kind: string
  anchors: { id: string; title: string }[]
  created_at: string
  updated_at: string
}

/** 全部想法卡片（批注 + 单独写的），按创建时间倒序；before = 上一页最后一张的创建时间 */
export async function fetchThoughts(opts: { before?: string; limit?: number } = {}): Promise<ThoughtCard[]> {
  const qs = new URLSearchParams()
  if (opts.before) qs.set('before', opts.before)
  if (opts.limit) qs.set('limit', String(opts.limit))
  const rows = await call<RawThought[]>(`${NOTES}/thoughts?${qs.toString()}`)
  return rows.map((r) => ({
    id: r.id,
    origin: r.origin === 'inline' ? 'inline' : 'page',
    text: r.text,
    quote: r.quote,
    pageId: r.page_id,
    blockId: r.block_id,
    contextPageId: r.context_page_id,
    contextTitle: r.context_title,
    contextIcon: r.context_icon,
    contextKind: r.context_kind,
    anchors: r.anchors,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

/** 单独写一张想法卡片（未关联语境） */
export async function createThought(text: string): Promise<NotePageMeta> {
  return mapMeta(await call<RawMeta>(`${NOTES}/thoughts`, jsonInit('POST', { text })))
}

/** 每天写了几张想法卡片；since = 从哪一天起（2026-01-01） */
export async function fetchThoughtHeatmap(since: string): Promise<ThoughtDay[]> {
  return call<ThoughtDay[]>(`${NOTES}/thoughts/heatmap?since=${encodeURIComponent(since)}`)
}

// ── 语境 ──

export async function fetchContextPages(): Promise<ContextPage[]> {
  const rows = await call<{
    id: string; title: string; icon: string | null; source_kind: string; source_id: string; thoughts: number
    created_at: string; updated_at: string
  }[]>(`${NOTES}/contexts`)
  return rows.map((r) => ({
    id: r.id, title: r.title, icon: r.icon, sourceKind: r.source_kind, sourceId: r.source_id, thoughts: r.thoughts,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }))
}

/** 打开某个语境：这个来源已经有页面就用它，没有就照传来的标题和正文建一页 */
export async function ensureContextPage(input: {
  sourceKind: string
  sourceId: string
  title: string
  icon?: string
  content: readonly unknown[]
  contentText: string
}): Promise<NotePageMeta> {
  return mapMeta(await call<RawMeta>(`${NOTES}/contexts/ensure`, jsonInit('POST', {
    source_kind: input.sourceKind,
    source_id: input.sourceId,
    title: input.title,
    icon: input.icon,
    content: input.content,
    content_text: input.contentText,
  })))
}
