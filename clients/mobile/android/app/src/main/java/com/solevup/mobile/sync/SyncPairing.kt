package com.solevup.mobile.sync

import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * 局域网同步的配对，规则和 desktop sync_auth.rs 相同，改了要同时改：
 *   · 被链接的一方生成 6 位配对码，发起方输入一次，换到长期令牌，两边各存一份，之后不用再输
 *   · 除 hello 和配对外的同步接口都要带令牌
 *   · 发令牌和数据之前，先用挑战应答确认对面持有同一个令牌。发现广播谁都能发，
 *     不校验的话，有人冒充已链接设备的 device_id 就能骗走令牌和全量数据
 *
 * 流量本身还是明文 HTTP：能抓包的人看得到内容，这里防的是局域网里其他设备直接来读写。
 * 这个类不依赖 Android API，方便在普通 JVM 上验证。
 */
class SyncPairing(private val now: () -> Long = System::currentTimeMillis) {
  data class PairCode(val code: String, val ttlSeconds: Long)

  private class ActiveCode(val code: String, val expiresAt: Long, var failures: Int = 0)

  private var active: ActiveCode? = null

  @Synchronized
  fun generate(): PairCode {
    val code = RANDOM.nextInt(1_000_000).toString().padStart(6, '0')
    active = ActiveCode(code, now() + PAIR_CODE_TTL_SECONDS * 1000)
    return PairCode(code, PAIR_CODE_TTL_SECONDS)
  }

  /** 通过返回 null，否则返回给对方看的原因。配对成功、过期或输错太多次就作废 */
  @Synchronized
  fun verify(input: String): String? {
    val current = active ?: return "对方还没有生成配对码"
    if (now() >= current.expiresAt) {
      active = null
      return "配对码已过期，请在对方设备上重新生成"
    }
    if (constantTimeEquals(current.code, input.trim())) {
      active = null
      return null
    }
    current.failures += 1
    if (current.failures >= MAX_PAIR_FAILURES) {
      active = null
      return "配对码输错次数太多已作废，请在对方设备上重新生成"
    }
    return "配对码不对"
  }

  companion object {
    const val PAIR_CODE_TTL_SECONDS = 300L
    private const val MAX_PAIR_FAILURES = 5
    private const val TOKEN_BYTES = 32
    private const val CHALLENGE_BYTES = 16
    private const val PROOF_PREFIX = "solevup-sync-proof:v1"
    private val RANDOM = SecureRandom()

    fun newToken(): String = randomHex(TOKEN_BYTES)

    fun newChallenge(): String = randomHex(CHALLENGE_BYTES)

    private fun randomHex(bytes: Int): String =
      ByteArray(bytes).also { RANDOM.nextBytes(it) }.joinToString("") { "%02x".format(it) }

    /** 持有令牌才算得出来；绑上应答方的 device_id，别人的应答不能拿来冒充这台 */
    fun peerProof(token: String, challenge: String, deviceId: String): String {
      val mac = Mac.getInstance("HmacSHA256")
      mac.init(SecretKeySpec(token.toByteArray(Charsets.UTF_8), "HmacSHA256"))
      return mac.doFinal("$PROOF_PREFIX:$challenge:$deviceId".toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
    }

    fun verifyProof(token: String, challenge: String, deviceId: String, proof: String): Boolean =
      constantTimeEquals(peerProof(token, challenge, deviceId), proof)

    fun bearerToken(header: String?): String? =
      header?.takeIf { it.startsWith("Bearer ") }?.removePrefix("Bearer ")?.trim()?.takeIf { it.isNotEmpty() }

    private fun constantTimeEquals(a: String, b: String): Boolean {
      if (a.length != b.length) return false
      var diff = 0
      for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
      return diff == 0
    }
  }
}
