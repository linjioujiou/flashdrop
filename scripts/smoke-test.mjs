// 本地接口冒烟测试：先启动 npx wrangler dev，再执行 node scripts/smoke-test.mjs
const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN = process.env.ADMIN || 'dev-token-12345';

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

// 4. 端到端加密：客户端加密 → 上传密文 → 下载 → 解密验证（FDENC1 容器）
{
  const te = new TextEncoder();
  const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const magic = te.encode('FDENC1');
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

  const plain1 = te.encode('Hello E2E! ');
  const plain2 = te.encode('第二段加密内容 secret-02');
  const metaPlain = te.encode(JSON.stringify({ n: 'secret-密件.txt', m: 'text/plain', s: plain1.length + plain2.length }));
  const frames = [];
  let iv = crypto.getRandomValues(new Uint8Array(12));
  frames.push([iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: u32le(0) }, key, metaPlain))]);
  for (const [idx, p] of [[1, plain1], [2, plain2]]) {
    iv = crypto.getRandomValues(new Uint8Array(12));
    frames.push([iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: u32le(idx) }, key, p))]);
  }
  let total = magic.length;
  for (const [a, b] of frames) total += 4 + a.length + b.length;
  const payload = new Uint8Array(total);
  payload.set(magic, 0);
  let off = magic.length;
  for (const [a, b] of frames) {
    new DataView(payload.buffer).setUint32(off, b.length, true); off += 4;
    payload.set(a, off); off += a.length;
    payload.set(b, off); off += b.length;
  }

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
  ok('下载密文字节一致', cipher.length === payload.length && cipher[0] === 70 /* F */);

  let o = magic.length, idx = 0, meta = null;
  const parts = [];
  while (o + 4 <= cipher.length) {
    const len = new DataView(cipher.buffer).getUint32(o, true); o += 4;
    const ivv = cipher.subarray(o, o + 12); o += 12;
    const ct = cipher.subarray(o, o + len); o += len;
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivv, additionalData: u32le(idx) }, key, ct));
    if (idx === 0) meta = JSON.parse(new TextDecoder().decode(pt)); else parts.push(pt);
    idx++;
  }
  const joined = new TextDecoder().decode(new Uint8Array([...parts[0], ...parts[1]]));
  ok('解密元数据完整', meta && meta.n === 'secret-密件.txt' && meta.s === plain1.length + plain2.length);
  ok('解密内容一致', joined === 'Hello E2E! 第二段加密内容 secret-02');

  const st = await j('GET', `/api/v1/transfers/${id}/status?st=${senderToken}`);
  ok('加密任务下载后自动删除', st.data.status === 'completed');
}

// 5. 分块上传（20MB / 8MB = 3 块）
{
  const size = 20 * 1024 * 1024;
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) buf[i] = i % 251;

  const create = await j('POST', '/api/v1/transfers', { fileName: 'big.bin', fileSize: size, mimeType: 'application/octet-stream' });
  const { id, claimCode, senderToken, partUrl, completeUrl } = create.data;
  const chunkSize = create.data.chunkSize;
  const parts = Math.ceil(size / chunkSize);
  let allOk = true;
  for (let n = 1; n <= parts; n++) {
    const chunk = buf.slice((n - 1) * chunkSize, Math.min(n * chunkSize, size));
    const r = await fetch(BASE + partUrl.replace('{n}', String(n)), { method: 'PUT', body: chunk });
    if (r.status !== 200) allOk = false;
  }
  ok(`分块上传 ${parts} 块`, allOk);

  const comp = await j('POST', completeUrl, { totalParts: parts });
  ok('分块合并完成', comp.status === 200 && comp.data.size === size, JSON.stringify(comp.data));

  const acc = await j('POST', `/api/v1/transfers/${id}/accept`, { code: claimCode });
  const dl = await fetch(BASE + acc.data.downloadUrl);
  const got = new Uint8Array(await dl.arrayBuffer());
  ok('分块下载内容一致', got.length === size && got[0] === 0 && got[4096] === 4096 % 251 && got[size - 1] === 0, `len=${got.length}`);

  const st = await j('GET', `/api/v1/transfers/${id}/status?st=${senderToken}`);
  ok('分块任务状态 = completed', st.data.status === 'completed');
}

// 3. 撤销任务 → 立即删除
{
  const create = await j('POST', '/api/v1/transfers', { fileName: 'cancel.txt', fileSize: 5, mimeType: 'text/plain' });
  const { id, senderToken, uploadUrl } = create.data;
  await fetch(BASE + uploadUrl, { method: 'PUT', body: '12345' });
  const del = await j('DELETE', `/api/v1/transfers/${id}?st=${senderToken}`);
  ok('撤销任务', del.status === 200);
  const lookup = await j('GET', `/api/v1/transfers?code=${create.data.claimCode}`);
  ok('撤销后查询 → 410', lookup.status === 410, String(lookup.status));
}

// 4. P2P 房间
{
  const room = await j('POST', '/api/v1/p2p/rooms');
  ok('创建 P2P 房间', room.status === 201 && /^[A-Z0-9]{6}$/.test(room.data.code));
  const lookup = await j('GET', `/api/v1/transfers?code=${room.data.code}`);
  ok('P2P 配对码查询 kind=p2p', lookup.status === 200 && lookup.data.kind === 'p2p');

  if (typeof WebSocket !== 'undefined') {
    await new Promise((resolve) => {
      const wsBase = BASE.replace('http', 'ws');
      const a = new WebSocket(`${wsBase}/api/v1/signal?room=${room.data.code}&role=sender`);
      let b = null;
      let done = false;
      const finish = (nameOk) => {
        if (done) return;
        done = true;
        ok('信令转发 sender→receiver', nameOk);
        try { a.close(); } catch {}
        try { b && b.close(); } catch {}
        resolve();
      };
      a.onopen = () => {
        // onmessage 必须在 open 之前挂好，避免漏掉第一条转发
        b = new WebSocket(`${wsBase}/api/v1/signal?room=${room.data.code}&role=receiver`);
        b.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.type === 'sdp' && m.data && m.data.test === 1) finish(true);
        };
      };
      a.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'peer-joined') {
          a.send(JSON.stringify({ type: 'sdp', data: { test: 1 } }));
        }
      };
      a.onerror = () => finish(false);
      setTimeout(() => finish(false), 8000);
    });
  } else {
    console.log('  - 当前 Node 无 WebSocket 全局对象，跳过信令转发测试');
  }
}

// 5. 管理接口
{
  const r1 = await j('GET', '/api/v1/admin/overview', null, { authorization: `Bearer ${ADMIN}` });
  ok('admin/overview', r1.status === 200 && 'stats' in r1.data, JSON.stringify(r1.data).slice(0, 120));

  const r2 = await j('GET', '/api/v1/admin/transfers?page=1&size=5', null, { authorization: `Bearer ${ADMIN}` });
  ok('admin/transfers', r2.status === 200 && Array.isArray(r2.data.items));

  const k = await j('POST', '/api/v1/admin/api-keys', { name: 'smoke-test' }, { authorization: `Bearer ${ADMIN}` });
  ok('创建 API 密钥', k.status === 201 && k.data.key.startsWith('fdk_'));

  const unauth = await j('GET', '/api/v1/admin/overview', null, { authorization: 'Bearer wrong' });
  ok('错误令牌 → 401', unauth.status === 401);

  const s = await j('PUT', '/api/v1/admin/settings', { default_ttl_hours: 48 }, { authorization: `Bearer ${ADMIN}` });
  ok('保存设置', s.status === 200 && s.data.default_ttl_hours === '48');
  await j('PUT', '/api/v1/admin/settings', { default_ttl_hours: 24 }, { authorization: `Bearer ${ADMIN}` });
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
