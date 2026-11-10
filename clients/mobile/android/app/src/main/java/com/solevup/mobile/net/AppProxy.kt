package com.solevup.mobile.net

import android.content.Context
import android.content.SharedPreferences
import okhttp3.ConnectionPool
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI

/**
 * 「网络代理」设置：Anthropic、Fish 语音和 models.dev（模型清单）从本机这个端口出去（127.0.0.1），和桌面端 network.rs 一个意思。
 * 端口是 0 就跟随系统 VPN 或系统代理。每台设备自己的设置，不同步。
 * 只代理这几个域名（范围和桌面端一致），局域网同步和阿里云都直连。
 */
object AppProxy {
  private const val PREFS_NAME = "solevup_network"
  private const val KEY_PORT = "proxy_port"
  private val PROXIED_HOSTS = setOf("api.anthropic.com", "api.fish.audio", "models.dev")

  private val system: ProxySelector? = ProxySelector.getDefault()
  private lateinit var prefs: SharedPreferences

  @Volatile private var port = 0

  // 已有的连接还走旧路线，改端口时要断开，所以用这个 selector 的 client 共用一个连接池
  val connectionPool = ConnectionPool()

  val selector: ProxySelector = object : ProxySelector() {
    override fun select(uri: URI?): List<Proxy> {
      if (uri == null) return listOf(Proxy.NO_PROXY)
      val current = port
      if (current > 0 && uri.host in PROXIED_HOSTS) {
        return listOf(Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", current)))
      }
      return system?.select(uri) ?: listOf(Proxy.NO_PROXY)
    }

    override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: IOException?) {
      if (uri != null && sa != null && ioe != null) system?.connectFailed(uri, sa, ioe)
    }
  }

  fun init(context: Context) {
    prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    port = prefs.getInt(KEY_PORT, 0)
  }

  fun port(): Int = port

  fun setPort(next: Int) {
    if (next !in 0..65535) throw IllegalArgumentException("端口要在 1 到 65535 之间")
    prefs.edit().putInt(KEY_PORT, next).apply()
    port = next
    connectionPool.evictAll()
  }
}
