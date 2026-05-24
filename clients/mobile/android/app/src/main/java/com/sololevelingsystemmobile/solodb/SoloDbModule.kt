package com.sololevelingsystemmobile.solodb

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * SoloDb 桥接 —— Phase 0：只暴露 ping / deviceId / stats，验证 SQLite 跑通。
 * 后续阶段会扩展 listCategories / upsertActivityBlock 等领域方法。
 */
class SoloDbModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  private val db: SoloDb by lazy { SoloDb(reactContext) }

  @ReactMethod
  fun ping(promise: Promise) {
    val map = Arguments.createMap().apply {
      putBoolean("ok", true)
      putDouble("ts", System.currentTimeMillis().toDouble())
      putString("module", NAME)
    }
    promise.resolve(map)
  }

  /** 返回 sync_meta 里的 device_id（首次 open DB 时会自动生成）。 */
  @ReactMethod
  fun getDeviceId(promise: Promise) {
    try {
      promise.resolve(db.deviceId())
    } catch (e: Throwable) {
      promise.reject("SOLODB_DEVICE_ID_FAILED", e.message, e)
    }
  }

  /** 各表行数 + DB 文件路径，Phase 0 验证连通 + 后续观察同步效果。 */
  @ReactMethod
  fun getStats(promise: Promise) {
    try {
      val (counts, path) = db.stats()
      val tables = Arguments.createMap()
      for ((name, count) in counts) tables.putDouble(name, count.toDouble())
      val out = Arguments.createMap().apply {
        putMap("tables", tables)
        putString("path", path)
      }
      promise.resolve(out)
    } catch (e: Throwable) {
      promise.reject("SOLODB_STATS_FAILED", e.message, e)
    }
  }

  companion object {
    const val NAME = "SoloDb"
  }
}
