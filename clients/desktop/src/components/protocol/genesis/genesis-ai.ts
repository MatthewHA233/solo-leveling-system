// 协议志 · 开局（梦想记事本）的 AI：誊便利贴 / 愿望短笺、照一遍（系统的回应）、人生金字塔、未来车票（年表）
//   走百炼（和动机蓝图一样的调用层），模型在模型库「协议志·开局」里换；调用记进模型审计
//   守的规矩：只陈述不评判，不鼓励不说教；用他自己的原话；不替他编新的愿望

import { queryModel } from '../../../lib/llm/api'
import { createUserMessage } from '../../../lib/llm/types'
import { loadConfig, getDashScopeApiKey } from '../../../lib/agent/agent-config'
import { getFeatureModel } from '../../../lib/model-audit'
import { toLocalDateStr } from '../../../lib/local-api'
import { AREAS, goalCount, normalizeNotes, normalizePyramid, normalizeTimeline, type InkNote, type Milestone, type Pyramid } from './genesis-model'

const FEATURE = 'protocol_genesis'
const DEFAULT_MODEL = 'qwen3.8-max'

const lists = (frustrations: readonly string[], wishes: readonly string[]) =>
  `最近最不如意的事：\n${frustrations.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n一直想做、却一直没做成的事：\n${wishes.map((x, i) => `${i + 1}. ${x}`).join('\n')}`

async function ask(systemPrompt: string, userText: string, maxTokens: number): Promise<string> {
  const config = loadConfig()
  const apiKey = getDashScopeApiKey(config) ?? ''
  if (!apiKey) throw new Error('还没配置 DashScope API Key：在「模型」里填好后再继续')
  const model = await getFeatureModel(FEATURE, DEFAULT_MODEL)
  const stream = queryModel([createUserMessage(userText)], {
    apiKey, apiBase: config.openaiApiBase, model, systemPrompt, maxTokens, feature: FEATURE,
  })
  let full = ''
  for await (const chunk of stream) {
    if (chunk.type === 'textDelta') full += chunk.delta
    else if (chunk.type === 'error') throw new Error(`模型调用失败（${model}）：${chunk.message}`)
  }
  return full.trim()
}

function json(reply: string): unknown {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(reply.slice(start, end + 1))
  } catch {
    return null
  }
}

// ── ① 照一遍 ──

const REFLECT_PROMPT = `你是「协议志」里的系统。用户刚写下两份清单：最近最不如意的事、一直想做却没做成的事。你要把他照一遍——像一面镜子，只陈述，不评判。

写法：
- 第二人称「你」，冷静、克制，像《我独自升级》里的系统，但不冷漠
- 第一段：一句话点出贯穿这些事的主线——他一直想成为什么样的人（用他的原话或最贴近的说法），以及他做过的努力（他写到的具体经历要点出来）
- 然后用「- 」列 3~7 条坐标：每条是一个事实对比或落差，尽量带上他写的数字和细节（比如「写过 20 万字的小说，现在一周写不出 200 字」）
- 最后一句固定：「这些我会原样放进镜子里。它们不是判决，是起点的坐标。」
- 不评价对错，不安慰，不鼓励，不给建议，不说教，不用感叹号，不用「加油」「相信自己」之类的话
- 只写他清单里有的事，不编造
- 总长 150~320 字

只输出正文。`

export async function reflect(frustrations: readonly string[], wishes: readonly string[]): Promise<string> {
  const text = await ask(REFLECT_PROMPT, lists(frustrations, wishes), 900)
  if (!text) throw new Error('系统这次没说出话来，再照一次试试')
  return text
}

// ── 责任之镜：把每条不如意誊成便利贴 ──

const CONDENSE_PROMPT = `你在给「责任之镜」写便利贴：把用户写下的每一条「最近最不如意的事」誊成一张便利贴，像他自己在手记本上随手记下的一句。
- 一条一张，顺序和条数都不变
- 第一人称「我」；留下最扎心的那个事实，带上他原话里的数字和细节（比如「20 万字」「200 字」「30 岁」「3000 块」），删掉解释、铺垫和形容
- 读起来要通顺、主语清楚（谁对谁做了什么），宁可多两个字
- 每张 14~34 个字，可以是一句，也可以是用「，」连起来的两个短句；不评判、不安慰、不鼓励、不加他没说过的事
- lines：把这句话排成 2~3 行写在便利贴上，每行 5~11 个字；只在语义停顿处换行（标点留在上一行行尾），不要把一个词、一个数字或一处标记拆到两行
- marks：在誊好的这句话里做 1~3 处手记标记，text 必须是句中原样的连续片段：
  - highlight：最刺痛的那个事实，4~12 字，每张必须有且只有一处
  - underline：一处落差或代价，4~12 字，可选
  - circle：一个数字或短词，不超过 6 字，可选
  - 标记之间不要重叠
只输出 JSON，不要代码块，不要解释：
{"notes":[{"lines":["……，","……"],"marks":[{"text":"……","kind":"highlight"}]}]}`

// ── 悬着的愿：把每条愿望誊成竖写的愿望短笺 ──

const WISH_PROMPT = `你在给「悬着的愿」写短笺：把用户写下的每一条「一直想做、却没做成的事」誊成一张竖着写的愿望短笺，像七夕挂在竹枝上的那种。
- 一条一张，顺序和条数都不变
- 这是一句随手写在短笺上的愿望，不是摘要：一条原话里说了好几件事，只留最核心的那一件
- 用他自己的口吻（「我想」「我要」），或者直接用他引用的那句诗；带上原话里的数字和名字，删掉解释和铺垫
- 每张 6~18 个字，硬上限 18 个字，超了就再删；读起来要通顺；不评判、不鼓励、不加他没说过的事
- lines：竖着写成 1~2 列（最多 2 列），每列 3~9 个字；只在语义停顿处换列（标点留在上一列末尾），不要把一个词、一个数字或一处标记拆开
- marks：在誊好的这句话里做 1~2 处手记标记，text 必须是句中原样的连续片段：
  - highlight：他最想要的那个东西，2~8 字，每张必须有且只有一处
  - circle：一个数字或短词，不超过 4 字，可选
  - 标记之间不要重叠
写法示例（不是他的愿望，只看写法）：原话「我一直想学钢琴，小时候家里买不起，现在工作了也总说没时间，但每次听到肖邦都很难受。」
→ {"lines":["我想学会钢琴，","弹一首肖邦"],"marks":[{"text":"学会钢琴","kind":"highlight"}]}
只输出 JSON，不要代码块，不要解释：
{"notes":[{"lines":["……","……"],"marks":[{"text":"……","kind":"highlight"}]}]}`

/** 模型偶尔吐出不合法的 JSON：誊写这种小活就地再问一次 */
const CONDENSE_ATTEMPTS = 2

/** 只誊传进来的这几条；按位置对回原话，所以条数对不上（中间漏了一条，后面就全错位）也算没誊成，再问一次 */
async function condense(prompt: string, items: readonly string[]): Promise<InkNote[]> {
  const user = items.map((x, i) => `${i + 1}. ${x}`).join('\n')
  for (let attempt = 0; attempt < CONDENSE_ATTEMPTS; attempt++) {
    const raw = json(await ask(prompt, user, 1500)) as { notes?: unknown } | null
    const list = Array.isArray(raw?.notes) ? raw.notes : []
    if (list.length !== items.length) continue
    const notes = normalizeNotes(list.map((n, i) => ({ ...(n as object), source: items[i] })))
    if (notes.length > 0) return notes
  }
  throw new Error('系统这次没誊出来，再试一次')
}

export const condenseFrustrations = (items: readonly string[]) => condense(CONDENSE_PROMPT, items)
export const condenseWishes = (items: readonly string[]) => condense(WISH_PROMPT, items)

// ── ② 以终为始：人生金字塔 ──

const PYRAMID_PROMPT = `你在帮用户「以终为始」：照熊谷正寿的「梦想·人生金字塔」，把他想做成的事分进六个领域。

塔分三层，越往下越是地基：
- 第一层 基本：health 健康（身体、睡眠、运动）、spirit 精神（心态、习惯、自律）、culture 教养（知识、技能、审美、外在的讲究）。健康在正中间，最要紧
- 第二层 实现：work 工作（事业、作品、社会上的位置）、family 家庭（伴侣、家人、朋友）
- 第三层 结果：wealth 资产（钱、物、生活条件），是前面几层自然长出来的结果

- mission：一句话的人生理念，写在塔尖上方。优先用他自己的原话（他引用的诗句、他说的初心）；没有就从愿望里提炼一句，不超过 30 字
- areas：每个领域 0~3 个具体目标，每个不超过 16 字，用他的原话改写成目标；「最不如意的事」可以反过来变成目标（比如「爬三层楼就喘」→「一口气爬完十层楼」）
- 两份清单都要看：不如意的事里碰到的方面（比如钱、感情）也算他提到了，反过来写成那一格的目标
- 同一件事只放进最贴切的那一格；两份清单都没碰到的领域才给空数组，不替他编新的愿望
- 不说教

只输出 JSON，不要代码块，不要解释：
{"mission":"……","areas":{"health":["……"],"spirit":[],"culture":[],"work":[],"family":[],"wealth":[]}}`

export async function proposePyramid(frustrations: readonly string[], wishes: readonly string[]): Promise<Pyramid> {
  const pyramid = normalizePyramid(json(await ask(PYRAMID_PROMPT, lists(frustrations, wishes), 900)))
  if (!pyramid || goalCount(pyramid) === 0) throw new Error('模型没有按格式给出金字塔，再提议一次试试')
  return pyramid
}

// ── ③ 未来年表 ──

const TIMELINE_PROMPT = `你在帮用户画「未来年表」：把人生金字塔放到时间上，倒推出几个有日期的锚点。

- 3~7 个锚点，按时间排序；when 用 YYYY-MM-DD（或只到月份 YYYY-MM），what 不超过 20 字，直接写那天的样子（不用写「到那天」）
- 他清单里有明确时间的（比如「半年后搬家」「30 岁前」），先按今天的日期换算成具体日子，作为锚点
- 第一个锚点在今天之后 30 天以内，小到一定做得到
- 远的不超过 3 年；数字要具体（公里、体脂、作品），但不要编他没提过的愿望
- 不说教

今天是 {TODAY}。

只输出 JSON，不要代码块，不要解释：
{"milestones":[{"when":"YYYY-MM-DD","what":"……"}]}`

export async function proposeTimeline(frustrations: readonly string[], wishes: readonly string[], pyramid: Pyramid): Promise<Milestone[]> {
  const prompt = TIMELINE_PROMPT.replace('{TODAY}', toLocalDateStr(new Date()))
  const filled = AREAS.filter((a) => pyramid.areas[a.key].length > 0)
  const pyramidText = `人生金字塔：\n人生理念：${pyramid.mission}\n${filled.map((a) => `- ${a.name}：${pyramid.areas[a.key].join('；')}`).join('\n')}`
  const raw = json(await ask(prompt, `${lists(frustrations, wishes)}\n\n${pyramidText}`, 900)) as { milestones?: unknown } | null
  const milestones = normalizeTimeline(raw?.milestones)
  if (!milestones || milestones.length === 0) throw new Error('模型没有按格式给出年表，再提议一次试试')
  return milestones
}
