package com.solevup.mobile.updater

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.solevup.mobile.BuildConfig
import java.io.File

/**
 * 应用自更新 native module。
 *
 * - getCurrentVersion()：返回本地 versionName / versionCode（BuildConfig 注入）
 * - downloadApk(url)：用系统 DownloadManager 下到 getExternalFilesDir("updates")
 *   文件名跟随远端 APK 名称。不要固定成 solevup-latest.apk：部分 OEM 安装器会按
 *   content:// URI 缓存 APK 元数据，同一个 URI 覆盖新字节后仍显示旧版本。
 * - installApk(localPath)：FileProvider 包装路径，ACTION_VIEW 拉系统安装器
 *
 * 不引入第三方 HTTP / Compose / WorkManager 依赖。安装器需要用户手动确认。
 */
class UpdaterModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  // 上次 enqueue 的 download id（线程内更新，主线程读）。新一次 downloadApk 前
  // 先 dm.remove(oldId) 取消旧任务，避免：
  //   1) 用户多次点"立即更新" → 多个并行下载条 + 失败通知刷屏
  //   2) 旧任务最终落到 solevup-latest.apk 覆盖新任务结果
  @Volatile private var lastDownloadId: Long = -1L

  override fun getName(): String = "Updater"

  @ReactMethod
  fun getCurrentVersion(promise: Promise) {
    try {
      promise.resolve(Arguments.createMap().apply {
        putString("versionName", BuildConfig.SOLEVUP_VERSION_NAME)
        putInt("versionCode", BuildConfig.SOLEVUP_VERSION_CODE)
      })
    } catch (e: Throwable) {
      promise.reject("VERSION_FAILED", e.message, e)
    }
  }

  /** 暴露 OSS manifest URL 给 JS（避免 TS 硬编码端点）。 */
  @ReactMethod
  fun getUpdateManifestUrl(promise: Promise) {
    try {
      promise.resolve(BuildConfig.SOLEVUP_UPDATE_MANIFEST_URL)
    } catch (e: Throwable) {
      promise.reject("MANIFEST_URL_FAILED", e.message, e)
    }
  }

  /** 下载 APK 到应用私有 external files 目录 / updates / {remote-apk-name}。
   *  返回本地绝对路径（成功）或 reject（失败）。覆盖旧文件。 */
  @ReactMethod
  fun downloadApk(url: String, promise: Promise) {
    try {
      val updatesDir = File(ctx.getExternalFilesDir(null), "updates").apply {
        if (!exists()) mkdirs()
      }
      // 清掉旧 APK，避免占空间（OSS 只 latest 策略对齐）
      updatesDir.listFiles()?.forEach { it.delete() }
      val remoteName = Uri.parse(url).lastPathSegment
        ?.takeIf { it.endsWith(".apk", ignoreCase = true) }
        ?.replace(Regex("[^A-Za-z0-9._-]"), "_")
        ?: "solevup-update-${System.currentTimeMillis()}.apk"
      val target = File(updatesDir, remoteName)

      val dm = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

      // 取消上一次 enqueue 的任务 —— 避免用户多次点"立即更新"导致状态栏
      // 多个进度条 / 失败通知刷屏
      if (lastDownloadId >= 0) {
        try { dm.remove(lastDownloadId) } catch (_: Throwable) {}
      }

      val req = DownloadManager.Request(Uri.parse(url))
        .setTitle("Solevup 更新")
        .setDescription("下载新版本中…")
        // VISIBILITY_VISIBLE 而非 VISIBLE_NOTIFY_COMPLETED：后者在某些 OEM
        // ROM 上下载过程通知行为不一致，下载完成另开一条通知；用 VISIBLE
        // 时进度条会随下载更新，完成后通知自动消失，体验更稳
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
        .setDestinationInExternalFilesDir(ctx, "updates", remoteName)
        .setAllowedOverMetered(true)
        .setAllowedOverRoaming(true)
      val id = dm.enqueue(req)
      lastDownloadId = id

      // 轮询下载状态 —— 简单实现，不上 BroadcastReceiver（一次性操作）
      Thread {
        val q = DownloadManager.Query().setFilterById(id)
        var lastReportedAt = 0L
        while (true) {
          dm.query(q).use { c ->
            if (c == null || !c.moveToFirst()) {
              promise.reject("DL_QUERY_FAILED", "DownloadManager 找不到任务 $id")
              return@Thread
            }
            val statusIdx = c.getColumnIndex(DownloadManager.COLUMN_STATUS)
            val status = if (statusIdx >= 0) c.getInt(statusIdx) else -1
            when (status) {
              DownloadManager.STATUS_SUCCESSFUL -> {
                promise.resolve(target.absolutePath)
                return@Thread
              }
              DownloadManager.STATUS_FAILED -> {
                val reasonIdx = c.getColumnIndex(DownloadManager.COLUMN_REASON)
                val reason = if (reasonIdx >= 0) c.getInt(reasonIdx) else -1
                promise.reject("DL_FAILED", "下载失败 reason=$reason")
                return@Thread
              }
            }
          }
          val now = System.currentTimeMillis()
          if (now - lastReportedAt > 2000) lastReportedAt = now
          Thread.sleep(500)
        }
      }.apply { isDaemon = true }.start()
    } catch (e: Throwable) {
      promise.reject("DL_ENQUEUE_FAILED", e.message, e)
    }
  }

  /** 拉系统安装器打开 APK。需要用户在系统设置允许"未知来源安装"。 */
  @ReactMethod
  fun installApk(localPath: String, promise: Promise) {
    try {
      val file = File(localPath)
      if (!file.exists()) {
        promise.reject("APK_MISSING", "APK 文件不存在: $localPath")
        return
      }
      val uri = FileProvider.getUriForFile(
        ctx,
        "${ctx.packageName}.fileprovider",
        file,
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      ctx.startActivity(intent)
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("INSTALL_FAILED", e.message, e)
    }
  }
}
