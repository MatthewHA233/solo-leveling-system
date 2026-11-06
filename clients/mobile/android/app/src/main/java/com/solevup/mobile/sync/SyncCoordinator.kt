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
    val result: SyncClient.SyncRoundResult?,
    // 配对成功但第一轮同步失败时的原因
    val syncError: String?,
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
      val alias = linkAlias(deviceId)
      syncing.add(deviceId)
      SyncLog.add("→ 开始与 $alias 同步")
      listener.onSyncStatus(deviceId, true, null, null)
      try {
        val token = db.linkedDeviceToken(deviceId)
          ?: throw SyncClient.SyncException("这台设备还没有配对")
        // 先确认对面持有同一个令牌，再发令牌和数据
        val hello = SyncClient.verifyPeer(base, db.deviceId(), deviceId, token)
        // 对方可能改过名。校验通过才信
        hello.optString("alias").takeIf { it.isNotBlank() && it != alias }?.let { db.updateLinkAlias(deviceId, it) }
        val r = SyncClient.bidirectionalSync(db, base, token)
        db.touchLinkSynced(deviceId, SyncProtocol.normalizeBase(base))
        lastSuccessAt[deviceId] = System.currentTimeMillis()
        lastErrors.remove(deviceId)
        if (r.pulled.hasChanges) listener.onDbChanged(source, r.pulled)
        SyncLog.add("✓ ${linkAlias(deviceId)} 同步完成 · 拉 [${SyncLog.describe(r.pulled)}] / 推 [${SyncLog.describe(r.pushed)}]")
        listener.onSyncStatus(deviceId, false, true, null)
        r
      } catch (t: Throwable) {
        val msg = t.message ?: "同步失败"
        lastErrors[deviceId] = msg
        SyncLog.add("✗ $alias 同步失败: $msg")
        listener.onSyncStatus(deviceId, false, false, msg)
        listener.onRoundFailed()
        throw t
      } finally {
        syncing.remove(deviceId)
      }
    }

  private fun linkAlias(deviceId: String): String =
    db.listLinkedDevices().find { it.deviceId == deviceId }?.alias ?: deviceId

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

  /** 输入对端地址和它屏幕上的配对码 → 换令牌 → 写链接 → 立刻同步一轮。 */
  fun linkPeer(rawBase: String, code: String): LinkResult {
    val base = SyncProtocol.normalizeBase(rawBase)
    val selfId = db.deviceId()
    val hello = SyncClient.fetchHello(base)
    val peerId = hello.optString("device_id")
    if (peerId.isEmpty()) throw SyncClient.SyncException("对端没有返回设备 ID")
    if (peerId == selfId) throw SyncClient.SyncException("不能链接本机")
    // 旧版对端没有配对接口，直接调只会收到一个看不出原因的 404
    if (hello.optInt("protocol_version") < 2) throw SyncClient.SyncException("对端版本太旧，请两边都升级后再配对")
    val paired = try {
      SyncClient.pair(base, code, selfId, db.syncAlias())
    } catch (e: org.json.JSONException) {
      throw SyncClient.SyncException("对端版本太旧或回复异常，请两边都升级后再配对", e)
    }
    if (paired.deviceId != peerId) throw SyncClient.SyncException("这个地址上已经不是刚才那台设备")
    db.addLinkedDevice(peerId, paired.alias, base, paired.token)
    // 到这里配对已经成功，令牌两边都存好了。第一轮同步失败不算配对失败，之后还会自动同步
    return try {
      LinkResult(peerId, paired.alias, runRound(peerId, base, "link"), null)
    } catch (t: Throwable) {
      LinkResult(peerId, paired.alias, null, t.message ?: "同步失败")
    }
  }

  /** 删本地链接，再告诉对方。对方不在线也算解除成功 */
  fun unlinkPeer(deviceId: String) {
    val link = db.listLinkedDevices().find { it.deviceId == deviceId }
    db.removeLinkedDevice(deviceId)
    lastErrors.remove(deviceId)
    if (link != null) background.execute { SyncClient.notifyUnpair(link.lastBase, link.authToken) }
  }

  /** 听到已链接设备的广播：电脑可能换了 IP，用新地址试一轮。广播谁都能发，校验通过、同步成功才写库 */
  @JvmOverloads
  fun onPeerSeen(peer: SyncDiscovery.NearbyPeer, cooldownMs: Long = DISCOVER_COOLDOWN_MS) {
    val link = db.listLinkedDevices().find { it.deviceId == peer.deviceId } ?: return
    enqueue(link.copy(lastBase = peer.base), "discover", cooldownMs)
  }

  /** 别的设备用本机的配对码配对成功，或解除了链接：刷新配对页 */
  fun onLinksChanged(deviceId: String) {
    lastErrors.remove(deviceId)
    listener.onSyncStatus(deviceId, false, null, null)
  }

  /** desktop 主动把数据推过来：记一次成功，避免紧接着又反向跑一轮。 */
  fun onInboundImport(deviceId: String, remoteIp: String?, result: SolevupDb.ImportResult) {
    if (result.hasChanges) listener.onDbChanged("sync-server", result)
    val link = db.listLinkedDevices().find { it.deviceId == deviceId } ?: return
    if (result.hasChanges) SyncLog.add("← ${link.alias} 推过来 ${SyncLog.describe(result)}")
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
    // 后台时两端都放慢到这个间隔：一轮要双向传整份数据，常驻后每 30 秒一轮太费电
    const val BACKGROUND_SYNC_MS = 5 * 60_000L
  }
}
