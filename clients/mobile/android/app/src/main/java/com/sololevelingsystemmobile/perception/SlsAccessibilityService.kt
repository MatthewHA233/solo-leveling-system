package com.sololevelingsystemmobile.perception

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 * 前台窗口感知 Service。
 *
 * Phase 2-块 1：仅骨架 —— onAccessibilityEvent 只 log，不写 DB。
 * Phase 2-块 2 起接入 perception_events_android（bucket = sls-watcher-window_android）。
 *
 * 启用方式：用户去 设置 → 辅助功能 → 已下载的应用 → SLS 感知前台窗口 → 启用。
 * 我们只用 canRetrieveWindowContent + typeWindowStateChanged，不读控件树文本，最小侵入。
 */
class SlsAccessibilityService : AccessibilityService() {

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    val e = event ?: return
    if (e.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
    Log.d(TAG, "window_state_changed pkg=${e.packageName} class=${e.className}")
  }

  override fun onInterrupt() {
    // no-op
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    Log.i(TAG, "SlsAccessibilityService connected")
    instanceRunning = true
  }

  override fun onDestroy() {
    instanceRunning = false
    super.onDestroy()
  }

  companion object {
    private const val TAG = "SlsAccessibility"

    /** Service 自报"我活着"，跟 enabled-list 配合做更严格的存活判断。 */
    @Volatile
    private var instanceRunning: Boolean = false

    /** 判断当前 Service 是否已在系统辅助功能列表里启用。 */
    fun isEnabled(context: Context): Boolean {
      val self = ComponentName(context, SlsAccessibilityService::class.java)
      val enabled = Settings.Secure.getString(
        context.contentResolver,
        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
      ) ?: return false
      if (TextUtils.isEmpty(enabled)) return false
      val splitter = TextUtils.SimpleStringSplitter(':')
      splitter.setString(enabled)
      while (splitter.hasNext()) {
        val piece = splitter.next()
        val cn = ComponentName.unflattenFromString(piece) ?: continue
        if (cn == self) return true
      }
      return false
    }

    /** 跳转系统"辅助功能"设置主页面（用户需手动找到本应用并启用）。 */
    fun openSettings(context: Context): Boolean {
      val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      return try {
        context.startActivity(intent)
        true
      } catch (_: Throwable) {
        false
      }
    }
  }
}
