// 斜杠菜单的中文输入习惯：
//   · 内置项补拼音全拼 + 首字母别名（BlockNote 自带的中文词条只有汉字和英文，/daima、/bt 搜不到）
//   · 中文输入法开着时按「/」键打出来的是「、」：空行开头的「、」也当斜杠用（句中的顿号照常是顿号）

/** key = BlockNote 斜杠菜单项的 key */
const PINYIN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  heading: ['biaoti', 'bt', 'yijibiaoti', 'yjbt', 'dabiaoti'],
  heading_2: ['erjibiaoti', 'ejbt', 'biaoti2', 'bt2'],
  heading_3: ['sanjibiaoti', 'sjbt', 'biaoti3', 'bt3'],
  heading_4: ['sijibiaoti', 'bt4'],
  heading_5: ['wujibiaoti', 'bt5'],
  heading_6: ['liujibiaoti', 'bt6'],
  toggle_heading: ['zhediebiaoti', 'zdbt', 'zhedie', 'zd'],
  toggle_heading_2: ['zhediebiaoti', 'zdbt', 'zhedie', 'zd'],
  toggle_heading_3: ['zhediebiaoti', 'zdbt', 'zhedie', 'zd'],
  quote: ['yinyong', 'yy'],
  numbered_list: ['youxuliebiao', 'yxlb', 'bianhao', 'shuzi'],
  bullet_list: ['wuxuliebiao', 'wxlb', 'liebiao', 'lb'],
  check_list: ['daiban', 'db', 'renwu', 'fuxuankuang', 'qingdan', 'todo'],
  toggle_list: ['zhedieliebiao', 'zdlb', 'zhedie', 'zd'],
  paragraph: ['zhengwen', 'zw', 'wenben', 'duanluo'],
  code_block: ['daima', 'dm', 'daimakuai'],
  divider: ['fengexian', 'fgx', 'fenge'],
  table: ['biaoge', 'bg'],
  image: ['tupian', 'tp', 'zhaopian'],
  video: ['shipin', 'sp'],
  audio: ['yinpin', 'yp'],
  file: ['wenjian', 'wj', 'fujian'],
  emoji: ['biaoqing', 'bq'],
}

export function withPinyinAliases<T extends { aliases?: readonly string[] }>(item: T): T {
  const key = (item as { key?: unknown }).key
  const extra = typeof key === 'string' ? PINYIN_ALIASES[key] : undefined
  if (!extra) return item
  return { ...item, aliases: [...(item.aliases ?? []), ...extra] }
}

/** 中文输入法下「/」键打出的字符 */
export const CJK_SLASH = '、'

/** 只在空行开头把「、」当斜杠：光标所在的块还一个字都没有 */
export function isEmptyLine(tr: { selection: { empty: boolean; $from: { parent: { textContent: string } } } }): boolean {
  return tr.selection.empty && tr.selection.$from.parent.textContent.length === 0
}
