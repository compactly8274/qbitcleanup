'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

let currentTab = 'orphans';
let orphansData = [];
let trashData = [];
let ignoredData = [];
let lastOrphanRes = null;
let selectedPaths = new Set();
let groupingEnabled = false;

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
      const ok = r.moved?.length ?? 0, fail = r.errors?.length ?? 0;
      msg = `Moved ${ok} to trash${fail ? `, ${fail} failed` : ''}`;
    } else if (job.type === 'restore') {
      const ok = r.restored?.length ?? 0, fail = r.errors?.length ?? 0;
      msg = `Restored ${ok}${fail ? `, ${fail} failed` : ''}`;
    } else if (job.type === 'delete') {
      const ok = r.deleted?.length ?? 0, fail = r.errors?.length ?? 0;
      msg = `Deleted ${ok}${fail ? `, ${fail} failed` : ''}`;
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

  list.innerHTML = meta + (groupingEnabled ? renderGrouped(filtered, 'orphan') : filtered.map(i => fileRow(i, 'orphan')).join(''));
}

// ── Trash ─────────────────────────────────────────────────────────────────────

async function loadTrash() {
  setListLoading('trash-list', 'Loading…');
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
  list.innerHTML = filtered.length
    ? filtered.map(i => fileRow(i, 'trash')).join('')
    : '<div class="empty-state"><div class="empty-icon">🗑</div><div>Trash is empty</div></div>';
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

function renderIgnored() {
  const list = document.getElementById('ignored-list');
  if (!ignoredData.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">✓</div><div>No ignored paths</div></div>';
    return;
  }
  list.innerHTML = ignoredData.map(item => `
    <div class="file-row">
      <div class="row-check"></div>
      <div class="file-icon">🚫</div>
      <div class="file-info">
        <div class="file-name" title="${escAttr(item.path)}">${escHtml(item.path)}</div>
        <div class="file-meta"><span>Added ${new Date(item.added_at * 1000).toLocaleDateString()}</span></div>
      </div>
      <div class="file-actions">
        <button class="btn btn-secondary btn-sm" onclick="unignore('${escAttr(item.path)}')">Unignore</button>
      </div>
    </div>
  `).join('');
}

// ── Filtering + sorting ───────────────────────────────────────────────────────

function applyFilters(data, type) {
  const searchId = type === 'orphan' ? 'search-orphans' : 'search-trash';
  const sortId   = type === 'orphan' ? 'orphan-sort'    : 'trash-sort';
  const query = (document.getElementById(searchId)?.value ?? '').toLowerCase();
  const ageDays = parseInt(document.getElementById('age-filter')?.value ?? '0');
  const [sortField, sortDir] = (document.getElementById(sortId)?.value ?? 'size-desc').split('-');
  const asc = sortDir === 'asc';
  const key = sortField === 'size' ? 'size' : 'accessed';
  const cutoff = ageDays ? Date.now() / 1000 - ageDays * 86400 : 0;

  return data
    .filter(i => !query || i.name.toLowerCase().includes(query) || (i.relative_path || '').toLowerCase().includes(query))
    .filter(i => !cutoff || i.modified < cutoff)
    .sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]);
}

function renderGrouped(items, type) {
  const groups = {};
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
  groupingEnabled = !groupingEnabled;
  document.getElementById('btn-group').classList.toggle('active', groupingEnabled);
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
               <button class="btn btn-ghost btn-sm" onclick="ignoreOne('${pa}')">Ignore</button>`;
  } else {
    actions = `<button class="btn btn-success btn-sm" onclick="restoreOne('${pa}')">Restore</button>
               <button class="btn btn-danger btn-sm btn-ghost" onclick="deleteOne('${pa}')">Delete</button>`;
  }

  return `<div class="file-row${selCls}">
    <div class="row-check"><input type="checkbox" ${checked} onchange="toggleSelect('${pa}', '${type}', this)"></div>
    <div class="file-icon">${icon}</div>
    <div class="file-info">
      <div class="file-name" title="${escAttr(item.name)}">${escHtml(item.name)}</div>
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
  const data = type === 'orphans' ? applyFilters(orphansData, 'orphan') : applyFilters(trashData, 'trash');
  const pathKey = type === 'orphans' ? 'path' : 'trash_path';
  if (master.checked) data.forEach(i => selectedPaths.add(i[pathKey]));
  else data.forEach(i => selectedPaths.delete(i[pathKey]));
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

async function ignoreOne(path) {
  try {
    await apiFetch('/api/ignore/add', 'POST', { path });
    orphansData = orphansData.filter(i => i.path !== path);
    renderOrphans();
    showToast('Ignored', 'success');
    refreshStatus();
  } catch (e) { showToast(e.message, 'error'); }
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

// ── Modal ─────────────────────────────────────────────────────────────────────

function confirm(title, body, cb) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent = body;
  const btn = document.getElementById('modal-confirm-btn');
  btn.onclick = () => { closeModal(); cb(); };
  btn.className = title.toLowerCase().includes('delete') ? 'btn btn-danger' : 'btn btn-warning';
  btn.textContent = title.toLowerCase().includes('restore') ? 'Restore' : 'Confirm';
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
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
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
