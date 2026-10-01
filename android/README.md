# 闪传 FlashDrop — Android 客户端

配套 [闪传 FlashDrop](../README.md)（Cloudflare Workers）的官方安卓客户端，使用 `/api/v1` 接口，支持云端中转发送/接收与端到端加密（FDENC1，与网页端互通）。

## 功能

- ☁️ **云端中转发送**：选择文件 → 端到端加密（可关）→ 分片上传 → 生成取件码/分享链接
- 📥 **接收**：输入完整取件码或粘贴分享链接 → 流式下载 → 自动解密 → 保存到系统「下载」目录
- 🔐 **FDENC1**：AES-256-GCM，密钥仅存在于分享内容中，服务器只见密文
- ⚙️ 可配置服务器地址与 API 密钥（`X-Api-Key`）

> 文件全程经云端中转，双方无需同时在线；速度取决于上行带宽。

## 构建与运行

1. 用 **Android Studio**（Hedgehog 及以上）打开本目录（`android/`），等待 Gradle 同步完成
2. 连接手机（开启 USB 调试）或启动模拟器，点击 Run ▶

命令行构建（需 JDK 17 + `ANDROID_HOME` 指向 Android SDK，且已接受 SDK 许可）：

```bash
cd android
./gradlew :app:assembleDebug          # Windows: gradlew.bat :app:assembleDebug
# 产物: app/build/outputs/apk/debug/app-debug.apk
```

首次构建会从腾讯镜像下载 Gradle 8.10.2（约 100MB），之后走本地缓存。
`local.properties` 里的 `sdk.dir` 是机器相关路径，已被 `.gitignore` 排除，克隆后需自行生成或由 Android Studio 写入。

Gradle/依赖已配置阿里云与腾讯镜像优先，国内网络可直接同步。

## 与服务端的接口映射

| 操作 | 接口 |
|---|---|
| 发送-创建 | `POST /api/v1/transfers`（`encrypted:true`，文件名传 `encrypted.fdenc`） |
| 发送-分片 | 容器按 8MB 切片 `PUT /parts/{n}`（≥5MiB，非末片等长）→ `POST /complete` |
| 接收-查询 | `GET /api/v1/transfers?code=` |
| 接收-确认 | `POST /api/v1/transfers/{id}/accept` |
| 接收-下载 | `GET {downloadUrl}` → FDENC1 解密（AAD：数据帧=块序号、元数据帧=0，元数据帧在最后，末尾 6 字节魔数） |

密钥传递：分享链接 `#k=` 片段或完整取件码 `CODE-KEY`，**永不上传服务器**。

## 已知限制（v1）

- E2E 解密需要整文件缓存后解密（密文临时文件 + 明文输出），超大文件受设备存储限制
