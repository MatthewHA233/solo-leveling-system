#!/usr/bin/env node
// ══════════════════════════════════════════════
// Fairy 对齐清单工具：把桌面端源码切成连续不重叠的段落，逐段记录手机端状态
//   node tool.mjs generate [B02,B03]   按 scope.mjs 切段，写 batches/*.md（已有状态按 文件+符号 保留）；可只刷新指定批次
//   node tool.mjs check      校验：清单和当前源码一致、状态填写合规、落点文件存在
//   node tool.mjs status     按批次统计进度
//   node tool.mjs excluded   列出大文件里没被收录的段落，写到 excluded.txt
//   node tool.mjs mark <ID范围> <状态> <落点> [说明]   按 ID 更新状态，同时刷新哈希
// 桌面端改了某段，哈希对不上，check 会报出来，那一段就要重新核对。
// ══════════════════════════════════════════════

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCOPE, AUTO_SKIP } from './scope.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')
const DESKTOP = join(REPO, 'clients/desktop')
const BATCH_DIR = join(HERE, 'batches')
const require = createRequire(join(DESKTOP, 'package.json'))
const ts = require('typescript')

/** 超过这个行数的段落继续往里切 */
const MAX_LINES = 60
/** 相邻的小语句合并到这个行数以内，免得一行一条 */
const MERGE_LINES = 18
/** 单段行数上限，语法切不动的按行硬切 */
const MAX_CHUNK = 80

const STATUS = ['待迁移', '已对齐', '已适配', '不迁移']

// ── TS / TSX ──

function tsChildren(node, sf) {
  const f = ts
  const body = (b) => (b && b.statements ? [...b.statements] : null)
  if (f.isFunctionDeclaration(node) || f.isMethodDeclaration(node) || f.isConstructorDeclaration(node)) {
    return body(node.body)
  }
  if (f.isArrowFunction(node) || f.isFunctionExpression(node)) {
    return f.isBlock(node.body) ? body(node.body) : [node.body]
  }
  if (f.isVariableStatement(node)) {
    const decls = node.declarationList.declarations
    if (decls.length === 1 && decls[0].initializer) return tsChildren(decls[0].initializer, sf) ?? null
    return [...decls]
  }
  if (f.isVariableDeclaration(node)) return node.initializer ? tsChildren(node.initializer, sf) : null
  if (f.isExportAssignment(node)) return tsChildren(node.expression, sf)
  if (f.isExpressionStatement(node)) return tsChildren(node.expression, sf)
  if (f.isReturnStatement(node)) return node.expression ? tsChildren(node.expression, sf) : null
  if (f.isParenthesizedExpression(node) || f.isAwaitExpression(node) || f.isAsExpression(node)) {
    return tsChildren(node.expression, sf)
  }
  if (f.isCallExpression(node)) {
    // 立即执行函数：{(() => { ... })()}
    if (f.isParenthesizedExpression(node.expression)) return tsChildren(node.expression, sf)
    const fnArg = node.arguments.find((a) => f.isArrowFunction(a) || f.isFunctionExpression(a))
    if (fnArg) return tsChildren(fnArg, sf)
    const big = node.arguments.find((a) => f.isObjectLiteralExpression(a) || f.isArrayLiteralExpression(a))
    if (big) return tsChildren(big, sf)
    return null
  }
  if (f.isObjectLiteralExpression(node)) return [...node.properties]
  if (f.isArrayLiteralExpression(node)) return [...node.elements]
  if (f.isPropertyAssignment(node)) return tsChildren(node.initializer, sf)
  if (f.isClassDeclaration(node)) return [...node.members]
  if (f.isInterfaceDeclaration(node)) return [...node.members]
  if (f.isTypeAliasDeclaration(node)) return ts.isTypeLiteralNode(node.type) ? [...node.type.members] : null
  if (f.isIfStatement(node)) {
    const out = [node.thenStatement]
    if (node.elseStatement) out.push(node.elseStatement)
    return out
  }
  if (f.isBlock(node)) return [...node.statements]
  if (f.isTryStatement(node)) {
    const out = [node.tryBlock]
    if (node.catchClause) out.push(node.catchClause.block)
    if (node.finallyBlock) out.push(node.finallyBlock)
    return out
  }
  if (f.isForStatement(node) || f.isForOfStatement(node) || f.isForInStatement(node) || f.isWhileStatement(node) || f.isDoStatement(node)) {
    return [node.statement]
  }
  if (f.isSwitchStatement(node)) return [...node.caseBlock.clauses]
  if (f.isCaseClause(node) || f.isDefaultClause(node)) return [...node.statements]
  if (f.isJsxElement(node)) return node.children.filter((c) => !f.isJsxText(c) || c.getText(sf).trim())
  if (f.isJsxFragment(node)) return node.children.filter((c) => !f.isJsxText(c) || c.getText(sf).trim())
  if (f.isJsxExpression(node)) return node.expression ? tsChildren(node.expression, sf) ?? [node.expression] : null
  if (f.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse]
  if (f.isBinaryExpression(node)) return [node.right]
  return null
}

function tsLabel(node, sf) {
  const f = ts
  const clip = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 48)
  if (f.isImportDeclaration(node)) return '导入'
  if (f.isFunctionDeclaration(node)) return `function ${node.name?.text ?? 'default'}`
  if (f.isVariableStatement(node)) {
    const d = node.declarationList.declarations[0]
    const name = d.name.getText(sf)
    const init = d.initializer
    if (init && f.isCallExpression(init)) return `const ${clip(name)} = ${clip(init.expression.getText(sf))}()`
    return `const ${clip(name)}`
  }
  if (f.isVariableDeclaration(node)) return `const ${clip(node.name.getText(sf))}`
  if (f.isInterfaceDeclaration(node)) return `interface ${node.name.text}`
  if (f.isTypeAliasDeclaration(node)) return `type ${node.name.text}`
  if (f.isClassDeclaration(node)) return `class ${node.name?.text ?? ''}`
  if (f.isEnumDeclaration(node)) return `enum ${node.name.text}`
  if (f.isMethodDeclaration(node) || f.isPropertyDeclaration(node)) return `member ${clip(node.name.getText(sf))}`
  if (f.isPropertyAssignment(node) || f.isShorthandPropertyAssignment(node)) return `key ${clip(node.name.getText(sf))}`
  if (f.isMethodSignature(node) || f.isPropertySignature(node)) return `field ${clip(node.name.getText(sf))}`
  if (f.isExportDeclaration(node)) return '再导出'
  if (f.isExportAssignment(node)) return 'export default'
  if (f.isJsxElement(node)) return `<${clip(node.openingElement.tagName.getText(sf))}>`
  if (f.isJsxSelfClosingElement(node)) return `<${clip(node.tagName.getText(sf))} />`
  if (f.isJsxFragment(node)) return '<>'
  if (f.isJsxExpression(node)) return `{${clip(node.getText(sf).slice(1))}}`
  if (f.isReturnStatement(node)) return 'return'
  if (f.isIfStatement(node)) return `if (${clip(node.expression.getText(sf))})`
  if (f.isExpressionStatement(node)) {
    const e = node.expression
    if (f.isCallExpression(e)) return `${clip(e.expression.getText(sf))}()`
    return clip(e.getText(sf))
  }
  if (f.isCaseClause(node)) return `case ${clip(node.expression.getText(sf))}`
  if (f.isDefaultClause(node)) return 'default:'
  if (f.isTryStatement(node)) return 'try'
  if (f.isForStatement(node) || f.isForOfStatement(node) || f.isForInStatement(node)) return 'for'
  if (f.isWhileStatement(node)) return 'while'
  if (f.isSwitchStatement(node)) return `switch (${clip(node.expression.getText(sf))})`
  return clip(node.getText(sf).split('\n')[0])
}

function sliceTs(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1
  const out = []
  const walk = (node, path) => {
    const start = lineOf(node.getStart(sf, true))
    const end = lineOf(node.getEnd())
    const own = tsLabel(node, sf)
    const label = path ? `${path} › ${own}` : own
    const kids = end - start + 1 > MAX_LINES ? tsChildren(node, sf) : null
    if (!kids || kids.length === 0) {
      out.push({ start, end, label })
      return
    }
    kids.forEach((k) => walk(k, label))
  }
  sf.statements.forEach((s) => walk(s, ''))
  return out
}

// ── Rust ──

function rustItems(lines, from, to) {
  const items = []
  let i = from
  let depth = 0
  let start = -1
  let inBlock = 0
  let rawClose = null
  let inStr = false
  while (i <= to) {
    const line = lines[i - 1]
    let j = 0
    while (j < line.length) {
      if (rawClose) {
        const at = line.indexOf(rawClose, j)
        if (at < 0) { j = line.length; break }
        j = at + rawClose.length
        rawClose = null
        continue
      }
      if (inBlock > 0) {
        if (line.startsWith('*/', j)) { inBlock--; j += 2; continue }
        if (line.startsWith('/*', j)) { inBlock++; j += 2; continue }
        j++
        continue
      }
      if (inStr) {
        if (line[j] === '\\') { j += 2; continue }
        if (line[j] === '"') inStr = false
        j++
        continue
      }
      const c = line[j]
      if (line.startsWith('//', j)) break
      if (line.startsWith('/*', j)) { inBlock++; j += 2; continue }
      const raw = /^b?r(#*)"/.exec(line.slice(j))
      if (raw && !/[A-Za-z0-9_]/.test(line[j - 1] ?? ' ')) {
        rawClose = `"${raw[1]}`
        j += raw[0].length
        continue
      }
      if (c === '"') { inStr = true; j++; continue }
      if (c === "'") {
        const m = /^'(\\.[^']*|[^\\'])'/.exec(line.slice(j))
        j += m ? m[0].length : 1
        continue
      }
      if (start < 0 && /\S/.test(c)) start = i
      if (c === '{' || c === '(' || c === '[') depth++
      if (c === '}' || c === ')' || c === ']') {
        depth--
        if (depth === 0 && c === '}') {
          const rest = line.slice(j + 1).trim()
          if (!rest.startsWith(')') && !rest.startsWith('.') && !rest.startsWith(';')) {
            items.push({ start, end: i })
            start = -1
            j++
            continue
          }
        }
      }
      if (c === ';' && depth === 0) {
        items.push({ start, end: i })
        start = -1
      }
      j++
    }
    i++
  }
  if (start > 0) items.push({ start, end: to })
  return items
}

function rustLabel(line) {
  const s = line.trim()
  const m = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(fn|struct|enum|impl|const|static|type|trait|mod|use)\s+([^\s(<{:;=]+(?:\s+for\s+[^\s{<]+)?)/.exec(s)
  return m ? `${m[1]} ${m[2]}` : s.slice(0, 48)
}

function sliceRust(text) {
  const lines = text.split('\n')
  const out = []
  const walk = (from, to, path) => {
    for (const it of rustItems(lines, from, to)) {
      // 属性行本身不是独立语句，并到下一项里
      let head = it.start
      while (head < it.end && /^\s*#\[/.test(lines[head - 1])) head++
      const label = rustLabel(lines[head - 1])
      const full = path ? `${path} › ${label}` : label
      const isContainer = /^(impl|mod|trait|fn) /.test(label)
      if (isContainer && it.end - it.start + 1 > MAX_LINES) {
        // 签名可能跨行，从以 { 结尾的那一行之后开始
        let open = head
        while (open < it.end && !/\{\s*(\/\/.*)?$/.test(lines[open - 1])) open++
        walk(open + 1, it.end - 1, full)
      } else {
        out.push({ start: it.start, end: it.end, label: full })
      }
    }
  }
  walk(1, lines.length, '')
  return out
}

// ── 公共：补缝、合并、哈希 ──

function finalize(text, raw) {
  const lines = text.split('\n')
  const blank = (n) => !lines[n - 1]?.trim()
  const sorted = raw.slice().sort((a, b) => a.start - b.start || b.end - a.end)
  // 去掉被包含的（同一行上的多个节点）
  const flat = []
  for (const s of sorted) {
    const last = flat[flat.length - 1]
    if (last && s.start <= last.end) {
      if (s.end > last.end) last.end = s.end
      continue
    }
    flat.push({ ...s })
  }
  // 缝隙（注释、框架行、右括号）：有内容就单独成段
  const filled = []
  let cursor = 1
  const pushGap = (from, to, nextLabel) => {
    let a = from
    let b = to
    while (a <= b && blank(a)) a++
    while (b >= a && blank(b)) b--
    if (a > b) return
    const gapText = lines.slice(a - 1, b).join('\n')
    const onlyComment = lines.slice(a - 1, b).every((l) => !l.trim() || /^\s*(\/\/|\/\*|\*|#\[)/.test(l))
    const closing = gapText.replace(/[\s})\]>;,/]/g, '') === ''
    filled.push({ start: a, end: b, label: onlyComment ? `注释 → ${nextLabel}` : closing ? '收尾括号' : `框架行 → ${nextLabel}`, gap: true })
  }
  for (const s of flat) {
    if (s.start > cursor) pushGap(cursor, s.start - 1, s.label)
    filled.push(s)
    cursor = s.end + 1
  }
  if (cursor <= lines.length) pushGap(cursor, lines.length, '文件结尾')

  // 注释紧贴下一段：并进去；收尾括号并到上一段
  const merged = []
  for (let i = 0; i < filled.length; i++) {
    const s = filled[i]
    const next = filled[i + 1]
    if (s.gap && s.label.startsWith('注释') && next && next.start - s.end <= 1) {
      next.start = s.start
      continue
    }
    if (s.gap && s.label === '收尾括号' && merged.length) {
      merged[merged.length - 1].end = s.end
      continue
    }
    merged.push(s)
  }
  // 语法上切不动的长段（SQL、CSS、大数组）按行硬切，优先落在空行上
  const bounded = []
  for (const s of merged) {
    if (s.end - s.start + 1 <= MAX_CHUNK) {
      bounded.push(s)
      continue
    }
    let from = s.start
    let part = 1
    while (from <= s.end) {
      let to = Math.min(from + MAX_CHUNK - 1, s.end)
      if (to < s.end) {
        for (let k = to; k > from + MAX_CHUNK / 2; k--) {
          if (blank(k)) { to = k; break }
        }
      }
      bounded.push({ start: from, end: to, label: `${s.label} （第 ${part} 块）` })
      from = to + 1
      part++
    }
  }
  // 相邻小段合并
  const out = []
  for (const s of bounded) {
    const last = out[out.length - 1]
    if (last && last.end - last.start + 1 + (s.end - s.start + 1) <= MERGE_LINES && s.start - last.end <= 2) {
      last.end = s.end
      last.parts.push(s.label)
      continue
    }
    out.push({ ...s, parts: [s.label] })
  }
  const seen = new Map()
  return out.map((s) => {
    const uniq = [...new Set(s.parts)]
    const joined = uniq.length > 2 ? `${uniq[0]} 等 ${uniq.length} 项` : uniq.join(' + ')
    const clean = joined.replace(/[`|]/g, "'")
    const n = (seen.get(clean) ?? 0) + 1
    seen.set(clean, n)
    const body = lines.slice(s.start - 1, s.end).join('\n')
    return {
      start: s.start,
      end: s.end,
      label: n > 1 ? `${clean} #${n}` : clean,
      hash: createHash('sha1').update(body).digest('hex').slice(0, 8),
      body,
    }
  })
}

function sliceFile(entry) {
  const path = join(REPO, entry.file)
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  const raw = entry.file.endsWith('.rs') ? sliceRust(text) : sliceTs(entry.file, text)
  return finalize(text, raw)
}

// ── 批次文件读写 ──

const HEADER = '| ID | 源码段 | 符号 | 哈希 | 状态 | 手机端落点 | 说明 |'
const RULE = '|---|---|---|---|---|---|---|'

function parseLine(line) {
  if (!line.startsWith('| ') || line === HEADER || line.startsWith('| ID ')) return []
  const cells = line.slice(1, -1).split(' | ').map((c) => c.trim())
  if (cells.length < 6) return []
  const [id, loc, label, hash, status, target, ...note] = cells
  const m = /^`?([^`:]+):(\d+)-(\d+)`?$/.exec(loc)
  if (!m) return []
  return [{
    id, file: m[1], start: +m[2], end: +m[3],
    label: label.replace(/^`|`$/g, ''), hash: hash.replace(/`/g, ''), status,
    target: (target ?? '').replace(/`/g, ''), note: note.join(' | '),
  }]
}

function parseBatch(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').flatMap(parseLine)
}

function formatRow(r) {
  return `| ${r.id} | \`${r.file}:${r.start}-${r.end}\` | \`${r.label}\` | \`${r.hash}\` | ${r.status} | ${r.target ? `\`${r.target}\`` : ''} | ${r.note ?? ''} |`
}

function batchPath(b) {
  return join(BATCH_DIR, `${b.id}.md`)
}

function expectedRows(batch) {
  const rows = []
  for (const entry of batch.files) {
    for (const s of sliceFile(entry)) {
      const head = s.body.split('\n').slice(0, 3).join(' ')
      if (entry.only && !entry.only.test(s.label) && !entry.only.test(head)) continue
      rows.push({ file: entry.file, ...s, defaultTarget: entry.target ?? '' })
    }
  }
  return rows
}

function autoSkip(row) {
  for (const rule of AUTO_SKIP) {
    if (rule.test(row)) return rule.reason
  }
  return null
}

function generate(only) {
  mkdirSync(BATCH_DIR, { recursive: true })
  let total = 0
  for (const batch of SCOPE) {
    if (only && !only.split(',').includes(batch.id.split('-')[0])) continue
    const old = new Map(parseBatch(batchPath(batch)).map((r) => [`${r.file}#${r.label}`, r]))
    const rows = expectedRows(batch).map((s, i) => {
      const prev = old.get(`${s.file}#${s.label}`)
      const id = `${batch.id.split('-')[0]}.${String(i + 1).padStart(3, '0')}`
      if (prev) {
        // 已处理过的段落改动后保留旧哈希，check 才能报出来
        const stale = prev.hash !== s.hash && prev.status !== '待迁移'
        return {
          id, file: s.file, start: s.start, end: s.end, label: s.label, hash: stale ? prev.hash : s.hash,
          status: prev.status, target: prev.target, note: prev.note,
        }
      }
      const reason = autoSkip(s)
      return {
        id, file: s.file, start: s.start, end: s.end, label: s.label, hash: s.hash,
        status: reason ? '不迁移' : '待迁移', target: reason ? '' : s.defaultTarget, note: reason ?? '',
      }
    })
    total += rows.length
    writeFileSync(batchPath(batch), [
      `# ${batch.id}：${batch.title}`,
      '',
      `状态只能是：${STATUS.join(' / ')}。规则见 ../README.md。`,
      '',
      HEADER,
      RULE,
      ...rows.map(formatRow),
      '',
    ].join('\n'))
  }
  console.log(`已生成 ${SCOPE.length} 个批次，共 ${total} 段`)
}

function check() {
  const problems = []
  const counts = new Map()
  for (const batch of SCOPE) {
    const rows = parseBatch(batchPath(batch))
    const byKey = new Map(rows.map((r) => [`${r.file}#${r.label}`, r]))
    const expected = expectedRows(batch)
    const expectedKeys = new Set(expected.map((s) => `${s.file}#${s.label}`))
    for (const s of expected) {
      const r = byKey.get(`${s.file}#${s.label}`)
      if (!r) problems.push(`${batch.id}: 缺少 ${s.file}:${s.start}-${s.end} ${s.label}`)
      else if (r.hash !== s.hash) problems.push(`${r.id}: 桌面端已改动，需重新核对 ${s.file}:${s.start}-${s.end} ${s.label}`)
    }
    for (const r of rows) {
      if (!expectedKeys.has(`${r.file}#${r.label}`)) problems.push(`${r.id}: 源码里已没有这段 ${r.file}:${r.start}-${r.end} ${r.label}`)
      if (!STATUS.includes(r.status)) problems.push(`${r.id}: 状态无效「${r.status}」`)
      if ((r.status === '已对齐' || r.status === '已适配') && !r.target) problems.push(`${r.id}: ${r.status} 必须写手机端落点`)
      if (r.status === '已适配' && !r.note) problems.push(`${r.id}: 已适配 必须说明差异`)
      if (r.status === '不迁移' && !r.note) problems.push(`${r.id}: 不迁移 必须写原因`)
      if ((r.status === '已对齐' || r.status === '已适配') && r.target) {
        const path = r.target.split(/[:#\s]/)[0]
        if (!existsSync(join(REPO, path))) problems.push(`${r.id}: 落点不存在 ${path}`)
      }
      counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
    }
  }
  readdirSync(BATCH_DIR)
    .filter((f) => f.endsWith('.md') && !SCOPE.some((b) => `${b.id}.md` === f))
    .forEach((f) => problems.push(`多余的批次文件 ${f}`))
  if (problems.length) {
    console.log(problems.join('\n'))
    console.log(`\n共 ${problems.length} 个问题`)
    process.exitCode = 1
  } else {
    console.log('清单校验通过')
  }
  console.log([...counts.entries()].map(([k, v]) => `${k} ${v}`).join(' · '))
}

function status() {
  for (const batch of SCOPE) {
    const rows = parseBatch(batchPath(batch))
    const count = (s) => rows.filter((r) => r.status === s).length
    console.log(`${batch.id.padEnd(16)} 共 ${String(rows.length).padStart(4)}  ${STATUS.map((s) => `${s} ${count(s)}`).join('  ')}`)
  }
}

// 大文件用 only 筛段，这里列出没被任何批次收录的段落，防止筛漏
function excluded() {
  const partial = new Set(SCOPE.flatMap((b) => b.files.filter((f) => f.only).map((f) => f.file)))
  const whole = new Set(SCOPE.flatMap((b) => b.files.filter((f) => !f.only).map((f) => f.file)))
  const out = []
  for (const file of partial) {
    if (whole.has(file)) continue
    const entries = SCOPE.flatMap((b) => b.files.filter((f) => f.file === file))
    const segs = sliceFile({ file })
    const rest = segs.filter((s) => {
      const head = s.body.split('\n').slice(0, 3).join(' ')
      return !entries.some((e) => e.only.test(s.label) || e.only.test(head))
    })
    out.push(`## ${file}（共 ${segs.length} 段，未收录 ${rest.length} 段）`)
    rest.forEach((s) => out.push(`${s.start}-${s.end}  ${s.label}`))
    out.push('')
  }
  writeFileSync(join(HERE, 'excluded.txt'), out.join('\n'))
  console.log(out.filter((l) => l.startsWith('## ')).join('\n'))
}

// node tool.mjs mark B01.001-B01.013,B01.020 已对齐 clients/mobile/src/lib/llm/types.ts "说明"
// 说明里的竖线会破坏表格，这里替换掉；同时把哈希刷新成当前源码的值，表示这一段已按最新内容核对过
function mark(spec, newStatus, target, note = '') {
  if (!STATUS.includes(newStatus)) throw new Error(`状态无效「${newStatus}」`)
  const ids = new Set()
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-')
    const prefix = a.split('.')[0]
    const from = +a.split('.')[1]
    const to = b ? +b.split('.')[1] : from
    for (let i = from; i <= to; i++) ids.add(`${prefix}.${String(i).padStart(3, '0')}`)
  }
  const prefix = spec.split('.')[0]
  const batch = SCOPE.find((b) => b.id.startsWith(`${prefix}-`))
  if (!batch) throw new Error(`没有批次 ${prefix}`)
  const current = new Map(expectedRows(batch).map((s) => [`${s.file}#${s.label}`, s]))
  const path = batchPath(batch)
  const hit = new Set()
  const lines = readFileSync(path, 'utf8').split('\n').map((line) => {
    if (!line.startsWith('| ')) return line
    const [row] = parseLine(line)
    if (!row || !ids.has(row.id)) return line
    hit.add(row.id)
    const live = current.get(`${row.file}#${row.label}`)
    return formatRow({
      ...row,
      hash: live?.hash ?? row.hash,
      status: newStatus,
      target: target || row.target,
      note: note.replace(/\|/g, '/').replace(/\n/g, ' '),
    })
  })
  const missing = [...ids].filter((id) => !hit.has(id))
  if (missing.length) throw new Error(`找不到这些 ID：${missing.join(', ')}`)
  writeFileSync(path, lines.join('\n'))
  console.log(`已标记 ${hit.size} 段 → ${newStatus}`)
}

const cmd = process.argv[2]
if (cmd === 'mark') mark(process.argv[3], process.argv[4], process.argv[5], process.argv[6])
else if (cmd === 'generate') generate(process.argv[3])
else if (cmd === 'check') check()
else if (cmd === 'status') status()
else if (cmd === 'excluded') excluded()
else console.log('用法: node tool.mjs generate|check|status|excluded')
