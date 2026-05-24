package com.sololevelingsystemmobile.syncclient

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.sololevelingsystemmobile.solodb.SoloDb
import java.util.concurrent.TimeUnit

/**
 * 定时后台同步：遍历 linked_devices 表，对每个对端跑 bidirectionalSync。
 * Android WorkManager 最低 15 分钟周期，app 被杀也能跑。
 *
 * 失败不抛错（returnRetry 会触发指数退避，过度激进）；记录 logcat + 在
 * touchLinkSynced 留时间戳让 UI 显示"上次同步: x 分钟前"。
 */
class SyncWorker(
  context: Context,
  params: WorkerParameters,
) : Worker(context, params) {

  override fun doWork(): Result {
    val db = SoloDb(applicationContext)
    val links = try {
      db.listLinkedDevices()
    } catch (e: Throwable) {
      Log.w(TAG, "list linked_devices failed", e)
      return Result.success()  // 表都查不到，重试也没用
    }
    if (links.isEmpty()) {
      Log.i(TAG, "no linked devices, skip")
      return Result.success()
    }
    Log.i(TAG, "syncing ${links.size} linked device(s)")
    for (link in links) {
      try {
        val r = SyncClient.bidirectionalSync(db, link.lastBase)
        db.touchLinkSynced(link.deviceId, link.lastBase)
        Log.i(TAG, "✓ ${link.alias}: pulled cats=${r.pulled.activityCategories}/" +
          "tags=${r.pulled.activityTags}/blocks=${r.pulled.activityBlocks} " +
          "pushed cats=${r.pushed.activityCategories}/" +
          "tags=${r.pushed.activityTags}/blocks=${r.pushed.activityBlocks}")
      } catch (e: Throwable) {
        Log.w(TAG, "✗ ${link.alias} (${link.lastBase}) sync failed: ${e.message}")
        // 不抛 retry —— 大概率对端不在线，等下一个 15min tick
      }
    }
    return Result.success()
  }

  companion object {
    private const val TAG = "SyncWorker"
    const val UNIQUE_NAME = "sls-sync-periodic"

    /**
     * 注册定时同步（幂等）。建议 app 启动时调一次。
     * KEEP 策略：已注册则不动；UPDATE 会重置 15min 计时器。
     */
    fun enqueuePeriodic(context: Context, intervalMinutes: Long = 15) {
      val request = PeriodicWorkRequestBuilder<SyncWorker>(intervalMinutes, TimeUnit.MINUTES)
        .setConstraints(
          Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build(),
        )
        .build()
      WorkManager.getInstance(context).enqueueUniquePeriodicWork(
        UNIQUE_NAME, ExistingPeriodicWorkPolicy.KEEP, request,
      )
      Log.i(TAG, "periodic sync registered, interval=${intervalMinutes}min")
    }

    fun cancel(context: Context) {
      WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_NAME)
    }
  }
}
