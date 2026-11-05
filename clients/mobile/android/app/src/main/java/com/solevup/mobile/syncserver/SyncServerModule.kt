package com.solevup.mobile.syncserver

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.solevup.mobile.solevupdb.SolevupDb
import com.solevup.mobile.sync.SyncDiscovery
import com.solevup.mobile.sync.SyncLog
import com.solevup.mobile.sync.SyncRuntime

/**
 * 同步服务现在由 SyncRuntime 随进程启动（端口 39733，与 desktop 统一）。
 * 这个模块只给配对页看状态、日志、重试、改别名和附近设备，并把同步事件转给 JS。
 */
class SyncServerModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), SyncRuntime.EventSink, LifecycleEventListener {

  override fun getName(): String = NAME

  override fun initialize() {
    super.initialize()
    SyncRuntime.setEventSink(this)
    reactContext.addLifecycleEventListener(this)
  }

  override fun invalidate() {
    SyncRuntime.clearEventSink(this)
    reactContext.removeLifecycleEventListener(this)
    super.invalidate()
  }

  override fun onHostResume() = SyncRuntime.setEventSink(this)
  override fun onHostPause() = Unit
  override fun onHostDestroy() = Unit

  @ReactMethod
  fun status(promise: Promise) {
    try {
      promise.resolve(statusMap(SyncRuntime.status()))
    } catch (e: Throwable) {
      promise.reject("SYNC_SERVER_STATUS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun retry(promise: Promise) {
    Thread {
      try {
        promise.resolve(statusMap(SyncRuntime.retry()))
      } catch (e: Throwable) {
        promise.reject("SYNC_SERVER_RETRY_FAILED", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun listNearbyPeers(promise: Promise) {
    try {
      promise.resolve(peersArray(SyncRuntime.nearbyPeers()))
    } catch (e: Throwable) {
      promise.reject("SYNC_LIST_PEERS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun refreshPeers(promise: Promise) {
    Thread {
      try {
        promise.resolve(peersArray(SyncRuntime.refreshPeers()))
      } catch (e: Throwable) {
        promise.reject("SYNC_REFRESH_PEERS_FAILED", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun setAlias(alias: String, promise: Promise) {
    try {
      promise.resolve(statusMap(SyncRuntime.setAlias(alias)))
    } catch (e: Throwable) {
      promise.reject("SYNC_SET_ALIAS_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun syncLog(promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (entry in SyncLog.list()) {
        arr.pushMap(Arguments.createMap().apply {
          putDouble("at", entry.at.toDouble())
          putString("text", entry.text)
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) {
      promise.reject("SYNC_LOG_FAILED", e.message, e)
    }
  }

  private fun peersArray(peers: List<SyncDiscovery.NearbyPeer>) = Arguments.createArray().apply {
    for (peer in peers) {
      pushMap(Arguments.createMap().apply {
        putString("deviceId", peer.deviceId)
        putString("alias", peer.alias)
        putString("deviceType", peer.deviceType)
        putString("deviceModel", peer.deviceModel)
        putString("base", peer.base)
        putString("pairCode", peer.pairCode)
      })
    }
  }

  @ReactMethod
  fun createPairCode(promise: Promise) {
    try {
      val code = SyncRuntime.createPairCode()
      promise.resolve(Arguments.createMap().apply {
        putString("code", code.code)
        putDouble("ttlSeconds", code.ttlSeconds.toDouble())
      })
    } catch (e: Throwable) {
      promise.reject("SYNC_PAIR_CODE_FAILED", e.message, e)
    }
  }

  // RN 的 NativeEventEmitter 要求模块实现这两个方法
  @ReactMethod
  fun addListener(eventName: String) = Unit

  @ReactMethod
  fun removeListeners(count: Double) = Unit

  private fun statusMap(s: SyncRuntime.Status) = Arguments.createMap().apply {
    putBoolean("running", s.running)
    putInt("port", s.port)
    putArray("ipv4s", Arguments.createArray().apply { for (ip in s.ipv4s) pushString(ip) })
    s.error?.let { putString("error", it) }
    putString("alias", s.alias)
    putString("deviceId", s.deviceId)
    putString("deviceModel", s.deviceModel)
    putString("pairCode", s.pairCode)
    putDouble("nextAutoSyncAt", s.nextAutoSyncAt.toDouble())
  }

  override fun onDbChanged(source: String, result: SolevupDb.ImportResult) {
    emit("SolevupDbChanged", Arguments.createMap().apply {
      putString("source", source)
      putMap("changed", Arguments.createMap().apply {
        putInt("activityCategories", result.activityCategories)
        putInt("activityTags", result.activityTags)
        putInt("activityBlocks", result.activityBlocks)
        putInt("planNodes", result.planNodes)
        putInt("plannedBlocks", result.plannedBlocks)
        putInt("modelApiKeys", result.modelApiKeys)
        putInt("modelCallLog", result.modelCallLog)
        putInt("modelFreeQuota", result.modelFreeQuota)
        putInt("featureBindings", result.featureBindings)
        putInt("chatSessions", result.chatSessions)
        putInt("chatMessages", result.chatMessages)
        putInt("modelRegistry", result.modelRegistry)
        putInt("settings", result.settings)
        putInt("chatImages", result.chatImages)
        putInt("skipped", result.skipped)
      })
    })
  }

  override fun onSyncStatus(deviceId: String, syncing: Boolean, ok: Boolean?, error: String?) {
    emit("SolevupSyncStatus", Arguments.createMap().apply {
      putString("deviceId", deviceId)
      putBoolean("syncing", syncing)
      if (ok != null) putBoolean("ok", ok)
      if (error != null) putString("error", error)
    })
  }

  private fun emit(event: String, payload: com.facebook.react.bridge.WritableMap) {
    if (!reactContext.hasActiveReactInstance()) return
    reactContext.runOnJSQueueThread {
      try {
        reactContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(event, payload)
      } catch (_: Throwable) {
        // JS runtime may be paused/destroyed; AppState refresh covers the next foreground.
      }
    }
  }

  companion object {
    const val NAME = "SyncServer"
  }
}
