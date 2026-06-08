package com.sololevelingsystemmobile

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.sololevelingsystemmobile.perception.PerceptionDb
import com.sololevelingsystemmobile.perception.SlsAccessibilityService

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "SoloLevelingSystemMobile"

  override fun onResume() {
    super.onResume()
    try {
      val db = PerceptionDb(applicationContext)
      // 没开辅助服务时，只有 SLS 自身会写前台事件，没有其他 app 切换来截断它。
      // app_monitor_segments 会把新段默认延展到当天结束，结果 UI 看起来像一整天都在用 SLS。
      // 因此自应用监控只在辅助服务开启、真正能观测外部窗口切换时写入。
      if (!SlsAccessibilityService.isEnabled(applicationContext)) {
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
}
