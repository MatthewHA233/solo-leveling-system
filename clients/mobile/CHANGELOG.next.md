- latest.json 改走 OSS 原生域（lingflow.oss-cn-heyuan.aliyuncs.com），不走
  assets.lingflow.cn CDN：CDN 边缘节点常忽略 Cache-Control: no-cache 缓存
  几小时甚至几天，新版本发布后用户拿到旧 manifest 误以为没更新；OSS 原生
  域永远是最新。APK 仍走 CDN（大文件需要加速）。
- 发布脚本拆 public_url_for_apk / public_url_for_manifest 两个函数
- gradle BuildConfig SLS_UPDATE_MANIFEST_URL 不再读 ossCustomDomain，
  直接拼 OSS 原生域
