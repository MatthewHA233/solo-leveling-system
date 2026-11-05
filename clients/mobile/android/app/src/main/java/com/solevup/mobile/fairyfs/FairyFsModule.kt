package com.solevup.mobile.fairyfs

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

private const val TAG = "FairyFs"

/**
 * 用 lstat，不用 java.nio.file.Files.isSymbolicLink：后者判断不了时也返回 false。
 * 路径不存在不算符号链接；其他错误（权限等）判断不了时按是处理，宁可拒绝。
 */
private fun isSymlink(file: File): Boolean =
  try {
    OsConstants.S_ISLNK(Os.lstat(file.path).st_mode)
  } catch (e: ErrnoException) {
    e.errno != OsConstants.ENOENT && e.errno != OsConstants.ENOTDIR
  }

/** Fairy 的 Read / Write / Edit 工具，JS 端在 src/lib/agent/tools/file-tools.ts */
class FairyFsModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  private val fs by lazy { FairyFs(reactContext.filesDir) { isSymlink(it) } }

  override fun getName(): String = "FairyFs"

  @ReactMethod
  fun read(path: String, promise: Promise) = respond(promise) { fs.read(path) }

  @ReactMethod
  fun write(path: String, content: String, promise: Promise) = respond(promise) { fs.write(path, content) }

  @ReactMethod
  fun edit(path: String, oldString: String, newString: String, promise: Promise) =
    respond(promise) { fs.edit(path, oldString, newString) }

  private inline fun respond(promise: Promise, block: () -> String) {
    try {
      promise.resolve(block())
    } catch (e: FairyFsDeniedException) {
      Log.w(TAG, "拒绝: ${e.message}")
      promise.reject("FAIRY_FS_DENIED", e.message, e)
    } catch (e: FairyFsException) {
      promise.reject("FAIRY_FS_FAILED", e.message, e)
    } catch (e: Throwable) {
      promise.reject("FAIRY_FS_FAILED", "文件操作失败: ${e.message}", e)
    }
  }
}
