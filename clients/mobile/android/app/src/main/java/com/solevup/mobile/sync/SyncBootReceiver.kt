package com.solevup.mobile.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 开机、应用更新后拉起常驻同步，不用等主人打开应用。这两个广播允许后台启动前台服务 */
class SyncBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> SyncService.start(context)
    }
  }
}
