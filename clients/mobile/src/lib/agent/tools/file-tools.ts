// ══════════════════════════════════════════════
// Read / Write / Edit
// 执行端和权限关卡在 Kotlin：android/.../fairyfs/FairyFs.kt（对应 desktop fairy_fs.rs）。
// 不属于三类数据来源：文件都在手机的 App 私有目录 filesDir/fairy-workspace 里。
//
// 工作区外 desktop 是弹窗询问，手机端先做成直接拒绝，所以描述文字里「弹窗请主人确认」改掉了，
// 其他文字和 desktop 一致。
// ══════════════════════════════════════════════

import { NativeModules, Platform } from 'react-native'
import type { Tool } from './types'

interface FairyFsNative {
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<string>
  edit(path: string, oldString: string, newString: string): Promise<string>
}

const Native: FairyFsNative | null =
  Platform.OS === 'android' ? (NativeModules.FairyFs as FairyFsNative) ?? null : null

function requireNative(): FairyFsNative {
  if (!Native) throw new Error('这台设备没有文件工具的原生模块')
  return Native
}

// ── 文件工具的权限约定（执行端在 Kotlin FairyFs.kt）──

const FILE_SCOPE_NOTE = '你有自己的工作区：写相对路径就落在工作区里，可自由读写；工作区外的路径在手机上一律拒绝访问，被拒绝时不要换路径重试。'
const FILE_PATH_DESC = '文件路径。相对路径落在你的工作区；工作区外的路径在手机上会被拒绝'

// 原生方法的参数类型是 String，模型传来别的类型（数字、对象）要在这里挡住：
// 传过桥会在原生线程抛类型异常，而不是回到 Promise

// ── Read ──

export const readFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'Read',
      description: `读取本地文件内容，返回文本。${FILE_SCOPE_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: FILE_PATH_DESC },
        },
        required: ['file_path'],
      },
    },
  },
  async execute(args) {
    const path = args.file_path
    if (!path || typeof path !== 'string') return '缺少参数：file_path'
    return await requireNative().read(path)
  },
}

// ── Write ──

export const writeFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'Write',
      description: `将内容写入本地文件（完全覆盖）。${FILE_SCOPE_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: FILE_PATH_DESC },
          content:   { type: 'string', description: '要写入的文件内容' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  async execute(args) {
    const path = args.file_path
    const content = args.content
    if (!path || typeof path !== 'string') return '缺少参数：file_path'
    if (typeof content !== 'string') return '缺少参数：content'
    const written = await requireNative().write(path, content)
    return `已写入：${written}`
  },
}

// ── Edit ──

export const editFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'Edit',
      description: `在文件中执行精确字符串替换。old_string 必须在文件中唯一存在，否则报错。${FILE_SCOPE_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          file_path:  { type: 'string', description: FILE_PATH_DESC },
          old_string: { type: 'string', description: '要替换的原始字符串（必须唯一存在）' },
          new_string: { type: 'string', description: '替换后的新字符串' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  async execute(args) {
    const path = args.file_path
    const oldString = args.old_string
    const newString = args.new_string ?? ''
    if (!path || typeof path !== 'string' || !oldString || typeof oldString !== 'string') {
      return '缺少参数：file_path 或 old_string'
    }
    if (typeof newString !== 'string') return '缺少参数：new_string'
    // 校验权限 → 读 → 校验唯一 → 写回在 Kotlin 里一次完成
    const edited = await requireNative().edit(path, oldString, newString)
    return `已替换：${edited}`
  },
}
