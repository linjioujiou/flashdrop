# 闪传 FlashDrop API 文档（v1）

为 Web 前端与 **Android 客户端**（预留）提供统一接口。所有接口均部署在 Cloudflare Workers 上，支持 HTTPS 与 CORS；原生 App 调用不受任何跨域限制。

- **Base URL**：`https://<your-worker>.workers.dev`（下文以 `{BASE}` 表示）
- **版本前缀**：`/api/v1`
- **数据格式**：请求与响应均为 UTF-8 JSON（文件上传/下载除外）
- **错误格式**：

```json
{ "error": { "code": "not_found", "message": "取件码不存在" } }
```

- **频率限制**：默认未启用；可按需在 Cloudflare 控制台配置 WAF Rate Limiting 规则。

---

## 1. 认证

| 场景 | 方式 |
|---|---|
| 管理后台接口 `/api/v1/admin/*` | `Authorization: Bearer <ADMIN_TOKEN>` |
| 开放接口（创建任务等） | 可选 `X-Api-Key: fdk_…`（管理后台签发） |
| 任务操作（上传/撤销/状态） | 每任务的 `senderToken`（查询参数 `st=`） |
| 下载文件 | accept 时发放的一次性 `downloadToken`（查询参数 `t=`） |

> 服务端设置 `api_require_key = 1` 后，创建任务必须携带有效 `X-Api-Key`。建议正式发布 Android 客户端时开启。

---

## 2. 数据模型：Transfer

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 任务 ID（随机 16 hex） |
| `status` | string | `pending` 上传中 → `ready` 待接收 → `downloading` 传输中 → `completed` 已完成；另有 `expired` 已过期 / `canceled` 已撤销 |
| `claimCode` | string | 6 位取件码（去混淆字母表） |
| `senderToken` | string | 发送方管理凭证，仅创建时返回一次 |
| `maxDownloads` | int | 允许接收次数，默认 1（一次性） |
| `expiresAt` | int | 过期时间戳（毫秒），到期自动删除 |

**生命周期**：

```
创建(POST /transfers) → pending
  PUT /file 或 parts+complete → ready
接收方 accept（downloads+1，发 downloadToken）
  GET /download 成功读完 → 达到 maxDownloads 时：删除 R2 对象 → completed
未及时被接收 → expiresAt 到期 → cron 或惰性检查删除 → expired
```

---

## 3. 中转传输接口

### 3.1 创建任务

```http
POST {BASE}/api/v1/transfers
Content-Type: application/json
X-Api-Key: fdk_xxx            ← 可选

{
  "fileName": "demo.mp4",       ← 加密传输时传占位符 "encrypted.fdenc"（真实名只放进密文元数据）
  "fileSize": 10485760,         ← 加密传输时为密文体积
  "mimeType": "video/mp4",      ← 加密传输时传 "application/octet-stream"
  "ttlHours": 24,               ← 可选 1–168，默认取系统设置
  "maxDownloads": 1,            ← 可选 1–10
  "encrypted": true             ← 可选，开启端到端加密（见第 4 节）
}
```

响应 `201`：

```json
{
  "id": "9f2c…",
  "claimCode": "7KQ2M9",
  "senderToken": "…32hex…",
  "expiresAt": 1750000000000,
  "encrypted": false,
  "chunkSize": 8388608,
  "uploadUrl":   "/api/v1/transfers/{id}/file?st=…",
  "partUrl":     "/api/v1/transfers/{id}/parts/{n}?st=…",
  "completeUrl": "/api/v1/transfers/{id}/complete?st=…"
}
```

### 3.2 上传文件

- **小文件**（`fileSize ≤ chunkSize`）：单请求直传

```http
PUT {BASE}{uploadUrl}
Content-Type: application/octet-stream

<原始文件字节>
```

- **大文件**：R2 Multipart 分块上传。按 `chunkSize`（默认 8 MB，≥5 MB）切块，`n` 从 1 开始递增；除最后一块外每块 ≥5 MB：

```http
PUT {BASE}/api/v1/transfers/{id}/parts/1?st=<senderToken>   ← 第 1 块（原始字节）
PUT {BASE}/api/v1/transfers/{id}/parts/2?st=<senderToken>   ← 第 2 块
…
POST {BASE}/api/v1/transfers/{id}/complete?st=<senderToken>
Content-Type: application/json

{ "totalParts": 3 }
```

分块可断点续传：重复 PUT 同一 `n` 会覆盖；失败可单独重传。

### 3.3 接收方查询（按取件码）

```http
GET {BASE}/api/v1/transfers?code=7KQ2M9
```

响应：

```json
{ "kind": "relay", "transfer": { "id": "…", "status": "ready", "fileName": "demo.mp4", "fileSize": 10485760, "mimeType": "video/mp4", "encrypted": false, "expiresAt": 1750000000000 } }
```

- `kind = "relay"`：云端中转任务，走 3.4 / 3.5
- `status = "pending"`：对方仍在上传
- 404：不存在；410：已过期 / 已被领取

### 3.4 接收（换取下载凭证）

```http
POST {BASE}/api/v1/transfers/{id}/accept
Content-Type: application/json

{ "code": "7KQ2M9" }
```

响应 `200`：

```json
{ "downloadToken": "…", "downloadUrl": "/api/v1/transfers/{id}/download?t=…", "fileName": "demo.mp4", "fileSize": 10485760, "mimeType": "video/mp4" }
```

### 3.5 下载（接收后自动删除）

```http
GET {BASE}/api/v1/transfers/{id}/download?t=<downloadToken>
```

- 响应为文件流（带 `Content-Disposition`、`Content-Length`）。
- **流被完整读完后，服务端立即删除 R2 中的对象**，任务标记 `completed`。之后同凭证再请求返回 `410 already_received`。
- 下载中途断开：文件保留，可重新 accept 换取新凭证（若 `maxDownloads` 未用尽）。
- Android 建议：OkHttp 流式写盘（`response.body.byteStream()`），避免整文件进内存。

### 3.6 发送方任务管理

```http
GET    {BASE}/api/v1/transfers/{id}/status?st=<senderToken>   → 状态/接收次数
DELETE {BASE}/api/v1/transfers/{id}?st=<senderToken>          → 撤销并立即删除
```

### 3.7 公共配置

```http
GET {BASE}/api/v1/config
→ { "maxFileMb": 2048, "ttlHours": 24, "maxDownloads": 1, "chunkSizeMb": 8 }
```

前端启动时拉取一次，用于显示单文件上限、默认保留时长与分块阈值。改配置无需重新部署前端。

---

## 4. 端到端加密（可选，AES-256-GCM）

开启后**服务器只见到密文**：文件名、MIME、内容全部在客户端加密，密钥永不上传。

### 4.1 密钥与分发

- 发送端生成随机 AES-256-GCM 密钥（32 字节），base64url 编码为 43 字符字符串；
- 密钥仅通过带外渠道传递给接收方，两种载体：
  - 分享链接的 URL 片段：`https://…/r/{claimCode}#k={key}`（`#` 后内容浏览器不会发给服务器）；
  - 完整取件码：`{claimCode}-{key}`，接收方粘贴后由客户端本地拆分，仅前 6 位提交给服务器；
- 服务器任何接口都不接受、不存储密钥；lookup 只返回 `encrypted: true` 标记。

### 4.2 密文容器格式（FDENC1）

```
"FDENC1"                                   ← 6 字节魔数
帧: [4字节小端 帧长][12字节 IV][密文 = 明文 + 16字节 GCM 标签] × N
      （帧长 = 密文字节数，不含 IV）
帧 0   = 元数据: UTF-8 JSON {"n":文件名, "m":MIME, "s":原始大小}
帧 1..N = 文件内容，按 4MB 分块
AAD    = 帧序号（uint32 小端，帧 0 → 0x00000000），防调序/截断
```

### 4.3 流程

1. 发送端：生成密钥 → 组装 FDENC1 密文（`encrypted:true` 创建任务，`fileName` 传占位符 `encrypted.fdenc`，`fileSize` 传密文体积）→ 按正常接口上传密文；
2. 接收端：lookup 得到 `encrypted: true` → accept → download 得到密文流 → 校验魔数后逐帧解密（`Cipher.getInstance("AES/GCM/NoPadding")` + `GCMParameterSpec(128, iv)` + `updateAAD(帧序号)`）→ 帧 0 解出真实文件名/MIME，帧 1..N 拼接为文件；
3. 下载完成后云端自动删除的逻辑与明文传输完全一致（删除的是密文）。

---

## 5. 管理接口

认证二选一：
- **网页登录**：`POST /api/v1/admin/login` 校验密码（`ADMIN_PASSWORD`，未设置时为 `ADMIN_TOKEN`），成功后签发 **HttpOnly 会话 Cookie `fd_admin`（7 天）**，后续请求自动携带；连续失败 5 次锁定 10 分钟（按 IP）。
- **Bearer 令牌**：`Authorization: Bearer <ADMIN_TOKEN>`（脚本 / 第三方集成，无会话）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/admin/login` | `{ "password": "…" }` → 签发会话 Cookie；429 = 触发限流 |
| POST | `/api/v1/admin/logout` | 清除会话 Cookie |
| GET | `/api/v1/admin/overview` | 统计概览 + 最近任务 |
| GET | `/api/v1/admin/transfers?page=&size=&status=&q=` | 任务列表（分页/筛选/搜索） |
| DELETE | `/api/v1/admin/transfers/{id}` | 删除文件并撤销任务 |
| POST | `/api/v1/admin/purge` | 立即清理所有过期任务 |
| GET / POST | `/api/v1/admin/api-keys` | 密钥列表 / 签发 `{name}` |
| DELETE | `/api/v1/admin/api-keys/{key}` | 吊销密钥 |
| GET / PUT | `/api/v1/admin/settings` | 读取 / 更新系统设置 |

---

## 6. 错误码速查

| HTTP | code | 场景 |
|---|---|---|
| 400 | bad_code / bad_part / no_parts | 参数不合法 |
| 401 | unauthorized | 缺少/错误 ADMIN_TOKEN 或 X-Api-Key（强制时） |
| 403 | bad_token / bad_code | 凭证或取件码不匹配 |
| 404 | not_found | 资源不存在或已过期 |
| 409 | not_ready / wrong_state | 状态冲突 |
| 410 | expired / gone / already_received / download_limit | 文件不可再接收 |
| 413 | file_too_large / use_parts | 超大小限制 / 需走分块 |

---

## 7. 路线图（v2 预留）

- 端到端加密 Android 参考实现（Kotlin）与桌面客户端
- 多文件打包、断点续传（下载侧）
- 推送通知（FCM），接收端离线提醒
