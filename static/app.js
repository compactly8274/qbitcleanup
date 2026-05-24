'use strict';

let currentTab = 'orphans';
let orphansData = [];
let trashData = [];
let statusInterval = null;

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  refreshStatus();
  loadOrphans();
  statusInterval = setInterval(refreshStatus, 15000);
});

// ── Tabs ──────────────────────────────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${tab}`));
  if (tab === 'orphans') loadOrphans();
  else loadTrash();
}

// ── Status ────────────────────────────────────────────────────────────────────

async function refreshStatus() {
  try {
    const data = await apiFetch('/api/status');
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (data.connected) {
      dot.className = 'status-dot connected';
      text.textContent = `Connected${data.version ? ' v' + data.version : ''}`;
    } else {
      dot.className = 'status-dot disconnected';
      text.textContent = data.error ? `Offline: ${data.error}` : 'Offline';
    }
    setBadge('orphans', data.orphan_count ?? 0);
    setBadge('trash', data.trash_count ?? 0);
  } catch {
    document.getElementById('status-dot').className = 'status-dot disconnected';
    document.getElementById('status-text').textContent = 'Error';
  }
}

function setBadge(tab, count) {
  const el = document.getElementById(`badge-${tab}`);
  if (el) el.textContent = count;
}

// ── Orphans ───────────────────────────────────────────────────────────────────

async function loadOrphans(force = false) {
  const list = document.getElementById('orphans-list');
  list.innerHTML = `<div class="loading"><span class="spinner"></span>${force ? 'Scanning…' : 'Loading…'}</div>`;
  try {
    const url = force ? '/api/orphans?refresh=true' : '/api/orphans';
    const res = await apiFetch(url);
    orphansData = res.orphans ?? [];
    renderOrphans(res);
    setBadge('orphans', orphansData.length);
  } catch (err) {
    list.innerHTML = `<div class="error-banner">${escHtml(err.message)}</div>`;
  }
}

function renderOrphans(res) {
  const list = document.getElementById('orphans-list');
  const lastScan = res.last_scan ? new Date(res.last_scan * 1000) : null;
  const scanAge = lastScan ? formatAge(lastScan) : 'never';
  const cachedLabel = res.cached
    ? `<span class="scan-cached">cached · ${scanAge}</span>`
    : `<span class="scan-fresh">scanned just now</span>`;
  const warning = res.warning
    ? `<div class="error-banner">${escHtml(res.warning)}</div>`
    : '';

  const header = `<div class="scan-meta">${cachedLabel}</div>${warning}`;

  if (!orphansData.length) {
    list.innerHTML = header + '<div class="empty-state"><div class="empty-icon">✓</div><div>No orphaned files found</div></div>';
    return;
  }
  list.innerHTML = header + orphansData.map(item => fileRow(item, 'orphan')).join('');
}

async function moveOne(path) {
  setLoading(true);
  try {
    const res = await apiFetch('/api/orphans/move', 'POST', { path });
    if (res.errors?.length) throw new Error(res.errors[0].error);
    showToast('Moved to trash', 'success');
    await Promise.all([loadOrphans(), refreshStatus()]);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function moveAll() {
  if (!orphansData.length) return;
  confirm(
    'Move All to Trash',
    `Move ${orphansData.length} item${orphansData.length !== 1 ? 's' : ''} to trash?`,
    async () => {
      setLoading(true);
      try {
        const res = await apiFetch('/api/orphans/move', 'POST', {});
        const ok = res.moved?.length ?? 0;
        const fail = res.errors?.length ?? 0;
        showToast(`Moved ${ok} item${ok !== 1 ? 's' : ''}${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
        await Promise.all([loadOrphans(), refreshStatus()]);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        setLoading(false);
      }
    }
  );
}

// ── Trash ─────────────────────────────────────────────────────────────────────

async function loadTrash() {
  const list = document.getElementById('trash-list');
  list.innerHTML = '<div class="loading"><span class="spinner"></span>Loading…</div>';
  try {
    trashData = await apiFetch('/api/trash');
    renderTrash();
    setBadge('trash', trashData.length);
  } catch (err) {
    list.innerHTML = `<div class="error-banner">${escHtml(err.message)}</div>`;
  }
}

function renderTrash() {
  const list = document.getElementById('trash-list');
  if (!trashData.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🗑</div><div>Trash is empty</div></div>';
    return;
  }
  list.innerHTML = trashData.map(item => fileRow(item, 'trash')).join('');
}

async function restoreOne(path) {
  setLoading(true);
  try {
    const res = await apiFetch('/api/trash/restore', 'POST', { path });
    if (res.errors?.length) throw new Error(res.errors[0].error);
    showToast('Restored', 'success');
    await Promise.all([loadTrash(), refreshStatus()]);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function restoreAll() {
  if (!trashData.length) return;
  confirm(
    'Restore All',
    `Restore ${trashData.length} item${trashData.length !== 1 ? 's' : ''} to their original locations?`,
    async () => {
      setLoading(true);
      try {
        const res = await apiFetch('/api/trash/restore', 'POST', {});
        const ok = res.restored?.length ?? 0;
        const fail = res.errors?.length ?? 0;
        showToast(`Restored ${ok}${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
        await Promise.all([loadTrash(), refreshStatus()]);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        setLoading(false);
      }
    }
  );
}

async function deleteOne(path) {
  confirm(
    'Permanently Delete',
    'This cannot be undone. Delete this item forever?',
    async () => {
      setLoading(true);
      try {
        const res = await apiFetch('/api/trash/delete', 'POST', { path });
        if (res.errors?.length) throw new Error(res.errors[0].error);
        showToast('Deleted', 'success');
        await Promise.all([loadTrash(), refreshStatus()]);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        setLoading(false);
      }
    }
  );
}

async function deleteAll() {
  if (!trashData.length) return;
  confirm(
    'Delete All Permanently',
    `Permanently delete all ${trashData.length} item${trashData.length !== 1 ? 's' : ''} in trash? This cannot be undone.`,
    async () => {
      setLoading(true);
      try {
        const res = await apiFetch('/api/trash/delete', 'POST', {});
        const ok = res.deleted?.length ?? 0;
        const fail = res.errors?.length ?? 0;
        showToast(`Deleted ${ok}${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
        await Promise.all([loadTrash(), refreshStatus()]);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        setLoading(false);
      }
    }
  );
}

// ── Render helpers ────────────────────────────────────────────────────────────

function fileRow(item, type) {
  const icon = item.is_dir ? '📁' : '📄';
  const date = item.modified ? new Date(item.modified * 1000).toLocaleDateString() : '—';
  const pathAttr = escAttr(type === 'trash' ? item.trash_path : item.path);

  const subPath = type === 'orphan'
    ? (item.relative_path && item.relative_path !== item.name ? item.relative_path : null)
    : (item.original_path || null);
  const pathLine = subPath
    ? `<div class="file-path" title="${escAttr(subPath)}">${type === 'trash' ? '↩ ' : ''}${escHtml(subPath)}</div>`
    : '';

  let actions = '';
  if (type === 'orphan') {
    actions = `<button class="btn btn-warning" onclick="moveOne('${pathAttr}')">Move to Trash</button>`;
  } else {
    actions = `
      <button class="btn btn-success" onclick="restoreOne('${pathAttr}')">Restore</button>
      <button class="btn btn-danger btn-ghost" onclick="deleteOne('${pathAttr}')">Delete</button>
    `;
  }

  return `
    <div class="file-row">
      <div class="file-icon">${icon}</div>
      <div class="file-info">
        <div class="file-name" title="${escAttr(item.name)}">${escHtml(item.name)}</div>
        <div class="file-meta">
          <span>${escHtml(item.size_human)}</span>
          <span>${date}</span>
        </div>
        ${pathLine}
      </div>
      <div class="file-actions">${actions}</div>
    </div>
  `;
}

function formatAge(date) {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ── Modal ─────────────────────────────────────────────────────────────────────

let _confirmCallback = null;

function confirm(title, body, cb) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent = body;
  _confirmCallback = cb;
  const btn = document.getElementById('modal-confirm-btn');
  btn.onclick = () => { closeModal(); cb(); };
  btn.className = title.toLowerCase().includes('delete') ? 'btn btn-danger' : 'btn btn-warning';
  btn.textContent = title.toLowerCase().includes('restore') ? 'Restore' : 'Confirm';
  document.getElementById('modal-backdrop').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-backdrop').classList.remove('open');
  _confirmCallback = null;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let _toastTimer = null;

function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.classList.remove('show'); }, 3000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function apiFetch(url, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str ?? '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function setLoading(on) {
  document.querySelectorAll('.btn').forEach(b => b.disabled = on);
}
