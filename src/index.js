// 闪传 FlashDrop — Cloudflare Worker 主入口
// 路由：静态页面 / API v1（云端中转传输 + 管理后台）
import {
  json, err, CORS_HEADERS, readJson, randomHex, randomCode, randomId,
  isAdmin, isPasswordOk, makeSession, getSettings, checkApiKey, clamp, maskIp, contentDisposition, DEFAULT_SETTINGS
} from './util.js';

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, ctx, url);
      return handlePage(request, env, url);
    } catch (e) {
      console.error('unhandled', e);
      return err(500, 'internal_error', '服务器内部错误');
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeExpired(env));
  }
};

/* ---------------- 页面路由 ---------------- */

function handlePage(request, env, url) {
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  const p = url.pathname;
  if (p === '/healthz') return json({ ok: true, time: Date.now() });
  if (p === '/favicon.ico') return new Response(null, { status: 204 });
  // 发送/接收共用首页；/r/<取件码>（可含 -密钥 后缀）深链也落到首页，由前端解析
  if (p === '/' || /^\/r\/[A-Za-z0-9_-]{4,90}$/.test(p)) return asset(env, '/index.html', url);
  if (p === '/admin' || p === '/admin/') return asset(env, '/admin.html', url);
  return Response.redirect(url.origin + '/', 302);
}

function asset(env, path, url) {
  return env.ASSETS.fetch(new URL(path, url.origin));
}

/* ---------------- API 路由 ---------------- */

async function handleApi(request, env, ctx, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api','v1',...]
  const m = request.method;
  const [, , a, b, ...rest] = seg;

  if (a === 'config' && m === 'GET') {
    const s = await getSettings(env.DB);
    const cfg = {
      maxFileMb: Number(s.max_file_mb) || 2048,
      ttlHours: Number(s.default_ttl_hours) || 24,
      maxDownloads: Number(s.default_max_downloads) || 1,
      chunkSizeMb: Math.max(5, Number(s.chunk_size_mb) || 8)
    };
    return json(cfg);
  }

  if (a === 'transfers') {
    if (!b) {
      if (m === 'POST') return createTransfer(request, env, url);
      if (m === 'GET') return lookupByCode(request, env, url);
      return err(405, 'method_not_allowed', '不支持的请求方法');
    }
    const id = b;
    if (rest.length === 0 && m === 'DELETE') return cancelTransfer(request, env, id);
    if (rest.length === 1) {
      const sub = rest[0];
      if (sub === 'file' && m === 'PUT') return uploadSingle(request, env, id);
      if (sub === 'complete' && m === 'POST') return completeUpload(request, env, id);
      if (sub === 'accept' && m === 'POST') return acceptTransfer(request, env, id);
      if (sub === 'download' && m === 'GET') return downloadTransfer(request, env, ctx, id);
      if (sub === 'status' && m === 'GET') return transferStatus(request, env, id);
    }
    if (rest.length === 2 && rest[0] === 'parts' && m === 'PUT') {
      const n = Number(rest[1]);
      if (!Number.isInteger(n) || n < 1 || n > 10000) return err(400, 'bad_part', '分块序号无效');
      return uploadPart(request, env, id, n);
    }
    return err(404, 'not_found', '接口不存在');
  }

  if (a === 'wallpaper' && m === 'GET') return handleWallpaper();
  if (a === 'admin') return handleAdmin(request, env, url, seg.slice(3), m);

  return err(404, 'not_found', '接口不存在');
}

/* ---------------- 中转传输 ---------------- */

async function getTransfer(env, id) {
  return env.DB.prepare('SELECT * FROM transfers WHERE id = ?').bind(id).first();
}

// 惰性过期：访问时发现已到期则立即清理 R2 并标记
async function maybeExpire(env, row) {
  if (row.expires_at >= Date.now()) return false;
  try { if (row.upload_id && row.r2_key) await env.BUCKET.resumeMultipartUpload(row.r2_key, row.upload_id).abort(); } catch {}
  try { if (row.r2_key) await env.BUCKET.delete(row.r2_key); } catch {}
  await env.DB.prepare("UPDATE transfers SET status = 'expired' WHERE id = ?").bind(row.id).run();
  return true;
}

async function createTransfer(request, env, url) {
  const settings = await getSettings(env.DB);
  const ak = await checkApiKey(env, request, settings);
  if (!ak.ok) return err(401, 'unauthorized', '需要有效的 X-Api-Key');

  const body = await readJson(request);
  const fileName = String(body.fileName || '').trim().slice(0, 255) || '未命名文件';
  const fileSize = Math.max(0, Math.floor(Number(body.fileSize) || 0));
  const maxMb = Math.max(1, Number(settings.max_file_mb) || 2048);
  if (fileSize > maxMb * 1048576) return err(413, 'file_too_large', `文件超过大小限制 ${maxMb} MB`);

  const ttlHours = clamp(Number(body.ttlHours) || Number(settings.default_ttl_hours) || 24, 1, 168);
  const maxDownloads = clamp(Number(body.maxDownloads ?? settings.default_max_downloads) || 1, 1, 10);
  const mimeType = String(body.mimeType || 'application/octet-stream').slice(0, 128);
  const encrypted = body.encrypted ? 1 : 0;

  let code = randomCode();
  for (let i = 0; i < 5; i++) {
    const dup = await env.DB.prepare('SELECT 1 FROM transfers WHERE claim_code = ?').bind(code).first();
    if (!dup) break;
    code = randomCode();
  }

  const id = randomId();
  const senderToken = randomHex(32);
  const r2Key = `files/${id}/blob`;
  const now = Date.now();
  const expiresAt = now + ttlHours * 3600000;
  const chunkSizeMb = Math.max(5, Number(settings.chunk_size_mb) || 8);

  // 预建分片会话：并发分片上传共享同一会话（懒创建会有竞态，导致分片散落多个会话）
  const mpu = await env.BUCKET.createMultipartUpload(r2Key, { httpMetadata: { contentType: mimeType } });

  await env.DB.prepare(
    `INSERT INTO transfers (id, kind, file_name, file_size, mime_type, r2_key, upload_id, claim_code, sender_token,
      status, encrypted, max_downloads, expires_at, created_at, note, sender_ip, sender_ua)
     VALUES (?1, 'relay', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
  ).bind(id, fileName, fileSize, mimeType, r2Key, mpu.uploadId, code, senderToken, encrypted, maxDownloads, expiresAt, now,
    String(body.note || '').slice(0, 500) || null,
    request.headers.get('cf-connecting-ip'), (request.headers.get('user-agent') || '').slice(0, 200)).run();

  return json({
    id,
    claimCode: code,
    senderToken,
    expiresAt,
    ttlHours,
    encrypted: !!encrypted,
    chunkSize: chunkSizeMb * 1048576,
    uploadUrl: `/api/v1/transfers/${id}/file?st=${senderToken}`,
    partUrl: `/api/v1/transfers/${id}/parts/{n}?st=${senderToken}`,
    completeUrl: `/api/v1/transfers/${id}/complete?st=${senderToken}`
  }, 201);
}

// 小文件单请求直传（<= chunkSize）
async function uploadSingle(request, env, id) {
  const url = new URL(request.url);
  const t = await getTransfer(env, id);
  if (!t) return err(404, 'not_found', '任务不存在');
  if (url.searchParams.get('st') !== t.sender_token) return err(403, 'bad_token', '发送方凭证无效');
  if (t.status !== 'pending') return err(409, 'wrong_state', '该任务已结束上传');

  const len = Number(request.headers.get('content-length') || 0);
  const settings = await getSettings(env.DB);
  const maxSingle = Math.max(5, Number(settings.chunk_size_mb) || 8) * 1048576;
  if (!len) return err(411, 'length_required', '缺少 Content-Length');
  if (len > maxSingle) return err(413, 'use_parts', '文件过大，请使用分块上传接口');

  const buf = await request.arrayBuffer();
  const obj = await env.BUCKET.put(t.r2_key, buf, {
    httpMetadata: { contentType: t.mime_type || 'application/octet-stream' }
  });
  // 单请求直传不使用预建的分片会话：中止它避免残留
  if (t.upload_id) {
    try { await env.BUCKET.resumeMultipartUpload(t.r2_key, t.upload_id).abort(); } catch {}
    await env.DB.prepare("UPDATE transfers SET status = 'ready', file_size = ?, upload_id = NULL WHERE id = ?")
      .bind(obj.size, id).run();
  } else {
    await env.DB.prepare("UPDATE transfers SET status = 'ready', file_size = ? WHERE id = ?")
      .bind(obj.size, id).run();
  }
  return json({ ok: true, size: obj.size, status: 'ready' });
}

// 分块上传（R2 Multipart，> chunkSize 的文件）
async function uploadPart(request, env, id, n) {
  const url = new URL(request.url);
  const t = await getTransfer(env, id);
  if (!t) return err(404, 'not_found', '任务不存在');
  if (url.searchParams.get('st') !== t.sender_token) return err(403, 'bad_token', '发送方凭证无效');
  if (t.status !== 'pending') return err(409, 'wrong_state', '该任务已结束上传');

  // 会话已在 createTransfer 预建，所有并发分片共享同一 upload_id
  const mpu = env.BUCKET.resumeMultipartUpload(t.r2_key, t.upload_id);

  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return err(400, 'empty_part', '分块内容为空');
  const part = await mpu.uploadPart(n, buf);

  // 原子追加 etag（客户端并发分片上传安全）；重传同块会产生重复项，complete 时按块号去重
  await env.DB.prepare(
    "UPDATE transfers SET parts = json_insert(COALESCE(parts, '[]'), '$[#]', json_object('partNumber', ?1, 'etag', ?2)) WHERE id = ?3"
  ).bind(n, part.etag, id).run();

  return json({ ok: true, partNumber: n, etag: part.etag });
}

async function completeUpload(request, env, id) {
  const url = new URL(request.url);
  const t = await getTransfer(env, id);
  if (!t) return err(404, 'not_found', '任务不存在');
  if (url.searchParams.get('st') !== t.sender_token) return err(403, 'bad_token', '发送方凭证无效');
  if (t.status !== 'pending') return err(409, 'wrong_state', '该任务已结束上传');
  if (!t.upload_id) return err(400, 'no_multipart', '未开始分块上传');

  const body = await readJson(request);
  let parts = [];
  try { parts = JSON.parse(t.parts || '[]'); } catch {}
  if (!parts.length) return err(400, 'no_parts', '没有已上传的分块');
  // 并发上传会追加重复项：按块号去重（后传覆盖先传），再按块号升序交给 R2
  const byPart = new Map();
  for (const p of parts) byPart.set(Number(p.partNumber), p);
  const deduped = [...byPart.entries()].sort((x, y) => x[0] - y[0]).map(e => e[1]);
  if (body.totalParts && Number(body.totalParts) !== deduped.length) {
    return err(409, 'parts_mismatch', `分块数量不符：已上传 ${deduped.length}/${body.totalParts}`);
  }

  const mpu = env.BUCKET.resumeMultipartUpload(t.r2_key, t.upload_id);
  const obj = await mpu.complete(deduped);
  await env.DB.prepare("UPDATE transfers SET status = 'ready', file_size = ?, upload_id = NULL, parts = NULL WHERE id = ?")
    .bind(obj.size, id).run();
  return json({ ok: true, size: obj.size, status: 'ready' });
}

// 接收方：按取件码查询
async function lookupByCode(request, env, url) {
  const code = (url.searchParams.get('code') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,10}$/.test(code)) return err(400, 'bad_code', '取件码格式不正确');

  const t = await env.DB.prepare('SELECT * FROM transfers WHERE claim_code = ? ORDER BY created_at DESC LIMIT 1')
    .bind(code).first();
  if (t) {
    if (await maybeExpire(env, t)) return err(410, 'expired', '取件码已过期');
    if (t.status === 'completed') return err(410, 'already_received', '文件已被接收，云端副本已删除');
    if (t.status === 'canceled') return err(410, 'gone', '文件已被发送方撤销');
    return json({
      kind: 'relay',
      transfer: {
        id: t.id, status: t.status, fileName: t.file_name, fileSize: t.file_size,
        mimeType: t.mime_type, encrypted: !!t.encrypted, expiresAt: t.expires_at
      }
    });
  }

  return err(404, 'not_found', '取件码不存在或已失效');
}

// 接收方：确认接收，换发下载凭证
async function acceptTransfer(request, env, id) {
  const t = await getTransfer(env, id);
  if (!t) return err(404, 'not_found', '任务不存在');
  if (await maybeExpire(env, t)) return err(410, 'expired', '文件已过期');

  const body = await readJson(request);
  if (String(body.code || '').toUpperCase() !== (t.claim_code || '')) return err(403, 'bad_code', '取件码不正确');
  if (t.status === 'pending') return err(409, 'not_ready', '对方仍在上传，请稍后再试');
  if (t.status !== 'ready') return err(410, 'gone', '文件已不可接收（可能已被领取）');
  if (t.downloads >= t.max_downloads) return err(410, 'download_limit', '接收次数已达上限');

  const token = randomHex(32);
  await env.DB.prepare('UPDATE transfers SET downloads = downloads + 1, download_token = ? WHERE id = ?')
    .bind(token, id).run();
  return json({
    downloadToken: token,
    downloadUrl: `/api/v1/transfers/${id}/download?t=${token}`,
    fileName: t.file_name, fileSize: t.file_size, mimeType: t.mime_type, expiresAt: t.expires_at
  });
}

// 下载：流式转发 R2 内容；下载结束后立即删除密文（接收即焚）
async function downloadTransfer(request, env, ctx, id) {
  const url = new URL(request.url);
  const token = url.searchParams.get('t') || '';
  const t = await getTransfer(env, id);
  if (!t) return err(404, 'not_found', '任务不存在');
  if (!token || token !== (t.download_token || '')) return err(403, 'bad_token', '下载凭证无效');
  if (await maybeExpire(env, t)) return err(410, 'expired', '文件已过期');
  if (t.status === 'completed') return err(410, 'already_received', '文件已被接收，云端副本已删除');
  if (!['ready', 'downloading'].includes(t.status)) return err(410, 'gone', '文件已不可下载');
  if (!t.r2_key) return err(404, 'not_found', '文件不存在');

  const obj = await env.BUCKET.get(t.r2_key);
  if (!obj) {
    await env.DB.prepare("UPDATE transfers SET status = 'expired' WHERE id = ?").bind(id).run();
    return err(404, 'not_found', '文件不存在');
  }

  await env.DB.prepare("UPDATE transfers SET status = 'downloading' WHERE id = ?").bind(id).run();

  const claimed = t.downloads;
  const its = new IdentityTransformStream();
  const finish = async () => {
    try {
      await obj.body.pipeTo(its.writable);
      // 下载结束 = 接收方完整收到密文：立即删除云端副本（接收即焚）
      await env.BUCKET.delete(t.r2_key);
      await env.DB.prepare("UPDATE transfers SET status = 'completed', r2_key = NULL, completed_at = ? WHERE id = ?")
        .bind(Date.now(), id).run();
    } catch {
      // 客户端中断下载：保留文件，等待重试或过期清理
      await env.DB.prepare("UPDATE transfers SET status = 'ready' WHERE id = ?").bind(id).run().catch(() => {});
    }
  };
  ctx.waitUntil(finish());

  return new Response(its.readable, {
    status: 200,
    headers: {
      'content-type': obj.httpMetadata?.contentType || t.mime_type || 'application/octet-stream',
      'content-length': String(obj.size),
      'content-disposition': contentDisposition(t.file_name),
      'cache-control': 'no-store',
      ...(t.encrypted ? { 'x-encrypted': 'FDENC1; use the transfer key from the share link to decrypt' } : {}),
      ...CORS_HEADERS
    }
  });
}

async function transferStatus(request, env, id) {
  const url = new URL(request.url);
  const t = await getTransfer(env, id);
  if (!t) return err(404, 'not_found', '任务不存在');
  if (url.searchParams.get('st') !== t.sender_token) return err(403, 'bad_token', '发送方凭证无效');
  return json({
    id: t.id, status: t.status, downloads: t.downloads, maxDownloads: t.max_downloads,
    fileName: t.file_name, fileSize: t.file_size, expiresAt: t.expires_at, completedAt: t.completed_at
  });
}

// 发送方主动撤销：立即删除云端文件
async function cancelTransfer(request, env, id) {
  const url = new URL(request.url);
  const t = await getTransfer(env, id);
  if (!t) return err(404, 'not_found', '任务不存在');
  if (url.searchParams.get('st') !== t.sender_token) return err(403, 'bad_token', '发送方凭证无效');
  try { if (t.upload_id && t.r2_key) await env.BUCKET.resumeMultipartUpload(t.r2_key, t.upload_id).abort(); } catch {}
  try { if (t.r2_key) await env.BUCKET.delete(t.r2_key); } catch {}
  await env.DB.prepare("UPDATE transfers SET status = 'canceled', r2_key = NULL WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

/* ---------------- Bing 每日壁纸 ---------------- */

/* ---------------- Bing 每日壁纸 ---------------- */

async function handleWallpaper() {
  try {
    const res = await fetch('https://bbab.net/api/bing/', {
      redirect: 'follow',
      cf: { cacheTtl: 43200, cacheEverything: true } // API 自身 12h 缓存，边缘直接命中
    });
    if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) {
      return err(404, 'wallpaper_unavailable', '壁纸暂不可用');
    }
    const final = (res.url || '').replace(/_UHD\.jpg/i, '_1920x1080.jpg');
    return Response.redirect(final || res.url, 302);
  } catch {
    return err(404, 'wallpaper_unavailable', '壁纸暂不可用');
  }
}

/* ---------------- 定时清理 ---------------- */

async function purgeExpired(env) {
  const now = Date.now();
  let n = 0;

  const rows = (await env.DB.prepare(
    "SELECT id, r2_key, upload_id FROM transfers WHERE status IN ('pending','ready','downloading') AND expires_at < ?"
  ).bind(now).all()).results;

  for (const r of rows) {
    try { if (r.upload_id && r.r2_key) await env.BUCKET.resumeMultipartUpload(r.r2_key, r.upload_id).abort(); } catch {}
    try { if (r.r2_key) await env.BUCKET.delete(r.r2_key); } catch {}
    await env.DB.prepare("UPDATE transfers SET status = 'expired' WHERE id = ?").bind(r.id).run();
    n++;
  }

  // 30 天前的历史记录仅保留统计意义，超期清除
  await env.DB.prepare("DELETE FROM transfers WHERE status IN ('completed','canceled','expired') AND created_at < ?")
    .bind(now - 30 * 86400000).run();
  return n;
}

/* ---------------- 管理后台登录 ---------------- */

const LOGIN_WINDOW_MS = 10 * 60 * 1000; // 失败计数窗口
const LOGIN_MAX_FAILS = 5;              // 窗口内最大失败次数
const SESSION_TTL_MS = 7 * 86400000;    // 会话有效期 7 天

async function adminLogin(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const now = Date.now();
  const row = await env.DB.prepare('SELECT count, window_start FROM login_attempts WHERE ip = ?').bind(ip).first();
  if (row && now - row.window_start < LOGIN_WINDOW_MS && row.count >= LOGIN_MAX_FAILS) {
    return err(429, 'too_many_attempts', '尝试次数过多，请 10 分钟后再试');
  }

  const body = await readJson(request);
  if (!isPasswordOk(String(body.password || ''), env)) {
    if (row && now - row.window_start < LOGIN_WINDOW_MS) {
      await env.DB.prepare('UPDATE login_attempts SET count = count + 1 WHERE ip = ?').bind(ip).run();
    } else {
      await env.DB.prepare(
        'INSERT INTO login_attempts (ip, count, window_start) VALUES (?1, 1, ?2) ' +
        'ON CONFLICT(ip) DO UPDATE SET count = 1, window_start = ?2'
      ).bind(ip, now).run();
    }
    return err(401, 'wrong_password', '密码错误');
  }

  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  const session = await makeSession(env.ADMIN_TOKEN, SESSION_TTL_MS);
  return json({ ok: true }, 200, {
    'set-cookie': `fd_admin=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  });
}

function adminLogout() {
  return json({ ok: true }, 200, {
    'set-cookie': 'fd_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'
  });
}

/* ---------------- 管理后台 API ---------------- */

async function handleAdmin(request, env, url, rest, m) {
  const [a] = rest;
  // 登录/注销在鉴权门之外（登录自身有失败次数限制）
  if (a === 'login' && m === 'POST') return adminLogin(request, env);
  if (a === 'logout' && m === 'POST') return adminLogout();
  if (!(await isAdmin(request, env))) return err(401, 'unauthorized', '未登录或凭据无效');
  const b = rest[1];

  if (a === 'overview' && m === 'GET') {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const stats = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM transfers WHERE status = 'ready') AS ready_count,
        (SELECT COUNT(*) FROM transfers WHERE status = 'pending') AS pending_count,
        (SELECT COALESCE(SUM(file_size), 0) FROM transfers WHERE status IN ('pending','ready','downloading')) AS storage_bytes,
        (SELECT COALESCE(SUM(file_size), 0) FROM transfers WHERE status = 'completed') AS delivered_bytes,
        (SELECT COUNT(*) FROM transfers WHERE created_at >= ?1) AS today_count,
        (SELECT COUNT(*) FROM transfers) AS total_count,
        (SELECT COUNT(*) FROM transfers WHERE status = 'completed') AS completed_count,
        (SELECT COUNT(*) FROM transfers WHERE status = 'expired') AS expired_count,
        (SELECT COUNT(*) FROM transfers WHERE status = 'canceled') AS canceled_count`
    ).bind(todayStart.getTime()).first();
    const recent = (await env.DB.prepare(
      'SELECT id, file_name, file_size, status, created_at, expires_at FROM transfers ORDER BY created_at DESC LIMIT 8'
    ).all()).results;
    return json({ stats, recent });
  }

  if (a === 'transfers') {
    if (!b && m === 'GET') {
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const size = clamp(Number(url.searchParams.get('size')) || 20, 5, 100);
      const status = url.searchParams.get('status') || '';
      const q = (url.searchParams.get('q') || '').trim();
      const where = []; const params = [];
      if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
      if (q) { where.push('(file_name LIKE ? OR claim_code LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = (await env.DB.prepare(`SELECT COUNT(*) AS c FROM transfers ${whereSql}`).bind(...params).first()).c;
      const items = (await env.DB.prepare(
        `SELECT id, kind, file_name, file_size, mime_type, encrypted, claim_code, status, downloads, max_downloads,
                expires_at, created_at, completed_at, sender_ip, sender_ua
         FROM transfers ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).bind(...params, size, (page - 1) * size).all()).results;
      for (const it of items) it.sender_ip = maskIp(it.sender_ip);
      return json({ items, total, page, size });
    }
    if (b && m === 'DELETE') {
      const t = await getTransfer(env, b);
      if (!t) return err(404, 'not_found', '任务不存在');
      try { if (t.upload_id && t.r2_key) await env.BUCKET.resumeMultipartUpload(t.r2_key, t.upload_id).abort(); } catch {}
      try { if (t.r2_key) await env.BUCKET.delete(t.r2_key); } catch {}
      await env.DB.prepare("UPDATE transfers SET status = 'canceled', r2_key = NULL WHERE id = ?").bind(b).run();
      return json({ ok: true });
    }
  }

  if (a === 'purge' && m === 'POST') {
    const n = await purgeExpired(env);
    return json({ purged: n });
  }

  if (a === 'api-keys') {
    if (!b && m === 'GET') {
      const items = (await env.DB.prepare(
        'SELECT key, name, created_at, last_used_at, requests, revoked FROM api_keys ORDER BY created_at DESC'
      ).all()).results;
      return json({ items });
    }
    if (!b && m === 'POST') {
      const body = await readJson(request);
      const key = 'fdk_' + randomHex(20);
      const name = String(body.name || '').trim().slice(0, 64) || '未命名应用';
      await env.DB.prepare('INSERT INTO api_keys (key, name, created_at) VALUES (?, ?, ?)')
        .bind(key, name, Date.now()).run();
      return json({ key, name, createdAt: Date.now() }, 201);
    }
    if (b && m === 'DELETE') {
      await env.DB.prepare('UPDATE api_keys SET revoked = 1 WHERE key = ?').bind(b).run();
      return json({ ok: true });
    }
  }

  if (a === 'settings') {
    if (m === 'GET') return json(await getSettings(env.DB));
    if (m === 'PUT') {
      const body = await readJson(request);
      for (const [k, v] of Object.entries(body)) {
        if (!SETTING_KEYS.includes(k)) continue;
        await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .bind(k, String(v).slice(0, 50)).run();
      }
      return json(await getSettings(env.DB));
    }
  }

  return err(404, 'not_found', '接口不存在');
}
