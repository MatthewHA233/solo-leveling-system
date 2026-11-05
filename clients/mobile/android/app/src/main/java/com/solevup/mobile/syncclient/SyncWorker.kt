package com.solevup.mobile.syncclient

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.solevup.mobile.sync.SyncRuntime
import java.util.concurrent.TimeUnit

/**
 * 定时后台同步：Android WorkManager 最低 15 分钟周期，app 被杀也能跑。
 * 进程是被 WorkManager 拉起来的话，SyncRuntime 已由 MainApplication 启动；
 * 同步统一走 SyncCoordinator，和其他触发源互斥。
 *
 * 失败不抛错（returnRetry 会触发指数退避，过度激进），大概率对端不在线，等下一个 15min tick。
 */
class SyncWorker(
  context: Context,
  params: WorkerParameters,
) : Worker(context, params) {

  override fun doWork(): Result {
    val items = try {
      SyncRuntime.coordinator.syncAllBlocking("worker")
    } catch (e: Throwable) {
      Log.w(TAG, "periodic sync failed", e)
      return Result.success()  // 表都查不到，重试也没用
    }
    for (item in items) {
      if (item.result != null) Log.i(TAG, "✓ ${item.alias}: ${item.result.pulled}")
      else Log.w(TAG, "✗ ${item.alias} sync failed: ${item.error}")
    }
    return Result.success()
  }

  companion object {
    private const val TAG = "SyncWorker"
    const val UNIQUE_NAME = "solevup-sync-periodic"

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
