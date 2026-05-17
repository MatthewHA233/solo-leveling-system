package com.sololevelingsystemmobile.perception

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * 感知层原生模块 (Android-only)。
 * 对齐 desktop 端 perception_windows.rs 的设置体系，
 * 数据写入本地 SQLite 表 perception_buckets_android / perception_events_android。
 *
 * Phase 1 块 1：骨架 + 桥接验证 (ping)
 * Phase 1 块 2：SQLite schema + 探针写入 (dbStats / dbInsertProbe)
 */
class PerceptionModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  private val db: PerceptionDb by lazy { PerceptionDb(reactContext) }

  @ReactMethod
  fun ping(promise: Promise) {
    val map = Arguments.createMap().apply {
      putBoolean("ok", true)
      putDouble("ts", System.currentTimeMillis().toDouble())
      putString("platform", "android")
      putString("module", NAME)
    }
    promise.resolve(map)
  }

  @ReactMethod
  fun dbStats(promise: Promise) {
    try {
      val (bucketCount, eventCount, path) = db.stats()
      val map = Arguments.createMap().apply {
        putDouble("bucketCount", bucketCount.toDouble())
        putDouble("eventCount", eventCount.toDouble())
        putString("path", path)
      }
      promise.resolve(map)
    } catch (e: Throwable) {
      promise.reject("DB_STATS_FAILED", e.message, e)
    }
  }

  /**
   * 写入一条 probe 事件，用于端到端验证写入路径。
   * 复用一个固定 bucket：`probe`，事件类型 `probe.heartbeat`。
   */
  @ReactMethod
  fun dbInsertProbe(promise: Promise) {
    try {
      val now = PerceptionDb.nowIso()
      val bucketId = db.ensureBucket(
        id = "probe",
        kind = "probe",
        eventType = "probe.heartbeat",
        source = "perception_module",
      )
      val rowId = db.insertEvent(
        bucketId = bucketId,
        startAt = now,
        endAt = now,
        dataJson = """{"source":"manual","ts":"$now"}""",
      )
      val map = Arguments.createMap().apply {
        putDouble("rowId", rowId.toDouble())
        putString("bucketId", bucketId)
        putString("at", now)
      }
      promise.resolve(map)
    } catch (e: Throwable) {
      promise.reject("DB_INSERT_FAILED", e.message, e)
    }
  }

  companion object {
    const val NAME = "Perception"
  }
}
