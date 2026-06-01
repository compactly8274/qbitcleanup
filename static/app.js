'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

let currentTab = 'orphans';
let orphansData = [];
let trashData = [];
let ignoredData = [];
let deadData = [];
let lastOrphanRes = null;
let selectedPaths = new Set();
let groupingEnabled = false;
let groupingMode = 'none'; // 'none' | 'type' | 'folder'
let _groupPathStore = [];
let _ignoreDialogBasePath = '';

// Pagination
let pageSize = 50;
const currentPage = { orphans: 1, trash: 1 };

// Job tracking
let pendingJobs = new Map(); // job_id -> {type, tab}
let jobPollTimer = null;

const FILE_TYPES = {
  '📹 Video':    ['mkv','mp4','avi','mov','wmv','m4v','mpg','mpeg','ts','m2ts','flv','webm','vob'],
  '🎵 Audio':    ['mp3','flac','wav','aac','ogg','opus','m4a','wma'],
  '💬 Subtitle': ['srt','ass','ssa','vtt','sub','idx','sup'],
  '📦 Archive':  ['zip','rar','7z','tar','gz','bz2','xz','iso','r00'],
};

function fileTypeLabel(name) {
  const ext = name.split('.').pop().toLowerCase();
  for (const [label, exts] of Object.entries(FILE_TYPES)) {
    if (exts.includes(ext)) return label;
  }
  return '📄 Other';
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );
  document.addEventListener('click', e => {
    if (_jobsPanelOpen &&
        !document.getElementById('jobs-panel').contains(e.target) &&
        e.target.id !== 'jobs-indicator') {
      closeJobsPanel();
    }
  });
  refreshStatus();
  loadOrphans();
  setInterval(refreshStatus, 15000);
});

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${tab}`));
  clearSelection();
  if (tab === 'orphans') loadOrphans();
  else if (tab === 'trash') loadTrash();
  else if (tab === 'dead') loadDead();
  else if (tab === 'stats') loadStats();
  else loadIgnored();
}

// ── Status + disk bar ─────────────────────────────────────────────────────────

async function refreshStatus() {
  try {
    const d = await apiFetch('/api/status');
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    dot.className = 'status-dot ' + (d.connected ? 'connected' : 'disconnected');
    text.textContent = d.connected
      ? `Connected${d.version ? ' ' + d.version : ''}`
      : (d.error ? `Offline: ${d.error}` : 'Offline');

    setBadge('orphans', d.orphan_count ?? 0);
    setBadge('trash', d.trash_count ?? 0);
    setBadge('ignored', d.ignored_count ?? 0);
    renderDiskBar(d.disk, d.orphan_size ?? 0);
  } catch {
    document.getElementById('status-dot').className = 'status-dot disconnected';
    document.getElementById('status-text').textContent = 'Error';
  }
}

function renderDiskBar(disk, orphanSize) {
  const el = document.getElementById('disk-bar');
  if (!disk || !disk.total) { el.innerHTML = ''; return; }
  const pct = v => Math.round(v / disk.total * 100);
  const orphanPct = pct(orphanSize);
  el.innerHTML = `
    <div class="disk-track" style="--orphan-pct:${orphanPct}%">
      <div class="disk-track-fill" style="width:${pct(disk.used)}%"></div>
    </div>
    <span class="disk-orphan">&#9632; ${fmtSize(orphanSize)} orphaned</span>
    <span class="disk-free">&#9632; ${fmtSize(disk.free)} free</span>
    <span style="color:var(--text-muted)">of ${fmtSize(disk.total)} total</span>
  `;
}

function setBadge(tab, n) {
  const el = document.getElementById(`badge-${tab}`);
  if (el) el.textContent = n;
}

// ── Job queue polling ─────────────────────────────────────────────────────────

function trackJob(jobId, type, tab) {
  pendingJobs.set(jobId, { type, tab });
  updateJobsIndicator();
  if (!jobPollTimer) {
    jobPollTimer = setInterval(pollJobs, 1500);
  }
}

async function pollJobs() {
  if (!pendingJobs.size) {
    clearInterval(jobPollTimer);
    jobPollTimer = null;
    updateJobsIndicator();
    closeJobsPanel();
    return;
  }
  try {
    const active = await apiFetch('/api/jobs');
    renderJobsPanel(active);
    const activeIds = new Set(active.map(j => j.id));
    const completed = [...pendingJobs.keys()].filter(id => !activeIds.has(id));
    for (const id of completed) {
      const info = pendingJobs.get(id);
      pendingJobs.delete(id);
      try {
        const job = await apiFetch(`/api/jobs/${id}`);
        _handleJobDone(job, info);
      } catch {
        _refreshAfterJob(info.tab);
      }
    }
    updateJobsIndicator();
  } catch { /* ignore poll errors */ }
}

// ── Jobs panel ────────────────────────────────────────────────────────────────

const JOB_LABELS = {
  move_to_trash: 'Moving to trash',
  restore: 'Restoring',
  delete: 'Deleting',
};

let _jobsPanelOpen = false;

function toggleJobsPanel(e) {
  e.stopPropagation();
  const panel = document.getElementById('jobs-panel');
  if (_jobsPanelOpen) {
    closeJobsPanel();
  } else {
    _positionJobsPanel();
    panel.style.display = 'block';
    _jobsPanelOpen = true;
  }
}

function closeJobsPanel() {
  document.getElementById('jobs-panel').style.display = 'none';
  _jobsPanelOpen = false;
}

function _positionJobsPanel() {
  const indicator = document.getElementById('jobs-indicator');
  const panel = document.getElementById('jobs-panel');
  const rect = indicator.getBoundingClientRect();
  panel.style.top = (rect.bottom + 8) + 'px';
  panel.style.right = (window.innerWidth - rect.right) + 'px';
  panel.style.left = 'auto';
}

function renderJobsPanel(jobs) {
  if (!_jobsPanelOpen) return;
  _positionJobsPanel();
  const list = document.getElementById('jobs-panel-list');
  if (!jobs.length) { closeJobsPanel(); return; }

  list.innerHTML = jobs.map(job => {
    const label = JOB_LABELS[job.type] || job.type;
    const total = job.total || 0;
    const done = job.progress || 0;
    const hasCount = total > 0;
    const pct = hasCount ? Math.round(done / total * 100) : 0;
    const isQueued = job.status === 'queued';
    const jid = escAttr(job.id);

    let etaHtml = '';
    if (!isQueued && job.started_at && done > 0 && hasCount) {
      const elapsed = Date.now() / 1000 - job.started_at;
      const rate = done / elapsed;
      const remaining = (total - done) / rate;
      etaHtml = `<div class="job-eta">~${_fmtDuration(remaining)} remaining</div>`;
    } else if (isQueued) {
      etaHtml = `<div class="job-eta">queued</div>`;
    } else if (!hasCount) {
      etaHtml = `<div class="job-eta">processing…</div>`;
    }

    const fraction = hasCount ? `${done} / ${total}` : '—';

    const currentFile = (!isQueued && job.current_file)
      ? `<div class="job-current-file" title="${escAttr(job.current_file)}">${escHtml(_truncateFilename(job.current_file, 38))}</div>`
      : '';

    return `<div class="job-item">
      <div class="job-item-label">
        <span>${escHtml(label)}</span>
        <div style="display:flex;align-items:center;gap:0.5rem">
          <span class="job-item-fraction">${fraction}</span>
          <button class="job-cancel-btn" onclick="cancelJob('${jid}')" title="Cancel">✕</button>
        </div>
      </div>
      <div class="job-progress-track">
        <div class="job-progress-fill" style="width:${pct}%"></div>
      </div>
      ${currentFile}
      ${etaHtml}
    </div>`;
  }).join('');
}

async function cancelJob(jobId) {
  try {
    await apiFetch(`/api/jobs/${jobId}/cancel`, 'POST');
    pendingJobs.delete(jobId);
    updateJobsIndicator();
    showToast('Job cancelled', 'success');
    await Promise.all([loadOrphans(), loadTrash(), refreshStatus()]);
  } catch (e) { showToast(e.message, 'error'); }
}

async function cancelAllJobs() {
  try {
    await apiFetch('/api/jobs/cancel', 'POST');
    pendingJobs.clear();
    closeJobsPanel();
    updateJobsIndicator();
    showToast('All jobs cancelled', 'success');
    await Promise.all([loadOrphans(), loadTrash(), refreshStatus()]);
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Pagination ────────────────────────────────────────────────────────────────

function _paginate(items, page) {
  if (!pageSize) return { items, page: 1, totalPages: 1, start: 0, end: items.length, total: items.length };
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * pageSize;
  const end = Math.min(start + pageSize, items.length);
  return { items: items.slice(start, end), page: p, totalPages, start, end, total: items.length };
}

function _pageNums(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const s = new Set([1, total, cur, Math.max(1, cur - 1), Math.min(total, cur + 1)]);
  const sorted = [...s].sort((a, b) => a - b);
  const r = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) r.push('…');
    r.push(p);
    prev = p;
  }
  return r;
}

function _renderPagination(tab, paged) {
  const { page, totalPages, start, end, total } = paged;
  if (totalPages <= 1 && !pageSize) return '';

  const btns = _pageNums(page, totalPages).map(n =>
    typeof n === 'string'
      ? `<span class="page-ellipsis">${n}</span>`
      : `<button class="page-btn${n === page ? ' active' : ''}" onclick="goToPage('${tab}',${n})">${n}</button>`
  ).join('');

  const sizeOpts = [25, 50, 100, 250, 0].map(n =>
    `<option value="${n}"${pageSize === n ? ' selected' : ''}>${n || 'All'}</option>`
  ).join('');

  return `<div class="pagination">
    <span class="page-info">${total ? start + 1 : 0}–${end} of ${total}</span>
    <div class="page-btns">
      <button class="page-btn" onclick="goToPage('${tab}',${page - 1})"${page <= 1 ? ' disabled' : ''}>‹</button>
      ${btns}
      <button class="page-btn" onclick="goToPage('${tab}',${page + 1})"${page >= totalPages ? ' disabled' : ''}>›</button>
    </div>
    <select class="page-size-sel" onchange="setPageSize(+this.value)" title="Items per page">${sizeOpts}</select>
  </div>`;
}

function goToPage(tab, page) {
  currentPage[tab] = page;
  if (tab === 'orphans') renderOrphans();
  else renderTrash();
}

function setPageSize(size) {
  pageSize = size;
  currentPage.orphans = 1;
  currentPage.trash = 1;
  if (currentTab === 'orphans') renderOrphans();
  else if (currentTab === 'trash') renderTrash();
}

async function movePageItems() {
  const filtered = applyFilters(orphansData, 'orphan');
  const paged = _paginate(filtered, currentPage.orphans);
  const paths = paged.items.map(i => i.path);
  if (!paths.length) return;
  const pathSet = new Set(paths);
  orphansData = orphansData.filter(i => !pathSet.has(i.path));
  renderOrphans();
  setBadge('orphans', orphansData.length);
  try {
    const res = await apiFetch('/api/orphans/move', 'POST', { paths });
    trackJob(res.job_id, 'move_to_trash', 'orphans');
    showToast(`Moving ${paths.length} item${paths.length !== 1 ? 's' : ''} to trash…`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
    loadOrphans();
  }
}

async function trashGroup(idx) {
  const paths = _groupPathStore[idx];
  if (!paths || !paths.length) return;
  const pathSet = new Set(paths);
  orphansData = orphansData.filter(i => !pathSet.has(i.path));
  renderOrphans();
  setBadge('orphans', orphansData.length);
  try {
    const res = await apiFetch('/api/orphans/move', 'POST', { paths });
    trackJob(res.job_id, 'move_to_trash', 'orphans');
    showToast(`Moving ${paths.length} item${paths.length !== 1 ? 's' : ''} to trash…`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
    loadOrphans();
  }
}

function _truncateFilename(name, max) {
  if (name.length <= max) return name;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  return name.slice(0, max - ext.length - 1) + '…' + ext;
}

function _fmtDuration(s) {
  if (s < 5) return 'a moment';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function _handleJobDone(job, info) {
  const r = job.result || {};
  if (job.status === 'cancelled') {
    return; // already handled at cancel time
  }
  if (job.status === 'error') {
    showToast(`Error: ${r.error || 'Unknown error'}`, 'error');
  } else {
    let msg = '';
    if (job.type === 'move_to_trash') {
      const ok = r.moved?.length ?? 0, gone = r.not_found?.length ?? 0, fail = r.errors?.length ?? 0;
      msg = `Moved ${ok} to trash`;
      if (gone) msg += `, ${gone} already gone`;
      if (fail) msg += `, ${fail} failed`;
    } else if (job.type === 'restore') {
      const ok = r.restored?.length ?? 0, gone = r.not_found?.length ?? 0, fail = r.errors?.length ?? 0;
      msg = `Restored ${ok}`;
      if (gone) msg += `, ${gone} already gone`;
      if (fail) msg += `, ${fail} failed`;
    } else if (job.type === 'delete') {
      const ok = r.deleted?.length ?? 0, fail = r.errors?.length ?? 0;
      msg = `Deleted ${ok}${fail ? `, ${fail} failed` : ''}`;
      if (fail && r.errors?.[0]?.error) msg += ` — ${r.errors[0].error}`;
    }
    showToast(msg, r.errors?.length ? 'error' : 'success');
  }
  _refreshAfterJob(info.tab);
}

function _refreshAfterJob(tab) {
  if (tab === 'orphans') Promise.all([loadOrphans(), refreshStatus()]);
  else if (tab === 'trash') Promise.all([loadTrash(), refreshStatus()]);
  else refreshStatus();
}

function updateJobsIndicator() {
  const el = document.getElementById('jobs-indicator');
  if (!el) return;
  const n = pendingJobs.size;
  el.style.display = n ? '' : 'none';
  el.textContent = `${n} job${n !== 1 ? 's' : ''} running`;
}

// ── Orphans ───────────────────────────────────────────────────────────────────

async function loadOrphans(force = false) {
  setListLoading('orphans-list', force ? 'Scanning…' : 'Loading…');
  currentPage.orphans = 1;
  try {
    const res = await apiFetch(force ? '/api/orphans?refresh=true' : '/api/orphans');
    orphansData = res.orphans ?? [];
    lastOrphanRes = res;
    renderOrphans();
    setBadge('orphans', orphansData.length);
  } catch (err) {
    document.getElementById('orphans-list').innerHTML =
      `<div class="error-banner">${escHtml(err.message)}</div>`;
  }
}

function renderOrphans() {
  _groupPathStore = [];
  const list = document.getElementById('orphans-list');
  const res = lastOrphanRes || {};
  const lastScan = res.last_scan ? new Date(res.last_scan * 1000) : null;
  const meta = `<div class="scan-meta">${
    res.cached
      ? `<span class="scan-cached">cached · ${lastScan ? formatAge(lastScan) : '—'}</span>`
      : '<span class="scan-fresh">scanned just now</span>'
  }${res.warning ? ` &nbsp;⚠ ${escHtml(res.warning)}` : ''}</div>`;

  const filtered = applyFilters(orphansData, 'orphan');

  if (!filtered.length) {
    list.innerHTML = meta + '<div class="empty-state"><div class="empty-icon">✓</div><div>No orphaned files found</div></div>';
    return;
  }

  const paged = _paginate(filtered, currentPage.orphans);
  currentPage.orphans = paged.page;
  const rows = groupingEnabled ? renderGrouped(paged.items, 'orphan') : paged.items.map(i => fileRow(i, 'orphan')).join('');
  list.innerHTML = meta + rows + _renderPagination('orphans', paged);
}

// ── Trash ─────────────────────────────────────────────────────────────────────

async function loadTrash() {
  setListLoading('trash-list', 'Loading…');
  currentPage.trash = 1;
  try {
    trashData = await apiFetch('/api/trash');
    renderTrash();
    setBadge('trash', trashData.length);
  } catch (err) {
    document.getElementById('trash-list').innerHTML =
      `<div class="error-banner">${escHtml(err.message)}</div>`;
  }
}

function renderTrash() {
  const list = document.getElementById('trash-list');
  const filtered = applyFilters(trashData, 'trash');
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🗑</div><div>Trash is empty</div></div>';
    return;
  }
  const paged = _paginate(filtered, currentPage.trash);
  currentPage.trash = paged.page;
  list.innerHTML = paged.items.map(i => fileRow(i, 'trash')).join('') + _renderPagination('trash', paged);
}

// ── Ignored ───────────────────────────────────────────────────────────────────

async function loadIgnored() {
  setListLoading('ignored-list', 'Loading…');
  try {
    ignoredData = await apiFetch('/api/ignore');
    renderIgnored();
    setBadge('ignored', ignoredData.length);
  } catch (err) {
    document.getElementById('ignored-list').innerHTML =
      `<div class="error-banner">${escHtml(err.message)}</div>`;
  }
}

function _ignorePatternMeta(raw) {
  if (raw.endsWith('//')) return { display: raw.slice(0, -2), scope: 'folder entry only' };
  if (raw.endsWith('/*')) return { display: raw, scope: 'contents only' };
  if (/[*?[\]]/.test(raw))  return { display: raw, scope: 'pattern' };
  return { display: raw, scope: 'folder + contents' };
}

function renderIgnored() {
  const list = document.getElementById('ignored-list');
  if (!ignoredData.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">✓</div><div>No ignored paths</div></div>';
    return;
  }
  list.innerHTML = ignoredData.map(item => {
    const { display, scope } = _ignorePatternMeta(item.path);
    const pa = escAttr(item.path);
    return `
    <div class="file-row">
      <div class="row-check"></div>
      <div class="file-icon">🚫</div>
      <div class="file-info">
        <div class="file-name" style="cursor:default">${escHtml(display)}</div>
        <div class="file-meta">
          <span class="ignore-scope-badge">${escHtml(scope)}</span>
          <span>Added ${new Date(item.added_at * 1000).toLocaleDateString()}</span>
        </div>
      </div>
      <div class="file-actions">
        <button class="btn btn-secondary btn-sm" onclick="unignore('${pa}')">Unignore</button>
      </div>
    </div>`;
  }).join('');
}

// ── Filtering + sorting ───────────────────────────────────────────────────────

function applyFilters(data, type) {
  const searchId = type === 'orphan' ? 'search-orphans' : 'search-trash';
  const sortId   = type === 'orphan' ? 'orphan-sort'    : 'trash-sort';
  const query = (document.getElementById(searchId)?.value ?? '').toLowerCase();
  const ageDays = parseInt(document.getElementById('age-filter')?.value ?? '0');
  const minSize = parseInt(document.getElementById('size-filter')?.value ?? '0');
  const [sortField, sortDir] = (document.getElementById(sortId)?.value ?? 'size-desc').split('-');
  const asc = sortDir === 'asc';
  const key = sortField === 'size' ? 'size' : 'accessed';
  const cutoff = ageDays ? Date.now() / 1000 - ageDays * 86400 : 0;

  return data
    .filter(i => !query || i.name.toLowerCase().includes(query) || (i.relative_path || '').toLowerCase().includes(query))
    .filter(i => !cutoff || i.modified < cutoff)
    .filter(i => !minSize || i.size >= minSize)
    .sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]);
}

function renderGrouped(items, type) {
  const groups = {};
  if (groupingMode === 'folder') {
    for (const item of items) {
      const rel = item.relative_path || item.name;
      const top = rel.includes('/') ? rel.split('/')[0] : '(root)';
      (groups[top] ??= []).push(item);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([label, grpItems]) => {
      const totalSize = grpItems.reduce((s, i) => s + i.size, 0);
      const idx = _groupPathStore.length;
      _groupPathStore.push(grpItems.map(i => i.path));
      return `<div class="group-header">
        📁 ${escHtml(label)}
        <span style="opacity:.5">(${grpItems.length} · ${fmtSize(totalSize)})</span>
        <button class="btn btn-warning btn-sm group-trash-btn" onclick="trashGroup(${idx})">Trash All</button>
      </div>` + grpItems.map(i => fileRow(i, type)).join('');
    }).join('');
  }
  // type grouping (existing)
  for (const item of items) {
    const label = item.is_dir ? '📁 Folders' : fileTypeLabel(item.name);
    (groups[label] ??= []).push(item);
  }
  const order = ['📁 Folders', '📹 Video', '🎵 Audio', '💬 Subtitle', '📦 Archive', '📄 Other'];
  const sorted = Object.entries(groups).sort(([a], [b]) => {
    const ai = order.indexOf(a), bi = order.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  return sorted.map(([label, grpItems]) =>
    `<div class="group-header">${escHtml(label)} <span style="opacity:.5">(${grpItems.length})</span></div>` +
    grpItems.map(i => fileRow(i, type)).join('')
  ).join('');
}

function toggleGrouping() {
  const modes = ['none', 'type', 'folder'];
  groupingMode = modes[(modes.indexOf(groupingMode) + 1) % 3];
  groupingEnabled = groupingMode !== 'none';
  const labels = { none: '⊞ Group', type: '⊞ By Type', folder: '⊞ By Folder' };
  const btn = document.getElementById('btn-group');
  btn.textContent = labels[groupingMode];
  btn.classList.toggle('active', groupingMode !== 'none');
  renderOrphans();
}

// ── File row ──────────────────────────────────────────────────────────────────

function fileRow(item, type) {
  const isOrphan = type === 'orphan';
  const path = isOrphan ? item.path : item.trash_path;
  const icon = item.is_dir ? '📁' : (isOrphan ? fileTypeIcon(item.name) : '📄');
  const accessed = item.accessed ? new Date(item.accessed * 1000).toLocaleDateString() : '—';
  const pa = escAttr(path);
  const subPath = isOrphan
    ? (item.relative_path !== item.name ? item.relative_path : null)
    : (item.original_path || null);
  const pathLine = subPath
    ? `<div class="file-path" title="${escAttr(subPath)}">${isOrphan ? '' : '↩ '}${escHtml(subPath)}</div>`
    : '';
  const checked = selectedPaths.has(path) ? 'checked' : '';
  const selCls = selectedPaths.has(path) ? ' selected' : '';

  let actions = '';
  if (isOrphan) {
    actions = `<button class="btn btn-warning btn-sm" onclick="moveOne('${pa}')">Trash</button>
               <button class="btn btn-ghost btn-sm" onclick="ignoreOne('${pa}',${item.is_dir})">Ignore</button>`;
  } else {
    actions = `<button class="btn btn-success btn-sm" onclick="restoreOne('${pa}')">Restore</button>
               <button class="btn btn-danger btn-sm btn-ghost" onclick="deleteOne('${pa}')">Delete</button>`;
  }

  return `<div class="file-row${selCls}">
    <div class="row-check"><input type="checkbox" ${checked} onchange="toggleSelect('${pa}', '${type}', this)"></div>
    <div class="file-icon">${icon}</div>
    <div class="file-info">
      <div class="file-name" title="Click to show full path" onclick="toggleFullPath(this,'${pa}')">${escHtml(item.name)}</div>
      <div class="file-meta"><span>${escHtml(item.size_human)}</span><span title="Last accessed">⏱ ${accessed}</span></div>
      ${pathLine}
    </div>
    <div class="file-actions">${actions}</div>
  </div>`;
}

function fileTypeIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['mkv','mp4','avi','mov','wmv','m4v','mpg','mpeg','ts','flv','webm'].includes(ext)) return '📹';
  if (['mp3','flac','wav','aac','ogg','opus','m4a','wma'].includes(ext)) return '🎵';
  if (['srt','ass','ssa','vtt','sub','idx'].includes(ext)) return '💬';
  if (['zip','rar','7z','tar','gz','bz2','xz','iso'].includes(ext)) return '📦';
  return '📄';
}

// ── Selection ─────────────────────────────────────────────────────────────────

function toggleSelect(path, type, cb) {
  if (cb.checked) selectedPaths.add(path);
  else selectedPaths.delete(path);
  cb.closest('.file-row').classList.toggle('selected', cb.checked);
  updateSelectionBar(type);
}

function toggleSelectAll(type) {
  const cbId = type === 'orphans' ? 'check-all-orphans' : 'check-all-trash';
  const master = document.getElementById(cbId);
  const tab = type === 'orphans' ? 'orphans' : 'trash';
  const filtered = type === 'orphans' ? applyFilters(orphansData, 'orphan') : applyFilters(trashData, 'trash');
  const paged = _paginate(filtered, currentPage[tab]);
  const pathKey = type === 'orphans' ? 'path' : 'trash_path';
  if (master.checked) paged.items.forEach(i => selectedPaths.add(i[pathKey]));
  else paged.items.forEach(i => selectedPaths.delete(i[pathKey]));
  if (type === 'orphans') renderOrphans(); else renderTrash();
  updateSelectionBar(type === 'orphans' ? 'orphan' : 'trash');
}

function clearSelection() {
  selectedPaths.clear();
  document.querySelectorAll('#check-all-orphans, #check-all-trash').forEach(c => c.checked = false);
  if (currentTab === 'orphans') renderOrphans();
  else if (currentTab === 'trash') renderTrash();
  updateSelectionBar('none');
}

function updateSelectionBar(type) {
  const bar = document.getElementById('selection-bar');
  const count = selectedPaths.size;
  if (!count) { bar.classList.remove('visible'); return; }

  document.getElementById('sel-count').textContent = `${count} selected`;
  const acts = document.getElementById('sel-actions');
  if (type === 'orphan') {
    acts.innerHTML = `
      <button class="btn btn-warning btn-sm" onclick="moveSelected()">Move to Trash</button>
      <button class="btn btn-ghost btn-sm" onclick="ignoreSelected()">Ignore</button>`;
  } else {
    acts.innerHTML = `
      <button class="btn btn-success btn-sm" onclick="restoreSelected()">Restore</button>
      <button class="btn btn-danger btn-sm" onclick="deleteSelected()">Delete</button>`;
  }
  bar.classList.add('visible');
}

// ── Actions — single ──────────────────────────────────────────────────────────

async function moveOne(path) {
  orphansData = orphansData.filter(i => i.path !== path);
  renderOrphans();
  setBadge('orphans', orphansData.length);
  try {
    const res = await apiFetch('/api/orphans/move', 'POST', { path });
    trackJob(res.job_id, 'move_to_trash', 'orphans');
    showToast('Moving to trash…', 'success');
  } catch (e) {
    showToast(e.message, 'error');
    loadOrphans();
  }
}

function ignoreOne(path, isDir) {
  _openIgnoreDialog(path, !!isDir);
}

function _openIgnoreDialog(path, isDir) {
  _ignoreDialogBasePath = path;
  const scopeHtml = isDir ? `
    <div class="ignore-scope-options">
      <label class="ignore-scope-opt">
        <input type="radio" name="ignore-scope" value="full" checked
               onchange="_ignoreDialogScopeChange('full')">
        <div>
          <div class="ignore-scope-title">Folder and contents</div>
          <div class="ignore-scope-desc">Both the folder and everything inside are fully hidden — nothing inside will ever appear as an orphan</div>
        </div>
      </label>
      <label class="ignore-scope-opt">
        <input type="radio" name="ignore-scope" value="contents"
               onchange="_ignoreDialogScopeChange('contents')">
        <div>
          <div class="ignore-scope-title">Contents only</div>
          <div class="ignore-scope-desc">Files inside are hidden; the folder itself can still appear as an orphan if qBit stops seeding it</div>
        </div>
      </label>
      <label class="ignore-scope-opt">
        <input type="radio" name="ignore-scope" value="folder"
               onchange="_ignoreDialogScopeChange('folder')">
        <div>
          <div class="ignore-scope-title">Folder entry only</div>
          <div class="ignore-scope-desc">The folder row is hidden, but files inside will still show up individually as orphans and can be trashed</div>
        </div>
      </label>
    </div>` : '';

  document.getElementById('modal-title').textContent = 'Ignore path';
  document.getElementById('modal-body').innerHTML = `
    <div style="margin-bottom:0.5rem;font-size:0.82rem">
      Use <code style="background:var(--surface);padding:0.1em 0.35em;border-radius:3px">*</code>
      as a wildcard — e.g. <code style="background:var(--surface);padding:0.1em 0.35em;border-radius:3px">unpackerr*.log</code>
      matches any rotating log file.
    </div>
    <input type="text" id="ignore-pattern-input" class="search-input"
           style="width:100%;font-family:monospace;font-size:0.82rem"
           value="${escHtml(path)}"
           onkeydown="if(event.key==='Enter')document.getElementById('modal-confirm-btn').click()">
    ${scopeHtml}
  `;
  const btn = document.getElementById('modal-confirm-btn');
  btn.className = 'btn btn-secondary';
  btn.textContent = 'Ignore';
  btn.onclick = async () => {
    const pattern = document.getElementById('ignore-pattern-input')?.value.trim();
    if (!pattern) return;
    closeModal();
    try {
      await apiFetch('/api/ignore/add', 'POST', { path: pattern });
      orphansData = orphansData.filter(i => !_pathMatchesIgnore(i.path, pattern));
      renderOrphans();
      showToast('Ignored', 'success');
      refreshStatus();
    } catch (e) { showToast(e.message, 'error'); }
  };
  document.getElementById('modal-backdrop').classList.add('open');
  requestAnimationFrame(() => {
    const inp = document.getElementById('ignore-pattern-input');
    if (inp) { inp.focus(); inp.select(); }
  });
}

function _ignoreDialogScopeChange(scope) {
  const inp = document.getElementById('ignore-pattern-input');
  if (!inp) return;
  const base = _ignoreDialogBasePath.replace(/\/$/, '');
  if (scope === 'contents') inp.value = base + '/*';
  else if (scope === 'folder') inp.value = base + '//';
  else inp.value = base;
}

function _pathMatchesIgnore(path, pattern) {
  if (pattern.endsWith('//')) {
    return path === pattern.slice(0, -2).replace(/\/$/, '');
  }
  if (!/[*?[\]]/.test(pattern)) {
    return path === pattern || path.startsWith(pattern.replace(/\/$/, '') + '/');
  }
  // Match Python fnmatch: * matches anything including /
  const re = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$');
  return re.test(path);
}

function toggleFullPath(el, fullPath) {
  const existing = el.parentElement.querySelector('.file-full-path');
  if (existing) { existing.remove(); return; }
  const div = document.createElement('div');
  div.className = 'file-full-path';
  div.textContent = fullPath;
  div.title = 'Click to copy';
  div.onclick = e => {
    e.stopPropagation();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(fullPath).then(() => showToast('Path copied', 'success'));
    } else {
      showToast(fullPath, 'info');
    }
  };
  el.after(div);
}

async function unignore(path) {
  try {
    await apiFetch('/api/ignore/remove', 'POST', { path });
    showToast('Unignored — cache invalidated', 'success');
    await Promise.all([loadIgnored(), refreshStatus()]);
  } catch (e) { showToast(e.message, 'error'); }
}

async function restoreOne(path) {
  trashData = trashData.filter(i => i.trash_path !== path);
  renderTrash();
  setBadge('trash', trashData.length);
  try {
    const res = await apiFetch('/api/trash/restore', 'POST', { path });
    trackJob(res.job_id, 'restore', 'trash');
    showToast('Restoring…', 'success');
  } catch (e) {
    showToast(e.message, 'error');
    loadTrash();
  }
}

async function deleteOne(path) {
  confirm('Permanently Delete', 'This cannot be undone. Delete this item forever?', async () => {
    trashData = trashData.filter(i => i.trash_path !== path);
    renderTrash();
    setBadge('trash', trashData.length);
    try {
      const res = await apiFetch('/api/trash/delete', 'POST', { path });
      trackJob(res.job_id, 'delete', 'trash');
      showToast('Deleting…', 'success');
    } catch (e) {
      showToast(e.message, 'error');
      loadTrash();
    }
  });
}

// ── Actions — bulk (all) ──────────────────────────────────────────────────────

async function moveAll() {
  const n = orphansData.length;
  if (!n) return;
  confirm('Move All to Trash', `Move all ${n} item${n !== 1 ? 's' : ''} to trash?`, async () => {
    orphansData = [];
    renderOrphans();
    setBadge('orphans', 0);
    clearSelection();
    try {
      const res = await apiFetch('/api/orphans/move', 'POST', {});
      trackJob(res.job_id, 'move_to_trash', 'orphans');
      showToast(`Moving ${n} item${n !== 1 ? 's' : ''} to trash…`, 'success');
    } catch (e) {
      showToast(e.message, 'error');
      loadOrphans();
    }
  });
}

async function restoreAll() {
  const n = trashData.length;
  if (!n) return;
  confirm('Restore All', `Restore all ${n} item${n !== 1 ? 's' : ''} to original locations?`, async () => {
    trashData = [];
    renderTrash();
    setBadge('trash', 0);
    clearSelection();
    try {
      const res = await apiFetch('/api/trash/restore', 'POST', {});
      trackJob(res.job_id, 'restore', 'trash');
      showToast(`Restoring ${n} item${n !== 1 ? 's' : ''}…`, 'success');
    } catch (e) {
      showToast(e.message, 'error');
      loadTrash();
    }
  });
}

async function deleteAll() {
  const n = trashData.length;
  if (!n) return;
  confirm('Delete All Permanently', `Permanently delete all ${n} item${n !== 1 ? 's' : ''}? This cannot be undone.`, async () => {
    trashData = [];
    renderTrash();
    setBadge('trash', 0);
    clearSelection();
    try {
      const res = await apiFetch('/api/trash/delete', 'POST', {});
      trackJob(res.job_id, 'delete', 'trash');
      showToast(`Deleting ${n} item${n !== 1 ? 's' : ''}…`, 'success');
    } catch (e) {
      showToast(e.message, 'error');
      loadTrash();
    }
  });
}

// ── Actions — bulk (selected) ─────────────────────────────────────────────────

async function moveSelected() {
  const paths = [...selectedPaths];
  if (!paths.length) return;
  orphansData = orphansData.filter(i => !selectedPaths.has(i.path));
  clearSelection();
  renderOrphans();
  setBadge('orphans', orphansData.length);
  try {
    const res = await apiFetch('/api/orphans/move', 'POST', { paths });
    trackJob(res.job_id, 'move_to_trash', 'orphans');
    showToast(`Moving ${paths.length} item${paths.length !== 1 ? 's' : ''} to trash…`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
    loadOrphans();
  }
}

async function ignoreSelected() {
  const paths = [...selectedPaths];
  if (!paths.length) return;
  try {
    await apiFetch('/api/ignore/add', 'POST', { paths });
    orphansData = orphansData.filter(i => !selectedPaths.has(i.path));
    clearSelection();
    renderOrphans();
    showToast(`Ignored ${paths.length} item${paths.length !== 1 ? 's' : ''}`, 'success');
    refreshStatus();
  } catch (e) { showToast(e.message, 'error'); }
}

async function restoreSelected() {
  const paths = [...selectedPaths];
  if (!paths.length) return;
  trashData = trashData.filter(i => !selectedPaths.has(i.trash_path));
  clearSelection();
  renderTrash();
  setBadge('trash', trashData.length);
  try {
    const res = await apiFetch('/api/trash/restore', 'POST', { paths });
    trackJob(res.job_id, 'restore', 'trash');
    showToast(`Restoring ${paths.length} item${paths.length !== 1 ? 's' : ''}…`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
    loadTrash();
  }
}

async function deleteSelected() {
  const paths = [...selectedPaths];
  if (!paths.length) return;
  confirm('Delete Selected', `Permanently delete ${paths.length} item${paths.length !== 1 ? 's' : ''}?`, async () => {
    trashData = trashData.filter(i => !selectedPaths.has(i.trash_path));
    clearSelection();
    renderTrash();
    setBadge('trash', trashData.length);
    try {
      const res = await apiFetch('/api/trash/delete', 'POST', { paths });
      trackJob(res.job_id, 'delete', 'trash');
      showToast(`Deleting ${paths.length} item${paths.length !== 1 ? 's' : ''}…`, 'success');
    } catch (e) {
      showToast(e.message, 'error');
      loadTrash();
    }
  });
}

// ── Unregistered torrents ─────────────────────────────────────────────────────

async function loadDead() {
  setListLoading('dead-list', 'Checking tracker status… (may take a few seconds)');
  try {
    const res = await apiFetch('/api/unregistered');
    deadData = res.torrents ?? [];
    renderDead();
    setBadge('dead', deadData.length || '');
  } catch (err) {
    document.getElementById('dead-list').innerHTML =
      `<div class="error-banner">${escHtml(err.message)}</div>`;
  }
}

function renderDead() {
  const list = document.getElementById('dead-list');
  if (!deadData.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">✓</div><div>No unregistered torrents found</div></div>';
    return;
  }
  list.innerHTML = deadData.map(t => _deadRow(t)).join('');
}

function _deadRow(t) {
  const h = escAttr(t.hash);
  const added = t.added_on ? new Date(t.added_on * 1000).toLocaleDateString() : '—';
  return `<div class="file-row">
    <div class="row-check"></div>
    <div class="file-icon">🧲</div>
    <div class="file-info">
      <div class="file-name" style="cursor:default">${escHtml(t.name)}</div>
      <div class="file-meta">
        <span>${escHtml(t.size_human)}</span>
        <span>ratio ${t.ratio}</span>
        <span>added ${added}</span>
      </div>
      <div class="file-path">${escHtml(t.save_path)}</div>
      <div class="file-meta" style="color:var(--danger);margin-top:0.15rem">⚠ ${escHtml(t.tracker_msg)}</div>
    </div>
    <div class="file-actions">
      <button class="btn btn-secondary btn-sm" onclick="removeOneDead('${h}',false)" title="Remove from qBittorrent — files stay on disk and will appear as orphans">Remove</button>
      <button class="btn btn-danger btn-sm btn-ghost" onclick="removeOneDead('${h}',true)" title="Remove from qBittorrent AND permanently delete all files">Delete</button>
    </div>
  </div>`;
}

async function removeOneDead(hash, deleteFiles) {
  const title = deleteFiles ? 'Delete Torrent + Files' : 'Remove Torrent';
  const body = deleteFiles
    ? 'Permanently delete this torrent and all its files from disk? This cannot be undone.'
    : 'Remove this torrent from qBittorrent? Files will stay on disk and appear as orphans on the next scan.';
  confirm(title, body, async () => {
    deadData = deadData.filter(t => t.hash !== hash);
    renderDead();
    setBadge('dead', deadData.length || '');
    try {
      await apiFetch('/api/unregistered/remove', 'POST', { hashes: [hash], delete_files: deleteFiles });
      showToast(deleteFiles ? 'Torrent and files deleted' : 'Torrent removed — rescan orphans to see freed files', 'success');
      refreshStatus();
    } catch (e) {
      showToast(e.message, 'error');
      loadDead();
    }
  });
}

async function removeAllDead(deleteFiles) {
  const n = deadData.length;
  if (!n) return;
  const title = deleteFiles ? 'Delete All + Files' : 'Remove All Torrents';
  const body = deleteFiles
    ? `Permanently delete all ${n} unregistered torrent${n !== 1 ? 's' : ''} and their files? This cannot be undone.`
    : `Remove all ${n} unregistered torrent${n !== 1 ? 's' : ''} from qBittorrent? Files will stay on disk as orphans.`;
  confirm(title, body, async () => {
    const hashes = deadData.map(t => t.hash);
    deadData = [];
    renderDead();
    setBadge('dead', '');
    try {
      await apiFetch('/api/unregistered/remove', 'POST', { hashes, delete_files: deleteFiles });
      showToast(deleteFiles ? `Deleted ${n} torrent${n !== 1 ? 's' : ''} and files` : `Removed ${n} torrent${n !== 1 ? 's' : ''}`, 'success');
      refreshStatus();
    } catch (e) {
      showToast(e.message, 'error');
      loadDead();
    }
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

async function loadStats() {
  document.getElementById('stats-cards').innerHTML = '<div class="loading"><span class="spinner"></span>Loading…</div>';
  document.getElementById('chart-cleanup').innerHTML = '';
  document.getElementById('chart-scans').innerHTML = '';
  try {
    const d = await apiFetch('/api/stats');
    _renderStatsCards(d);
    _renderCleanupChart(d.cleanup_history || []);
    _renderScanChart(d.scan_history || []);
  } catch (e) {
    document.getElementById('stats-cards').innerHTML = `<div class="error-banner">${escHtml(e.message)}</div>`;
  }
}

function _renderStatsCards(d) {
  const cards = [
    { label: 'Orphaned now', value: fmtSize(d.orphan_size || 0), sub: `${d.orphan_count || 0} items` },
    { label: 'In trash', value: fmtSize(d.trash_size || 0), sub: '' },
    { label: 'Cleaned (30d)', value: fmtSize(_sumBytes(d.cleanup_history, 'trash')), sub: `${_sumItems(d.cleanup_history, 'trash')} moved to trash` },
    { label: 'Deleted (30d)', value: `${_sumItems(d.cleanup_history, 'delete')} items`, sub: 'permanently removed' },
  ];
  document.getElementById('stats-cards').innerHTML = cards.map(c => `
    <div class="stat-card">
      <div class="stat-value">${c.value}</div>
      <div class="stat-label">${c.label}</div>
      ${c.sub ? `<div class="stat-sub">${c.sub}</div>` : ''}
    </div>
  `).join('');
}

function _sumBytes(events, action) {
  return (events || []).filter(e => e.action === action).reduce((s, e) => s + e.bytes_freed, 0);
}
function _sumItems(events, action) {
  return (events || []).filter(e => e.action === action).reduce((s, e) => s + e.item_count, 0);
}

function _renderCleanupChart(events) {
  const el = document.getElementById('chart-cleanup');
  const DAYS = 30;
  const now = Date.now() / 1000;
  const buckets = Array.from({ length: DAYS }, (_, i) => ({ trash: 0, delete: 0 }));
  for (const ev of events) {
    const idx = DAYS - 1 - Math.floor((now - ev.occurred_at) / 86400);
    if (idx >= 0 && idx < DAYS) {
      if (ev.action === 'trash') buckets[idx].trash += ev.bytes_freed;
      else buckets[idx].delete += ev.item_count * 1e8; // approximate for display
    }
  }
  const maxVal = Math.max(1, ...buckets.map(b => b.trash + b.delete));
  if (maxVal <= 1) { el.innerHTML = '<div class="chart-empty">No cleanup activity in the last 30 days.</div>'; return; }

  const W = 560, H = 140, pL = 58, pR = 8, pT = 8, pB = 28;
  const cW = W - pL - pR, cH = H - pT - pB;
  const bW = Math.max(2, cW / DAYS - 2);

  const bars = buckets.map((b, i) => {
    const x = pL + i * (cW / DAYS) + 1;
    const tH = (b.trash / maxVal) * cH;
    const dH = (b.delete / maxVal) * cH;
    return `<rect x="${x.toFixed(1)}" y="${(pT + cH - tH - dH).toFixed(1)}" width="${bW.toFixed(1)}" height="${dH.toFixed(1)}" fill="#ef4444" opacity="0.7"/>
            <rect x="${x.toFixed(1)}" y="${(pT + cH - tH).toFixed(1)}" width="${bW.toFixed(1)}" height="${tH.toFixed(1)}" fill="#f59e0b" opacity="0.75"/>`;
  }).join('');

  const yLines = [0, 0.5, 1].map(f => {
    const y = (pT + cH * (1 - f)).toFixed(1);
    return `<line x1="${pL}" x2="${W - pR}" y1="${y}" y2="${y}" stroke="#2d3148" stroke-dasharray="3,3"/>
            <text x="${pL - 4}" y="${(+y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#7a8399">${fmtSize(f * maxVal)}</text>`;
  }).join('');

  const xLabels = Array.from({ length: 6 }, (_, j) => {
    const i = Math.round(j * (DAYS - 1) / 5);
    const x = (pL + i * (cW / DAYS) + bW / 2).toFixed(1);
    const d = new Date((now - (DAYS - 1 - i) * 86400) * 1000);
    return `<text x="${x}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#7a8399">${d.getMonth()+1}/${d.getDate()}</text>`;
  }).join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block">
    ${yLines}${bars}${xLabels}
    <line x1="${pL}" x2="${pL}" y1="${pT}" y2="${pT+cH}" stroke="#2d3148"/>
    <line x1="${pL}" x2="${W-pR}" y1="${pT+cH}" y2="${pT+cH}" stroke="#2d3148"/>
  </svg>
  <div class="chart-legend">
    <span class="legend-dot" style="background:#f59e0b"></span>Trashed &nbsp;
    <span class="legend-dot" style="background:#ef4444"></span>Deleted
  </div>`;
}

function _renderScanChart(scans) {
  const el = document.getElementById('chart-scans');
  if (!scans.length) { el.innerHTML = '<div class="chart-empty">No scan history yet.</div>'; return; }

  const W = 560, H = 120, pL = 58, pR = 8, pT = 8, pB = 28;
  const cW = W - pL - pR, cH = H - pT - pB;
  const maxCount = Math.max(1, ...scans.map(s => s.orphan_count));
  const minT = scans[0].scanned_at, maxT = scans[scans.length - 1].scanned_at || (minT + 1);
  const tRange = Math.max(1, maxT - minT);

  const pts = scans.map(s => {
    const x = pL + ((s.scanned_at - minT) / tRange) * cW;
    const y = pT + cH - (s.orphan_count / maxCount) * cH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const dots = scans.map(s => {
    const x = (pL + ((s.scanned_at - minT) / tRange) * cW).toFixed(1);
    const y = (pT + cH - (s.orphan_count / maxCount) * cH).toFixed(1);
    return `<circle cx="${x}" cy="${y}" r="3" fill="#6366f1"/>`;
  }).join('');

  const yLines = [0, 0.5, 1].map(f => {
    const y = (pT + cH * (1 - f)).toFixed(1);
    const val = Math.round(f * maxCount);
    return `<line x1="${pL}" x2="${W-pR}" y1="${y}" y2="${y}" stroke="#2d3148" stroke-dasharray="3,3"/>
            <text x="${pL-4}" y="${(+y+4).toFixed(1)}" text-anchor="end" font-size="10" fill="#7a8399">${val}</text>`;
  }).join('');

  const area = `M${pL},${pT+cH} ` + scans.map(s => {
    const x = pL + ((s.scanned_at - minT) / tRange) * cW;
    const y = pT + cH - (s.orphan_count / maxCount) * cH;
    return `L${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ') + ` L${(pL + cW).toFixed(1)},${pT+cH} Z`;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block">
    ${yLines}
    <path d="${area}" fill="#6366f1" opacity="0.15"/>
    <polyline points="${pts}" fill="none" stroke="#6366f1" stroke-width="2"/>
    ${dots}
    <line x1="${pL}" x2="${pL}" y1="${pT}" y2="${pT+cH}" stroke="#2d3148"/>
    <line x1="${pL}" x2="${W-pR}" y1="${pT+cH}" y2="${pT+cH}" stroke="#2d3148"/>
  </svg>
  <div class="chart-legend"><span class="legend-dot" style="background:#6366f1"></span>Orphan count at scan time</div>`;
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function confirm(title, body, cb) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent = body;
  const btn = document.getElementById('modal-confirm-btn');
  btn.onclick = () => { closeModal(); cb(); };
  const tl = title.toLowerCase();
  btn.className = tl.includes('delete') ? 'btn btn-danger' : 'btn btn-warning';
  btn.textContent = tl.includes('restore') ? 'Restore' : tl.includes('delete') ? 'Delete' : 'Confirm';
  document.getElementById('modal-backdrop').classList.add('open');
}
function closeModal() { document.getElementById('modal-backdrop').classList.remove('open'); }

// ── Toast ─────────────────────────────────────────────────────────────────────

let _toastTimer;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), type === 'error' ? 7000 : 3000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function setListLoading(id, msg) {
  document.getElementById(id).innerHTML =
    `<div class="loading"><span class="spinner"></span>${msg}</div>`;
}

async function apiFetch(url, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body !== null) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) { return String(s ?? '').replace(/'/g,"\\'").replace(/"/g,'&quot;'); }

function formatAge(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

function fmtSize(b) {
  for (const u of ['B','KB','MB','GB','TB']) {
    if (b < 1024) return `${b.toFixed(1)} ${u}`;
    b /= 1024;
  }
  return `${b.toFixed(1)} PB`;
}
