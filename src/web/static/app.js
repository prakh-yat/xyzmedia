'use strict';

const $ = (id) => document.getElementById(id);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ===========================================================
// View routing — left nav drives which main panel is visible.
// Only "trends" is implemented; the others show a placeholder.
// ===========================================================
function activateView(target) {
  const shell = document.querySelector('.app-shell');
  if (!shell) return;
  shell.dataset.view = target;
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.classList.toggle('active', btn.dataset.target === target);
  }
  for (const panel of document.querySelectorAll('[data-view-panel]')) {
    panel.hidden = panel.dataset.viewPanel !== target;
  }
}

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.nav-item');
  if (!btn) return;
  activateView(btn.dataset.target);
});

const ICONS = {
  created: '+',
  updated: '~',
  skipped: '·',
  recovered: '↺',
  failed: '✗',
};

// ===========================================================
// Toasts
// ===========================================================
const TOAST_ICONS = {
  success: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  info: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function toast(kind, title, detail) {
  const stack = $('toast-stack');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.innerHTML = `${TOAST_ICONS[kind] || TOAST_ICONS.info}<div class="toast-text"><strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}</div>`;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 220);
  }, 4500);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtRelTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
function fmtDuration(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

// ===========================================================
// OAuth status
// ===========================================================
async function refreshStatus() {
  const el = $('oauth-pill');
  try {
    const res = await fetch('/api/status');
    const j = await res.json();
    if (j.oauthOk) {
      el.className = 'pill pill-ok';
      el.innerHTML = '<span class="dot"></span><span>OAuth connected</span>';
    } else {
      el.className = 'pill pill-error';
      el.innerHTML = '<span class="dot"></span><span>OAuth not set up — run <code style="background:rgba(0,0,0,0.2)">npm run oauth-setup</code></span>';
    }
  } catch {
    el.className = 'pill pill-error';
    el.innerHTML = '<span class="dot"></span><span>status unknown</span>';
  }
  updateSyncButtonState();
}

async function refreshLastRun() {
  try {
    const res = await fetch('/api/last-summary');
    const j = await res.json();
    const pill = $('last-run-pill');
    if (!j.summary) { pill.hidden = true; return; }
    const s = j.summary;
    const totalChanged = (s.products?.created ?? 0) + (s.products?.updated ?? 0);
    const failed = (s.products?.failed ?? 0) + (s.collections?.failed ?? 0);
    const when = fmtRelTime(s.finishedAt);
    pill.hidden = false;
    if (failed > 0) {
      pill.className = 'pill pill-warn';
      pill.innerHTML = `<span class="dot"></span><span>last run ${when} · ${failed} failed</span>`;
    } else {
      pill.className = 'pill pill-info';
      pill.innerHTML = `<span class="dot"></span><span>last run ${when} · ${totalChanged} synced</span>`;
    }
  } catch { /* ignore */ }
}

// ===========================================================
// Files / archive
// ===========================================================
let cachedFiles = [];

async function refreshFiles() {
  try {
    const res = await fetch('/api/files');
    const j = await res.json();
    cachedFiles = j.files || [];
  } catch (err) {
    console.error(err);
    cachedFiles = [];
  }
  renderFiles();
  populateSyncSelectors();
  updateSyncButtonState();
}

function renderFiles() {
  const list = $('rail-files-list');
  const count = $('rail-files-count');
  if (count) {
    count.textContent = cachedFiles.length === 0 ? '0' : String(cachedFiles.length);
  }

  if (cachedFiles.length === 0) {
    list.innerHTML = `<div class="rail-empty">No catalogue files yet.<br/>Upload one to begin.</div>`;
    return;
  }

  list.innerHTML = '';
  for (const f of cachedFiles) {
    const row = document.createElement('div');
    row.className = 'rail-file';
    const rowsLine = f.rows != null ? `${f.rows.toLocaleString()} rows` : '—';
    row.innerHTML = `
      <div class="rail-file-icon">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/><line x1="9" y1="11" x2="15" y2="11"/></svg>
      </div>
      <div class="rail-file-body">
        <div class="rail-file-name">${escapeHtml(f.name)}</div>
        <div class="rail-file-meta">${escapeHtml(rowsLine)} · ${fmtBytes(f.size)} · ${fmtRelTime(f.mtime)}</div>
      </div>
      <button class="rail-file-del" data-name="${escapeHtml(f.name)}" title="Delete">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
      </button>
    `;
    row.querySelector('.rail-file-del').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const name = ev.currentTarget.dataset.name;
      if (!confirm(`Delete ${name}? This cannot be undone.`)) return;
      const r = await fetch(`/api/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (r.ok) {
        toast('success', 'File deleted', name);
        await refreshFiles();
      } else {
        const e = await r.json().catch(() => ({}));
        toast('error', 'Delete failed', e.error || r.statusText);
      }
    });
    list.appendChild(row);
  }
}

function populateSyncSelectors() {
  const newSel = $('sync-new');
  const oldSel = $('sync-old');
  const prevNew = newSel.value;
  const prevOld = oldSel.value;

  newSel.innerHTML = '';
  oldSel.innerHTML = '';

  if (cachedFiles.length === 0) {
    newSel.innerHTML = '<option value="" disabled>(no files)</option>';
    oldSel.innerHTML = '<option value="" disabled>(no files)</option>';
    updatePickerMeta();
    return;
  }

  for (const f of cachedFiles) {
    const o1 = document.createElement('option');
    o1.value = f.name; o1.textContent = f.name; newSel.appendChild(o1);
    const o2 = document.createElement('option');
    o2.value = f.name; o2.textContent = f.name; oldSel.appendChild(o2);
  }
  // Preserve selection when possible; default to newest as new and second-newest as old
  newSel.value = cachedFiles.find((f) => f.name === prevNew) ? prevNew : cachedFiles[0].name;
  if (cachedFiles.length > 1) {
    oldSel.value = cachedFiles.find((f) => f.name === prevOld) && prevOld !== newSel.value
      ? prevOld
      : cachedFiles[1].name;
  } else {
    oldSel.value = cachedFiles[0].name;
  }
  updatePickerMeta();
}

function updatePickerMeta() {
  const newName = $('sync-new').value;
  const oldName = $('sync-old').value;
  const newFile = cachedFiles.find((f) => f.name === newName);
  const oldFile = cachedFiles.find((f) => f.name === oldName);
  $('sync-new-meta').textContent = newFile
    ? `${newFile.rows != null ? newFile.rows.toLocaleString() + ' rows · ' : ''}${fmtBytes(newFile.size)}`
    : '—';
  $('sync-old-meta').textContent = oldFile
    ? `${oldFile.rows != null ? oldFile.rows.toLocaleString() + ' rows · ' : ''}${fmtBytes(oldFile.size)}`
    : '—';
  updateSyncButtonState();
}

$('sync-new').addEventListener('change', updatePickerMeta);
$('sync-old').addEventListener('change', updatePickerMeta);

function updateSyncButtonState() {
  const btn = $('sync-btn');
  const reasonPill = $('sync-disabled-reason');
  const newName = $('sync-new').value;
  const oldName = $('sync-old').value;

  let reason = null;
  if (cachedFiles.length < 2) reason = 'upload at least 2 files';
  else if (!newName || !oldName) reason = 'select both files';
  else if (newName === oldName) reason = '"new" and "old" must differ';

  if (reason) {
    btn.disabled = true;
    reasonPill.hidden = false;
    reasonPill.innerHTML = `<span class="dot"></span><span>${escapeHtml(reason)}</span>`;
  } else {
    btn.disabled = false;
    reasonPill.hidden = true;
  }
}

// ===========================================================
// Upload (with drag-and-drop + filename auto-detect)
// ===========================================================
const dropzone = $('dropzone');
const fileInput = $('upload-file');

['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  }),
);
dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files.length > 0) {
    fileInput.files = e.dataTransfer.files;
    onFileSelected();
  }
});
fileInput.addEventListener('change', onFileSelected);

function onFileSelected() {
  if (!fileInput.files || fileInput.files.length === 0) {
    $('dropzone-empty').hidden = false;
    $('dropzone-selected').hidden = true;
    $('upload-meta').hidden = true;
    return;
  }
  const f = fileInput.files[0];
  $('dropzone-empty').hidden = true;
  $('dropzone-selected').hidden = false;
  $('selected-name').textContent = f.name;
  $('selected-meta').textContent = fmtBytes(f.size);

  // Auto-detect month/year from filename if not yet set
  const detected = detectMonthYear(f.name);
  if (detected) {
    if (!$('upload-month').value) $('upload-month').value = detected.month;
    if (!$('upload-year').value) $('upload-year').value = detected.year;
    $('upload-meta').hidden = false;
    $('upload-meta-text').textContent = `Detected ${detected.month} ${detected.year} from filename`;
  } else {
    $('upload-meta').hidden = true;
  }
}

function detectMonthYear(filename) {
  const name = filename.replace(/\.csv$/i, '');
  // Match: "May_2026", "may-2026", "May 2026", "2026-may", etc.
  const monthRe = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const yearRe = '(20\\d{2})';
  const re1 = new RegExp(`${monthRe}[\\s_\\-]*${yearRe}`, 'i');
  const re2 = new RegExp(`${yearRe}[\\s_\\-]*${monthRe}`, 'i');
  let m = re1.exec(name) || re2.exec(name);
  if (!m) return null;
  // Determine which group is month, which is year
  const a = m[1], b = m[2];
  const monthStr = /^\d{4}$/.test(a) ? b : a;
  const year = /^\d{4}$/.test(a) ? a : b;
  const mon = MONTHS.find((mm) => mm.toLowerCase().startsWith(monthStr.slice(0, 3).toLowerCase()));
  return mon ? { month: mon, year } : null;
}

$('upload-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!fileInput.files || fileInput.files.length === 0) {
    toast('error', 'No file selected'); return;
  }
  const month = $('upload-month').value;
  const year = $('upload-year').value;
  if (!month || !year) {
    toast('error', 'Pick month and year'); return;
  }
  const submitBtn = $('upload-submit');
  submitBtn.disabled = true;
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  fd.append('month', month);
  fd.append('year', year);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const j = await res.json();
    if (!res.ok) {
      toast('error', 'Upload failed', j.error || res.statusText);
      return;
    }
    toast('success', 'Uploaded', `Saved as ${j.filename}`);
    fileInput.value = '';
    $('upload-month').value = '';
    $('upload-year').value = '';
    onFileSelected();
    await refreshFiles();
  } catch (err) {
    toast('error', 'Upload failed', err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

// ===========================================================
// Live progress
// ===========================================================
const counts = { created: 0, updated: 0, skipped: 0, recovered: 0, failed: 0 };
const activityRows = [];
const ACTIVITY_KEEP = 200;
let runStart = 0;
let phaseStarts = {};
let phaseTimer = null;

const PHASE_KEYS = ['diff', 'collections', 'products', 'wrap'];

function resetProgress() {
  for (const k of Object.keys(counts)) counts[k] = 0;
  activityRows.length = 0;
  $('progress-text').textContent = '0 / 0';
  $('progress-pct').textContent = '0%';
  $('progress-fill').style.width = '0%';
  for (const k of Object.keys(counts)) {
    $(`cnt-${k}`).textContent = '0';
    $(`cnt-${k}`).dataset.target = '0';
  }
  $('counter-failed-card').dataset.active = 'false';
  $('progress-wrap').hidden = false;
  $('activity-list').innerHTML = `
    <div class="activity-empty">
      <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      waiting for first product…
    </div>`;
  // reset phases
  for (const p of PHASE_KEYS) {
    setPhase(p, 'idle');
    $(`phase-${p}-detail`).textContent = 'waiting…';
    $(`phase-${p}-time`).textContent = '';
  }
  phaseStarts = {};
  $('run-summary').hidden = true;
  $('output-card').classList.add('is-running');
  $('run-status-pill').className = 'pill pill-loading';
  $('run-status-pill').innerHTML = '<span class="dot"></span><span>preparing…</span>';
  $('log-output').textContent = '';
  if (phaseTimer) clearInterval(phaseTimer);
  phaseTimer = setInterval(updateActivePhaseTimer, 1000);
  runStart = Date.now();
}

function setPhase(key, state, detail) {
  const el = document.querySelector(`.step[data-phase="${key}"]`);
  if (!el) return;
  el.classList.remove('active', 'done');
  if (state === 'active') el.classList.add('active');
  if (state === 'done') el.classList.add('done');
  if (state === 'active' && !phaseStarts[key]) phaseStarts[key] = Date.now();
  if (state === 'done' && phaseStarts[key]) {
    const elapsed = Date.now() - phaseStarts[key];
    $(`phase-${key}-time`).textContent = fmtDuration(elapsed);
  }
  if (detail) $(`phase-${key}-detail`).textContent = detail;
}

function updateActivePhaseTimer() {
  for (const p of PHASE_KEYS) {
    const el = document.querySelector(`.step[data-phase="${p}"]`);
    if (el && el.classList.contains('active') && phaseStarts[p]) {
      const elapsed = Date.now() - phaseStarts[p];
      $(`phase-${p}-time`).textContent = fmtDuration(elapsed);
    }
  }
}

function applyProgress(ev) {
  if (counts[ev.status] !== undefined) counts[ev.status] += 1;

  $('progress-text').textContent = `${ev.index.toLocaleString()} / ${ev.total.toLocaleString()}`;
  const pct = ev.total > 0 ? Math.round((ev.index / ev.total) * 100) : 0;
  $('progress-pct').textContent = pct + '%';
  $('progress-fill').style.width = pct + '%';

  for (const k of Object.keys(counts)) {
    animateCounter($(`cnt-${k}`), counts[k]);
  }
  if (counts.failed > 0) $('counter-failed-card').dataset.active = 'true';

  // Phase 3 detail (products)
  if (ev.total > 0) {
    setPhase('products', 'active', `${ev.index.toLocaleString()} / ${ev.total.toLocaleString()} processed`);
  }

  activityRows.unshift(ev);
  if (activityRows.length > ACTIVITY_KEEP) activityRows.length = ACTIVITY_KEEP;
  renderActivity();
}

function animateCounter(el, target) {
  const current = Number(el.dataset.target ?? 0);
  if (target === current) {
    el.textContent = target.toLocaleString();
    return;
  }
  el.dataset.target = target;
  // Quick fade animation
  el.style.transform = 'translateY(-2px)';
  el.style.opacity = '0.6';
  el.textContent = target.toLocaleString();
  requestAnimationFrame(() => {
    el.style.transition = 'all 0.18s ease';
    el.style.transform = 'translateY(0)';
    el.style.opacity = '1';
    setTimeout(() => { el.style.transition = ''; }, 180);
  });
}

function renderActivity() {
  const onlyFailed = $('activity-only-failed').checked;
  const list = $('activity-list');
  const filtered = onlyFailed ? activityRows.filter((r) => r.status === 'failed') : activityRows;
  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="activity-empty">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        ${onlyFailed ? 'no failures yet' : 'waiting for first product…'}
      </div>`;
    return;
  }
  const VIEW = 100;
  const slice = filtered.slice(0, VIEW);
  list.innerHTML = slice.map((r) => {
    const errFrag = r.error
      ? `<span class="err">— ${escapeHtml(String(r.error).slice(0, 100))}</span>`
      : '';
    return `<div class="activity-row ${escapeHtml(r.status)}">
      <span class="icon">${ICONS[r.status] || '·'}</span>
      <span class="code">${escapeHtml(r.code)}</span>
      <span class="name">${escapeHtml(r.name || '')}</span>
      ${errFrag}
    </div>`;
  }).join('');
}

document.addEventListener('change', (ev) => {
  if (ev.target && ev.target.id === 'activity-only-failed') renderActivity();
});

function appendLog(obj) {
  const out = $('log-output');
  const lvl = obj.level || 30;
  const cls = lvl >= 50 ? 'log-error' : lvl >= 40 ? 'log-warn' : lvl <= 20 ? 'log-debug' : 'log-info';
  const t = obj.time ? new Date(obj.time).toLocaleTimeString() : '';
  const phase = obj.phase ? `[${obj.phase}]` : '';
  const detail = formatDetail(obj);
  const line = document.createElement('span');
  line.className = `log-line ${cls}`;
  line.innerHTML = `<span class="log-time">${escapeHtml(t)}</span>${phase ? `<span class="log-phase">${escapeHtml(phase)}</span>` : ''}${escapeHtml(obj.msg || '')}${detail ? ` ${escapeHtml(detail)}` : ''}`;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;

  // Drive phase tracker from log message text
  detectPhaseFromLog(obj);
}

function detectPhaseFromLog(obj) {
  const msg = (obj.msg || '').toLowerCase();
  if (msg.includes('running diff script') && obj.script && !phaseStarts.diff) {
    setPhase('diff', 'active', 'running python diff scripts');
  } else if (msg.includes('diff script ok') && obj.script) {
    if (obj.script.includes('diff_categories')) {
      setPhase('diff', 'done', 'produced changes.csv + category_changes.csv');
      setPhase('collections', 'active', 'listing existing collections…');
    }
  } else if (msg === 'collections phase done' || msg.includes('cached existing collections')) {
    if (msg === 'collections phase done') {
      setPhase('collections', 'done', `${obj.added ?? 0} added, ${obj.alreadyPresent ?? 0} already present`);
      setPhase('products', 'active', 'waiting for first product…');
    }
  } else if (msg === 'products phase done') {
    setPhase('products', 'done', `${(obj.created ?? 0) + (obj.updated ?? 0)} synced`);
    setPhase('wrap', 'active', 'writing report + status column…');
  } else if (msg === 'sync done' || msg.includes('report written')) {
    if (msg === 'sync done') {
      setPhase('wrap', 'done', `total ${fmtDuration(Date.now() - runStart)}`);
    }
  }
}

function formatDetail(obj) {
  const skip = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'run_id', 'phase']);
  const pairs = Object.entries(obj).filter(([k]) => !skip.has(k));
  if (pairs.length === 0) return '';
  return pairs.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
}

// ===========================================================
// Run sync (SSE via fetch)
// ===========================================================
let currentRunId = null;
let cancelInflight = false;
let lastSyncParams = null; // remembers {newFile, oldFile, dryRun} so the Resume button can re-trigger

async function startSync(params) {
  const { newFile, oldFile, dryRun } = params;

  if (newFile === oldFile) {
    toast('error', '"New" and "Old" must be different');
    return;
  }

  lastSyncParams = { newFile, oldFile, dryRun };
  cancelInflight = false;
  currentRunId = null;
  $('sync-btn').disabled = true;
  $('sync-cancel').hidden = false;
  $('sync-cancel').disabled = true; // enabled when runId arrives
  $('output-card').hidden = false;
  $('output-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  resetProgress();

  $('run-meta').innerHTML = `
    <span class="pill"><svg class="ic" style="width:13px;height:13px;margin-right:3px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg> new: ${escapeHtml(newFile)}</span>
    <span class="pill"><svg class="ic" style="width:13px;height:13px;margin-right:3px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg> old: ${escapeHtml(oldFile)}</span>
    ${dryRun ? '<span class="pill pill-warn"><span class="dot"></span> DRY RUN</span>' : ''}
  `;

  await runSyncStream({ newFile, oldFile, dryRun });
}

async function runSyncStream({ newFile, oldFile, dryRun }) {

  setPhase('diff', 'active', 'queued…');

  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newFile, oldFile, dryRun }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      handleDoneEvent({ ok: false, error: j.error || res.statusText });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split('\n\n');
      buf = blocks.pop() || '';
      for (const block of blocks) {
        if (!block.trim()) continue;
        const ev = parseSse(block);
        if (!ev) continue;
        if (ev.event === 'log') appendLog(ev.data);
        else if (ev.event === 'start') {
          currentRunId = ev.data.runId;
          $('sync-cancel').disabled = false; // we have a runId, cancel is now usable
          $('run-status-pill').className = 'pill pill-info pill-loading';
          $('run-status-pill').innerHTML = '<span class="dot"></span><span>running</span>';
          const m = $('run-meta');
          m.insertAdjacentHTML(
            'afterbegin',
            `<span class="runid">${escapeHtml(ev.data.runId)}</span>`,
          );
        } else if (ev.event === 'progress') applyProgress(ev.data);
        else if (ev.event === 'cancelling') {
          cancelInflight = true;
          $('sync-cancel').disabled = true;
          $('run-status-pill').className = 'pill pill-warn pill-loading';
          $('run-status-pill').innerHTML =
            '<span class="dot"></span><span>cancelling — finishing in-flight products, please wait…</span>';
          toast('info', 'Stopping sync', 'Waiting for in-flight products to finish. Re-run will continue where you left off.');
        }
        else if (ev.event === 'done') handleDoneEvent(ev.data);
      }
    }
  } catch (err) {
    handleDoneEvent({ ok: false, error: err.message });
  } finally {
    $('sync-btn').disabled = false;
    $('sync-cancel').hidden = true;
    $('sync-cancel').disabled = false;
    currentRunId = null;
    cancelInflight = false;
    $('output-card').classList.remove('is-running');
    if (phaseTimer) clearInterval(phaseTimer);
    refreshFiles();
    refreshLastRun();
    refreshRuns();
  }
}

$('sync-btn').addEventListener('click', () => {
  startSync({
    newFile: $('sync-new').value,
    oldFile: $('sync-old').value,
    dryRun: $('sync-dry-run').checked,
  });
});

// ---------- Smoke test ----------
$('smoke-btn').addEventListener('click', async () => {
  const newFile = $('sync-new').value;
  if (!newFile) {
    toast('error', 'Pick a "New" file first');
    return;
  }
  if (
    !confirm(
      'Smoke test creates a REAL product in the store (with images and a price) to verify the pipeline.\n\nYou will need to delete this product manually in the store afterwards.\n\nContinue?',
    )
  ) {
    return;
  }
  await startSmoke({ newFile });
});

async function startSmoke({ newFile }) {
  $('sync-btn').disabled = true;
  $('smoke-btn').disabled = true;
  $('sync-cancel').hidden = true;
  $('output-card').hidden = false;
  $('output-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  resetProgress();
  $('progress-wrap').hidden = true; // smoke doesn't have a multi-product progress bar
  // Hide the per-product counters and activity feed for smoke (only one product)
  document.querySelector('.counters').style.display = 'none';
  document.querySelector('.activity-wrap').style.display = 'none';
  document.querySelector('.stepper').style.display = 'none';

  $('run-meta').innerHTML = `
    <span class="pill pill-info"><span class="dot"></span><span>smoke test</span></span>
    <span class="pill"><svg class="ic" style="width:13px;height:13px;margin-right:3px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg> ${escapeHtml(newFile)}</span>
  `;
  $('run-status-pill').className = 'pill pill-info pill-loading';
  $('run-status-pill').innerHTML = '<span class="dot"></span><span>probing scopes…</span>';

  try {
    const res = await fetch('/api/smoke-one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newFile }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      renderSmokeSummary({ ok: false, error: j.error || res.statusText, probes: { collections: { ok: false }, medias: { ok: false } }, product: null, roundTrip: [] });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split('\n\n');
      buf = blocks.pop() || '';
      for (const block of blocks) {
        if (!block.trim()) continue;
        const ev = parseSse(block);
        if (!ev) continue;
        if (ev.event === 'log') appendLog(ev.data);
        else if (ev.event === 'start') {
          const m = $('run-meta');
          m.insertAdjacentHTML('afterbegin', `<span class="runid">${escapeHtml(ev.data.runId)}</span>`);
        } else if (ev.event === 'smoke-done') {
          renderSmokeSummary(ev.data);
        }
      }
    }
  } catch (err) {
    renderSmokeSummary({
      ok: false,
      error: err.message,
      probes: { collections: { ok: false }, medias: { ok: false } },
      product: null,
      roundTrip: [],
    });
  } finally {
    $('sync-btn').disabled = false;
    $('smoke-btn').disabled = false;
    // Restore the hidden sections for next sync
    document.querySelector('.counters').style.display = '';
    document.querySelector('.activity-wrap').style.display = '';
    document.querySelector('.stepper').style.display = '';
  }
}

function renderSmokeSummary(result) {
  const el = $('run-summary');
  el.hidden = false;

  const pill = $('run-status-pill');
  if (result.ok) {
    pill.className = 'pill pill-ok';
    pill.innerHTML = '<span class="dot"></span><span>smoke passed</span>';
  } else {
    pill.className = 'pill pill-error';
    pill.innerHTML = '<span class="dot"></span><span>smoke failed</span>';
  }

  const checkRow = (c) => `
    <div class="smoke-check ${c.ok ? 'ok' : 'fail'}">
      <span class="icon">${c.ok ? '✓' : '✗'}</span>
      <div class="smoke-check-body">
        <div class="smoke-check-name">${escapeHtml(c.name)}</div>
        <div class="smoke-check-detail">${escapeHtml(c.detail || (c.error ?? 'OK'))}</div>
      </div>
    </div>
  `;

  const probeChecks = [
    { name: 'collection.write scope (POST /products/collections)', ok: result.probes?.collections?.ok ?? false, detail: result.probes?.collections?.error ?? 'OK' },
    { name: 'medias.write scope (POST /medias/upload-file)', ok: result.probes?.medias?.ok ?? false, detail: result.probes?.medias?.error ?? 'OK' },
  ];

  const probeIcon = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  const productIcon = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect x="3" y="9" width="18" height="12" rx="2"/></svg>';
  const trIcon = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const titleIcon = result.ok
    ? '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

  el.className = `run-summary ${result.ok ? 'success' : 'failure'}`;
  el.innerHTML = `
    <div class="run-summary-title">${titleIcon}${result.ok ? 'Smoke test passed' : 'Smoke test failed'}</div>
    <div class="run-summary-meta">${result.error ? escapeHtml(result.error) : `run <code>${escapeHtml(result.runId ?? '')}</code> · ${((result.durationMs ?? 0) / 1000).toFixed(1)}s`}</div>

    <div class="smoke-section">
      <div class="smoke-section-title">${probeIcon} OAuth scope probes</div>
      ${probeChecks.map(checkRow).join('')}
    </div>

    ${result.product ? `
      <div class="smoke-section">
        <div class="smoke-section-title">${productIcon} Test product created</div>
        <dl class="smoke-product-grid">
          <dt>Code</dt><dd>${escapeHtml(result.product.code)}</dd>
          <dt>Name</dt><dd style="font-family: var(--font-sans)">${escapeHtml(result.product.name)}</dd>
          <dt>Product ID</dt><dd>${escapeHtml(result.product.productId)}</dd>
          <dt>Price ID</dt><dd>${escapeHtml(result.product.priceId)}</dd>
          ${result.product.image ? `<dt>Image</dt><dd><a href="${escapeHtml(result.product.image)}" target="_blank" rel="noopener">${escapeHtml(result.product.image)}</a></dd>` : ''}
          <dt>Store</dt><dd><a href="${escapeHtml(result.product.productUiUrl)}" target="_blank" rel="noopener">open products page →</a></dd>
        </dl>
        <p style="font-size: 12px; color: var(--text-muted); margin-top: 12px; margin-bottom: 0;">
          <strong style="color: var(--warning)">⚠</strong> Delete this product in the store when you're done verifying.
        </p>
      </div>
    ` : ''}

    ${result.roundTrip && result.roundTrip.length > 0 ? `
      <div class="smoke-section">
        <div class="smoke-section-title">${trIcon} Round-trip verification</div>
        ${result.roundTrip.map(checkRow).join('')}
      </div>
    ` : ''}
  `;

  if (result.ok) {
    toast('success', 'Smoke test passed', 'You\'re ready for a real sync');
  } else {
    toast('error', 'Smoke test failed', result.error || 'see checks above');
  }
}

// ---------- Stop sync ----------
$('sync-cancel').addEventListener('click', async () => {
  if (!currentRunId) return;
  if (!confirm('Stop the sync? In-flight products will finish first. Re-run will pick up where you left off.')) {
    return;
  }
  $('sync-cancel').disabled = true;
  try {
    const res = await fetch('/api/sync/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: currentRunId }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast('error', 'Cancel failed', j.error || res.statusText);
      $('sync-cancel').disabled = false;
    }
  } catch (err) {
    toast('error', 'Cancel failed', err.message);
    $('sync-cancel').disabled = false;
  }
});

function handleDoneEvent(payload) {
  const pill = $('run-status-pill');
  if (payload.cancelled) {
    pill.className = 'pill pill-warn';
    pill.innerHTML = '<span class="dot"></span><span>stopped by user</span>';
    setPhase('wrap', 'done', `stopped after ${fmtDuration(Date.now() - runStart)}`);
  } else if (!payload.ok) {
    pill.className = 'pill pill-error';
    pill.innerHTML = '<span class="dot"></span><span>failed</span>';
    setPhase('wrap', 'idle');
  } else {
    const failed = (payload.summary?.products?.failed ?? 0) + (payload.summary?.collections?.failed ?? 0);
    if (failed > 0) {
      pill.className = 'pill pill-warn';
      pill.innerHTML = '<span class="dot"></span><span>completed with failures</span>';
    } else {
      pill.className = 'pill pill-ok';
      pill.innerHTML = '<span class="dot"></span><span>complete</span>';
    }
    setPhase('wrap', 'done', `total ${fmtDuration(Date.now() - runStart)}`);
  }
  renderSummary(payload);
}

// SVG icons used across summary states
const SUMMARY_ICONS = {
  ok: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  warn: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  stop: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12"/></svg>',
  play: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  rerun: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>',
};

function buildResumeActions({ kind, params, hasFailures }) {
  // kind: 'cancelled' | 'failures' | 'success' | 'failed'
  if (!params) return '';
  const { newFile, oldFile, dryRun } = params;
  const safeNew = escapeHtml(newFile || '');
  const safeOld = escapeHtml(oldFile || '');
  const dryHint = dryRun
    ? '<code>state.dryrun.json</code> tracks dry-run progress separately from real syncs.'
    : '<code>state.json</code> tracks completed products; already-synced rows are skipped via SHA match.';

  if (kind === 'cancelled') {
    return `
      <div class="summary-actions">
        <button class="btn btn-primary" data-action="resume" data-new="${safeNew}" data-old="${safeOld}" data-dry="${dryRun ? '1' : '0'}">
          ${SUMMARY_ICONS.play}
          Resume sync${dryRun ? ' (dry run)' : ''}
        </button>
        <div class="resume-note">Picks up where you left off. ${dryHint}</div>
      </div>`;
  }
  if (kind === 'failures') {
    return `
      <div class="summary-actions">
        <button class="btn btn-primary" data-action="resume" data-new="${safeNew}" data-old="${safeOld}" data-dry="${dryRun ? '1' : '0'}">
          ${SUMMARY_ICONS.rerun}
          Re-run (retry failed)
        </button>
        <div class="resume-note">Successful products are skipped via SHA match; only failed/missing rows are retried.</div>
      </div>`;
  }
  if (kind === 'success') {
    return `
      <div class="summary-actions">
        <button class="btn" data-action="resume" data-new="${safeNew}" data-old="${safeOld}" data-dry="${dryRun ? '1' : '0'}">
          ${SUMMARY_ICONS.rerun}
          Run again
        </button>
        <div class="resume-note">All rows will be SHA-checked and skipped if unchanged.</div>
      </div>`;
  }
  return '';
}

// Event delegation for the resume buttons (they live inside summary HTML that re-renders)
document.addEventListener('click', (ev) => {
  const btn = ev.target && ev.target.closest('[data-action="resume"]');
  if (!btn) return;
  startSync({
    newFile: btn.dataset.new,
    oldFile: btn.dataset.old,
    dryRun: btn.dataset.dry === '1',
  });
});

function renderSummary(payload) {
  const el = $('run-summary');
  el.hidden = false;
  const params = lastSyncParams;

  // Cancelled (user stopped the sync mid-run)
  if (payload.cancelled) {
    const s = payload.summary;
    const cancelledCount = s?.products?.cancelled ?? 0;
    const synced = (s?.products?.created ?? 0) + (s?.products?.updated ?? 0);
    el.className = 'run-summary failure';
    el.innerHTML = `
      <div class="run-summary-title" style="color: var(--warning)">
        ${SUMMARY_ICONS.stop}
        Stopped by user
      </div>
      <div class="run-summary-meta">
        ${synced.toLocaleString()} product(s) finished before the stop · ${cancelledCount.toLocaleString()} remaining${s ? ` · run <code>${escapeHtml(s.runId)}</code>` : ''}
      </div>
      ${s ? `<div class="summary-grid">
        <div class="summary-stat"><strong>${(s.collections?.added ?? 0).toLocaleString()}</strong><span>collections added</span></div>
        <div class="summary-stat"><strong>${(s.products?.created ?? 0).toLocaleString()}</strong><span>created</span></div>
        <div class="summary-stat"><strong>${(s.products?.updated ?? 0).toLocaleString()}</strong><span>updated</span></div>
        <div class="summary-stat"><strong>${(s.products?.skipped ?? 0).toLocaleString()}</strong><span>skipped</span></div>
        <div class="summary-stat"><strong>${cancelledCount.toLocaleString()}</strong><span>remaining</span></div>
      </div>` : ''}
      ${buildResumeActions({ kind: 'cancelled', params })}
    `;
    toast('info', 'Sync stopped', 'Click Resume to continue where you left off');
    return;
  }

  if (!payload.ok) {
    el.className = 'run-summary failure';
    el.innerHTML = `
      <div class="run-summary-title">
        ${SUMMARY_ICONS.warn}
        Failed
      </div>
      <div class="run-summary-meta">${escapeHtml(payload.error || 'unknown error')}</div>
      ${buildResumeActions({ kind: 'failures', params })}
    `;
    toast('error', 'Sync failed', payload.error);
    return;
  }
  const s = payload.summary;
  if (!s) {
    el.className = 'run-summary success';
    el.innerHTML = `<div class="run-summary-title">${SUMMARY_ICONS.ok}Done</div>`;
    return;
  }
  const failed = (s.products?.failed ?? 0) + (s.collections?.failed ?? 0);
  el.className = `run-summary ${failed > 0 ? 'failure' : 'success'}`;
  el.innerHTML = `
    <div class="run-summary-title">
      ${failed > 0 ? SUMMARY_ICONS.warn : SUMMARY_ICONS.ok}
      ${failed > 0 ? 'Completed with failures' : 'Sync complete'}
    </div>
    <div class="run-summary-meta">
      run <code>${escapeHtml(s.runId)}</code> · ${(s.durationMs / 1000).toFixed(1)}s${s.dryRun ? ' · dry-run' : ''}
    </div>
    <div class="summary-grid">
      <div class="summary-stat"><strong>${(s.collections?.added ?? 0).toLocaleString()}</strong><span>collections added</span></div>
      <div class="summary-stat"><strong>${(s.products?.created ?? 0).toLocaleString()}</strong><span>products created</span></div>
      <div class="summary-stat"><strong>${(s.products?.updated ?? 0).toLocaleString()}</strong><span>products updated</span></div>
      <div class="summary-stat"><strong>${(s.products?.skipped ?? 0).toLocaleString()}</strong><span>skipped</span></div>
      <div class="summary-stat"><strong style="${failed > 0 ? 'color:var(--error)' : ''}">${failed.toLocaleString()}</strong><span>failed</span></div>
    </div>
    ${buildResumeActions({ kind: failed > 0 ? 'failures' : 'success', params })}
  `;
  if (failed > 0) {
    toast('error', 'Sync had failures', `${failed} item(s) — see dead-letter`);
  } else {
    toast('success', 'Sync complete', `${(s.products?.created ?? 0) + (s.products?.updated ?? 0)} product(s) synced`);
  }
}

function parseSse(block) {
  const lines = block.split('\n');
  let event = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return { event, data: dataLines.join('\n') };
  }
}

// ===========================================================
// Previous runs (right rail bottom) + log modal
// ===========================================================
let cachedRuns = [];

async function refreshRuns() {
  try {
    const res = await fetch('/api/runs');
    const j = await res.json();
    cachedRuns = j.runs || [];
  } catch (err) {
    console.error(err);
    cachedRuns = [];
  }
  renderRuns();
  populateRevertCard();
}

function populateRevertCard() {
  const sel = $('revert-select');
  const meta = $('revert-meta');
  const btn = $('revert-btn');
  const reason = $('revert-disabled-reason');
  if (!sel) return;
  const revertable = cachedRuns.filter((r) => r.hasChangelog && !(r.summary && r.summary.dryRun));
  sel.innerHTML = '';
  if (revertable.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no revertable runs)';
    opt.disabled = true;
    opt.selected = true;
    sel.appendChild(opt);
    sel.disabled = true;
    btn.disabled = true;
    reason.hidden = false;
    reason.innerHTML = '<span class="dot"></span><span>no revertable runs yet — only new syncs are revertable</span>';
    meta.textContent = '—';
    return;
  }
  for (const r of revertable) {
    const opt = document.createElement('option');
    opt.value = r.runId;
    opt.textContent = `${runIdToDateLabel(r.runId)} · ${r.runId}`;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  btn.disabled = false;
  reason.hidden = true;
  sel.value = revertable[0].runId;
  updateRevertMeta();
}

function updateRevertMeta() {
  const sel = $('revert-select');
  const meta = $('revert-meta');
  const r = cachedRuns.find((x) => x.runId === sel.value);
  if (!r || !r.summary) { meta.textContent = '—'; return; }
  const s = r.summary;
  const created = s.products?.created ?? 0;
  const updated = s.products?.updated ?? 0;
  const dur = fmtDuration(s.durationMs ?? 0);
  meta.textContent = `${created.toLocaleString()} created · ${updated.toLocaleString()} updated · ${dur}`;
}

function runIdToDateLabel(runId) {
  // runId format: YYYYMMDD-HHMMSS (UTC-like local timestamp)
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(runId);
  if (!m) return runId;
  const [, Y, Mo, D, H, Mi] = m;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mi = parseInt(Mo, 10) - 1;
  return `${months[mi]} ${parseInt(D, 10)}, ${H}:${Mi}`;
}

function summariseRun(r) {
  if (!r.summary) {
    return { cls: 'incomplete', label: 'incomplete', detail: fmtBytes(r.logSize) };
  }
  const s = r.summary;
  const failed = (s.products?.failed ?? 0) + (s.collections?.failed ?? 0);
  const cancelled = s.products?.cancelled ?? 0;
  const created = s.products?.created ?? 0;
  const updated = s.products?.updated ?? 0;
  const dur = fmtDuration(s.durationMs ?? 0);
  if (s.dryRun) {
    return { cls: 'dryrun', label: `dry run · ${dur}`, detail: `${(created + updated).toLocaleString()} previewed` };
  }
  if (failed > 0) {
    return { cls: 'failed', label: `${failed} failed · ${dur}`, detail: `${(created + updated).toLocaleString()} synced` };
  }
  if (cancelled > 0) {
    return { cls: 'incomplete', label: `cancelled · ${dur}`, detail: `${(created + updated).toLocaleString()} synced before stop` };
  }
  return { cls: 'ok', label: `${(created + updated).toLocaleString()} synced · ${dur}`, detail: `${created.toLocaleString()} new, ${updated.toLocaleString()} updated` };
}

function renderRuns() {
  const list = $('rail-runs-list');
  const count = $('rail-runs-count');
  if (count) count.textContent = cachedRuns.length === 0 ? '0' : String(cachedRuns.length);
  if (cachedRuns.length === 0) {
    list.innerHTML = `<div class="rail-empty">No runs yet.</div>`;
    return;
  }
  list.innerHTML = '';
  for (const r of cachedRuns) {
    const { cls, label, detail } = summariseRun(r);
    // A run is revertable only if its sync wrote a changelog (added recently).
    // Earlier runs predate changelog tracking → wipe is the only option.
    const isDryRun = r.summary?.dryRun === true;
    const canRevert = r.hasChangelog && !isDryRun;
    const row = document.createElement('div');
    row.className = `rail-run ${cls}`;
    row.dataset.runId = r.runId;
    row.title = `Click to open full log · ${r.runId}`;
    const revertBtn = canRevert
      ? `<button class="rail-run-action danger" data-action="revert" title="Revert this run — undo every change it made">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        </button>`
      : isDryRun
        ? `<span class="rail-run-tag" title="Dry run — nothing to revert">dry</span>`
        : `<span class="rail-run-tag" title="This run predates per-product tracking — it can't be reverted. Future syncs will be revertable.">no log</span>`;
    row.innerHTML = `
      <span class="rail-run-dot"></span>
      <div class="rail-run-body">
        <div class="rail-run-when">${escapeHtml(runIdToDateLabel(r.runId))}</div>
        <div class="rail-run-meta">${escapeHtml(label)} · ${escapeHtml(detail)}</div>
      </div>
      <div class="rail-run-actions">${revertBtn}</div>
    `;
    row.addEventListener('click', (ev) => {
      const actionBtn = ev.target.closest('[data-action]');
      if (actionBtn) {
        ev.stopPropagation();
        if (actionBtn.dataset.action === 'revert') openRevertConfirm(r);
        return;
      }
      openLogModal(r);
    });
    list.appendChild(row);
  }
}

async function openLogModal(run) {
  const modal = $('log-modal');
  const titleEl = $('modal-title');
  const subEl = $('modal-sub');
  const logEl = $('modal-log');
  titleEl.textContent = runIdToDateLabel(run.runId);
  const { label, detail } = summariseRun(run);
  subEl.textContent = `${run.runId} · ${label} · ${detail}`;
  logEl.innerHTML = '<span style="color: var(--text-faint)">loading…</span>';
  modal.hidden = false;
  document.body.style.overflow = 'hidden';

  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(run.runId)}/log`);
    if (!res.ok) {
      logEl.innerHTML = `<span style="color: var(--error)">failed to load log: ${escapeHtml(res.statusText)}</span>`;
      return;
    }
    const text = await res.text();
    logEl.innerHTML = renderLogText(text);
  } catch (err) {
    logEl.innerHTML = `<span style="color: var(--error)">${escapeHtml(err.message || String(err))}</span>`;
  }
}

function renderLogText(text) {
  const out = [];
  const lines = text.split('\n');
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let obj;
    try { obj = JSON.parse(raw); } catch { out.push(`<span class="log-row">${escapeHtml(raw)}</span>`); continue; }
    const lvl = obj.level || 30;
    const cls = lvl >= 50 ? 'error' : lvl >= 40 ? 'warn' : lvl <= 20 ? 'debug' : 'info';
    const lvlText = lvl >= 50 ? 'error' : lvl >= 40 ? 'warn' : lvl <= 20 ? 'debug' : 'info';
    const t = obj.time ? new Date(obj.time).toLocaleTimeString() : '';
    const skip = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'run_id']);
    const pairs = Object.entries(obj).filter(([k]) => !skip.has(k));
    const kv = pairs.length
      ? '  <span class="kv">' + pairs.map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}`).join(' ') + '</span>'
      : '';
    out.push(`<span class="log-row ${cls}"><span class="lvl">${lvlText}</span><span class="t">${escapeHtml(t)}</span>${escapeHtml(obj.msg || '')}${kv}</span>`);
  }
  if (out.length === 0) return '<span style="color: var(--text-faint)">log is empty</span>';
  return out.join('\n');
}

function closeLogModal() {
  $('log-modal').hidden = true;
  document.body.style.overflow = '';
}

$('modal-close').addEventListener('click', closeLogModal);
$('log-modal').addEventListener('click', (ev) => {
  // Close when clicking the backdrop itself (not the modal contents).
  if (ev.target === $('log-modal')) closeLogModal();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('log-modal').hidden) closeLogModal();
});

// ===========================================================
// Revert / Wipe — confirm dialog + SSE consumer
// ===========================================================

// Generic confirm-modal opener.
// kind: { eyebrow, title, sub, body (innerHTML), typeWord (optional — must be typed to enable Commit),
//          onDryRun, onCommit, commitLabel }
function openConfirmModal(kind) {
  const modal = $('confirm-modal');
  $('confirm-eyebrow').textContent = kind.eyebrow;
  $('confirm-title').textContent = kind.title;
  $('confirm-sub').textContent = kind.sub;
  $('confirm-body').innerHTML = kind.body;
  $('confirm-commit').textContent = kind.commitLabel || 'Commit';

  const typeBox = $('confirm-typebox');
  const typeInput = $('confirm-type-input');
  const typeLabel = $('confirm-type-label');
  const commitBtn = $('confirm-commit');
  const dryBtn = $('confirm-dryrun');
  const cancelBtn = $('confirm-cancel');
  const closeBtn = $('confirm-close');

  if (kind.typeWord) {
    typeBox.hidden = false;
    typeLabel.textContent = `Type "${kind.typeWord}" to enable commit`;
    typeInput.value = '';
    commitBtn.disabled = true;
    typeInput.oninput = () => {
      commitBtn.disabled = typeInput.value.trim() !== kind.typeWord;
    };
  } else {
    typeBox.hidden = true;
    commitBtn.disabled = false;
  }

  const close = () => {
    modal.hidden = true;
    document.body.style.overflow = '';
    dryBtn.onclick = null;
    commitBtn.onclick = null;
    cancelBtn.onclick = null;
    closeBtn.onclick = null;
    typeInput.oninput = null;
  };

  dryBtn.onclick = () => { close(); kind.onDryRun(); };
  commitBtn.onclick = () => { if (!commitBtn.disabled) { close(); kind.onCommit(); } };
  cancelBtn.onclick = close;
  closeBtn.onclick = close;

  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  if (kind.typeWord) setTimeout(() => typeInput.focus(), 50);
}

function openRevertConfirm(run) {
  const s = run.summary || { products: {}, collections: {} };
  const created = s.products?.created ?? 0;
  const updated = s.products?.updated ?? 0;
  const autoCols = s.collections?.added ?? 0;
  openConfirmModal({
    eyebrow: 'Revert run',
    title: runIdToDateLabel(run.runId),
    sub: `${run.runId} — undo every change this sync made`,
    commitLabel: 'Revert for real',
    typeWord: `revert ${run.runId.slice(-6)}`,
    body: `
      <p>This will undo the following changes that the sync at <strong>${escapeHtml(runIdToDateLabel(run.runId))}</strong> made:</p>
      <ul>
        <li><strong>${created.toLocaleString()}</strong> created products will be <strong>deleted</strong></li>
        <li><strong>${updated.toLocaleString()}</strong> updated products will be <strong>restored</strong> from the baseline CSV</li>
        <li><strong>${autoCols.toLocaleString()}</strong> auto-created collections will be <strong>deleted</strong></li>
      </ul>
      <div class="warn">Dry run logs every action but skips the API calls and state writes. Pick that first if unsure.</div>
    `,
    onDryRun: () => startRevertOrWipe('revert', run.runId, true),
    onCommit: () => startRevertOrWipe('revert', run.runId, false),
  });
}

function openWipeConfirm() {
  openConfirmModal({
    eyebrow: 'Wipe everything',
    title: 'Delete all tracked products + collections',
    sub: 'Uses state.json — affects every run, including pre-changelog ones',
    commitLabel: 'Wipe for real',
    typeWord: 'WIPE EVERYTHING',
    body: `
      <p>This will <strong>delete every product</strong> listed in <code>state.json</code> and <strong>every collection</strong> we know about from the store. State will be cleared after.</p>
      <div class="warn"><strong>Destructive.</strong> Cannot be undone. Use this only when the per-run revert isn't enough (e.g. for syncs that pre-date changelog tracking).</div>
    `,
    onDryRun: () => startRevertOrWipe('wipe', null, true),
    onCommit: () => startRevertOrWipe('wipe', null, false),
  });
}

function startRevertOrWipe(mode, targetRunId, dryRun) {
  // Show the live status panel + reset counters.
  $('sync-btn').disabled = true;
  $('sync-cancel').hidden = true;
  $('output-card').hidden = false;
  $('output-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  resetProgress();
  document.querySelector('.stepper').style.display = 'none'; // revert has different phases

  const action = mode === 'revert' ? 'Revert' : 'Wipe';
  $('run-meta').innerHTML = `
    <span class="pill pill-info"><span class="dot"></span><span>${action}${dryRun ? ' · DRY RUN' : ''}</span></span>
    ${targetRunId ? `<span class="pill"><svg class="ic" style="width:13px;height:13px;margin-right:3px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg> ${escapeHtml(targetRunId)}</span>` : ''}
  `;
  $('run-status-pill').className = 'pill pill-info pill-loading';
  $('run-status-pill').innerHTML = `<span class="dot"></span><span>${action.toLowerCase()}ing…</span>`;

  // Re-label the counters for revert mode (created → deleted, updated → restored, etc).
  if (mode === 'revert') {
    document.querySelector('.counter-created span').textContent = 'deleted';
    document.querySelector('.counter-updated span').textContent = 'restored';
  } else {
    document.querySelector('.counter-created span').textContent = 'deleted';
    document.querySelector('.counter-updated span').textContent = '—';
  }

  const url = mode === 'revert'
    ? `/api/runs/${encodeURIComponent(targetRunId)}/revert`
    : '/api/wipe';
  const body = mode === 'wipe' && !dryRun
    ? { dryRun: false, confirm: 'WIPE EVERYTHING' }
    : { dryRun };

  runRevertStream(url, body, mode);
}

async function runRevertStream(url, body, mode) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      handleRevertDone({ ok: false, error: j.error || res.statusText }, mode);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split('\n\n');
      buf = blocks.pop() || '';
      for (const block of blocks) {
        if (!block.trim()) continue;
        const ev = parseSse(block);
        if (!ev) continue;
        if (ev.event === 'log') appendLog(ev.data);
        else if (ev.event === 'start') {
          $('run-status-pill').className = 'pill pill-info pill-loading';
          $('run-status-pill').innerHTML = `<span class="dot"></span><span>running</span>`;
        }
        else if (ev.event === 'progress') applyRevertProgress(ev.data, mode);
        else if (ev.event === 'done') handleRevertDone(ev.data, mode);
      }
    }
  } catch (err) {
    handleRevertDone({ ok: false, error: err.message }, mode);
  } finally {
    $('sync-btn').disabled = false;
    if (phaseTimer) clearInterval(phaseTimer);
    refreshRuns();
    refreshLastRun();
  }
}

function applyRevertProgress(ev, mode) {
  // ev shape: { index, total, status: 'deleted'|'restored'|'skipped'|'failed', kind, code?, name, id, error? }
  if (ev.status === 'deleted') counts.created += 1; // reuse counter slot
  else if (ev.status === 'restored') counts.updated += 1;
  else if (ev.status === 'failed') counts.failed += 1;
  else if (ev.status === 'skipped') counts.skipped += 1;

  $('progress-text').textContent = `${ev.index.toLocaleString()} / ${ev.total.toLocaleString()}`;
  const pct = ev.total > 0 ? Math.round((ev.index / ev.total) * 100) : 0;
  $('progress-pct').textContent = pct + '%';
  $('progress-fill').style.width = pct + '%';
  $('progress-wrap').hidden = false;

  for (const k of Object.keys(counts)) animateCounter($(`cnt-${k}`), counts[k]);
  if (counts.failed > 0) $('counter-failed-card').dataset.active = 'true';

  activityRows.unshift({
    code: ev.code || '',
    name: ev.kind === 'collection' ? `collection: ${ev.name}` : ev.name,
    status: ev.status === 'deleted' || ev.status === 'restored' ? 'created' : ev.status === 'failed' ? 'failed' : 'skipped',
    error: ev.error,
  });
  if (activityRows.length > ACTIVITY_KEEP) activityRows.length = ACTIVITY_KEEP;
  renderActivity();
}

function handleRevertDone(data, mode) {
  $('output-card').classList.remove('is-running');
  const pill = $('run-status-pill');
  if (data.ok) {
    const r = data.result;
    const c = r?.counts || {};
    pill.className = 'pill pill-ok';
    pill.innerHTML = `<span class="dot"></span><span>${mode} ${r?.dryRun ? 'dry-run ' : ''}complete</span>`;
    toast('success', `${mode === 'revert' ? 'Revert' : 'Wipe'} ${r?.dryRun ? '(dry run) ' : ''}done`,
      `${(c.productsDeleted || 0)} deleted, ${(c.productsRestored || 0)} restored, ${(c.collectionsDeleted || 0)} collections removed`);
  } else {
    pill.className = 'pill pill-error';
    pill.innerHTML = `<span class="dot"></span><span>${mode} failed</span>`;
    toast('error', `${mode === 'revert' ? 'Revert' : 'Wipe'} failed`, data.error || 'unknown error');
  }
  // Restore counter labels for next time.
  document.querySelector('.counter-created span').textContent = 'created';
  document.querySelector('.counter-updated span').textContent = 'updated';
  document.querySelector('.stepper').style.display = '';
}

$('revert-select').addEventListener('change', updateRevertMeta);

$('revert-btn').addEventListener('click', () => {
  const runId = $('revert-select').value;
  const dryRun = $('revert-dry-run').checked;
  const run = cachedRuns.find((r) => r.runId === runId);
  if (!run) return;
  // Inline path — same confirm modal, but we may pre-honor the dry-run checkbox.
  if (dryRun) {
    startRevertOrWipe('revert', runId, true);
  } else {
    openRevertConfirm(run);
  }
});

// ===========================================================
// Init
// ===========================================================
refreshStatus();
refreshFiles();
refreshLastRun();
refreshRuns();
setInterval(refreshStatus, 30_000);
setInterval(refreshLastRun, 60_000);
setInterval(refreshRuns, 60_000);
