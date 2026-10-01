// 闪传 FlashDrop — 前端逻辑（发送：云端中转；接收）
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

  const iconSvg = (id) => `<svg class="icon" aria-hidden="true"><use href="#i-${id}"></use></svg>`;

  const fileIconId = (name, mime) => {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if ((mime || '').startsWith('image/')) return 'image';
    if ((mime || '').startsWith('video/')) return 'video';
    if ((mime || '').startsWith('audio/')) return 'music';
    if (ext === 'pdf') return 'book';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
    if (['doc', 'docx', 'pages', 'txt', 'md'].includes(ext)) return 'file-text';
    if (['xls', 'xlsx', 'numbers', 'csv'].includes(ext)) return 'chart';
    if (['ppt', 'pptx', 'key'].includes(ext)) return 'monitor';
    if (['apk', 'dmg', 'exe', 'msi', 'ipa'].includes(ext)) return 'package';
    return 'file';
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
  const E2E_CHUNK = 4 * 1024 * 1024;        // 加密帧内明文块
  const E2E_PART_TARGET = 12 * 1024 * 1024; // 分片目标大小（保证非末片 ≥5MiB，R2 要求）

  /* 流式 E2E 分片构建器：边加密边出片，内存恒定，支持任意大文件。
     布局：数据帧（AAD=1..N，帧内明文 ≤4MB，末块补零到整块）在前，
     元数据帧（AAD=0，任意大小）在最后——保证所有非末尾分片等大（R2/本地模拟均要求）。 */
  async function makeE2EPartBuilder(file, partTarget) {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    const enc = new TextEncoder();
    const metaPlain = enc.encode(JSON.stringify({ n: file.name, m: file.type || 'application/octet-stream', s: file.size }));
    const metaIv = crypto.getRandomValues(new Uint8Array(12));
    const metaCipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: metaIv, additionalData: u32le(0) }, key, metaPlain));
    const metaFrame = (() => {
      const f = new Uint8Array(16 + metaCipher.length);
      new DataView(f.buffer).setUint32(0, metaCipher.length, true);
      f.set(metaIv, 4);
      f.set(metaCipher, 16);
      return f;
    })();

    const chunkCount = Math.max(1, Math.ceil(file.size / E2E_CHUNK));
    const frameSize = E2E_CHUNK + 32;
    const framesTotal = chunkCount + 1; // 最后一帧 = 元数据
    const K = Math.max(1, Math.floor(partTarget / frameSize)); // 每片帧数
    const totalParts = Math.ceil(framesTotal / K);
    const totalSize = (chunkCount - 1) * frameSize + (file.size - (chunkCount - 1) * E2E_CHUNK + 32) + metaFrame.length;

    const buildPart = async (n) => {
      const pieces = [];
      const from = (n - 1) * K;
      const to = Math.min(n * K, framesTotal);
      for (let f = from; f < to; f++) {
        if (f === chunkCount) { pieces.push(metaFrame); break; } // 元数据帧收尾
        const start = f * E2E_CHUNK;
        const real = Math.min(E2E_CHUNK, file.size - start);
        const plain = new Uint8Array(E2E_CHUNK); // 末块补零到整块，保证等大分片
        plain.set(new Uint8Array(await file.slice(start, start + real).arrayBuffer()));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: u32le(f + 1) }, key, plain));
        const frame = new Uint8Array(4 + iv.length + cipher.length);
        new DataView(frame.buffer).setUint32(0, cipher.length, true);
        frame.set(iv, 4);
        frame.set(cipher, 16);
        pieces.push(frame);
      }
      if (n === totalParts) pieces.push(E2E_MAGIC); // 魔数置于容器末尾（属于大小不受限的末分片）
      let total = 0;
      for (const p of pieces) total += p.length;
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of pieces) { out.set(p, o); o += p.length; }
      return new Blob([out], { type: 'application/octet-stream' });
    };

    return { keyB64: b64urlEncode(rawKey), buildPart, totalParts: totalParts, totalSize: totalSize + E2E_MAGIC.length };
  }

  async function e2eDecrypt(blob, keyB64) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    // 魔数位于容器末尾
    const bodyEnd = buf.length - E2E_MAGIC.length;
    if (bodyEnd < 10 || !E2E_MAGIC.every((b, i) => buf[bodyEnd + i] === b)) throw new Error('bad_container');
    const key = await crypto.subtle.importKey('raw', b64urlDecode(keyB64), { name: 'AES-GCM' }, false, ['decrypt']);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let off = 0, pos = 0, meta = null;
    const dataByIndex = new Map();
    while (off + 4 <= bodyEnd) {
      const len = dv.getUint32(off, true); off += 4;
      if (off + 12 + len > bodyEnd) throw new Error('bad_container');
      const iv = buf.subarray(off, off + 12); off += 12;
      const cipher = buf.subarray(off, off + len); off += len;
      const isLast = off === bodyEnd; // body 内最后一帧 = 元数据（AAD 0），其余帧 AAD = 序号+1
      const aad = u32le(isLast ? 0 : pos + 1);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, cipher));
      if (isLast) meta = JSON.parse(new TextDecoder().decode(plain));
      else dataByIndex.set(pos + 1, plain);
      pos++;
    }
    if (!meta) throw new Error('bad_container');
    // 末块补零：按元数据里的真实大小裁剪；并校验数据帧完整性
    if (dataByIndex.size !== Math.ceil(meta.s / E2E_CHUNK)) throw new Error('bad_container');
    const ordered = [];
    for (let i = 1; i <= dataByIndex.size; i++) {
      const c = dataByIndex.get(i);
      if (!c) throw new Error('bad_container');
      ordered.push(c);
    }
    const full = new Blob(ordered, { type: meta.m || 'application/octet-stream' });
    return { meta, blob: full.slice(0, meta.s) };
  }

  function toast(msg, type = '') {
    const root = $('#toast-root');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    root.appendChild(el); // 入场由 @starting-style 驱动
    setTimeout(() => {
      el.classList.add('out'); // 与入场同侧退出，且更快
      setTimeout(() => el.remove(), 300);
    }, 2600);
  }

  // 复制成功反馈：按钮文案变形（状态指示），不再叠加 toast
  async function copyWithFeedback(btn, text) {
    if (!btn || btn.disabled) return false;
    if (await copyText(text)) {
      const orig = btn.textContent;
      btn.textContent = '已复制 ✓';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
      return true;
    }
    return false;
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
    recv: {
      code: '', kind: null, info: null, token: null, blob: null,
      chunks: [], bytes: 0, meta: null, key: ''
    }
  };

  const show = (id) => {
    const el = $(id);
    if (!el) return;
    // 只隐藏目标步骤所在视图的步骤：两个视图互不干扰，
    // 接收流程的 show 不会抹掉发送侧的结果页（反之亦然）
    const view = el.closest('#view-recv') ? '#view-recv' : '#view-send';
    document.querySelectorAll(view + ' .step').forEach((s) => s.classList.add('hidden'));
    el.classList.remove('hidden');
    replayEnter(el);
  };

  const setBar = (barEl, pctEl, ratio, statusEl, status) => {
    const clamped = Math.min(1, Math.max(0, ratio));
    if (barEl) {
      barEl.style.transform = 'scaleX(' + clamped.toFixed(4) + ')';
      const wrap = barEl.closest('.progress');
      if (wrap) wrap.classList.toggle('playing', clamped > 0.005 && clamped < 0.995); // 传输中才显示扫光
    }
    if (pctEl) pctEl.textContent = Math.floor(clamped * 100) + '%';
    if (statusEl && status) statusEl.textContent = status;
  };

  const chipHtml = (name, size, mime, iconId) =>
    `<span class="fc-icon">${iconSvg(iconId || fileIconId(name, mime))}</span>
     <span><span class="fc-name"></span><div class="fc-size">${fmtBytes(size)}</div></span>`;
  const setChip = (el, name, size, mime, iconId) => {
    if (el) { el.innerHTML = chipHtml(name, size, mime, iconId); el.querySelector('.fc-name').textContent = name; }
  };

  /* ---------- 入场动画驱动（data-mounted 模式） ----------
     显示元素后再挂 .entering 类播放级联动画，800ms 后自动摘除；
     动画因任何原因失效时，元素保持自然可见态，绝不会卡在隐藏。 */

  let enteringTimers = new WeakMap();
  function replayEnter(el) {
    if (!el || document.hidden) return; // 后台标签页不播动画，内容直接可见
    clearTimeout(enteringTimers.get(el));
    el.classList.remove('entering');
    void el.offsetWidth; // 强制回流，保证重复显示时动画从头重放
    el.classList.add('entering');
    enteringTimers.set(el, setTimeout(() => el.classList.remove('entering'), 800));
  }

  /* ---------- 标签页切换（滑动指示器跟随所选） ---------- */

  const segWrap = $('#seg-tabs');
  const segThumb = $('#seg-thumb');

  function moveSegThumb() {
    const active = segWrap.querySelector('.seg.active');
    if (!active || !segThumb) return;
    segThumb.style.width = active.offsetWidth + 'px';
    segThumb.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  }

  function switchTab(tab) {
    S.tab = tab;
    document.querySelectorAll('#seg-tabs .seg').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('#view-send').classList.toggle('hidden', tab !== 'send');
    $('#view-recv').classList.toggle('hidden', tab !== 'recv');
    moveSegThumb();
    // show() 会隐藏两个视图的所有步骤：发送流程推进后切到接收（或反之）时，
    // 目标视图可能没有任何可见步骤——回退到该视图的初始步骤
    const view = tab === 'send' ? '#view-send' : '#view-recv';
    let visibleStep = document.querySelector(view + ' .step:not(.hidden)');
    if (!visibleStep) {
      if (tab === 'recv') resetRecv();       // 重置状态并显示取件码输入
      else show('#send-pick');               // 发送侧回到选择文件
      visibleStep = document.querySelector(view + ' .step:not(.hidden)');
    }
    replayEnter(visibleStep);
  }

  document.querySelectorAll('#seg-tabs .seg').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  window.addEventListener('resize', moveSegThumb);

  /* ---------- 顶部导航：滚动边缘效果 ---------- */

  const navEl = document.querySelector('.nav');
  window.addEventListener('scroll', () => {
    navEl.classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });

  /* ---------- 背景：Bing 每日壁纸 ----------
     经同源 /api/v1/wallpaper 解析（服务端把 UHD 改写为 1080p 并在边缘缓存），
     避免直接解码 4K 图卡住渲染进程；加载失败静默回退到渐变光斑。 */

  function applyWallpaper(bg, url) {
    const img = new Image();
    img.onload = () => {
      bg.style.setProperty('--wallpaper', `url("${url}")`);
      bg.classList.add('bg-photo');
    };
    img.src = url;
  }

  (function loadWallpaper() {
    const bg = document.querySelector('.bg');
    if (!bg) return;
    applyWallpaper(bg, '/api/v1/wallpaper');
  })();

  /* ---------- 特性卡指针微倾斜（营销档位 delight；触屏/降级环境自动关闭） ---------- */

  (function initTilt() {
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.querySelectorAll('.feature').forEach((card) => {
      card.addEventListener('pointermove', (e) => {
        if (document.hidden) return; // 时间轴冻结时不更新，避免叠积未完成过渡
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = `perspective(700px) rotateX(${(-y * 5).toFixed(2)}deg) rotateY(${(x * 6).toFixed(2)}deg)`;
      });
      card.addEventListener('pointerleave', () => { card.style.transform = ''; });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) document.querySelectorAll('.feature').forEach((c) => { c.style.transform = ''; });
    });
  })();

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

  /* ---------- 发送：云端中转 ---------- */

  $('#opt-relay').addEventListener('click', () => { if (S.file) startRelaySend(S.file, $('#opt-e2e').checked).catch(onFlowError); });

  const UPLOAD_CONCURRENCY = 3; // 并发分片数（HTTP/2 多路复用下显著提升吞吐）

  async function startRelaySend(file, encrypt) {
    show('#send-progress');
    setBar($('#send-bar'), $('#send-percent'), 0, $('#send-status'), '准备中…');

    const chunkSize = Math.max(5, (S.chunkSizeMb || 8)) * 1048576;
    let keyB64 = null, buildPart, totalParts, payloadSize;

    if (encrypt) {
      setBar($('#send-bar'), $('#send-percent'), 0, $('#send-status'), '正在准备加密…');
      const plan = await makeE2EPartBuilder(file, Math.max(chunkSize, E2E_PART_TARGET));
      keyB64 = plan.keyB64;
      buildPart = plan.buildPart;
      totalParts = plan.totalParts;
      payloadSize = plan.totalSize;
    } else {
      payloadSize = file.size;
      totalParts = Math.max(1, Math.ceil(payloadSize / chunkSize));
      buildPart = (n) => file.slice((n - 1) * chunkSize, Math.min(n * chunkSize, payloadSize));
    }

    const created = await api('/api/v1/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: keyB64 ? 'encrypted.fdenc' : file.name,
        fileSize: payloadSize,
        mimeType: 'application/octet-stream',
        encrypted: !!keyB64
      })
    });
    S.relay = { ...created, keyB64 };

    // 并发分片上传：3 路并行，进度按各分片已传字节合计
    const partLoaded = new Array(totalParts + 1).fill(0);
    const uploadedSoFar = () => partLoaded.reduce((a, b) => a + b, 0);
    const render = () => setBar($('#send-bar'), $('#send-percent'), uploadedSoFar() / payloadSize,
      $('#send-status'), keyB64 ? '加密并上传中…' : '正在上传…');

    let nextPart = 1;
    const worker = async () => {
      while (nextPart <= totalParts) {
        const n = nextPart++;
        const blob = await buildPart(n);
        let lastErr;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await xhrSend(created.partUrl.replace('{n}', String(n)), 'PUT', blob,
              (loaded) => { partLoaded[n] = loaded; render(); });
            lastErr = null;
            break;
          } catch (e) { lastErr = e; }
        }
        if (lastErr) throw lastErr;
        partLoaded[n] = blob.size;
        render();
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, totalParts) }, worker));

    await api(created.completeUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ totalParts })
    });

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

  $('#btn-copy-code').addEventListener('click', () => {
    if (!S.relay) return;
    const text = S.relay.keyB64 ? `${S.relay.claimCode}-${S.relay.keyB64}` : S.relay.claimCode;
    copyWithFeedback($('#btn-copy-code'), text);
  });
  $('#btn-copy-link').addEventListener('click', () => copyWithFeedback($('#btn-copy-link'), $('#relay-link').value));
  $('#btn-relay-again').addEventListener('click', () => { S.relay = null; S.file = null; show('#send-pick'); });
  $('#btn-relay-undo').addEventListener('click', async () => {
    if (!S.relay) return;
    try {
      await api(`/api/v1/transfers/${S.relay.id}?st=${S.relay.senderToken}`, { method: 'DELETE' });
      toast('已撤销，云端文件已删除', 'success');
    } catch (e) { toast(e.message, 'error'); }
    S.relay = null; S.file = null; show('#send-pick');
  });

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
    S.recv = { code: '', kind: null, info: null, token: null, blob: null, chunks: [], bytes: 0, meta: null, key: '' };
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
      showRelayRecv(res.transfer);
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
      setChip($('#recv-info-chip'), '端到端加密文件（接收后自动解密）', t.fileSize, '', 'lock');
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
    // 注意：要 show 的是外层 step，不是里面的进度条元素——否则父级会被一起隐藏，
    // 进度条永远不可见（此前 show('#recv-progress') 就踩了这个坑）
    show('#recv-progress-step');
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
    saveBlob(finalBlob, finalName); // 自动保存一次，错过也能随时点下方按钮重存
    const encNote = (S.recv.info && S.recv.info.encrypted)
      ? '已在浏览器内解密 · 云端始终仅存密文且已删除'
      : '云端副本已自动删除';
    $('#recv-done-sub').textContent = `${finalName} · ${fmtBytes(finalSize)} · ${encNote}`;
    show('#recv-done');
    toast('接收完成，云端副本已删除', 'success');
  }

  /* ---------- 初始化 ---------- */

  (async function init() {
    moveSegThumb();
    // 后台/被遮挡的标签页冻结动画时间轴，入场动画会停在透明帧——直接禁用
    const syncAnimGate = () => document.documentElement.classList.toggle('no-anim', document.hidden);
    syncAnimGate();
    document.addEventListener('visibilitychange', syncAnimGate);
    try {
      const cfg = await api('/api/v1/config');
      maxFileMb = cfg.maxFileMb || 2048;
      S.chunkSizeMb = cfg.chunkSizeMb || 8;
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
