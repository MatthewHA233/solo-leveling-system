package com.sololevelingsystemmobile.updater

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
import com.sololevelingsystemmobile.BuildConfig
import java.io.File

/**
 * 应用自更新 native module。
 *
 * - getCurrentVersion()：返回本地 versionName / versionCode（BuildConfig 注入）
 * - downloadApk(url)：用系统 DownloadManager 下到 getExternalFilesDir("updates")
 *   覆盖式（每次更新只保留最新一个 APK，与 OSS "只 latest" 策略一致）
 * - installApk(localPath)：FileProvider 包装路径，ACTION_VIEW 拉系统安装器
 *
 * 不引入第三方 HTTP / Compose / WorkManager 依赖。安装器需要用户手动确认。
 */
class UpdaterModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  override fun getName(): String = "Updater"

  @ReactMethod
  fun getCurrentVersion(promise: Promise) {
    try {
      promise.resolve(Arguments.createMap().apply {
        putString("versionName", BuildConfig.SLS_VERSION_NAME)
        putInt("versionCode", BuildConfig.SLS_VERSION_CODE)
      })
    } catch (e: Throwable) {
      promise.reject("VERSION_FAILED", e.message, e)
    }
  }

  /** 暴露 OSS manifest URL 给 JS（避免 TS 硬编码端点）。 */
  @ReactMethod
  fun getUpdateManifestUrl(promise: Promise) {
    try {
      promise.resolve(BuildConfig.SLS_UPDATE_MANIFEST_URL)
    } catch (e: Throwable) {
      promise.reject("MANIFEST_URL_FAILED", e.message, e)
    }
  }

  /** 下载 APK 到应用私有 external files 目录 / updates / sls-latest.apk。
   *  返回本地绝对路径（成功）或 reject（失败）。覆盖旧文件。 */
  @ReactMethod
  fun downloadApk(url: String, promise: Promise) {
    try {
      val updatesDir = File(ctx.getExternalFilesDir(null), "updates").apply {
        if (!exists()) mkdirs()
      }
      // 清掉旧 APK，避免占空间（OSS 只 latest 策略对齐）
      updatesDir.listFiles()?.forEach { it.delete() }
      val target = File(updatesDir, "sls-latest.apk")

      val dm = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      val req = DownloadManager.Request(Uri.parse(url))
        .setTitle("Solo Leveling 更新")
        .setDescription("下载新版本中…")
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationInExternalFilesDir(ctx, "updates", "sls-latest.apk")
        .setAllowedOverMetered(true)
        .setAllowedOverRoaming(true)
      val id = dm.enqueue(req)

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
