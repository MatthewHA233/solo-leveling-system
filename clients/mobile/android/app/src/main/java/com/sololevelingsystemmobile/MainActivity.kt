package com.sololevelingsystemmobile

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.sololevelingsystemmobile.perception.PerceptionDb

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "SoloLevelingSystemMobile"

  override fun onResume() {
    super.onResume()
    try {
      PerceptionDb(applicationContext).insertSelfWindowEvent(
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
