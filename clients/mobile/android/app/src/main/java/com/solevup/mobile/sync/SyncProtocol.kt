package com.solevup.mobile.sync

import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URL

/**
 * LAN 同步协议常量与工具，全部对齐 desktop
 * （lib.rs 的 API 端口、sync_discovery.rs 的发现报文、db.rs 的 sync_pair_code）。
 */
object SyncProtocol {
  // HTTP API 和 UDP 发现共用同一端口：desktop 把广播发到 group:port、把回应单播到 addr:port，
  // 两端端口不一致就互相发现不了。
  const val DEFAULT_PORT = 39733
  const val MULTICAST_GROUP = "224.0.0.167"
  const val DISCOVERY_VERSION = "1.0"

  // 蜂窝 / VPN 网卡上没有可配对的电脑，不展示也不发广播
  private val NON_LAN_PREFIXES = listOf("rmnet", "ccmni", "pdp", "dummy", "tun", "ppp")

  /** 补 scheme 和默认端口，存库与发请求都用这个形态。 */
  fun normalizeBase(raw: String): String {
    val trimmed = raw.trim().trimEnd('/')
    val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      trimmed
    } else "http://$trimmed"
    val url = URL(withScheme)
    val port = if (url.port == -1) DEFAULT_PORT else url.port
    return "${url.protocol}://${url.host}:$port"
  }

  /** 跟 desktop db.rs sync_pair_code 一致的 FNV-1a 64bit，格式 XXXX-XXXX。 */
  fun pairCode(deviceId: String): String {
    val input = "solevup:sync:v1:$deviceId"
    var hash = 0xcbf29ce484222325UL
    for (byte in input.toByteArray(Charsets.UTF_8)) {
      hash = hash xor (byte.toUByte().toULong())
      hash = (hash * 0x100000001b3UL)
    }
    val hex = hash.toString(16).padStart(16, '0')
    return "${hex.substring(0, 4)}-${hex.substring(4, 8)}".uppercase()
  }

  /** 可用于局域网通信的网卡（up、非回环、非虚拟、有 IPv4）。 */
  fun lanInterfaces(): List<NetworkInterface> {
    val out = ArrayList<NetworkInterface>()
    try {
      val ifs = NetworkInterface.getNetworkInterfaces() ?: return out
      for (nif in ifs) {
        if (!nif.isUp || nif.isLoopback || nif.isVirtual) continue
        if (NON_LAN_PREFIXES.any { nif.name.startsWith(it) }) continue
        if (nif.inetAddresses.toList().none { it is Inet4Address && !it.isLoopbackAddress }) continue
        out.add(nif)
      }
    } catch (_: Throwable) {
      // 枚举失败等同无网卡，下次网络变化再试
    }
    return out
  }

  fun lanIpv4Addresses(): List<String> =
    lanInterfaces().flatMap { nif ->
      nif.inetAddresses.toList()
        .filter { it is Inet4Address && !it.isLoopbackAddress }
        .mapNotNull { it.hostAddress }
    }
}
