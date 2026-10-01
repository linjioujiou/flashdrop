// 通用工具：响应、随机串、鉴权、设置读取

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-api-key, range',
  'access-control-max-age': '86400'
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS_HEADERS, ...extraHeaders }
  });
}

export function err(status, code, message) {
  return json({ error: { code, message } }, status);
}

const HEX = '0123456789abcdef';
export function randomHex(chars = 32) {
  const bytes = new Uint8Array(Math.ceil(chars / 2));
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => HEX[b >> 4] + HEX[b & 15]).join('').slice(0, chars);
}

// 去掉易混淆字符（0/O/1/I/L）的取件码字母表
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function randomCode(len = 6) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function randomId() {
  return randomHex(16);
}

export async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// 常数时间字符串比较（防时序侧信道）
export function safeEqual(a, b) {
  const A = String(a);
  const B = String(b);
  let diff = A.length === B.length ? 0 : 1;
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    diff |= (A.charCodeAt(i) || 0) ^ (B.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 管理密码校验：优先 ADMIN_PASSWORD，未设置时回退 ADMIN_TOKEN
export function isPasswordOk(input, env) {
  const password = env.ADMIN_PASSWORD || env.ADMIN_TOKEN;
  return !!password && safeEqual(String(input), password);
}

// 管理会话：exp.HMAC(ADMIN_TOKEN, 'admin.'+exp) —— 无状态、无法伪造、自带过期
export async function makeSession(secret, ttlMs) {
  const exp = Date.now() + ttlMs;
  return `${exp}.${await hmac(secret, 'admin.' + exp)}`;
}

export async function verifySession(secret, val) {
  const dot = String(val).lastIndexOf('.');
  if (dot < 1) return false;
  const exp = Number(val.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expect = await hmac(secret, 'admin.' + exp);
  return safeEqual(val.slice(dot + 1), expect);
}

// 管理鉴权：Bearer ADMIN_TOKEN（API/脚本）或 fd_admin 会话 Cookie（网页登录）二选一
export async function isAdmin(request, env) {
  const secret = env.ADMIN_TOKEN;
  if (!secret) return false;
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  if (m && safeEqual(m[1].trim(), secret)) return true;
  const cookie = /(?:^|;\s*)fd_admin=([^;]+)/.exec(request.headers.get('cookie') || '');
  if (cookie) return verifySession(secret, cookie[1]);
  return false;
}

export const DEFAULT_SETTINGS = {
  default_ttl_hours: '24',
  max_file_mb: '2048',
  default_max_downloads: '1',
  api_require_key: '0',
  chunk_size_mb: '8'
};

export async function getSettings(db) {
  const map = { ...DEFAULT_SETTINGS };
  try {
    const { results } = await db.prepare('SELECT key, value FROM settings').all();
    for (const r of results) map[r.key] = String(r.value);
  } catch {}
  return map;
}

// 校验 X-Api-Key（可选）：未启用强制时，无效密钥也放行
export async function checkApiKey(env, request, settings) {
  const key = request.headers.get('x-api-key');
  if (!key) return { ok: settings.api_require_key !== '1' };
  const row = await env.DB.prepare('SELECT key FROM api_keys WHERE key = ? AND revoked = 0').bind(key).first();
  if (!row) return { ok: settings.api_require_key !== '1', invalid: true };
  env.DB.prepare('UPDATE api_keys SET last_used_at = ?, requests = requests + 1 WHERE key = ?')
    .bind(Date.now(), key).run().catch(() => {});
  return { ok: true };
}

export function maskIp(ip) {
  if (!ip) return '';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':*';
  const parts = ip.split('.');
  if (parts.length !== 4) return '*';
  return parts.slice(0, 2).join('.') + '.*.*';
}

// Content-Disposition（RFC 5987，兼容中文文件名）
export function contentDisposition(name) {
  const ascii = String(name || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name || 'file')}`;
}
