package com.solevup.mobile.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log
import androidx.core.content.ContextCompat
import com.solevup.mobile.MainActivity
import com.solevup.mobile.R

/**
 * 常驻前台服务：系统不再冻结后台进程，切到别的应用、锁屏后局域网同步也收发得到。
 * 同步本身在 SyncRuntime，这里只让进程活着；通知是系统要求的，低优先级、不响。
 * 打开应用时（MainActivity）、开机和应用更新后（SyncBootReceiver）拉起。
 */
class SyncService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    SyncRuntime.start(application)
    try {
      startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } catch (t: Throwable) {
      // 系统在后台重启服务时可能不让转前台：这次不常驻，等下次打开应用
      Log.w(TAG, "startForeground failed: ${t.message}")
      stopSelf()
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

  private fun buildNotification(): Notification {
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "局域网同步", NotificationManager.IMPORTANCE_LOW).apply {
        description = "后台和电脑保持同步"
        setShowBadge(false)
      },
    )
    val open = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_sync)
      .setContentTitle("局域网同步")
      .setContentText("后台保持连接，电脑随时能同步")
      .setContentIntent(open)
      .setOngoing(true)
      .setShowWhen(false)
      .setCategory(Notification.CATEGORY_SERVICE)
      .build()
  }

  companion object {
    private const val TAG = "SyncService"
    private const val CHANNEL_ID = "lan_sync"
    private const val NOTIFICATION_ID = 39733

    /** 只在前台、开机或更新广播里调；后台不允许启动时记日志，等下次打开应用 */
    fun start(context: Context) {
      try {
        ContextCompat.startForegroundService(context, Intent(context, SyncService::class.java))
      } catch (t: Throwable) {
        Log.w(TAG, "start failed: ${t.message}")
      }
    }
  }
}
