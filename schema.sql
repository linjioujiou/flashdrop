-- 闪传 FlashDrop 数据库结构
-- 执行: npx wrangler d1 execute flashdrop --remote --file=./schema.sql

-- 中转传输任务
CREATE TABLE IF NOT EXISTS transfers (
  id              TEXT PRIMARY KEY,            -- 内部 ID（随机 16 hex）
  kind            TEXT NOT NULL DEFAULT 'relay',
  file_name       TEXT NOT NULL,
  file_size       INTEGER NOT NULL DEFAULT 0,
  mime_type       TEXT,
  r2_key          TEXT,                        -- R2 对象键
  upload_id       TEXT,                        -- R2 分块上传会话 ID
  parts           TEXT,                        -- 已上传分块 JSON: [{partNumber,etag}]
  claim_code      TEXT,                        -- 6 位取件码
  sender_token    TEXT NOT NULL,               -- 发送方管理凭证
  download_token  TEXT,                        -- 接收方下载凭证
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending/ready/downloading/completed/expired/canceled
  encrypted       INTEGER NOT NULL DEFAULT 0,  -- 端到端加密（服务端仅存密文）
  downloads       INTEGER NOT NULL DEFAULT 0,  -- 已被认领的下载次数
  max_downloads   INTEGER NOT NULL DEFAULT 1,  -- 允许接收次数
  expires_at      INTEGER NOT NULL,            -- 过期时间戳 (ms)
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  note            TEXT,
  sender_ip       TEXT,
  sender_ua       TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfers_status   ON transfers(status);
CREATE INDEX IF NOT EXISTS idx_transfers_expires  ON transfers(expires_at);
CREATE INDEX IF NOT EXISTS idx_transfers_code     ON transfers(claim_code);
CREATE INDEX IF NOT EXISTS idx_transfers_created  ON transfers(created_at);

-- P2P 实时互传会话（仅记录元信息，文件不经过服务器）
CREATE TABLE IF NOT EXISTS p2p_sessions (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL,                 -- 6 位配对码
  status        TEXT NOT NULL DEFAULT 'active',-- active/completed/expired
  file_name     TEXT DEFAULT '',
  file_size     INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL,
  connected_at  INTEGER,
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_p2p_code     ON p2p_sessions(code);
CREATE INDEX IF NOT EXISTS idx_p2p_status   ON p2p_sessions(status);

-- 移动端 / 第三方 API 密钥（为 Android 应用预留）
CREATE TABLE IF NOT EXISTS api_keys (
  key           TEXT PRIMARY KEY,              -- fdk_ 前缀
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  requests      INTEGER NOT NULL DEFAULT 0,
  revoked       INTEGER NOT NULL DEFAULT 0
);

-- 系统设置（key-value）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('default_ttl_hours', '24'),        -- 云端文件默认保留时长（小时）
  ('max_file_mb', '2048'),            -- 单文件大小上限 (MB)
  ('default_max_downloads', '1'),     -- 默认允许接收次数（1 = 一次性）
  ('api_require_key', '0'),           -- API 创建传输是否强制要求 X-Api-Key
  ('chunk_size_mb', '8'),             -- 分块上传块大小 (MB)
  ('p2p_room_ttl_minutes', '30');     -- P2P 配对码有效期（分钟）
