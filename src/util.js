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

export function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  return !!m && m[1].trim() === env.ADMIN_TOKEN;
}

export const DEFAULT_SETTINGS = {
  default_ttl_hours: '24',
  max_file_mb: '2048',
  default_max_downloads: '1',
  api_require_key: '0',
  chunk_size_mb: '8',
  p2p_room_ttl_minutes: '30'
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
