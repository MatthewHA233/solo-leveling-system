package com.solevup.mobile.syncclient

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.solevup.mobile.solevupdb.SolevupDb
import com.solevup.mobile.sync.SyncRuntime

/**
 * Mobile 主动同步 bridge，所有触发都走 SyncCoordinator：
 *   - listLinkedDevices()   → 已链接对端列表 + lastSyncedAt
 *   - linkPeer(baseUrl, code) → 用配对码换令牌 → addLinkedDevice → 立即 bidirectional 一次
 *   - verifyLinkedPeer(deviceId) → 确认对面持有同一个令牌（发私人内容前用）
 *   - unlinkPeer(deviceId)  → 解除
 *   - syncNow(deviceId)     → 手动触发一次
 *   - syncAll()             → 遍历所有 linked 跑一遍
 */
class SyncClientModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  private val db: SolevupDb by lazy { SolevupDb.shared(reactContext.applicationContext) }

  @ReactMethod
  fun listLinkedDevices(promise: Promise) {
    try {
      val arr = Arguments.createArray()
      val coordinator = SyncRuntime.coordinator
      for (link in db.listLinkedDevices()) {
        arr.pushMap(Arguments.createMap().apply {
          putString("deviceId", link.deviceId)
          putString("alias", link.alias)
          putString("lastBase", link.lastBase)
          link.lastSyncedAt?.let { putString("lastSyncedAt", it) }
          putString("createdAt", link.createdAt)
          putString("authToken", link.authToken)
          putBoolean("syncing", coordinator.isSyncing(link.deviceId))
          coordinator.lastError(link.deviceId)?.let { putString("lastError", it) }
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) {
      promise.reject("LIST_LINKS_FAILED", e.message, e)
    }
  }

  /**
   * 输入对端 baseUrl (形如 192.168.0.104 或 http://x:39733) 和它屏幕上的配对码，
   * 换令牌 → 写 linked_devices → 立即 bidirectional 一次。
   * 返回 { deviceId, alias, pulled{...}, pushed{...} }
   */
  @ReactMethod
  fun linkPeer(baseUrl: String, code: String, promise: Promise) {
    Thread {
      try {
        val r = SyncRuntime.coordinator.linkPeer(baseUrl, code)
        promise.resolve(Arguments.createMap().apply {
          putString("deviceId", r.deviceId)
          putString("alias", r.alias)
          r.result?.let { round ->
            putMap("pulled", importResultToMap(round.pulled))
            putMap("pushed", importResultToMap(round.pushed))
          }
          r.syncError?.let { putString("syncError", it) }
        })
      } catch (e: Throwable) {
        promise.reject("LINK_PEER_FAILED", e.message, e)
      }
    }.start()
  }

  /** 通过时返回对端的 deviceType；连不上、认不出或令牌对不上都 resolve null */
  @ReactMethod
  fun verifyLinkedPeer(deviceId: String, promise: Promise) {
    Thread {
      try {
        val link = db.listLinkedDevices().find { it.deviceId == deviceId }
        if (link == null) {
          promise.resolve(null)
        } else {
          val hello = SyncClient.verifyPeer(link.lastBase, db.deviceId(), deviceId, link.authToken)
          promise.resolve(hello.optString("device_type", "desktop"))
        }
      } catch (_: Throwable) {
        promise.resolve(null)
      }
    }.start()
  }

  @ReactMethod
  fun unlinkPeer(deviceId: String, promise: Promise) {
    try {
      SyncRuntime.coordinator.unlinkPeer(deviceId)
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("UNLINK_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun syncNow(deviceId: String, promise: Promise) {
    Thread {
      try {
        val link = db.listLinkedDevices().find { it.deviceId == deviceId }
          ?: throw SyncClient.SyncException("no such linked device: $deviceId")
        val r = SyncRuntime.coordinator.runRound(deviceId, link.lastBase, "manual")
        promise.resolve(Arguments.createMap().apply {
          putString("deviceId", r.peerDeviceId)
          putString("alias", link.alias)
          putMap("pulled", importResultToMap(r.pulled))
          putMap("pushed", importResultToMap(r.pushed))
        })
      } catch (e: Throwable) {
        promise.reject("SYNC_NOW_FAILED", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun syncAll(promise: Promise) {
    Thread {
      try {
        val results = Arguments.createArray()
        for (item in SyncRuntime.coordinator.syncAllBlocking("manual")) {
          results.pushMap(Arguments.createMap().apply {
            putString("deviceId", item.deviceId)
            putString("alias", item.alias)
            putBoolean("ok", item.result != null)
            item.result?.let {
              putMap("pulled", importResultToMap(it.pulled))
              putMap("pushed", importResultToMap(it.pushed))
            }
            item.error?.let { putString("error", it) }
          })
        }
        promise.resolve(results)
      } catch (e: Throwable) {
        promise.reject("SYNC_ALL_FAILED", e.message, e)
      }
    }.start()
  }

  private fun importResultToMap(r: SolevupDb.ImportResult) = Arguments.createMap().apply {
    putInt("activityCategories", r.activityCategories)
    putInt("activityTags", r.activityTags)
    putInt("activityBlocks", r.activityBlocks)
    putInt("planNodes", r.planNodes)
    putInt("plannedBlocks", r.plannedBlocks)
    putInt("modelApiKeys", r.modelApiKeys)
    putInt("modelCallLog", r.modelCallLog)
    putInt("modelFreeQuota", r.modelFreeQuota)
    putInt("featureBindings", r.featureBindings)
    putInt("chatSessions", r.chatSessions)
    putInt("chatMessages", r.chatMessages)
    putInt("modelRegistry", r.modelRegistry)
    putInt("skipped", r.skipped)
  }

  companion object {
    const val NAME = "SyncClient"
  }
}
