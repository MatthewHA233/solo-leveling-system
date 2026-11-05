package com.solevup.mobile.chatimage

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.solevup.mobile.solevupdb.SolevupDb
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

/**
 * 聊天图片：系统选图 → 压缩成 JPEG → 存 filesDir/chat-images/<id>.jpg。
 * 用系统选择器，不申请存储权限。规则见 src/lib/agent/chat-images.ts。
 */
class ChatImageModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx), ActivityEventListener {

  private var pending: Promise? = null
  private var pendingMax = 0

  init {
    ctx.addActivityEventListener(this)
  }

  override fun getName(): String = "ChatImage"

  private val dir: File get() = File(ctx.filesDir, DIR_NAME)

  @ReactMethod
  fun getDirUri(promise: Promise) {
    promise.resolve(Uri.fromFile(dir).toString())
  }

  @ReactMethod
  fun pick(max: Int, promise: Promise) {
    val activity = ctx.currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "应用不在前台")
      return
    }
    if (pending != null) {
      promise.reject("BUSY", "选择器已经打开")
      return
    }
    pending = promise
    pendingMax = max
    try {
      try {
        activity.startActivityForResult(photoPickerIntent(max), REQUEST_PICK)
      } catch (_: ActivityNotFoundException) {
        activity.startActivityForResult(contentPickerIntent(max), REQUEST_PICK)
      }
    } catch (t: Throwable) {
      pending = null
      promise.reject("PICK_FAILED", t.message ?: "打不开系统选择器", t)
    }
  }

  private fun photoPickerIntent(max: Int): Intent {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return contentPickerIntent(max)
    return Intent(MediaStore.ACTION_PICK_IMAGES).apply {
      // 只选一张时不能带这个参数，否则系统选择器直接报错
      if (max > 1) putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, max)
    }
  }

  private fun contentPickerIntent(max: Int): Intent =
    Intent(Intent.ACTION_GET_CONTENT).apply {
      type = "image/*"
      addCategory(Intent.CATEGORY_OPENABLE)
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, max > 1)
    }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQUEST_PICK) return
    val promise = pending ?: return
    val max = pendingMax
    pending = null
    val uris = if (resultCode == Activity.RESULT_OK) urisOf(data).take(max) else emptyList()
    // 解码压缩放后台：大图要几百毫秒
    Thread({
      val images = Arguments.createArray()
      var failed = 0
      for (uri in uris) {
        try {
          images.pushMap(saveCompressed(uri))
        } catch (t: Throwable) {
          failed++
          Log.w(TAG, "读不了这张图: ${t.message}")
        }
      }
      promise.resolve(Arguments.createMap().apply {
        putArray("images", images)
        putInt("failed", failed)
      })
    }, "solevup-chat-image").start()
  }

  override fun onNewIntent(intent: Intent) {}

  private fun urisOf(data: Intent?): List<Uri> {
    val clip: ClipData? = data?.clipData
    if (clip != null) return (0 until clip.itemCount).map { clip.getItemAt(it).uri }
    return listOfNotNull(data?.data)
  }

  private fun saveCompressed(uri: Uri) = Arguments.createMap().apply {
    val bitmap = decode(uri)
    val bytes = ByteArrayOutputStream().use { out ->
      check(bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)) { "压缩失败" }
      out.toByteArray()
    }
    bitmap.recycle()
    val id = UUID.randomUUID().toString().replace("-", "").take(ID_LENGTH)
    dir.mkdirs()
    val file = File(dir, "$id.jpg")
    file.writeBytes(bytes)
    putString("id", id)
    putString("uri", Uri.fromFile(file).toString())
    putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
    putString("mediaType", "image/jpeg")
  }

  /** ImageDecoder 自己按 EXIF 转正；长边压到 1568（Claude 和千问超过这个尺寸都会缩小），透明底垫白 */
  private fun decode(uri: Uri): Bitmap {
    val source = ImageDecoder.createSource(ctx.contentResolver, uri)
    val decoded = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
      decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
      val longEdge = maxOf(info.size.width, info.size.height)
      if (longEdge > MAX_EDGE) {
        val scale = MAX_EDGE.toFloat() / longEdge
        decoder.setTargetSize(
          (info.size.width * scale).toInt().coerceAtLeast(1),
          (info.size.height * scale).toInt().coerceAtLeast(1),
        )
      }
    }
    if (!decoded.hasAlpha()) return decoded
    val flat = Bitmap.createBitmap(decoded.width, decoded.height, Bitmap.Config.ARGB_8888)
    Canvas(flat).apply {
      drawColor(Color.WHITE)
      drawBitmap(decoded, 0f, 0f, null)
    }
    decoded.recycle()
    return flat
  }

  /** 清掉没有消息引用的旧文件。刚选还没发的不动：消息还没落库 */
  @ReactMethod
  fun sweep(promise: Promise) {
    Thread({
      try {
        val keep = SolevupDb.shared(ctx).chatImageIds()
        val cutoff = System.currentTimeMillis() - SWEEP_GRACE_MS
        var removed = 0
        dir.listFiles()?.forEach { f ->
          if (f.nameWithoutExtension !in keep && f.lastModified() < cutoff && f.delete()) removed++
        }
        promise.resolve(removed)
      } catch (t: Throwable) {
        promise.reject("SWEEP_FAILED", t.message, t)
      }
    }, "solevup-chat-image-sweep").start()
  }

  private companion object {
    const val TAG = "ChatImage"
    const val DIR_NAME = "chat-images"
    const val REQUEST_PICK = 0x5a11
    const val MAX_EDGE = 1568
    const val JPEG_QUALITY = 85
    const val ID_LENGTH = 16
    const val SWEEP_GRACE_MS = 24 * 3600 * 1000L
  }
}
