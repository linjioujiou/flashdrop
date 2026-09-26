# ⚡ 闪传 FlashDrop

部署在 **Cloudflare Workers** 上的文件传输站：设备同时在线时走 **WebRTC P2P 直传**（文件不经过服务器）；对方离线时走 **Cloudflare R2 云端中转**——文件临时保存，**接收完成后立即自动删除**，到期自动清理。

内置 Apple 现代风格的前端与管理后台，并提供 REST + WebSocket API（`/api/v1`），已为后续 **Android 客户端**预留完整接口。

## 功能特性

- **⚡ 实时直传（P2P）**：WebRTC DataChannel 点对点传输，6 位配对码 + 二维码配对，实时速度与进度展示，文件不落盘
- **☁️ 云端中转（R2）**：对方离线也能收；分块上传支持大文件（默认上限 2 GB）；下载完成后云端副本**立即删除**
- **🔐 端到端加密（默认开启）**：中转文件用 AES-256-GCM 在浏览器内加密后才上传，密钥只存在于分享链接 `#k=` 片段或「取件码-密钥」完整取件码中，服务器（含 Cloudflare 日志）永远只见密文，文件名也不上传
- **自动清理**：一次性接收（可配置次数）；TTL 到期惰性清理 + 每小时 cron 兜底；未完成的分块上传会话一并中止
- **🗂️ 管理后台**（`/admin`）：存储占用/今日新增/累计送达等统计、传输记录（筛选/搜索/删除）、P2P 会话记录、API 密钥签发与吊销、系统设置、内置 API 文档
- **📱 Android 预留接口**：`/api/v1` 全套 REST + 信令 WebSocket，支持 `X-Api-Key` 应用密钥，见 [docs/API.md](docs/API.md)
- **🔒 安全**：全程 TLS、R2 静态加密、下载凭证一次性、管理令牌 Bearer 认证、来源 IP 脱敏展示
- **🎨 设计**：Apple 现代风格——毛玻璃卡片、SF 字体栈、渐变光斑背景、深浅色自适应、移动端适配

## 架构

| 组件 | 服务 |
|---|---|
| 前端页面 | Workers Static Assets（`/` 传输、`/admin` 管理） |
| API + 下载流 | Cloudflare Workers |
| 文件临时存储 | Cloudflare R2（`flashdrop-files`） |
| 元数据 | Cloudflare D1（`flashdrop`） |
| P2P 信令 | Durable Objects（WebSocket Hibernation，闲置零计费） |
| 过期清理 | Cron Triggers（每小时） |

## 快速部署

前提：Node.js ≥ 18，一个 Cloudflare 账号（免费版即可，Durable Objects 使用 SQLite 存储类，免费计划可用）。

```bash
cd flashdrop
npm install
npx wrangler login     # 浏览器授权
npm run setup          # 自动创建 R2/D1/数据表/密钥并部署
```

`npm run setup` 会依次完成：创建 R2 桶 `flashdrop-files` → 创建 D1 库 `flashdrop` 并把 `database_id` 写回 `wrangler.toml` → 执行 `schema.sql` 建表 → 生成并保存 `ADMIN_TOKEN`（同时写入 `.admin-token.txt`）→ `wrangler deploy`。

完成后终端会输出访问地址：

- 前台：`https://flashdrop.<你的子域>.workers.dev/`
- 管理后台：`https://flashdrop.<你的子域>.workers.dev/admin`（用 `.admin-token.txt` 里的令牌登录）

### 手动部署（备选）

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create flashdrop-files
npx wrangler d1 create flashdrop          # 把输出的 database_id 填入 wrangler.toml
npx wrangler d1 execute flashdrop --remote --file=./schema.sql
npx wrangler secret put ADMIN_TOKEN       # 自定义管理令牌
npx wrangler deploy
```

### 已有部署升级（v1.0 → v1.1，端到端加密）

```bash
npx wrangler d1 execute flashdrop --remote --file=./migrations/001_add_encrypted.sql
npx wrangler deploy
```

新部署无需此步骤（`npm run setup` 已包含最新表结构）。

### 本地开发

```bash
npm run dev                 # http://localhost:8787（R2/D1/DO 均为本地模拟）
npm test                    # 冒烟测试（需先启动 dev；定时清理测试需 --test-scheduled）
```

本地默认管理令牌见 `.dev.vars`：`dev-token-12345`。

## 使用方式

**发送**：打开首页 → 拖入文件 → 选择「实时直传」或「云端中转」。
- 直传：把 6 位配对码或二维码给对方，双方在线时自动直连
- 中转：得到取件码和链接（`/r/取件码`），可随时撤销并立即删除

**接收**：打开对方分享的链接（推荐，加密文件密钥内嵌其中）或输入取件码 → 「接收文件」→ 加密文件在浏览器内自动解密后保存，云端副本同步删除。

**加密说明**：端到端加密默认开启，可在上传前取消勾选。开启后必须通过**完整链接**或**完整取件码**（`取件码-密钥`）分享——只凭 6 位取件码无法解密，这是设计使然。格式规范见 [docs/API.md](docs/API.md) 第 5 节，Android 端可按规范自行实现加解密。

**管理**：`/admin` 登录后可查看统计、清理/删除文件、签发 App 密钥、调整 TTL / 大小上限 / 接收次数等设置。

## 为 Android 预留的接口

完整规范见 [docs/API.md](docs/API.md)，要点：

- 中转模式：`POST /api/v1/transfers` 创建 → `PUT …/parts/{n}` 分块上传 → `…/accept` 换取一次性下载凭证 → `GET …/download` 流式下载（读完即焚）
- P2P 模式：`POST /api/v1/p2p/rooms` 配对 + `GET /api/v1/signal` WebSocket 信令，数据面用 `org.webrtc` DataChannel
- 应用鉴权：管理后台签发 `X-Api-Key`；可在设置中开启「强制密钥」后正式发布客户端
- 管理接口与 Web 后台共用（`Authorization: Bearer <ADMIN_TOKEN>`）

## 数据安全与自动删除机制

1. **端到端加密**：中转文件默认 AES-256-GCM 浏览器内加密（FDENC1 容器，分帧 + AAD 防调序），密钥经链接 `#k=` 片段传递，永不上传；
2. 接收方下载流完整读毕 → Worker 立即 `R2.delete()`，任务标记 `completed`；
3. 到期未接收 → 访问时惰性删除 + 每小时 cron 兜底，同时中止残留的分块上传会话；
4. 发送方可随时「撤销并删除」，管理后台可强制删除；
5. 建议在 Cloudflare 控制台为 R2 桶加一条**生命周期规则**（前缀 `files/`，7 天后删除）作为双保险；
6. 管理后台的来源 IP 做了脱敏（`1.2.*.*`）。

## 目录结构

```
flashdrop/
├── wrangler.toml          # Cloudflare 配置（R2/D1/DO/Cron/Assets）
├── schema.sql             # D1 建表语句
├── src/
│   ├── index.js           # Worker 主入口：路由/中转传输/管理 API/定时清理
│   ├── util.js            # 通用工具
│   └── do/signal-room.js  # P2P 信令 Durable Object
├── public/
│   ├── index.html         # 传输页（发送/接收）
│   ├── admin.html         # 管理后台
│   ├── css/style.css      # Apple 风格样式
│   └── js/app.js | admin.js
├── scripts/
│   ├── setup.mjs          # 一键初始化 + 部署
│   └── smoke-test.mjs     # 接口冒烟测试
└── docs/API.md            # v1 API 文档（Android 接入指南）
```

## 常见问题

- **免费额度够用吗？** Workers 免费计划每天 10 万请求；R2 免费 10 GB 存储/月，超出后按量计费。Durable Objects 免费计划可用（SQLite 类）。
- **P2P 连不上？** 双方都在严格对称 NAT 后时无法直连（未内置 TURN），请改用云端中转模式。
- **单文件上限？** 默认 2 GB（可在管理后台调整）； Workers 单请求体上限约 100–500 MB，大文件已自动走分块上传，不受该限制影响。
- **自定义域名？** 在 Cloudflare 控制台 Workers → flashdrop → Domains 添加即可。
