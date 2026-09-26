// 闪传 FlashDrop — 前端逻辑（发送：P2P / 云端中转；接收）
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);

  /* ---------- 通用工具 ---------- */

  const fmtBytes = (n) => {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
  };

  const fmtTime = (ts) => {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    const pad = (x) => String(x).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const fmtRemain = (ts) => {
    const ms = Number(ts) - Date.now();
    if (ms <= 0) return '已过期';
    const h = ms / 3600000;
    if (h >= 1) return `剩余约 ${Math.floor(h)} 小时`;
    return `剩余约 ${Math.max(1, Math.floor(ms / 60000))} 分钟`;
  };

  const fileIcon = (name, mime) => {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if ((mime || '').startsWith('image/')) return '🖼️';
    if ((mime || '').startsWith('video/')) return '🎬';
    if ((mime || '').startsWith('audio/')) return '🎵';
    if (ext === 'pdf') return '📕';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜️';
    if (['doc', 'docx', 'pages'].includes(ext)) return '📄';
    if (['xls', 'xlsx', 'numbers', 'csv'].includes(ext)) return '📊';
    if (['ppt', 'pptx', 'key'].includes(ext)) return '📽️';
    if (['apk', 'dmg', 'exe', 'msi', 'ipa'].includes(ext)) return '📦';
    return '📄';
  };

  /* ---------- 端到端加密（FDENC1 容器，AES-256-GCM） ----------
     密钥只在浏览器生成，通过链接 #k= 片段或「取件码-密钥」传递，服务器永不可见。
     容器: "FDENC1" + N × [4字节LE帧长][12字节IV][密文(含GCM标签)]
     帧 0 = 元数据 JSON {n:文件名, m:MIME, s:大小}；帧 1..N = 4MB 内容分块；AAD = 帧序号 */

  const b64urlEncode = (bytes) => {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const b64urlDecode = (str) => {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const E2E_MAGIC = new TextEncoder().encode('FDENC1');
  const E2E_CHUNK = 4 * 1024 * 1024;

  async function e2eEncrypt(file) {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    const enc = new TextEncoder();
    const frames = [];
    const metaPlain = enc.encode(JSON.stringify({ n: file.name, m: file.type || 'application/octet-stream', s: file.size }));
    const metaIv = crypto.getRandomValues(new Uint8Array(12));
    const metaCipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: metaIv, additionalData: u32le(0) }, key, metaPlain));
    frames.push([metaIv, metaCipher]);
    for (let i = 0, idx = 1; i < file.size; i += E2E_CHUNK, idx++) {
      const plain = new Uint8Array(await file.slice(i, Math.min(i + E2E_CHUNK, file.size)).arrayBuffer());
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: u32le(idx) }, key, plain));
      frames.push([iv, cipher]);
    }
    let total = E2E_MAGIC.length;
    for (const [iv, c] of frames) total += 4 + iv.length + c.length;
    const out = new Uint8Array(total);
    out.set(E2E_MAGIC, 0);
    let off = E2E_MAGIC.length;
    for (const [iv, c] of frames) {
      new DataView(out.buffer).setUint32(off, c.length, true); off += 4;
      out.set(iv, off); off += iv.length;
      out.set(c, off); off += c.length;
    }
    return { blob: new Blob([out], { type: 'application/octet-stream' }), keyB64: b64urlEncode(rawKey) };
  }

  async function e2eDecrypt(blob, keyB64) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (buf.length < E2E_MAGIC.length || !E2E_MAGIC.every((b, i) => buf[i] === b)) throw new Error('bad_container');
    const key = await crypto.subtle.importKey('raw', b64urlDecode(keyB64), { name: 'AES-GCM' }, false, ['decrypt']);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let off = E2E_MAGIC.length, idx = 0, meta = null;
    const parts = [];
    while (off + 4 <= buf.length) {
      const len = dv.getUint32(off, true); off += 4;
      if (off + 12 + len > buf.length) throw new Error('bad_container');
      const iv = buf.subarray(off, off + 12); off += 12;
      const cipher = buf.subarray(off, off + len); off += len;
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: u32le(idx) }, key, cipher));
      if (idx === 0) meta = JSON.parse(new TextDecoder().decode(plain));
      else parts.push(plain);
      idx++;
    }
    if (!meta) throw new Error('bad_container');
    return { meta, blob: new Blob(parts, { type: meta.m || 'application/octet-stream' }) };
  }

  function toast(msg, type = '') {
    const root = $('#toast-root');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2600);
    setTimeout(() => el.remove(), 3000);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const e = new Error((data && data.error && data.error.message) || `请求失败 (HTTP ${res.status})`);
      e.status = res.status;
      e.code = data && data.error && data.error.code;
      throw e;
    }
    return data;
  }

  function renderQr(el, text) {
    if (!el) return;
    try {
      if (typeof qrcode === 'function') {
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        el.classList.remove('hidden');
        return;
      }
    } catch {}
    el.classList.add('hidden'); // CDN 不可用时仅展示文字取件码
  }

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name || 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  function xhrSend(url, method, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      if (onProgress) {
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      }
      xhr.onload = () => (xhr.status < 300 ? resolve(xhr) : reject(new Error('上传失败 (HTTP ' + xhr.status + ')')));
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(blob);
    });
  }

  /* ---------- 页面状态 ---------- */

  const S = {
    tab: 'send',
    file: null,
    relay: null, // 中转任务 {id, claimCode, senderToken, ...}
    p2pSend: { ws: null, pc: null, dc: null, code: '' },
    recv: {
      code: '', kind: null, info: null, token: null, blob: null,
      ws: null, pc: null, dc: null, chunks: [], bytes: 0, meta: null, key: ''
    }
  };

  const show = (id) => {
    document.querySelectorAll('#view-send .step, #view-recv .step').forEach((el) => el.classList.add('hidden'));
    const el = $(id);
    if (el) el.classList.remove('hidden');
  };

  const setBar = (barEl, pctEl, ratio, statusEl, status) => {
    if (barEl) barEl.style.width = Math.min(100, Math.max(0, ratio * 100)).toFixed(1) + '%';
    if (pctEl) pctEl.textContent = Math.floor(Math.min(100, Math.max(0, ratio * 100))) + '%';
    if (statusEl && status) statusEl.textContent = status;
  };

  const chipHtml = (name, size, mime) =>
    `<span class="fc-icon">${fileIcon(name, mime)}</span>
     <span><span class="fc-name"></span><div class="fc-size">${fmtBytes(size)}</div></span>`;
  const setChip = (el, name, size, mime) => {
    if (el) { el.innerHTML = chipHtml(name, size, mime); el.querySelector('.fc-name').textContent = name; }
  };

  /* ---------- 标签页切换 ---------- */

  function switchTab(tab) {
    S.tab = tab;
    document.querySelectorAll('#seg-tabs .seg').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('#view-send').classList.toggle('hidden', tab !== 'send');
    $('#view-recv').classList.toggle('hidden', tab !== 'recv');
  }

  document.querySelectorAll('#seg-tabs .seg').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  /* ---------- 发送：选择文件 ---------- */

  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  let maxFileMb = 2048;

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  ['dragover', 'dragenter'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) pickFile(f);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) pickFile(fileInput.files[0]); fileInput.value = ''; });

  function pickFile(f) {
    if (f.size > maxFileMb * 1048576) {
      toast(`文件超过上限 ${fmtBytes(maxFileMb * 1048576)}`, 'error');
      return;
    }
    S.file = f;
    setChip($('#send-file-chip'), f.name, f.size, f.type);
    setChip($('#send-file-chip2'), f.name, f.size, f.type);
    show('#send-mode');
  }

  $('#btn-repick').addEventListener('click', () => { S.file = null; show('#send-pick'); });
  $('#btn-send-cancel').addEventListener('click', () => { S.file = null; show('#send-pick'); });
  $('#btn-send-again').addEventListener('click', () => { S.file = null; show('#send-pick'); });

  /* ---------- 发送：云端中转 ---------- */

  $('#opt-relay').addEventListener('click', () => { if (S.file) startRelaySend(S.file, $('#opt-e2e').checked).catch(onFlowError); });

  async function startRelaySend(file, encrypt) {
    show('#send-progress');
    setBar($('#send-bar'), $('#send-percent'), 0, $('#send-status'), '准备中…');

    let payload = file;
    let keyB64 = null;
    if (encrypt) {
      setBar($('#send-bar'), $('#send-percent'), 0, $('#send-status'), '正在端到端加密…');
      const r = await e2eEncrypt(file);
      payload = r.blob;
      keyB64 = r.keyB64;
    }

    const created = await api('/api/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: keyB64 ? 'encrypted.fdenc' : file.name,
        fileSize: payload.size,
        mimeType: 'application/octet-stream',
        encrypted: !!keyB64
      })
    });
    S.relay = { ...created, keyB64 };

    const chunkSize = created.chunkSize || 8 * 1048576;
    let uploaded = 0;
    const onPart = (loaded, total) =>
      setBar($('#send-bar'), $('#send-percent'), (uploaded + loaded) / payload.size, $('#send-status'), '正在上传…');

    if (payload.size > chunkSize) {
      const totalParts = Math.ceil(payload.size / chunkSize);
      for (let n = 1; n <= totalParts; n++) {
        const blob = payload.slice((n - 1) * chunkSize, Math.min(n * chunkSize, payload.size));
        let lastErr;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { await xhrSend(created.partUrl.replace('{n}', String(n)), 'PUT', blob, onPart); lastErr = null; break; }
          catch (e) { lastErr = e; }
        }
        if (lastErr) throw lastErr;
        uploaded += blob.size;
        setBar($('#send-bar'), $('#send-percent'), uploaded / payload.size, $('#send-status'), '正在上传…');
      }
      await api(created.completeUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ totalParts })
      });
    } else {
      await xhrSend(created.uploadUrl, 'PUT', payload, onPart);
    }

    showRelayResult(created, file, keyB64);
  }

  function showRelayResult(created, file, keyB64) {
    setChip($('#relay-file-chip'), file.name, file.size, file.type);
    const codeEl = $('#relay-code');
    const fullCode = keyB64 ? `${created.claimCode}-${keyB64}` : created.claimCode;
    codeEl.textContent = fullCode;
    codeEl.classList.toggle('long', !!keyB64);
    $('#relay-code-label').textContent = keyB64 ? '完整取件码（取件码-密钥）' : '取件码（6 位）';
    $('#btn-copy-code').textContent = keyB64 ? '复制完整取件码（含密钥）' : '复制取件码';
    const link = `${location.origin}/r/${created.claimCode}${keyB64 ? `#k=${keyB64}` : ''}`;
    $('#relay-link').value = link;
    $('#relay-expiry').textContent = `有效期至 ${fmtTime(created.expiresAt)}（${fmtRemain(created.expiresAt)}）· ` +
      (keyB64 ? '端到端加密：服务器仅存密文，密钥只存在于链接中' : '接收完成后云端文件自动删除');
    renderQr($('#relay-qr'), link);
    show('#send-relay-result');
  }

  $('#btn-copy-code').addEventListener('click', async () => {
    if (!S.relay) return;
    const text = S.relay.keyB64 ? `${S.relay.claimCode}-${S.relay.keyB64}` : S.relay.claimCode;
    if (await copyText(text)) toast(S.relay.keyB64 ? '完整取件码已复制（含密钥）' : '取件码已复制', 'success');
  });
  $('#btn-copy-link').addEventListener('click', async () => {
    if (await copyText($('#relay-link').value)) toast('链接已复制', 'success');
  });
  $('#btn-relay-again').addEventListener('click', () => { S.relay = null; S.file = null; show('#send-pick'); });
  $('#btn-relay-undo').addEventListener('click', async () => {
    if (!S.relay) return;
    try {
      await api(`/api/v1/transfers/${S.relay.id}?st=${S.relay.senderToken}`, { method: 'DELETE' });
      toast('已撤销，云端文件已删除', 'success');
    } catch (e) { toast(e.message, 'error'); }
    S.relay = null; S.file = null; show('#send-pick');
  });

  /* ---------- 发送：P2P 实时直传 ---------- */

  const RTC_CFG = {
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }]
  };

  $('#opt-p2p').addEventListener('click', () => { if (S.file) startP2PSend(S.file).catch(onFlowError); });

  function wsUrl(code, role) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/v1/signal?room=${encodeURIComponent(code)}&role=${role}`;
  }

  async function startP2PSend(file) {
    const room = await api('/api/v1/p2p/rooms', { method: 'POST' });
    S.p2pSend = { ws: null, pc: null, dc: null, code: room.code };
    $('#p2p-code').textContent = room.code;
    $('#p2p-waiting').classList.remove('hidden');
    $('#p2p-send-progress-wrap').classList.add('hidden');
    $('#p2p-send-meta').classList.add('hidden');
    renderQr($('#p2p-qr'), room.roomUrl || `${location.origin}/?code=${room.code}`);
    show('#send-p2p-room');

    const ws = new WebSocket(wsUrl(room.code, 'sender'));
    S.p2pSend.ws = ws;
    S.p2pSend.finished = false;
    // 经信令上报文件元信息（管理后台展示；同时也会转发给接收端）
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: 'meta', fileName: file.name, fileSize: file.size, mime: file.type || 'application/octet-stream' }));
      } catch {}
    };

    ws.onmessage = async (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'peer-joined') {
        $('#p2p-waiting').classList.add('hidden');
        $('#p2p-send-status') && ($('#p2p-send-status').textContent = '已连接，正在建立直连通道…');
        $('#p2p-send-progress-wrap').classList.remove('hidden');
        $('#p2p-send-meta').classList.remove('hidden');
        setBar($('#p2p-send-bar'), $('#p2p-send-percent'), 0, $('#p2p-send-status'), '正在建立直连通道…');
        await setupSenderPeer(file);
      } else if (m.type === 'sdp') {
        try { await S.p2pSend.pc.setRemoteDescription(m.data); } catch (e) { console.error(e); }
      } else if (m.type === 'ice') {
        try { await S.p2pSend.pc.addIceCandidate(m.data); } catch {}
      } else if (m.type === 'transfer-done') {
        S.p2pSend.finished = true;
        setBar($('#p2p-send-bar'), $('#p2p-send-percent'), 1, $('#p2p-send-status'), '对方已接收');
        cleanupP2P();
        show('#send-done');
      } else if (m.type === 'peer-left') {
        if (S.p2pSend.finished) return;
        toast('对方已断开', 'error');
        resetSend();
      }
    };
    ws.onerror = () => { toast('信令连接失败', 'error'); resetSend(); };
  }

  async function setupSenderPeer(file) {
    const pc = new RTCPeerConnection(RTC_CFG);
    S.p2pSend.pc = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate && S.p2pSend.ws && S.p2pSend.ws.readyState === 1) {
        S.p2pSend.ws.send(JSON.stringify({ type: 'ice', data: e.candidate.toJSON() }));
      }
    };
    const dc = pc.createDataChannel('file', { ordered: true });
    S.p2pSend.dc = dc;

    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 512 * 1024;
    // 接收端通过 DataChannel 回传完成确认
    dc.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'transfer-done') {
      S.p2pSend.finished = true;
      setBar($('#p2p-send-bar'), $('#p2p-send-percent'), 1, $('#p2p-send-status'), '对方已接收');
      cleanupP2P();
      show('#send-done');
    }
    };
    dc.onopen = () => {
      dc.send(JSON.stringify({ type: 'meta', fileName: file.name, fileSize: file.size, mime: file.type || 'application/octet-stream' }));
      pump(file);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    S.p2pSend.ws.send(JSON.stringify({ type: 'sdp', data: pc.localDescription.toJSON() }));
  }

  async function pump(file) {
    const dc = S.p2pSend.dc;
    const CHUNK = 64 * 1024;
    const HIGH = 4 * 1024 * 1024;
    let offset = 0;
    let lastTs = performance.now();
    let lastBytes = 0;

    while (offset < file.size) {
      if (dc.readyState !== 'open') return;
      if (dc.bufferedAmount > HIGH) {
        await new Promise((r) => dc.addEventListener('bufferedamountlow', r, { once: true }));
        if (dc.readyState !== 'open') return;
      }
      const slice = file.slice(offset, Math.min(offset + CHUNK, file.size));
      const buf = await slice.arrayBuffer();
      dc.send(buf);
      offset += buf.byteLength;

      const now = performance.now();
      if (now - lastTs > 200) {
        const speed = (offset - lastBytes) / ((now - lastTs) / 1000);
        lastTs = now; lastBytes = offset;
        setBar($('#p2p-send-bar'), $('#p2p-send-percent'), offset / file.size,
          $('#p2p-send-status'), `直传中 · ${fmtBytes(speed)}/s`);
      }
    }
    setBar($('#p2p-send-bar'), $('#p2p-send-percent'), 1, $('#p2p-send-status'), '发送完成，等待对方确认…');
    dc.send(JSON.stringify({ type: 'file-end' }));
  }

  $('#btn-p2p-cancel').addEventListener('click', () => { cleanupP2P(); resetSend(); });
  function cleanupP2P() {
    try { S.p2pSend.dc && S.p2pSend.dc.close(); } catch {}
    try { S.p2pSend.pc && S.p2pSend.pc.close(); } catch {}
    try { S.p2pSend.ws && S.p2pSend.ws.close(); } catch {}
    S.p2pSend = { ws: null, pc: null, dc: null, code: '', finished: false };
  }
  function resetSend() { S.file = null; S.relay = null; show('#send-pick'); }

  function onFlowError(e) {
    console.error(e);
    toast(e.message || '出错了，请重试', 'error');
    resetSend();
  }

  /* ---------- 接收 ---------- */

  const recvInput = $('#recv-input');
  recvInput.addEventListener('input', () => { recvInput.value = recvInput.value.replace(/[^A-Za-z0-9\-_]/g, ''); });
  recvInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-lookup').click(); });
  $('#btn-lookup').addEventListener('click', () => lookup().catch((e) => toast(e.message, 'error')));
  $('#btn-recv-again').addEventListener('click', resetRecv);
  $('#btn-recv-cancel').addEventListener('click', resetRecv);
  $('#btn-recv-info-cancel').addEventListener('click', resetRecv);
  $('#btn-save-again').addEventListener('click', () => {
    const r = S.recv;
    if (r.blob) saveBlob(r.blob, r.meta ? r.meta.fileName : 'file');
  });

  function resetRecv() {
    const r = S.recv;
    try { r.ws && r.ws.close(); } catch {}
    try { r.pc && r.pc.close(); } catch {}
    try { r.dc && r.dc.close(); } catch {}
    S.recv = { code: '', kind: null, info: null, token: null, blob: null, ws: null, pc: null, dc: null, chunks: [], bytes: 0, meta: null, key: '', finished: false };
    recvInput.value = '';
    show('#recv-code');
  }

  async function lookup() {
    const raw = recvInput.value.trim();
    const dash = raw.indexOf('-');
    const codePart = (dash === -1 ? raw : raw.slice(0, dash)).toUpperCase();
    const keyPart = dash === -1 ? '' : raw.slice(dash + 1);
    if (!/^[A-Z0-9]{4,10}$/.test(codePart)) { toast('请输入正确的取件码', 'error'); return; }
    if (keyPart && !/^[A-Za-z0-9_-]{10,80}$/.test(keyPart)) { toast('取件码中的密钥部分格式不正确', 'error'); return; }
    const btn = $('#btn-lookup');
    btn.disabled = true;
    try {
      const res = await api('/api/v1/transfers?code=' + encodeURIComponent(codePart));
      S.recv.code = codePart;
      S.recv.kind = res.kind;
      S.recv.key = keyPart || S.recv.key || '';
      if (res.kind === 'relay') showRelayRecv(res.transfer);
      else startP2PReceive(codePart);
    } finally {
      btn.disabled = false;
    }
  }

  // 云端中转接收
  function showRelayRecv(t) {
    if (t.status === 'pending') { toast('对方正在上传，请稍后再试', 'error'); return; }
    if (t.status !== 'ready') { toast('文件已不可接收（可能已被领取）', 'error'); return; }
    if (t.encrypted && !S.recv.key) {
      toast('该文件已端到端加密：请使用对方分享的完整链接，或粘贴「取件码-密钥」完整取件码', 'error');
      return;
    }
    S.recv.info = t;
    if (t.encrypted) {
      setChip($('#recv-info-chip'), '端到端加密文件（接收后自动解密）', t.fileSize, '');
      const icon = $('#recv-info-chip .fc-icon');
      if (icon) icon.textContent = '🔒';
    } else {
      setChip($('#recv-info-chip'), t.fileName, t.fileSize, t.mimeType);
    }
    $('#recv-info-meta').textContent = `有效期至 ${fmtTime(t.expiresAt)} · 接收后云端副本自动删除`;
    show('#recv-info');
  }

  $('#btn-recv-download').addEventListener('click', () => acceptAndDownload().catch(onRecvError));

  // 接收流程出错：提示并回到取件码输入（解密失败时用户可换正确密钥重试）
  function onRecvError(e) {
    console.error(e);
    toast(e.message || '出错了，请重试', 'error');
    resetRecv();
  }

  async function acceptAndDownload() {
    const t = S.recv.info;
    show('#recv-progress');
    $('#recv-progress').classList.remove('hidden');
    $('#recv-progress-meta').classList.remove('hidden');
    setBar($('#recv-bar'), $('#recv-percent'), 0, $('#recv-status'), '正在获取下载凭证…');

    const acc = await api(`/api/v1/transfers/${t.id}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: S.recv.code })
    });

    setBar($('#recv-bar'), $('#recv-percent'), 0, $('#recv-status'), '开始下载…');
    const res = await fetch(acc.downloadUrl);
    if (!res.ok) {
      let msg = '下载失败 (HTTP ' + res.status + ')';
      try { const j = await res.json(); if (j.error) msg = j.error.message; } catch {}
      throw new Error(msg);
    }
    const total = Number(res.headers.get('content-length')) || t.fileSize || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      setBar($('#recv-bar'), $('#recv-percent'), total ? received / total : 0, $('#recv-status'), `下载中 · ${fmtBytes(received)}`);
    }
    const blob = new Blob(chunks, { type: acc.mimeType || 'application/octet-stream' });
    let finalBlob = blob;
    let finalName = acc.fileName;
    let finalSize = acc.fileSize;
    if (S.recv.info && S.recv.info.encrypted) {
      setBar($('#recv-bar'), $('#recv-percent'), 1, $('#recv-status'), '正在解密…');
      try {
        const d = await e2eDecrypt(blob, S.recv.key);
        finalBlob = d.blob;
        finalName = d.meta.n || finalName;
        finalSize = d.meta.s || d.blob.size;
      } catch {
        throw new Error('解密失败：密钥不正确或文件已损坏');
      }
    }
    S.recv.blob = finalBlob;
    S.recv.meta = { fileName: finalName };
    saveBlob(finalBlob, finalName);
    const encNote = (S.recv.info && S.recv.info.encrypted)
      ? '已在浏览器内解密 · 云端始终仅存密文且已删除'
      : '云端副本已自动删除';
    $('#recv-done-sub').textContent = `${finalName} · ${fmtBytes(finalSize)} · ${encNote}`;
    show('#recv-done');
    toast('接收完成，云端副本已删除', 'success');
  }

  // P2P 接收
  function startP2PReceive(code) {
    show('#recv-connect');
    $('#recv-connect-text').textContent = '正在连接对方设备…';

    const r = S.recv;
    const ws = new WebSocket(wsUrl(code, 'receiver'));
    r.ws = ws;

    ws.onmessage = async (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'sdp') {
        const pc = new RTCPeerConnection(RTC_CFG);
        r.pc = pc;
        pc.onicecandidate = (e) => {
          if (e.candidate && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ice', data: e.candidate.toJSON() }));
        };
        pc.ondatachannel = (e) => wireRecvChannel(e.channel);
        await pc.setRemoteDescription(m.data);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'sdp', data: pc.localDescription.toJSON() }));
      } else if (m.type === 'ice') {
        try { await r.pc.addIceCandidate(m.data); } catch {}
      } else if (m.type === 'peer-left') {
        if (S.recv.finished) return;
        toast('对方已断开', 'error');
        resetRecv();
      }
    };
    ws.onerror = () => { toast('连接失败，请检查配对码', 'error'); resetRecv(); };
  }

  function wireRecvChannel(dc) {
    const r = S.recv;
    r.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'meta') {
          r.meta = m;
          setChip($('#recv-file-chip'), m.fileName, m.fileSize, m.mime);
          $('#recv-file-chip').classList.remove('hidden');
          $('#recv-connect-text').textContent = '直连已建立，正在接收…';
          $('#recv-progress').classList.remove('hidden');
          $('#recv-progress-meta').classList.remove('hidden');
          setBar($('#recv-bar'), $('#recv-percent'), 0, $('#recv-status'), `接收中 · ${fmtBytes(m.fileSize)}`);
        } else if (m.type === 'file-end') {
          finishP2PReceive();
        }
      } else {
        r.chunks.push(ev.data);
        r.bytes += ev.data.byteLength;
        if (r.meta && r.meta.fileSize) {
          setBar($('#recv-bar'), $('#recv-percent'), r.bytes / r.meta.fileSize, $('#recv-status'), `接收中 · ${fmtBytes(r.bytes)}`);
        }
      }
    };
  }

  function finishP2PReceive() {
    const r = S.recv;
    r.finished = true;
    const blob = new Blob(r.chunks, { type: (r.meta && r.meta.mime) || 'application/octet-stream' });
    r.blob = blob;
    setBar($('#recv-bar'), $('#recv-percent'), 1, $('#recv-status'), '接收完成');
    saveBlob(blob, (r.meta && r.meta.fileName) || 'file');
    try { r.dc && r.dc.send(JSON.stringify({ type: 'transfer-done' })); } catch {}
    // 同步告知服务器（记录会话完成 + 经信令通知发送端）
    try { r.ws && r.ws.readyState === 1 && r.ws.send(JSON.stringify({ type: 'transfer-done' })); } catch {}
    $('#recv-done-sub').textContent = `${(r.meta && r.meta.fileName) || '文件'} · ${fmtBytes(blob.size)} · P2P 直传，未经过服务器`;
    show('#recv-done');
    toast('接收完成', 'success');
  }

  /* ---------- 初始化 ---------- */

  (async function init() {
    try {
      const cfg = await api('/api/v1/config');
      maxFileMb = cfg.maxFileMb || 2048;
      $('#dz-max').textContent = fmtBytes(maxFileMb * 1048576);
    } catch {}

    // 深链：/r/<code>（或含 -密钥 后缀）、?code=xxx、链接 #k= 密钥片段
    const fragKey = new URLSearchParams(location.hash.replace(/^#/, '')).get('k') || '';
    const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,10})(?:-([A-Za-z0-9_-]{10,80}))?$/) ||
      location.search.match(/[?&]code=([A-Za-z0-9]{4,10})/);
    if (m) {
      switchTab('recv');
      S.recv.key = fragKey || m[2] || '';
      recvInput.value = m[2] ? `${m[1].toUpperCase()}-${m[2]}` : m[1].toUpperCase();
      lookup().catch((e) => toast(e.message, 'error'));
    }
  })();
})();
