package com.solevup.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.solevup.mobile.perception.PerceptionDb
import com.solevup.mobile.perception.SolevupAccessibilityService
import com.solevup.mobile.sync.SyncService

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "Solevup"

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    SyncService.start(this)
    askNotificationPermissionOnce()
  }

  // 常驻同步的通知要这个权限（Android 13+）。只问一次：拒绝了同步照常跑，只是通知栏看不到
  private fun askNotificationPermissionOnce() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
    if (prefs.getBoolean(KEY_ASKED_NOTIFICATIONS, false)) return
    prefs.edit().putBoolean(KEY_ASKED_NOTIFICATIONS, true).apply()
    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
  }

  override fun onResume() {
    super.onResume()
    try {
      val db = PerceptionDb(applicationContext)
      // 没开辅助服务时，只有 Solevup 自身会写前台事件，没有其他 app 切换来截断它。
      // app_monitor_segments 会把新段默认延展到当天结束，结果 UI 看起来像一整天都在用 Solevup。
      // 因此自应用监控只在辅助服务开启、真正能观测外部窗口切换时写入。
      if (!SolevupAccessibilityService.isEnabled(applicationContext)) {
        db.purgeSelfWindowEvents()
        return
      }
      db.insertSelfWindowEvent(
        packageName = packageName,
        className = javaClass.name,
        appLabel = getString(R.string.app_name),
        windowTitle = "应用前台",
      )
    } catch (_: Throwable) {
      // 自身使用记录不能影响主界面启动。
    }
  }

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  companion object {
    private const val PREFS_NAME = "solevup_sync_service"
    private const val KEY_ASKED_NOTIFICATIONS = "asked_notifications"
    private const val REQUEST_NOTIFICATIONS = 39733
  }
}
