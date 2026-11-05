package com.solevup.mobile.fairyfs

import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

// ══════════════════════════════════════════════
// Fairy 文件工具（Read / Write / Edit）的权限关卡，对应 desktop fairy_fs.rs
//
// Fairy 会读 B 站评论、视频转写这类外部文字，里面可能藏着诱导它读写文件的指令（提示词注入）。
// 这个进程能读写自己的数据库、Key、设置，只靠系统提示词里「破坏性操作先确认」挡不住。
//
// 规则：
//   · 工作区 filesDir/fairy-workspace 内：直接读写；相对路径一律落在这里
//   · 工作区外：直接拒绝。desktop 是每次弹窗询问，手机端先不做询问
//
// 和 desktop 的其他不同（都是收紧）：
//   · 路径比较区分大小写：desktop 转小写是因为 Windows，Android 内部存储区分大小写
//   · 工作区内任何一级是符号链接都拒绝：desktop 只按字面消解，符号链接能带出工作区
//   · Edit 先判权限再读文件：desktop 为了少弹窗先读后问，工作区外的文件有没有、
//     某个字符串出现几次，在询问之前就从错误信息漏出去了
//
// 这个类不依赖 Android API，符号链接判断由外面传入，方便在普通 JVM 上验证。
// ══════════════════════════════════════════════

/** 工具执行失败，message 原样给模型看 */
open class FairyFsException(message: String) : Exception(message)

/** 权限关卡拒绝，单独一类方便记日志 */
class FairyFsDeniedException(message: String) : FairyFsException(message)

class FairyFs(filesDir: File, private val isSymlink: (File) -> Boolean) {

  /**
   * 工作区真实路径。只规范化 filesDir（/data/user/0 在多数机型上是指向 /data/data 的符号链接），
   * 不规范化 fairy-workspace 自身：它要是符号链接，得在 ensureNoSymlink 里被拒绝，而不是把工作区挪走。
   */
  val workspacePath: String = File(filesDir.canonicalFile, WORKSPACE_DIR).path

  /** filesDir 原样拼出来的路径，模型传绝对路径时可能用这种写法，指的是同一个目录 */
  private val workspaceAlias: String = File(filesDir.absoluteFile, WORKSPACE_DIR).path

  /** 相对路径落在工作区；按字面消解 `.` / `..`（目标文件可能还不存在，不能只靠 canonicalize） */
  fun resolve(path: String): File {
    if (path.isBlank()) throw FairyFsException("缺少文件路径")
    // NUL 在 C 层会截断路径，校验的和实际打开的就不是同一个文件
    if (path.indexOf('\u0000') >= 0) throw FairyFsDeniedException("文件路径含非法字符，拒绝访问。不要换个路径重试，先问主人是否要这样做。")
    val joined = if (path.startsWith("/")) path else "$workspacePath/$path"
    val parts = ArrayList<String>()
    for (segment in joined.split('/')) {
      when (segment) {
        "", "." -> {}
        ".." -> if (parts.isNotEmpty()) parts.removeAt(parts.lastIndex)
        else -> parts.add(segment)
      }
    }
    val normalized = "/" + parts.joinToString("/")
    val canonicalSpelling =
      if (workspaceAlias != workspacePath && isUnder(normalized, workspaceAlias)) {
        workspacePath + normalized.removePrefix(workspaceAlias)
      } else {
        normalized
      }
    return File(canonicalSpelling)
  }

  private fun isUnder(path: String, root: String): Boolean = path == root || path.startsWith("$root/")

  private fun inWorkspace(file: File): Boolean = isUnder(file.path, workspacePath)

  /** 字面检查通过后，从工作区根往下逐级检查符号链接，目标不存在的部分自然不是符号链接 */
  private fun ensureNoSymlink(file: File, action: String) {
    var current = File(workspacePath)
    val relative = file.path.removePrefix(workspacePath).trim('/')
    val segments = if (relative.isEmpty()) emptyList() else relative.split('/')
    for (i in -1 until segments.size) {
      if (i >= 0) current = File(current, segments[i])
      if (isSymlink(current)) {
        throw FairyFsDeniedException("「${file.path}」经过符号链接，可能指向工作区外，拒绝${action}。不要换个路径重试，先问主人是否要这样做。")
      }
    }
    // 兜底：逐级检查之后，真实路径也必须还在工作区里
    val real = file.canonicalPath
    if (!isUnder(real, workspacePath)) {
      throw FairyFsDeniedException("「${file.path}」实际指向工作区外，拒绝${action}。不要换个路径重试，先问主人是否要这样做。")
    }
  }

  private fun authorize(action: String, file: File) {
    if (!inWorkspace(file)) {
      throw FairyFsDeniedException("手机上不能${action}工作区外的文件「${file.path}」。不要换个路径重试，先问主人是否要这样做。")
    }
    ensureNoSymlink(file, action)
    // 还没建工作区时对根路径写入，会在 filesDir 下建出一个叫 fairy-workspace 的普通文件，之后工作区就废了
    if (file.path == workspacePath) {
      throw FairyFsException("「${file.path}」是工作区目录本身，不是文件")
    }
  }

  fun read(path: String): String {
    val p = resolve(path)
    authorize("读取", p)
    return readUtf8(p)
  }

  fun write(path: String, content: String): String {
    val p = resolve(path)
    authorize("写入", p)
    val parent = p.parentFile
    if (parent != null && !parent.isDirectory && !parent.mkdirs()) {
      throw FairyFsException("创建目录失败: ${parent.path}")
    }
    writeUtf8(p, content)
    return p.path
  }

  /** 判权限 → 读 → 校验唯一 → 替换写回，一次完成 */
  fun edit(path: String, old: String, new: String): String {
    val p = resolve(path)
    if (old.isEmpty()) throw FairyFsException("old_string 不能为空")
    authorize("修改", p)
    val content = readUtf8(p)
    val count = countOccurrences(content, old)
    if (count == 0) throw FairyFsException("未找到要替换的字符串：${preview(old)}")
    if (count > 1) throw FairyFsException("字符串不唯一（出现 $count 次），请提供更多上下文")
    val index = content.indexOf(old)
    writeUtf8(p, content.substring(0, index) + new + content.substring(index + old.length))
    return p.path
  }

  /** 严格按 UTF-8 解码（同 Rust read_to_string）：替换成 U+FFFD 的话，Edit 写回时会把二进制文件写坏 */
  private fun readUtf8(file: File): String {
    val bytes = try {
      file.readBytes()
    } catch (e: IOException) {
      throw FairyFsException("读取失败: ${e.message}")
    }
    return try {
      StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()
    } catch (e: CharacterCodingException) {
      throw FairyFsException("读取失败: 文件不是有效的 UTF-8 文本")
    }
  }

  private fun writeUtf8(file: File, content: String) {
    try {
      file.writeBytes(content.toByteArray(StandardCharsets.UTF_8))
    } catch (e: IOException) {
      throw FairyFsException("写入失败: ${e.message}")
    }
  }

  /** 不重叠计数（同 Rust str::matches） */
  private fun countOccurrences(content: String, needle: String): Int {
    var count = 0
    var from = content.indexOf(needle)
    while (from >= 0) {
      count += 1
      from = content.indexOf(needle, from + needle.length)
    }
    return count
  }

  /** 按码点截断（同 Rust chars），不把代理对切成两半 */
  private fun preview(s: String): String {
    if (s.codePointCount(0, s.length) <= PREVIEW_CHARS) return s
    return s.substring(0, s.offsetByCodePoints(0, PREVIEW_CHARS)) + "……"
  }

  companion object {
    const val WORKSPACE_DIR = "fairy-workspace"
    private const val PREVIEW_CHARS = 200
  }
}
