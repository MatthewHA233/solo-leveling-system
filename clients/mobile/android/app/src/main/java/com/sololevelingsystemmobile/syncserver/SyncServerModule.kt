package com.sololevelingsystemmobile.syncserver

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.sololevelingsystemmobile.solodb.SoloDb
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * 桥接 SyncHttpServer 的启停 + 显示当前监听地址。
 *
 * 端口对齐 desktop sync_engine.rs 的 49733（避免冲突也能用 49734，
 * 但 desktop discover 走 multicast 看 49733；mobile 端先用 49733 直连即可）。
 */
class SyncServerModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  private val db: SoloDb by lazy { SoloDb(reactContext) }

  @Volatile
  private var server: SyncHttpServer? = null

  @Volatile
  private var currentPort: Int = 0

  @ReactMethod
  fun start(port: Double, promise: Promise) {
    try {
      val p = port.toInt().takeIf { it > 0 } ?: DEFAULT_PORT
      // 已经在跑同端口，幂等
      if (server != null && currentPort == p) {
        promise.resolve(addrMap(p))
        return
      }
      // 跑着别的端口先停
      server?.stop()
      val s = SyncHttpServer(p, db)
      s.start(SOCKET_TIMEOUT_MS, false)  // daemon=false 让线程跟 app 进程
      server = s
      currentPort = p
      promise.resolve(addrMap(p))
    } catch (e: Throwable) {
      promise.reject("SYNC_SERVER_START_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      server?.stop()
      server = null
      currentPort = 0
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("SYNC_SERVER_STOP_FAILED", e.message, e)
    }
  }

  @ReactMethod
  fun status(promise: Promise) {
    try {
      val running = server != null
      promise.resolve(Arguments.createMap().apply {
        putBoolean("running", running)
        putInt("port", currentPort)
        putArray("ipv4s", Arguments.createArray().apply {
          for (ip in lanIpv4Addresses()) pushString(ip)
        })
      })
    } catch (e: Throwable) {
      promise.reject("SYNC_SERVER_STATUS_FAILED", e.message, e)
    }
  }

  private fun addrMap(port: Int) = Arguments.createMap().apply {
    putBoolean("running", true)
    putInt("port", port)
    putArray("ipv4s", Arguments.createArray().apply {
      for (ip in lanIpv4Addresses()) pushString(ip)
    })
  }

  /** 拉所有 active 网卡的 ipv4，过滤 loopback。让 UI 选/展示给用户。 */
  private fun lanIpv4Addresses(): List<String> {
    val out = ArrayList<String>()
    try {
      val ifs = NetworkInterface.getNetworkInterfaces() ?: return out
      for (nif in ifs) {
        if (!nif.isUp || nif.isLoopback || nif.isVirtual) continue
        for (addr in nif.inetAddresses) {
          if (addr is Inet4Address && !addr.isLoopbackAddress) {
            out.add(addr.hostAddress ?: continue)
          }
        }
      }
    } catch (_: Throwable) {
      // ignore，返回空
    }
    return out
  }

  companion object {
    const val NAME = "SyncServer"
    private const val DEFAULT_PORT = 49733
    private const val SOCKET_TIMEOUT_MS = 30_000
  }
}
