// 闪传 FlashDrop — 管理后台逻辑
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);

  /* ---------- 认证：密码登录 → HttpOnly 会话 Cookie（7 天） ---------- */

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch {}
    if (res.status === 401) { logout(); throw new Error('登录已失效，请重新登录'); }
    if (!res.ok) throw new Error((data && data.error && data.error.message) || `请求失败 (HTTP ${res.status})`);
    return data;
  }

  const fmtBytes = (n) => {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n; let i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
  };
  const fmtTime = (ts) => {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const iconSvg = (id) => `<svg class="icon" aria-hidden="true"><use href="#i-${id}"></use></svg>`;

  const STATUS_TEXT = {
    pending: '上传中', ready: '待接收', downloading: '传输中',
    completed: '已完成', expired: '已过期', canceled: '已撤销', active: '进行中'
  };
  const badge = (s) => `<span class="badge ${esc(s)}">${STATUS_TEXT[s] || esc(s)}</span>`;

  function toast(msg, type = '') {
    const root = $('#toast-root');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    root.appendChild(el); // 入场由 @starting-style 驱动
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, 2600);
  }

  async function api(path, opts = {}) {
    if (opts.body && typeof opts.body !== 'string') { opts.body = JSON.stringify(opts.body); opts.headers = { ...(opts.headers || {}), 'content-type': 'application/json' }; }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch {}
    if (res.status === 401) { logout(); throw new Error('登录已失效，请重新登录'); }
    if (!res.ok) throw new Error((data && data.error && data.error.message) || `请求失败 (HTTP ${res.status})`);
    return data;
  }

  /* ---------- 登录 ---------- */

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('#admin-password').value;
    const btn = $('#login-form .btn.primary');
    btn.disabled = true;
    try {
      const res = await fetch('/api/v1/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password })
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error((j && j.error && j.error.message) || `登录失败 (HTTP ${res.status})`);
      }
      $('#admin-password').value = '';
      enterAdmin();
    } catch (err) {
      $('#login-error').textContent = err.message;
      $('#login-error').classList.remove('hidden');
      const card = $('#login-form'); // 错误反馈：轻微水平抖动
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
      setTimeout(() => card.classList.remove('shake'), 450);
    } finally {
      btn.disabled = false;
    }
  });

  $('#btn-logout').addEventListener('click', async (e) => {
    e.preventDefault();
    try { await fetch('/api/v1/admin/logout', { method: 'POST' }); } catch {}
    logout();
  });
  function logout() {
    $('#admin-password').value = '';
    $('#admin-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
    $('#login-error').classList.add('hidden');
  }

  function enterAdmin() {
    $('#login-view').classList.add('hidden');
    $('#admin-view').classList.remove('hidden');
    switchPage('overview');
  }

  /* ---------- 侧栏导航 ---------- */

  document.querySelectorAll('.side-item').forEach((b) => {
    b.addEventListener('click', () => switchPage(b.dataset.page));
  });

  /* ---------- 入场动画驱动（与前台同一套 .entering 机制） ---------- */

  const enteringTimers = new WeakMap();
  function replayEnter(el) {
    if (!el || document.hidden) return; // 后台标签页不播动画，内容直接可见
    clearTimeout(enteringTimers.get(el));
    el.classList.remove('entering');
    void el.offsetWidth;
    el.classList.add('entering');
    enteringTimers.set(el, setTimeout(() => el.classList.remove('entering'), 800));
  }

  /* ---------- 侧栏滑动指示块 ---------- */

  const sideEl = document.querySelector('.side');
  const sideThumb = document.getElementById('side-thumb');

  function moveSideThumb() {
    const active = document.querySelector('.side-item.active');
    if (!active || !sideThumb) return;
    sideThumb.style.width = active.offsetWidth + 'px';
    sideThumb.style.height = active.offsetHeight + 'px';
    sideThumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  }

  /* ---------- 统计数字滚动（状态变化指示；后台/降级环境直接落值） ---------- */

  const statPrev = new Map();
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function setStat(id, value, fmt = (v) => String(v)) {
    const el = $('#' + id);
    if (!el) return;
    const from = statPrev.has(id) ? statPrev.get(id) : value;
    statPrev.set(id, value);
    if (from === value || document.hidden || reduceMotion.matches) { el.textContent = fmt(value); return; }
    const t0 = performance.now();
    const dur = 450;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(Math.round(from + (value - from) * eased));
      if (p < 1 && !document.hidden) requestAnimationFrame(tick);
      else el.textContent = fmt(value); // 兜底落值
    };
    requestAnimationFrame(tick);
  }

  let current = 'overview';
  function switchPage(page) {
    current = page;
    document.querySelectorAll('.side-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
    moveSideThumb();
    document.querySelectorAll('.admin-page').forEach((p) => p.classList.add('hidden'));
    const pageEl = $('#page-' + page);
    if (pageEl) {
      pageEl.classList.remove('hidden');
      replayEnter(pageEl);
    }
    if (page === 'overview') loadOverview();
    if (page === 'transfers') loadTransfers();
    if (page === 'keys') loadKeys();
    if (page === 'settings') loadSettings();
  }

  /* ---------- 概览 ---------- */

  async function loadOverview() {
    try {
      const { stats, recent } = await api('/api/v1/admin/overview');
      setStat('st-ready', Number(stats.ready_count));
      $('#st-ready-sub').textContent = `另有 ${stats.pending_count} 个上传中`;
      setStat('st-storage', Number(stats.storage_bytes), fmtBytes);
      setStat('st-today', Number(stats.today_count));
      setStat('st-completed', Number(stats.completed_count));
      $('#st-completed-sub').textContent = '已完成任务';
      setStat('st-delivered', Number(stats.delivered_bytes), fmtBytes);
      $('#st-gone').textContent = `${stats.expired_count} / ${stats.canceled_count}`;
      setStat('st-total', Number(stats.total_count));
      $('#recent-body').innerHTML = recent.map((t) => `
        <tr>
          <td><div class="t-name">${esc(t.file_name)}</div><div class="t-sub">${fmtTime(t.created_at)}</div></td>
          <td>${fmtBytes(Number(t.file_size))}</td>
          <td>${badge(t.status)}</td>
          <td>${fmtTime(t.created_at)}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">暂无数据</td></tr>'; replayEnter(document.getElementById('recent-body'));
    } catch (e) { toast(e.message, 'error'); }
  }

  $('#btn-refresh').addEventListener('click', () => loadOverview());
  $('#btn-purge').addEventListener('click', async () => {
    try {
      const r = await api('/api/v1/admin/purge', { method: 'POST' });
      toast(`清理完成：过期 ${r.purged} 个任务`, 'success');
      loadOverview();
    } catch (e) { toast(e.message, 'error'); }
  });

  /* ---------- 传输记录 ---------- */

  let page = 1;
  async function loadTransfers() {
    const status = $('#f-status').value;
    const q = $('#f-q').value.trim();
    try {
      const data = await api(`/api/v1/admin/transfers?page=${page}&size=20&status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`);
      const pages = Math.max(1, Math.ceil(data.total / data.size));
      page = Math.min(page, pages);
      $('#t-count').textContent = `共 ${data.total} 条`;
      $('#t-page').textContent = `${page} / ${pages}`;
      $('#transfers-body').innerHTML = data.items.map((t) => `
        <tr>
          <td><div class="t-name t-name-icon">${t.encrypted ? iconSvg('lock') + '<span>端到端加密文件</span>' : esc(t.file_name)}</div><div class="t-sub">${fmtBytes(Number(t.file_size))} · ${fmtTime(t.created_at)}</div></td>
          <td class="mono">${esc(t.claim_code || '—')}</td>
          <td>${badge(t.status)}</td>
          <td>${t.downloads} / ${t.max_downloads}</td>
          <td>${t.status === 'completed' ? fmtTime(t.completed_at) : fmtTime(t.expires_at)}</td>
          <td class="mono">${esc(t.sender_ip || '—')}</td>
          <td>${['pending', 'ready', 'downloading'].includes(t.status)
            ? `<button class="btn small danger-ghost" data-del="${esc(t.id)}" type="button">删除</button>` : '—'}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">暂无数据</td></tr>'; replayEnter(document.getElementById('transfers-body'));
      document.querySelectorAll('[data-del]').forEach((b) => {
        b.addEventListener('click', async () => {
          if (!confirm('确认删除该文件并撤销任务？')) return;
          try { await api('/api/v1/admin/transfers/' + b.dataset.del, { method: 'DELETE' }); toast('已删除', 'success'); loadTransfers(); }
          catch (e) { toast(e.message, 'error'); }
        });
      });
    } catch (e) { toast(e.message, 'error'); }
  }
  $('#btn-filter').addEventListener('click', () => { page = 1; loadTransfers(); });
  $('#f-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { page = 1; loadTransfers(); } });
  $('#t-prev').addEventListener('click', () => { if (page > 1) { page--; loadTransfers(); } });
  $('#t-next').addEventListener('click', () => { page++; loadTransfers(); });

  /* ---------- API 密钥 ---------- */

  async function loadKeys() {
    try {
      const { items } = await api('/api/v1/admin/api-keys');
      $('#keys-body').innerHTML = items.map((k) => `
        <tr>
          <td class="mono">${esc(k.key)}</td>
          <td>${esc(k.name)}</td>
          <td>${k.requests}</td>
          <td>${fmtTime(k.last_used_at)}</td>
          <td>${k.revoked ? '<span class="badge canceled">已吊销</span>' : '<span class="badge active">有效</span>'}</td>
          <td>${k.revoked ? '—' : `<button class="btn small danger-ghost" data-revoke="${esc(k.key)}" type="button">吊销</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无密钥</td></tr>'; replayEnter(document.getElementById('keys-body'));
      document.querySelectorAll('[data-revoke]').forEach((b) => {
        b.addEventListener('click', async () => {
          if (!confirm('确认吊销该密钥？')) return;
          try { await api('/api/v1/admin/api-keys/' + b.dataset.revoke, { method: 'DELETE' }); toast('已吊销', 'success'); loadKeys(); }
          catch (e) { toast(e.message, 'error'); }
        });
      });
    } catch (e) { toast(e.message, 'error'); }
  }

  $('#btn-create-key').addEventListener('click', async () => {
    const name = $('#key-name').value.trim() || '未命名应用';
    try {
      const r = await api('/api/v1/admin/api-keys', { method: 'POST', body: { name } });
      $('#key-name').value = '';
      showModal('密钥已生成（仅显示一次）',
        `<div class="codeblock" style="user-select:all">${esc(r.key)}</div>
         <p class="muted small" style="text-align:left">请立即复制并保存。调用 API 时作为 <code>X-Api-Key</code> 请求头使用。</p>`);
      loadKeys();
    } catch (e) { toast(e.message, 'error'); }
  });

  function showModal(title, html) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="glass modal"><h3>${esc(title)}</h3>${html}
      <div class="btn-row"><button class="btn primary" type="button">好 的</button></div></div>`;
    const close = () => {
      mask.classList.add('closing'); // 退出比进入快（200ms）
      setTimeout(() => mask.remove(), 220);
    };
    mask.querySelector('.btn').addEventListener('click', close);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    $('#modal-root').appendChild(mask);
  }

  /* ---------- 设置 ---------- */

  async function loadSettings() {
    try {
      const s = await api('/api/v1/admin/settings');
      $('#s-ttl').value = s.default_ttl_hours;
      $('#s-maxmb').value = s.max_file_mb;
      $('#s-maxdl').value = s.default_max_downloads;
      $('#s-chunk').value = s.chunk_size_mb;
      $('#s-reqkey').checked = s.api_require_key === '1';
    } catch (e) { toast(e.message, 'error'); }
  }

  $('#btn-save-settings').addEventListener('click', async () => {
    try {
      await api('/api/v1/admin/settings', {
        method: 'PUT',
        body: {
          default_ttl_hours: $('#s-ttl').value,
          max_file_mb: $('#s-maxmb').value,
          default_max_downloads: $('#s-maxdl').value,
          chunk_size_mb: $('#s-chunk').value,
          api_require_key: $('#s-reqkey').checked ? '1' : '0'
        }
      });
      toast('设置已保存', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });

  /* ---------- 初始化 ---------- */

  (function init() {
    // 后台/被遮挡的标签页冻结动画时间轴，入场动画会停在透明帧——直接禁用
    const syncAnimGate = () => document.documentElement.classList.toggle('no-anim', document.hidden);
    syncAnimGate();
    document.addEventListener('visibilitychange', () => {
      syncAnimGate();
      if (document.hidden) moveSideThumb(); // 回到前台时校准指示块位置
    });
    // 顶部导航：滚动边缘效果
    const navEl = document.querySelector('.nav');
    if (navEl) {
      window.addEventListener('scroll', () => {
        navEl.classList.toggle('scrolled', window.scrollY > 8);
      }, { passive: true });
    }
    window.addEventListener('resize', moveSideThumb);
    if (navEl) {
      window.addEventListener('scroll', () => {
        navEl.classList.toggle('scrolled', window.scrollY > 8);
      }, { passive: true });
    }
    // 背景：Bing 每日壁纸（同源 /api/v1/wallpaper 解析，服务端改写为 1080p；失败保持光斑）
    const bgEl = document.querySelector('.bg');
    if (bgEl) {
      const img = new Image();
      img.onload = () => {
        bgEl.style.setProperty('--wallpaper', 'url("/api/v1/wallpaper")');
        bgEl.classList.add('bg-photo');
      };
      img.src = '/api/v1/wallpaper';
    }
    // 已有会话 Cookie 时自动登录；否则停在登录页
    api('/api/v1/admin/overview').then(enterAdmin).catch(() => {});
    // 概览页每 30 秒自动刷新
    setInterval(() => { if (current === 'overview' && !$('#admin-view').classList.contains('hidden')) loadOverview(); }, 30000);
  })();
})();
