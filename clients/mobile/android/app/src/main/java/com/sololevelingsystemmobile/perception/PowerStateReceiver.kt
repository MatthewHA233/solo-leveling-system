package com.sololevelingsystemmobile.perception

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 开 / 关机事件 receiver。manifest 静态注册。
 *
 * - BOOT_COMPLETED：开机解锁后触发（首次走完锁屏）。要 RECEIVE_BOOT_COMPLETED 权限。
 * - LOCKED_BOOT_COMPLETED：Android N+ 文件级加密设备，解锁前触发；某些时候 BOOT_COMPLETED
 *   可能延迟，多接一个可靠些。两个都收到的话只写一次（按时间窗口去重）。
 * - ACTION_SHUTDOWN：Android 7+ 上不保证收到、不保证写完，但有总比没好 — 落盘成功就赚到。
 *
 * SCREEN_ON / SCREEN_OFF / USER_PRESENT 在 SlsAccessibilityService 动态注册（manifest
 * 注册在 Android O+ 会被忽略）。
 */
class PowerStateReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    val ctx = context ?: return
    val action = intent?.action ?: return
    val event = when (action) {
      Intent.ACTION_BOOT_COMPLETED, "android.intent.action.LOCKED_BOOT_COMPLETED" -> "boot"
      Intent.ACTION_SHUTDOWN -> "shutdown"
      else -> return
    }
    val ts = System.currentTimeMillis()
    // 同步写一次 —— BroadcastReceiver 有 10s 限制，但 SQLite 插一条远低于这个
    // 关机时 system 立即杀进程，executor 异步可能写不完，所以同步落盘
    try {
      val db = PerceptionDb(ctx.applicationContext)
      db.insertPowerEvent(event, ts)
      Log.i(TAG, "power $event @ $ts")
    } catch (ex: Throwable) {
      Log.w(TAG, "write boot/shutdown event failed", ex)
    }
  }
  companion object { private const val TAG = "SlsPowerReceiver" }
}
