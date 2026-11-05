package com.solevup.mobile

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.modules.network.OkHttpClientProvider
import com.solevup.mobile.chatimage.ChatImagePackage
import com.solevup.mobile.fairyfs.FairyFsPackage
import com.solevup.mobile.net.AppProxy
import com.solevup.mobile.net.NetworkPackage
import com.solevup.mobile.perception.PerceptionPackage
import com.solevup.mobile.solevupdb.SolevupDbPackage
import com.solevup.mobile.sync.SyncRuntime
import com.solevup.mobile.syncclient.SyncClientPackage
import com.solevup.mobile.syncserver.SyncServerPackage
import com.solevup.mobile.omni.OmniPackage
import com.solevup.mobile.updater.UpdaterPackage
import com.solevup.mobile.voice.VoicePackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(PerceptionPackage())
          add(SolevupDbPackage())
          add(SyncServerPackage())
          add(SyncClientPackage())
          add(UpdaterPackage())
          add(OmniPackage())
          add(VoicePackage())
          add(FairyFsPackage())
          add(ChatImagePackage())
          add(NetworkPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    AppProxy.init(this)
    // RN 的 XHR（Anthropic）也要走「网络代理」设置。其他都和默认一样
    OkHttpClientProvider.setOkHttpClientFactory {
      OkHttpClientProvider.createClientBuilder(this)
        .proxySelector(AppProxy.selector)
        .connectionPool(AppProxy.connectionPool)
        .build()
    }
    loadReactNative(this)
    SyncRuntime.start(this)
  }
}
