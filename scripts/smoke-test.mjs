// 本地接口冒烟测试：先启动 npx wrangler dev，再执行 node scripts/smoke-test.mjs
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8787';
// Bearer 用 ADMIN_TOKEN，网页登录用 ADMIN_PASSWORD；环境变量优先，否则自动读本地 .dev.vars
let ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
let ADMIN = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_TOKEN || !ADMIN) {
  try {
    const vars = fs.readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    if (!ADMIN_TOKEN) ADMIN_TOKEN = (vars.match(/^ADMIN_TOKEN=(.*)$/m) || [])[1]?.trim() || '';
    if (!ADMIN) ADMIN = (vars.match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1]?.trim()
      || (vars.match(/^ADMIN_TOKEN=(.*)$/m) || [])[1]?.trim() || '';
  } catch {}
}
if (!ADMIN_TOKEN) ADMIN_TOKEN = 'dev-token-12345';
if (!ADMIN) ADMIN = ADMIN_TOKEN;

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
};

async function j(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}

console.log(`闪传 FlashDrop 冒烟测试 → ${BASE}\n`);

// 0. 健康检查
{
  const r = await j('GET', '/api/v1/config');
  ok('GET /api/v1/config', r.status === 200 && r.data.maxFileMb > 0, JSON.stringify(r.data));
}

// 1. 小文件：创建 → 单请求上传 → 查询 → 接收 → 下载 → 自动删除
{
  const create = await j('POST', '/api/v1/transfers', { fileName: '你好.txt', fileSize: 11, mimeType: 'text/plain' });
  ok('创建中转任务 (201)', create.status === 201 && /^[A-Z0-9]{6}$/.test(create.data.claimCode), JSON.stringify(create.data));

  const { id, claimCode, senderToken, uploadUrl } = create.data;
  const up = await fetch(BASE + uploadUrl, { method: 'PUT', body: 'hello world' });
  ok('单请求上传 (200)', up.status === 200, String(up.status));

  const lookup = await j('GET', `/api/v1/transfers?code=${claimCode}`);
  ok('取件码查询 kind=relay', lookup.status === 200 && lookup.data.kind === 'relay' && lookup.data.transfer.fileName === '你好.txt');

  const acc = await j('POST', `/api/v1/transfers/${id}/accept`, { code: claimCode });
  ok('accept 换发下载凭证', acc.status === 200 && acc.data.downloadToken, JSON.stringify(acc.data));

  const dl = await fetch(BASE + acc.data.downloadUrl);
  const text = await dl.text();
  ok('下载内容一致', dl.status === 200 && text === 'hello world', JSON.stringify(text));

  const again = await fetch(BASE + acc.data.downloadUrl);
  ok('一次性接收后再次下载 → 410', again.status === 410, String(again.status));

  const st = await j('GET', `/api/v1/transfers/${id}/status?st=${senderToken}`);
  ok('状态 = completed', st.data.status === 'completed', JSON.stringify(st.data));
}

// 2. 端到端加密：客户端加密 → 上传密文 → 下载 → 解密验证（FDENC1 容器）
{
  const te = new TextEncoder();
  const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const magic = te.encode('FDENC1');
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

  const plain1 = te.encode('Hello E2E! ');
  const plain2 = te.encode('第二段加密内容 secret-02');
  const metaPlain = te.encode(JSON.stringify({ n: 'secret-密件.txt', m: 'text/plain', s: plain1.length + plain2.length }));
  // 新布局：数据帧（AAD=1..N）在前，元数据帧（AAD=0）在最后
  const frames = [];
  for (const [idx, p] of [[1, plain1], [2, plain2]]) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    frames.push([iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: u32le(idx) }, key, p))]);
  }
  let iv = crypto.getRandomValues(new Uint8Array(12));
  frames.push([iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: u32le(0) }, key, metaPlain))]);
  let total = frames.length * 4;
  for (const [a, b] of frames) total += a.length + b.length;
  total += magic.length; // 容器末尾的魔数
  const payload = new Uint8Array(total);
  let off = 0;
  for (const [a, b] of frames) {
    new DataView(payload.buffer).setUint32(off, b.length, true); off += 4;
    payload.set(a, off); off += a.length;
    payload.set(b, off); off += b.length;
  }
  payload.set(magic, off);

  payload.set(magic, payload.length - magic.length); // 魔数在容器末尾
  const create = await j('POST', '/api/v1/transfers', { fileName: 'encrypted.fdenc', fileSize: payload.length, mimeType: 'application/octet-stream', encrypted: true });
  ok('创建加密任务 (201)', create.status === 201 && create.data.encrypted === true);
  const { id, claimCode, senderToken, uploadUrl } = create.data;
  const up = await fetch(BASE + uploadUrl, { method: 'PUT', body: payload });
  ok('上传密文', up.status === 200);

  const lookup = await j('GET', `/api/v1/transfers?code=${claimCode}`);
  ok('查询标记 encrypted=true', lookup.status === 200 && lookup.data.transfer.encrypted === true);

  const acc = await j('POST', `/api/v1/transfers/${id}/accept`, { code: claimCode });
  const dl = await fetch(BASE + acc.data.downloadUrl);
  const cipher = new Uint8Array(await dl.arrayBuffer());
  ok('下载密文字节一致', cipher.length === payload.length && magic.every((b, i) => cipher[cipher.length - magic.length + i] === b));

  const bodyEnd = cipher.length - magic.length;
  if (bodyEnd < 10 || !magic.every((b, i) => cipher[bodyEnd + i] === b)) throw new Error('bad_container');
  let o = 0, idx = 0, meta = null;
  const parts = [];
  const totalFrames = 3;
  while (o + 4 <= bodyEnd) {
    const len = new DataView(cipher.buffer).getUint32(o, true); o += 4;
    const ivv = cipher.subarray(o, o + 12); o += 12;
    const ct = cipher.subarray(o, o + len); o += len;
    const aad = u32le(idx === totalFrames - 1 ? 0 : idx + 1); // 末帧=元数据(AAD 0)
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivv, additionalData: aad }, key, ct));
    if (idx === totalFrames - 1) meta = JSON.parse(new TextDecoder().decode(pt)); else parts.push(pt);
    idx++;
  }
  const joined = new TextDecoder().decode(new Uint8Array([...parts[0], ...parts[1]]));
  ok('解密元数据完整', meta && meta.n === 'secret-密件.txt' && meta.s === plain1.length + plain2.length);
  ok('解密内容一致', joined === 'Hello E2E! 第二段加密内容 secret-02');

  const st = await j('GET', `/api/v1/transfers/${id}/status?st=${senderToken}`);
  ok('加密任务下载后自动删除', st.data.status === 'completed');
}

// 3. 分块上传（20MB / 8MB = 3 块）
{
  const size = 20 * 1024 * 1024;
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) buf[i] = i % 251;

  const create = await j('POST', '/api/v1/transfers', { fileName: 'big.bin', fileSize: size, mimeType: 'application/octet-stream' });
  const { id, claimCode, senderToken, partUrl, completeUrl } = create.data;
  const chunkSize = create.data.chunkSize;
  const parts = Math.ceil(size / chunkSize);
  // 乱序上传（并发分片安全：服务端按块号去重排序）
  const order = Array.from({ length: parts }, (_, i) => i + 1).reverse();
  let allOk = true;
  for (const n of order) {
    const chunk = buf.slice((n - 1) * chunkSize, Math.min(n * chunkSize, size));
    const r = await fetch(BASE + partUrl.replace('{n}', String(n)), { method: 'PUT', body: chunk });
    if (r.status !== 200) allOk = false;
  }
  ok(`乱序分块上传 ${parts} 块`, allOk);

  const comp = await j('POST', completeUrl, { totalParts: parts });
  ok('分块合并完成', comp.status === 200 && comp.data.size === size, JSON.stringify(comp.data));

  const acc = await j('POST', `/api/v1/transfers/${id}/accept`, { code: claimCode });
  const dl = await fetch(BASE + acc.data.downloadUrl);
  const got = new Uint8Array(await dl.arrayBuffer());
  ok('分块下载内容一致', got.length === size && got[0] === 0 && got[4096] === 4096 % 251 && got[size - 1] === 0, `len=${got.length}`);

  const st = await j('GET', `/api/v1/transfers/${id}/status?st=${senderToken}`);
  ok('分块任务状态 = completed', st.data.status === 'completed');
}

// 4. 撤销任务 → 立即删除
{
  const create = await j('POST', '/api/v1/transfers', { fileName: 'cancel.txt', fileSize: 5, mimeType: 'text/plain' });
  const { id, senderToken, uploadUrl } = create.data;
  await fetch(BASE + uploadUrl, { method: 'PUT', body: '12345' });
  const del = await j('DELETE', `/api/v1/transfers/${id}?st=${senderToken}`);
  ok('撤销任务', del.status === 200);
  const lookup = await j('GET', `/api/v1/transfers?code=${create.data.claimCode}`);
  ok('撤销后查询 → 410', lookup.status === 410, String(lookup.status));
}

// 5. 管理接口
{
  const r1 = await j('GET', '/api/v1/admin/overview', null, { authorization: `Bearer ${ADMIN_TOKEN}` });
  ok('admin/overview', r1.status === 200 && 'stats' in r1.data, JSON.stringify(r1.data).slice(0, 120));

  const r2 = await j('GET', '/api/v1/admin/transfers?page=1&size=5', null, { authorization: `Bearer ${ADMIN_TOKEN}` });
  ok('admin/transfers', r2.status === 200 && Array.isArray(r2.data.items));

  // 密码登录 → 会话 Cookie
  const badLogin = await j('POST', '/api/v1/admin/login', { password: 'wrong-password-001' });
  ok('错误密码 → 401', badLogin.status === 401);
  const login = await fetch(BASE + '/api/v1/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD || ADMIN })
  });
  const cookie = (login.headers.get('set-cookie') || '').match(/fd_admin=[^;]+/);
  ok('密码登录签发会话 Cookie', login.status === 200 && !!cookie);
  const me = await fetch(BASE + '/api/v1/admin/overview', { headers: { cookie: cookie ? cookie[0] : '' } });
  ok('Cookie 会话访问管理接口', me.status === 200);

  const k = await j('POST', '/api/v1/admin/api-keys', { name: 'smoke-test' }, { authorization: `Bearer ${ADMIN_TOKEN}` });
  ok('创建 API 密钥', k.status === 201 && k.data.key.startsWith('fdk_'));

  const unauth = await j('GET', '/api/v1/admin/overview', null, { authorization: 'Bearer wrong' });
  ok('错误令牌 → 401', unauth.status === 401);

  const s = await j('PUT', '/api/v1/admin/settings', { default_ttl_hours: 48 }, { authorization: `Bearer ${ADMIN_TOKEN}` });
  ok('保存设置', s.status === 200 && s.data.default_ttl_hours === '48');
  await j('PUT', '/api/v1/admin/settings', { default_ttl_hours: 24 }, { authorization: `Bearer ${ADMIN_TOKEN}` });
}

// 6. 定时清理（需 wrangler dev --test-scheduled）
{
  try {
    const r = await fetch(BASE + '/__scheduled?cron=0+*+*+*+*');
    ok('触发 scheduled 清理', r.status === 200 || r.status === 204, String(r.status));
  } catch {
    console.log('  - 未启用 --test-scheduled，跳过定时任务触发测试');
  }
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
