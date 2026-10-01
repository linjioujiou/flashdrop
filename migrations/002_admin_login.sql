-- v1.2 升级：管理后台密码登录（失败限流表）
-- 仅已有部署需要执行一次（新部署直接使用最新 schema.sql）
-- 执行: npx wrangler d1 execute flashdrop --remote --file=./migrations/002_admin_login.sql
-- 并设置管理密码: npx wrangler secret put ADMIN_PASSWORD
CREATE TABLE IF NOT EXISTS login_attempts (
  ip           TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
