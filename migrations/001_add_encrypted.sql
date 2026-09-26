-- v1.0 → v1.1 升级：新增端到端加密标记列
-- 仅已有部署需要执行一次（新部署直接使用最新 schema.sql）
-- 执行: npx wrangler d1 execute flashdrop --remote --file=./migrations/001_add_encrypted.sql
ALTER TABLE transfers ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;
