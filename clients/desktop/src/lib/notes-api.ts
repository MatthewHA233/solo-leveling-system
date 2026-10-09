// ══════════════════════════════════════════════
// 洪流域 · 笔记的本地 API 客户端（后端 src-tauri/src/notes_api.rs）
//   页面树只拉元信息；正文进页面时单独拉。附件在正文里存 note-asset://{文件名}，显示时才换成 HTTP 地址。
// ══════════════════════════════════════════════

import { API_BASE } from './local-api'

export interface NotePageMeta {
  readonly id: string
  readonly parentId: string | null
  readonly kind: string
  readonly title: string
  readonly icon: string | null
  readonly sortOrder: number
  readonly favorite: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly deletedAt: string | null
}

export interface NotePage extends NotePageMeta {
  readonly cover: string | null
  readonly fullWidth: boolean
  /** 编辑器的块数组（后端原样存取） */
  readonly content: readonly unknown[]
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
}

interface RawPage extends RawMeta {
  cover: string | null
  full_width: boolean
  content: unknown
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
  }
}

export async function createNotePage(parentId: string | null, init: { title?: string; icon?: string } = {}): Promise<NotePageMeta> {
  return mapMeta(await call<RawMeta>(`${NOTES}/pages`, jsonInit('POST', { parent_id: parentId, ...init })))
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
