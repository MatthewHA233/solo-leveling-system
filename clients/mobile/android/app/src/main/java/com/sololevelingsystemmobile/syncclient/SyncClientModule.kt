package com.sololevelingsystemmobile.syncclient

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.sololevelingsystemmobile.solodb.SoloDb

/**
 * Mobile 主动同步 bridge：
 *   - listLinkedDevices()              → 已链接对端列表 + lastSyncedAt
 *   - linkPeer(baseUrl)                → hello → addLinkedDevice → 立即 bidirectional 一次
 *   - unlinkPeer(deviceId)             → 解除
 *   - syncNow(deviceId)                → 手动触发一次
 *   - syncAll()                        → 遍历所有 linked 跑一遍（前台手动按钮）
 *   - enqueuePeriodicSync(minutes)     → 注册 WorkManager 定时同步
 *   - cancelPeriodicSync()             → 取消
 */
class SyncClientModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  private val db: SoloDb by lazy { SoloDb(reactContext) }

  @ReactMethod
  fun listLinkedDevices(promise: Promise) {
    try {
      val arr = Arguments.createArray()
      for (link in db.listLinkedDevices()) {
        arr.pushMap(Arguments.createMap().apply {
          putString("deviceId", link.deviceId)
          putString("alias", link.alias)
          putString("lastBase", link.lastBase)
          link.lastSyncedAt?.let { putString("lastSyncedAt", it) }
          putString("createdAt", link.createdAt)
        })
      }
      promise.resolve(arr)
    } catch (e: Throwable) {
      promise.reject("LIST_LINKS_FAILED", e.message, e)
    }
  }

  /**
   * 输入对端 baseUrl (形如 192.168.0.104 或 http://x:49733)，
   * 走 hello 拿 device_id + alias → 写 linked_devices → 立即 bidirectional 一次。
   * 返回 { deviceId, alias, pulled{...}, pushed{...} }
   */
  @ReactMethod
  fun linkPeer(baseUrl: String, promise: Promise) {
    Thread {
      try {
        val hello = SyncClient.fetchHello(baseUrl)
        val peerDeviceId = hello.optString("device_id")
        val peerAlias = hello.optString("alias", peerDeviceId)
        // normalize 一次再存
        val normalized = baseUrlNormalize(baseUrl)
        db.addLinkedDevice(peerDeviceId, peerAlias, normalized)
        val r = SyncClient.bidirectionalSync(db, normalized)
        db.touchLinkSynced(peerDeviceId, normalized)
        promise.resolve(Arguments.createMap().apply {
          putString("deviceId", peerDeviceId)
          putString("alias", peerAlias)
          putMap("pulled", importResultToMap(r.pulled))
          putMap("pushed", importResultToMap(r.pushed))
        })
      } catch (e: Throwable) {
        promise.reject("LINK_PEER_FAILED", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun unlinkPeer(deviceId: String, promise: Promise) {
    try {
      db.removeLinkedDevice(deviceId)
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
        val r = SyncClient.bidirectionalSync(db, link.lastBase)
        db.touchLinkSynced(deviceId, link.lastBase)
        promise.resolve(Arguments.createMap().apply {
          putString("deviceId", r.peerDeviceId)
          putString("alias", r.peerAlias)
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
        val links = db.listLinkedDevices()
        val results = Arguments.createArray()
        for (link in links) {
          val itemMap = Arguments.createMap().apply {
            putString("deviceId", link.deviceId)
            putString("alias", link.alias)
          }
          try {
            val r = SyncClient.bidirectionalSync(db, link.lastBase)
            db.touchLinkSynced(link.deviceId, link.lastBase)
            itemMap.putBoolean("ok", true)
            itemMap.putMap("pulled", importResultToMap(r.pulled))
            itemMap.putMap("pushed", importResultToMap(r.pushed))
          } catch (e: Throwable) {
            itemMap.putBoolean("ok", false)
            itemMap.putString("error", e.message ?: "unknown")
          }
          results.pushMap(itemMap)
        }
        promise.resolve(results)
      } catch (e: Throwable) {
        promise.reject("SYNC_ALL_FAILED", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun enqueuePeriodicSync(intervalMinutes: Double, promise: Promise) {
    try {
      val mins = intervalMinutes.toLong().coerceAtLeast(15L)
      SyncWorker.enqueuePeriodic(reactContext.applicationContext, mins)
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("ENQUEUE_PERIODIC_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun cancelPeriodicSync(promise: Promise) {
    try {
      SyncWorker.cancel(reactContext.applicationContext)
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("CANCEL_PERIODIC_FAILED", e.message, e)
    }
  }

  private fun importResultToMap(r: SoloDb.ImportResult) = Arguments.createMap().apply {
    putInt("activityCategories", r.activityCategories)
    putInt("activityTags", r.activityTags)
    putInt("activityBlocks", r.activityBlocks)
    putInt("planNodes", r.planNodes)
    putInt("plannedBlocks", r.plannedBlocks)
    putInt("skipped", r.skipped)
  }

  private fun baseUrlNormalize(raw: String): String {
    val trimmed = raw.trim().trimEnd('/')
    val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      trimmed
    } else "http://$trimmed"
    val url = java.net.URL(withScheme)
    val port = if (url.port == -1) 49733 else url.port
    return "${url.protocol}://${url.host}:$port"
  }

  companion object {
    const val NAME = "SyncClient"
  }
}
