- 修：状态栏出现多个"更新失败"通知。根因是用户多次点"立即更新"会
  enqueue 多个并行下载任务；UpdaterModule 现在记录上次 download id，
  新一次开始前 dm.remove(oldId) 取消，并把 Notification visibility
  从 VISIBLE_NOTIFY_COMPLETED 改成 VISIBLE（下载过程中显示进度条，
  完成后通知自动消失）
- 修：PerceptionScreen.runDownloadAndInstall 拦重复触发，installing
  中再点确认按钮直接 noop
