package com.solevup.mobile.sync

import android.util.Log
import com.solevup.mobile.solevupdb.SolevupDb
import com.solevup.mobile.syncclient.SyncClient
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * 所有同步触发的唯一入口（启动 / 发现 / 网络恢复 / 回前台 / WorkManager / 手动），
 * 语义对应 desktop sync_engine.rs：设备去重 + 冷却，避免多个触发源并发跑全量 export。
 */
class SyncCoordinator(
  private val db: SolevupDb,
  private val listener: Listener,
) {
  interface Listener {
    fun onDbChanged(source: String, result: SolevupDb.ImportResult)
    fun onSyncStatus(deviceId: String, syncing: Boolean, ok: Boolean?, error: String?)
    /** 一轮失败：多半是对端换了地址，广播一次让对端回应新地址。 */
    fun onRoundFailed()
  }

  data class SyncAllItem(
    val deviceId: String,
    val alias: String,
    val result: SyncClient.SyncRoundResult?,
    val error: String?,
  )

  data class LinkResult(
    val deviceId: String,
    val alias: String,
    val result: SyncClient.SyncRoundResult,
  )

  // 一轮是全量 export + import，同一时刻只跑一轮
  private val roundLock = Any()
  private val queued = ConcurrentHashMap.newKeySet<String>()
  private val syncing = ConcurrentHashMap.newKeySet<String>()
  private val lastSuccessAt = ConcurrentHashMap<String, Long>()
  private val lastErrors = ConcurrentHashMap<String, String>()
  private val background = Executors.newSingleThreadExecutor { r ->
    Thread(r, "solevup-sync-background").apply { isDaemon = true }
  }

  fun isSyncing(deviceId: String): Boolean = syncing.contains(deviceId)

  fun lastError(deviceId: String): String? = lastErrors[deviceId]

  /** 阻塞跑一轮：手动同步和 WorkManager 用，失败抛异常。 */
  fun runRound(deviceId: String, base: String, source: String): SyncClient.SyncRoundResult =
    synchronized(roundLock) {
      syncing.add(deviceId)
      listener.onSyncStatus(deviceId, true, null, null)
      try {
        // 地址可能已被 DHCP 分给别的设备，同步前先确认对面还是这台
        val helloId = SyncClient.fetchHello(base).optString("device_id")
        if (helloId != deviceId) {
          throw SyncClient.SyncException("地址 $base 已不是这台设备")
        }
        val r = SyncClient.bidirectionalSync(db, base)
        db.touchLinkSynced(deviceId, SyncProtocol.normalizeBase(base))
        lastSuccessAt[deviceId] = System.currentTimeMillis()
        lastErrors.remove(deviceId)
        if (r.pulled.hasChanges) listener.onDbChanged(source, r.pulled)
        listener.onSyncStatus(deviceId, false, true, null)
        r
      } catch (t: Throwable) {
        val msg = t.message ?: "同步失败"
        lastErrors[deviceId] = msg
        listener.onSyncStatus(deviceId, false, false, msg)
        listener.onRoundFailed()
        throw t
      } finally {
        syncing.remove(deviceId)
      }
    }

  /** 后台触发：冷却期内和已排队的直接丢弃，失败只记日志。 */
  fun enqueue(link: SolevupDb.LinkedDevice, source: String, cooldownMs: Long) {
    val since = System.currentTimeMillis() - (lastSuccessAt[link.deviceId] ?: 0L)
    if (since < cooldownMs) return
    if (!queued.add(link.deviceId)) return
    background.execute {
      try {
        runRound(link.deviceId, link.lastBase, source)
        Log.i(TAG, "$source ✓ ${link.alias}")
      } catch (t: Throwable) {
        Log.w(TAG, "$source ✗ ${link.alias} (${link.lastBase}): ${t.message}")
      } finally {
        queued.remove(link.deviceId)
      }
    }
  }

  fun enqueueAll(source: String, cooldownMs: Long) {
    background.execute {
      for (link in db.listLinkedDevices()) enqueue(link, source, cooldownMs)
    }
  }

  fun syncAllBlocking(source: String): List<SyncAllItem> =
    db.listLinkedDevices().map { link ->
      try {
        SyncAllItem(link.deviceId, link.alias, runRound(link.deviceId, link.lastBase, source), null)
      } catch (t: Throwable) {
        SyncAllItem(link.deviceId, link.alias, null, t.message ?: "同步失败")
      }
    }

  /** 输入对端地址 → hello 确认身份 → 写链接 → 立刻同步一轮。 */
  fun linkPeer(rawBase: String): LinkResult {
    val base = SyncProtocol.normalizeBase(rawBase)
    val hello = SyncClient.fetchHello(base)
    val peerId = hello.optString("device_id")
    if (peerId.isEmpty()) throw SyncClient.SyncException("对端没有返回设备 ID")
    if (peerId == db.deviceId()) throw SyncClient.SyncException("不能链接本机")
    val peerAlias = hello.optString("alias", peerId)
    db.addLinkedDevice(peerId, peerAlias, base)
    return LinkResult(peerId, peerAlias, runRound(peerId, base, "link"))
  }

  /** 听到已链接设备的广播：刷新地址（电脑可能换了 IP），过了冷却就同步。 */
  fun onPeerSeen(peer: SyncDiscovery.NearbyPeer) {
    val link = db.listLinkedDevices().find { it.deviceId == peer.deviceId } ?: return
    val fresh = if (link.lastBase != peer.base) {
      db.updateLinkBase(link.deviceId, peer.base)
      link.copy(lastBase = peer.base)
    } else link
    enqueue(fresh, "discover", DISCOVER_COOLDOWN_MS)
  }

  /** desktop 主动把数据推过来：记一次成功，避免紧接着又反向跑一轮。 */
  fun onInboundImport(deviceId: String, remoteIp: String?, result: SolevupDb.ImportResult) {
    if (result.hasChanges) listener.onDbChanged("sync-server", result)
    val link = db.listLinkedDevices().find { it.deviceId == deviceId } ?: return
    lastSuccessAt[deviceId] = System.currentTimeMillis()
    lastErrors.remove(deviceId)
    val base = remoteIp?.let { "http://$it:${SyncProtocol.DEFAULT_PORT}" } ?: link.lastBase
    db.touchLinkSynced(deviceId, base)
    listener.onSyncStatus(deviceId, false, true, null)
  }

  companion object {
    private const val TAG = "SyncCoordinator"
    // desktop 每 30s 广播一次，而且它自己也会反向同步，手机不必每次都跑
    const val DISCOVER_COOLDOWN_MS = 60_000L
    const val FOREGROUND_COOLDOWN_MS = 15_000L
  }
}
