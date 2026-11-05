package com.solevup.mobile.net

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/** 设置页读写「网络代理」端口。规则见 AppProxy */
class NetworkModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = NAME

  @ReactMethod
  fun getProxyPort(promise: Promise) {
    promise.resolve(AppProxy.port())
  }

  @ReactMethod
  fun setProxyPort(port: Double, promise: Promise) {
    try {
      AppProxy.setPort(port.toInt())
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("SET_PROXY_PORT_FAILED", e.message, e)
    }
  }

  companion object {
    const val NAME = "Network"
  }
}
