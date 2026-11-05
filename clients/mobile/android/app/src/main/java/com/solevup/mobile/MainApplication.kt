package com.solevup.mobile

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.solevup.mobile.chatimage.ChatImagePackage
import com.solevup.mobile.fairyfs.FairyFsPackage
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
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    SyncRuntime.start(this)
  }
}
