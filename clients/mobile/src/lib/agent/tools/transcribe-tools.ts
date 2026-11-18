// ══════════════════════════════════════════════
// Fairy 的转录工具：在转录好的视频里找内容、让电脑下载并转录（desktop src/lib/agent/agent-tools-transcribe.ts 的手机端）
// 数据来源 ② 桌面端：视频和转录都在电脑上。文件头之外逐字一致，改工具要两端一起改
// ══════════════════════════════════════════════

import { requestVideoTranscribe, searchVideoTranscripts } from '../../bili-transcribe-api'
import type { TranscribeKind, TranscriptHit } from '../../bili-transcribe-api'
import type { ToolDefinition } from '../../llm/types'
import { enqueueTaskNotice } from '../message-queue'

export interface TranscribeTool {
  readonly definition: ToolDefinition
  execute(args: Record<string, unknown>): Promise<string>
  /** 手机端用：这个工具靠桌面端，连不上时怎么跟模型说 */
  readonly desktop?: { readonly read: string } | { readonly write: string }
}

/** 按内容找时每个视频带几句；读一个视频时一次读几句；列视频时最多几个 */
const HITS_PER_VIDEO = 6
const READ_LINES = 80
const LIST_LIMIT = 12
const MAX_FRAME_INTERVAL_SEC = 60

/** 转录在电脑后台跑：隔一会儿看一眼转好没有，转好了给 Fairy 发通知 */
const WATCH_INTERVAL_MS = 15_000
const WATCH_TIMEOUT_MS = 40 * 60_000

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 字符串或数组；有的模型会把数组序列化成字符串 '["a","b"]' 传进来 */
function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  const s = text(value)
  if (!s) return []
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s) as unknown
      if (Array.isArray(parsed)) return parsed.map(text).filter(Boolean)
    } catch { /* 当普通字符串 */ }
  }
  return [s]
}

function clock(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '--:--'
  const total = Math.max(0, Math.floor(sec))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function kindLabel(kind: string): string {
  return kind === 'visual' ? '读画面文字' : '听声音'
}

function videoLine(h: TranscriptHit): string {
  return `《${h.title}》 ${h.author_name ? `UP ${h.author_name} · ` : ''}${h.bvid} · ${kindLabel(h.kind)} · 共 ${h.total} 句`
}

// ── FindVideoTranscript ──

const findVideoTranscript: TranscribeTool = {
  desktop: { read: '视频转录' },
  definition: {
    type: 'function',
    function: {
      name: 'FindVideoTranscript',
      description:
        '在已经转录好的视频里找内容，不需要主人先打开哪个视频、也不需要语境卡。' +
        'video 填标题里的词、UP 主名或 BV 号来定位视频；keyword 填要找的内容词（可以是数组，对上任意一个就算），会在所有转录里搜。' +
        '只给 video 并且只对上一个视频时，返回这个视频的转录正文（带时间点），长视频用 after_sec 接着往后读。' +
        'video 和 keyword 都不填 = 列出最近转录好的视频。' +
        '返回「没有转录好的视频对得上」时可能只是还没转录：用 GetBiliHistory 看它有没有「已转录」标记，没有就问主人要不要用 TranscribeVideos 转。',
      parameters: {
        type: 'object',
        properties: {
          video: { type: 'string', description: '标题里的词、UP 主名或 BV 号；多个词用空格分开，都要对上' },
          keyword: {
            description: '转录内容里要找的词。字符串或字符串数组（数组对上任意一个就算）',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          after_sec: { type: 'number', description: '只读这个时间点（秒）之后的句子，接着上一次往后读时用' },
        },
        required: [],
      },
    },
  },
  async execute(args) {
    const video = text(args.video)
    const keywords = toList(args.keyword)
    const afterSec = typeof args.after_sec === 'number' && args.after_sec > 0 ? args.after_sec : 0
    const hits = await searchVideoTranscripts({
      video, keywords, afterSec,
      perVideo: keywords.length > 0 ? HITS_PER_VIDEO : READ_LINES,
      limit: LIST_LIMIT,
    })
    if (hits.length === 0) {
      return '没有转录好的视频对得上。可能是这个视频还没转录（用 GetBiliHistory 看有没有「已转录」标记），也可能是词不对，换一个更短的词再试一次。'
    }

    if (keywords.length > 0) {
      return hits
        .map((h) => {
          const more = h.matched > h.lines.length ? `\n  ……（共 ${h.matched} 句提到，这里是前 ${h.lines.length} 句）` : ''
          return `${videoLine(h)}\n${h.lines.map((l) => `  [${clock(l.start)}] ${l.text}`).join('\n')}${more}`
        })
        .join('\n\n')
    }

    if (hits.length === 1 && video) {
      const h = hits[0]
      if (h.lines.length === 0) return `${videoLine(h)}\n这个时间点之后没有句子了。`
      const last = h.lines[h.lines.length - 1]
      const more = h.matched > h.lines.length && last.start != null
        ? `\n\n（后面还有 ${h.matched - h.lines.length} 句；接着读传 after_sec=${last.start}）`
        : ''
      return `${videoLine(h)}\n${h.lines.map((l) => `[${clock(l.start)}] ${l.text}`).join('\n')}${more}`
    }

    const head = video ? `对上了 ${hits.length} 个视频，用更具体的标题词或 BV 号指定一个再读：` : '最近转录好的视频：'
    return `${head}\n${hits.map((h) => `- ${videoLine(h)}`).join('\n')}`
  },
}

// ── TranscribeVideos ──

/** 正在等的转录（BV 号）：同一个视频不重复盯 */
const watching = new Set<string>()

function watchTranscribe(bvid: string, title: string, kind: TranscribeKind, before: string): void {
  if (watching.has(bvid)) return
  watching.add(bvid)
  const startedAt = Date.now()
  const finish = (notice: string) => {
    watching.delete(bvid)
    enqueueTaskNotice(`transcribe:${bvid}`, notice)
  }
  const tick = async () => {
    try {
      const hit = (await searchVideoTranscripts({ video: bvid, perVideo: 0, limit: 1 })).find((h) => h.bvid === bvid)
      // 重新转录时原来就有一份，要等到时间变了才算这次的
      if (hit && hit.transcribed_at !== before) {
        finish(`《${title}》转录好了（${kindLabel(kind)}，共 ${hit.total} 句，${bvid}）。用 FindVideoTranscript 读它。`)
        return
      }
    } catch { /* 电脑暂时连不上，下次再看 */ }
    if (Date.now() - startedAt > WATCH_TIMEOUT_MS) {
      finish(`《${title}》（${bvid}）等了 ${Math.round(WATCH_TIMEOUT_MS / 60_000)} 分钟还没转录好，可能失败了。让主人去电脑的任务面板看一下。`)
      return
    }
    setTimeout(tick, WATCH_INTERVAL_MS)
  }
  setTimeout(tick, WATCH_INTERVAL_MS)
}

const transcribeVideos: TranscribeTool = {
  desktop: { write: '发起转录' },
  definition: {
    type: 'function',
    function: {
      name: 'TranscribeVideos',
      description:
        '让电脑把 B 站视频下载下来并转录成文字。电脑在后台做，要几分钟到十几分钟：这个工具立刻返回，不用等，也不要反复查；' +
        '转好时系统会自动发一条通知给你，期间照常和主人聊天。' +
        'bvids 从 GetBiliHistory 的结果里拿，带「已转录」标记的不用再转。' +
        'kind 默认 audio（听声音转文字，大多数视频用这个）；画面是滚动的文字、没有人讲解的视频（录屏的文章、纯字幕图文）用 visual：' +
        '每隔 frame_interval_sec 秒截一张图读上面的字，再拼成全文，不传间隔就用主人在电脑上设的默认值。' +
        '转录要花主人的模型额度：主人没有点名转哪个时，先把你打算转的视频列出来让主人确认，确认了再调用。',
      parameters: {
        type: 'object',
        properties: {
          bvids: { type: 'array', items: { type: 'string' }, description: '要转录的视频 BV 号，一次最多 20 个' },
          kind: { type: 'string', enum: ['audio', 'visual'], description: 'audio = 听声音（默认）；visual = 按间隔截图读画面上的字' },
          frame_interval_sec: { type: 'number', description: 'visual 时每隔几秒截一张图；不传用电脑上的默认值' },
        },
        required: ['bvids'],
      },
    },
  },
  async execute(args) {
    const bvids = [...new Set(toList(args.bvids))]
    if (bvids.length === 0) return '请给出要转录的视频 BV 号（从 GetBiliHistory 的结果里拿）'
    const kind: TranscribeKind = args.kind === 'visual' ? 'visual' : 'audio'
    const interval = typeof args.frame_interval_sec === 'number' && args.frame_interval_sec > 0
      ? Math.min(MAX_FRAME_INTERVAL_SEC, args.frame_interval_sec)
      : undefined

    // 发起之前先记下原来那份转录的时间：重新转录时靠它认出新的一份
    const before = new Map<string, string>()
    for (const bvid of bvids) {
      const hit = (await searchVideoTranscripts({ video: bvid, perVideo: 0, limit: 1 })).find((h) => h.bvid === bvid)
      if (hit) before.set(bvid, hit.transcribed_at)
    }

    const res = await requestVideoTranscribe(bvids, kind, interval)
    for (const v of res.accepted) watchTranscribe(v.bvid, v.title, kind, before.get(v.bvid) ?? '')

    const lines: string[] = []
    if (res.accepted.length > 0) {
      lines.push(`已经交给电脑在后台下载并转录（${kindLabel(kind)}），共 ${res.accepted.length} 个：`)
      lines.push(...res.accepted.map((v) => `- 《${v.title}》 ${v.bvid}`))
      lines.push('不用等也不用查：转好时系统会发通知给你。现在告诉主人已经开始了，然后照常聊。')
    }
    if (res.unknown.length > 0) {
      lines.push(`这些 BV 号不在观看记录里，没有处理：${res.unknown.join('、')}。用 GetBiliHistory 核对一下。`)
    }
    return lines.join('\n')
  },
}

export const TRANSCRIBE_TOOLS: readonly TranscribeTool[] = [findVideoTranscript, transcribeVideos]
