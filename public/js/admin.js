// 闪传 FlashDrop — 管理后台逻辑
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const TOKEN_KEY = 'fd_admin_token';

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
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2600);
    setTimeout(() => el.remove(), 3000);
  }

  async function api(path, opts = {}) {
    opts.headers = { ...(opts.headers || {}), authorization: 'Bearer ' + (localStorage.getItem(TOKEN_KEY) || '') };
    if (opts.body && typeof opts.body !== 'string') { opts.body = JSON.stringify(opts.body); opts.headers['content-type'] = 'application/json'; }
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
    const token = $('#admin-token').value.trim();
    localStorage.setItem(TOKEN_KEY, token);
    try {
      await api('/api/v1/admin/overview');
      enterAdmin();
    } catch (err) {
      if (!$('#admin-view').classList.contains('hidden')) return; // 401 已处理
      localStorage.removeItem(TOKEN_KEY);
      $('#login-error').textContent = err.message;
      $('#login-error').classList.remove('hidden');
    }
  });

  $('#btn-logout').addEventListener('click', (e) => { e.preventDefault(); logout(); });
  function logout() {
    localStorage.removeItem(TOKEN_KEY);
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

  let current = 'overview';
  function switchPage(page) {
    current = page;
    document.querySelectorAll('.side-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
    document.querySelectorAll('.admin-page').forEach((p) => p.classList.add('hidden'));
    $('#page-' + page).classList.remove('hidden');
    if (page === 'overview') loadOverview();
    if (page === 'transfers') loadTransfers();
    if (page === 'p2p') loadP2P();
    if (page === 'keys') loadKeys();
    if (page === 'settings') loadSettings();
  }

  /* ---------- 概览 ---------- */

  async function loadOverview() {
    try {
      const { stats, recent } = await api('/api/v1/admin/overview');
      $('#st-ready').textContent = stats.ready_count;
      $('#st-ready-sub').textContent = `另有 ${stats.pending_count} 个上传中`;
      $('#st-storage').textContent = fmtBytes(Number(stats.storage_bytes));
      $('#st-today').textContent = stats.today_count;
      $('#st-completed').textContent = stats.completed_count;
      $('#st-completed-sub').textContent = '已完成任务';
      $('#st-delivered').textContent = fmtBytes(Number(stats.delivered_bytes));
      $('#st-gone').textContent = `${stats.expired_count} / ${stats.canceled_count}`;
      $('#st-p2p').textContent = stats.p2p_week_count;
      $('#st-total').textContent = stats.total_count;
      $('#recent-body').innerHTML = recent.map((t) => `
        <tr>
          <td><div class="t-name">${esc(t.file_name)}</div><div class="t-sub">${fmtTime(t.created_at)}</div></td>
          <td>${fmtBytes(Number(t.file_size))}</td>
          <td>${badge(t.status)}</td>
          <td>${fmtTime(t.created_at)}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">暂无数据</td></tr>';
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
          <td><div class="t-name">${t.encrypted ? '🔒 端到端加密文件' : esc(t.file_name)}</div><div class="t-sub">${fmtBytes(Number(t.file_size))} · ${fmtTime(t.created_at)}</div></td>
          <td class="mono">${esc(t.claim_code || '—')}</td>
          <td>${badge(t.status)}</td>
          <td>${t.downloads} / ${t.max_downloads}</td>
          <td>${t.status === 'completed' ? fmtTime(t.completed_at) : fmtTime(t.expires_at)}</td>
          <td class="mono">${esc(t.sender_ip || '—')}</td>
          <td>${['pending', 'ready', 'downloading'].includes(t.status)
            ? `<button class="btn small danger-ghost" data-del="${esc(t.id)}" type="button">删除</button>` : '—'}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">暂无数据</td></tr>';
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

  /* ---------- P2P 会话 ---------- */

  async function loadP2P() {
    try {
      const { items } = await api('/api/v1/admin/p2p');
      $('#p2p-body').innerHTML = items.map((t) => `
        <tr>
          <td class="mono">${esc(t.code)}</td>
          <td><div class="t-name">${esc(t.file_name || '未上报文件信息')}</div><div class="t-sub">${t.file_size ? fmtBytes(Number(t.file_size)) : ''}</div></td>
          <td>${badge(t.status)}</td>
          <td>${fmtTime(t.created_at)}</td>
          <td>${fmtTime(t.connected_at)}</td>
          <td>${fmtTime(t.completed_at)}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无数据</td></tr>';
    } catch (e) { toast(e.message, 'error'); }
  }

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
        </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无密钥</td></tr>';
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
    mask.querySelector('.btn').addEventListener('click', () => mask.remove());
    mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
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
      $('#s-p2pttl').value = s.p2p_room_ttl_minutes;
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
          p2p_room_ttl_minutes: $('#s-p2pttl').value,
          api_require_key: $('#s-reqkey').checked ? '1' : '0'
        }
      });
      toast('设置已保存', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });

  /* ---------- 初始化 ---------- */

  (function init() {
    if (localStorage.getItem(TOKEN_KEY)) {
      api('/api/v1/admin/overview').then(enterAdmin).catch(() => {});
    }
    // 概览页每 30 秒自动刷新
    setInterval(() => { if (current === 'overview' && !$('#admin-view').classList.contains('hidden')) loadOverview(); }, 30000);
  })();
})();
