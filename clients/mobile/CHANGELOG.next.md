- 修：强制更新（min_supported_code > 当前版本码）路径下载/安装失败后弹窗
  会消失，用户能回到旧版本继续用。现在 runDownloadAndInstall() 强制时不在
  下载开始前关闭弹窗，catch 失败分支再次 setConfirmUpdateOpen(true) 兜底
  (AUDIT-021)
- 非强制更新行为不变（下载开始关弹窗，进度看通知栏）
