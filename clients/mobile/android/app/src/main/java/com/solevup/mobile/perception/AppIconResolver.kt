package com.solevup.mobile.perception

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.Collections
import java.util.LinkedHashMap

/**
 * 把 app 的 launcher 图标渲染成 base64 PNG，方便 RN <Image source={{uri: 'data:image/png;base64,…'}} /> 直接用。
 *
 * - 同一 pkg 最多解一次 Drawable，结果常驻进程内（LRU，cap = 64）
 * - 输出统一缩到 96×96，已经足够列表清晰；超过这个再大对 RN <Image> 也意义不大
 * - 解不出图标（系统服务 / 装错的包）返回空串，前端 fallback 到首字母圆点
 */
object AppIconResolver {

  private const val SIZE_PX = 96
  private const val CACHE_CAP = 64

  // synchronizedMap + LinkedHashMap 自做 LRU
  private val cache: MutableMap<String, String> = Collections.synchronizedMap(
    object : LinkedHashMap<String, String>(16, 0.75f, true) {
      override fun removeEldestEntry(eldest: Map.Entry<String, String>?): Boolean {
        return size > CACHE_CAP
      }
    },
  )

  /** 返回 "iVBORw..." 之类的 base64 PNG 串；失败返回空串。 */
  fun base64Of(context: Context, pkg: String): String {
    if (pkg.isEmpty()) return ""
    cache[pkg]?.let { return it }
    val b64 = try {
      val drawable = context.packageManager.getApplicationIcon(pkg)
      val bmp = drawableToBitmap(drawable)
      val baos = ByteArrayOutputStream()
      bmp.compress(Bitmap.CompressFormat.PNG, 100, baos)
      bmp.recycle()
      Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
    } catch (_: PackageManager.NameNotFoundException) {
      ""
    } catch (_: Throwable) {
      ""
    }
    cache[pkg] = b64
    return b64
  }

  private fun drawableToBitmap(d: Drawable): Bitmap {
    if (d is BitmapDrawable && d.bitmap != null) {
      // 缩到目标尺寸，避免 launcher 高分辨率原图（512px+）爆 base64
      return Bitmap.createScaledBitmap(d.bitmap, SIZE_PX, SIZE_PX, true)
    }
    val bmp = Bitmap.createBitmap(SIZE_PX, SIZE_PX, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bmp)
    d.setBounds(0, 0, SIZE_PX, SIZE_PX)
    d.draw(canvas)
    return bmp
  }
}
