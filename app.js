/* ═══════════════════════════════════════════════════════════════════════
   CONFIG  ← Update BACKEND_URL after you deploy the backend to Render.com
═══════════════════════════════════════════════════════════════════════ */
const CONFIG = {
  backendUrl:        'https://daivi-backend.onrender.com', // ← change this
  pollInterval:      30_000,          // re-fetch data every 30 seconds
  keepAliveInterval: 24 * 60 * 1000, // ping Render every 24 min to prevent cold-start
};

/* ═══════════════════════════════════════════════════════════════════════
   State
═══════════════════════════════════════════════════════════════════════ */
const state = {
  data:            null,
  isAdmin:         false,
  adminPassword:   null,
  scurveChart:     null,
  scurveRendered:  false,
};

/* ═══════════════════════════════════════════════════════════════════════
   DOM helpers
═══════════════════════════════════════════════════════════════════════ */
const $  = (id) => document.getElementById(id);
const show = (id) => $(id)?.classList.remove('hidden');
const hide = (id) => $(id)?.classList.add('hidden');

/* ═══════════════════════════════════════════════════════════════════════
   Status classification
═══════════════════════════════════════════════════════════════════════ */
const DONE_VALS   = new Set(['done','complete','completed','yes','✓','finished','ok','1','true','p']);
const NA_VALS     = new Set(['n/a','na','not applicable','nil','-','n.a','n.a.','unsold - not for sale']);
const PROG_VALS   = new Set(['in progress','wip','ongoing','partial','started','in-progress']);

function classifyStatus(rawVal, actName, deadlines) {
  const v = String(rawVal ?? '').trim().toLowerCase();
  if (NA_VALS.has(v))   return 'na';
  if (DONE_VALS.has(v)) return 'done';
  if (PROG_VALS.has(v)) return 'prog';
  // Behind schedule?
  if (actName && deadlines) {
    const dl = deadlines[actName.toLowerCase()];
    if (dl && new Date() > dl) return 'behind';
  }
  return 'pend';
}

function statusLabel(status, rawVal) {
  if (status === 'done')   return '✓ Done';
  if (status === 'na')     return 'N/A';
  if (status === 'behind') return '⚠ Behind';
  if (status === 'prog')   return '⏳ In Progress';
  return rawVal || 'Pending';
}

function buildDeadlines(schedule) {
  const m = {};
  (schedule || []).forEach((s) => {
    if (s.plannedEnd) {
      const d = new Date(s.plannedEnd);
      if (!isNaN(d)) m[s.activity.toLowerCase()] = d;
    }
  });
  return m;
}

/* ═══════════════════════════════════════════════════════════════════════
   HTML builders
═══════════════════════════════════════════════════════════════════════ */
function soldPillHtml(soldStatus) {
  const val = String(soldStatus ?? '').trim().toLowerCase();
  if (!val) return '';
  const isSold = val === 'sold';
  return `<span class="pill ${isSold ? 'pill-sold' : 'pill-unsold'}">${isSold ? 'Sold' : 'Unsold'}</span>`;
}

function actPillHtml(actName, rawVal, deadlines) {
  const status = classifyStatus(rawVal, actName, deadlines);
  const label  = statusLabel(status, rawVal);
  return `
    <span class="act-pill" title="${actName}: ${rawVal || 'Pending'}">
      <span class="act-name">${escHtml(actName)}</span>
      <span class="act-status pill pill-${status}">${label}</span>
    </span>`;
}

function flatRowHtml(flat, deadlines) {
  const acts = Object.entries(flat.activities || {})
    .map(([n, v]) => actPillHtml(n, v, deadlines))
    .join('');
  return `
    <div class="flat-row">
      <span class="flat-no">${escHtml(flat.flatNo)}</span>
      ${soldPillHtml(flat.soldStatus)}
      <span class="flat-type">${escHtml(flat.type || '')}</span>
      <div class="flat-acts">${acts}</div>
    </div>`;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   Group flats by floor
═══════════════════════════════════════════════════════════════════════ */
function groupByFloor(flats) {
  const map = {};
  flats.forEach((f) => {
    const key = f.floor !== null && f.floor !== undefined
      ? String(f.floor).padStart(2, '0')
      : '??';
    (map[key] = map[key] || []).push(f);
  });
  return Object.entries(map).sort(([a], [b]) =>
    a === '??' ? 1 : b === '??' ? -1 : parseInt(a) - parseInt(b)
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Data fetch
═══════════════════════════════════════════════════════════════════════ */
async function fetchData() {
  show('loading-state');
  hide('error-state');
  hide('dashboard');

  try {
    const res = await fetch(`${CONFIG.backendUrl}/api/data`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    state.data = json;
    state.scurveRendered = false; // reset so chart rebuilds with new data
    renderDashboard();
    hide('loading-state');
    show('dashboard');
  } catch (err) {
    hide('loading-state');
    show('error-state');
    $('error-msg').textContent = err.message;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   Render full dashboard
═══════════════════════════════════════════════════════════════════════ */
function renderDashboard() {
  const { summary, lastUpdated, wings, schedule, progressLog } = state.data;

  // ── Summary cards
  // OVERRIDE SUMMARY TOTALS (Exclude Common Lobby from total flat counts)
  let realTotal = 0;
  let realUnsold = 0;
  let myFinished = 0;
  
  const allF = Object.values(wings).flat();
  allF.forEach(f => {
    // If it's a Lobby, we don't count it as a "flat" in the summary cards
    const isLobby = f.wing && f.wing.toLowerCase().includes('lobby');
    if (!isLobby) {
      realTotal++;
      const isSold = String(f.soldStatus ?? '').trim().toLowerCase() === 'sold';
      if (!isSold) realUnsold++;
    }
    
    // Count finished flats
    if (f.type && String(f.type).toLowerCase().includes('finished')) myFinished++;
  });
  
  $('s-total').textContent   = realTotal;
  $('s-sold').textContent    = summary.sold; // (Sold is already accurate at 234)
  $('s-unsold').textContent  = realUnsold;
  $('s-finished').textContent = myFinished;

  // OVERRIDE FOR BEHIND SCHEDULE (Count activities falling behind target)
  let actsBehind = 0; window.behindNames = [];
  const statsMap = {};
  const schedMap = {};
  (schedule || []).forEach(s => {
    schedMap[String(s.activity).trim().toLowerCase()] = s;
  });

  allF.forEach(f => {
    const isSold = String(f.soldStatus ?? '').trim().toLowerCase() === 'sold';
    if (!isSold) return;

    Object.entries(f.activities || {}).forEach(([act, val]) => {
      const aLow = act.toLowerCase();
      const allowed = ['blockwork', 'plum', 'electrical', 'first coat', 'floor', 'tile/floo', 'gypsum', 'guypsum', 'kitchen dado', 'platform', 'door', 'primer', 'putty', 'plaster', 'water proof', 'waterproof', 'toilet dado', 'conduit', 'db box'];
      if (!allowed.some(w => aLow.includes(w))) return;
      const v = String(val ?? '').trim().toLowerCase();
      if (NA_VALS.has(v)) return; 
      
      if (!statsMap[act]) statsMap[act] = { total: 0, done: 0 };
      statsMap[act].total++;
      if (DONE_VALS.has(v)) statsMap[act].done++;
    });
  });

  const td = new Date();
  Object.entries(statsMap).forEach(([act, s]) => {
    const balance = s.total - s.done;
    if (balance === 0) return; 
    
    let planned = s.total;
    const sItem = schedMap[act.toLowerCase()];
    if (sItem && sItem.plannedStart && sItem.plannedEnd) {
      const pD = (str) => {
        if (!str) return new Date();
        const p = str.split('-');
        if (p.length === 3) return new Date(p[2], p[1]-1, p[0]);
        return new Date(str);
      };
      const start = pD(sItem.plannedStart);
      const end = pD(sItem.plannedEnd);
      if (td <= start) planned = 0;
      else if (td >= end) planned = s.total;
      else {
        const tDays = (end - start) / 86400000;
        const eDays = (td - start) / 86400000;
        const pT = Math.round(s.total * (eDays / tDays));
        planned = isNaN(pT) ? s.total : pT;
      }
    }
    if (s.done < planned) { actsBehind++; window.behindNames.push(act); }
  });
  
  $('s-behind').textContent = actsBehind;
  $('s-pct').textContent     = summary.overallPercent + '%';
  $('s-bar').style.width     = summary.overallPercent + '%';
  $('last-updated').textContent = lastUpdated
    ? 'Updated: ' + formatDate(lastUpdated) : '';

  const deadlines = buildDeadlines(schedule);

  // ── Flat Status tab (all flats combined)
  renderWingSection('flat-status-content', Object.values(wings).flat(), deadlines);

  // ── A-Wing / B-Wing / Common Lobby — flexible name matching
  const findWing = (...names) => {
    for (const name of names) {
      for (const key of Object.keys(wings)) {
        if (key.toLowerCase().replace(/[\s-]/g, '') === name.toLowerCase().replace(/[\s-]/g, '')) {
          return wings[key];
        }
      }
    }
    return [];
  };

  renderWingSection('a-wing-content',       findWing('A-Wing', 'AWing', 'A Wing', 'Sheet1'), deadlines);
  renderWingSection('b-wing-content',       findWing('B-Wing', 'BWing', 'B Wing', 'Sheet2'), deadlines);
  renderLobbySection('common-lobby-content', findWing('Common Lobby','CommonLobby','Lobby','Sheet3'), deadlines);
  renderActivitySummary('activity-summary-content');
}

/* ═══════════════════════════════════════════════════════════════════════
   Render wing (floor-by-floor flat list)
═══════════════════════════════════════════════════════════════════════ */
function renderWingSection(containerId, flats, deadlines) {
  const el = $(containerId);
  if (!el) return;
  if (!flats || flats.length === 0) {
    el.innerHTML = '<div class="empty">No data found for this section.</div>';
    return;
  }
  const floors = groupByFloor(flats);
  el.innerHTML = floors.map(([floor, fFlats]) => `
    <div class="floor-section">
      <div class="floor-header">Floor ${floor}</div>
      ${fFlats.map((f) => flatRowHtml(f, deadlines)).join('')}
    </div>`).join('');
}

/* ═══════════════════════════════════════════════════════════════════════
   Render Common Lobby (activity bars + floor-by-floor)
═══════════════════════════════════════════════════════════════════════ */
function renderLobbySection(containerId, flats, deadlines) {
  const el = $(containerId);
  if (!el) return;
  if (!flats || flats.length === 0) {
    el.innerHTML = '<div class="empty">No Common Lobby data found.</div>';
    return;
  }

  // Aggregate per-activity completion
  const stats = {};
  flats.forEach((f) => {
    Object.entries(f.activities || {}).forEach(([act, val]) => {
      const v = String(val ?? '').trim().toLowerCase();
      if (NA_VALS.has(v)) return;
      if (!stats[act]) stats[act] = { done: 0, total: 0 };
      stats[act].total++;
      if (DONE_VALS.has(v)) stats[act].done++;
    });
  });

  const bars = Object.entries(stats)
    .filter(([, s]) => s.total > 0)
    .map(([act, s]) => {
      const pct = Math.round((s.done / s.total) * 100);
      return `
        <div class="lbar">
          <div class="lbar-label">
            <span>${escHtml(act)}</span>
            <span>${s.done} / ${s.total} (${pct}%)</span>
          </div>
          <div class="lbar-track"><div class="lbar-fill" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');

  const floors = groupByFloor(flats);
  const floorHtml = floors.map(([floor, fFlats]) => `
    <div class="floor-section">
      <div class="floor-header">Lobby — Floor ${floor}</div>
      ${fFlats.map((f) => flatRowHtml(f, deadlines)).join('')}
    </div>`).join('');

  el.innerHTML = `
    <div class="card lobby-bars" style="padding:20px 24px;margin-bottom:24px">
      <h3 style="font-size:.9rem;font-weight:600;margin-bottom:14px">Activity Completion Overview</h3>
      ${bars || '<p style="color:var(--muted)">No activity data.</p>'}
    </div>
    ${floorHtml}`;
}

/* ═══════════════════════════════════════════════════════════════════════
   S-Curve chart
═══════════════════════════════════════════════════════════════════════ */
function renderSCurve() {
  if (state.scurveRendered) return;
  if (!state.data) return;

  const { schedule, progressLog } = state.data;
  const canvas = $('scurve-chart');
  if (!canvas) return;

  if (!schedule || schedule.length === 0) {
    $('scurve-note').textContent = 'No schedule.xlsx uploaded — upload it via Admin to see the planned curve.';
    show('scurve-note');
    return;
  }

  // Find project date range from schedule
  let minDate = null, maxDate = null;
  schedule.forEach((s) => {
    const start = s.plannedStart ? new Date(s.plannedStart) : null;
    const end   = s.plannedEnd   ? new Date(s.plannedEnd)   : null;
    if (start && !isNaN(start) && (!minDate || start < minDate)) minDate = start;
    if (end   && !isNaN(end)   && (!maxDate || end > maxDate))   maxDate = end;
  });

  if (!minDate || !maxDate) {
    $('scurve-note').textContent = 'Could not read dates from schedule.xlsx. Check column headers (Planned Start / Planned End).';
    show('scurve-note');
    return;
  }
  hide('scurve-note');

  // Build weekly planned data points
  const totalActs = schedule.length;
  const weeks = [];
  const cur = new Date(minDate); cur.setDate(cur.getDate() - 7);
  const end = new Date(maxDate); end.setDate(end.getDate() + 14);
  while (cur <= end) {
    const wDate = new Date(cur);
    const done = schedule.filter((s) => {
      if (!s.plannedEnd) return false;
      const d = new Date(s.plannedEnd);
      return !isNaN(d) && d <= wDate;
    }).length;
    weeks.push({ x: wDate.toISOString().split('T')[0], y: Math.round((done / totalActs) * 100) });
    cur.setDate(cur.getDate() + 7);
  }

  // Actual progress log
  const actualData = (progressLog || [])
    .map((r) => ({ x: r.date, y: r.percent }))
    .sort((a, b) => new Date(a.x) - new Date(b.x));

  const todayStr = new Date().toISOString().split('T')[0];

  // Destroy old chart
  if (state.scurveChart) { state.scurveChart.destroy(); state.scurveChart = null; }

  const ctx = canvas.getContext('2d');
  state.scurveChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Planned Progress',
          data: weeks,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,.07)',
          borderDash: [6, 3],
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.35,
        },
        {
          label: 'Actual Progress',
          data: actualData,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16,185,129,.07)',
          borderWidth: 2.5,
          pointRadius: 5,
          pointBackgroundColor: '#10b981',
          fill: false,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
          },
        },
        annotation: {
          annotations: {
            todayLine: {
              type: 'line',
              xMin: todayStr,
              xMax: todayStr,
              borderColor: '#f59e0b',
              borderWidth: 2,
              borderDash: [5, 4],
              label: {
                display: true,
                content: 'Today',
                position: 'start',
                backgroundColor: '#f59e0b',
                color: '#fff',
                font: { size: 11, weight: '600' },
                padding: { x: 6, y: 4 },
              },
            },
          },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'week', displayFormats: { week: 'MMM dd' } },
          grid: { color: 'rgba(0,0,0,.04)' },
          title: { display: true, text: 'Date', color: '#64748b' },
        },
        y: {
          min: 0, max: 100,
          grid: { color: 'rgba(0,0,0,.04)' },
          title: { display: true, text: '% Complete', color: '#64748b' },
          ticks: { callback: (v) => v + '%' },
        },
      },
    },
  });

  state.scurveRendered = true;

  if (actualData.length === 0) {
    $('scurve-note').textContent =
      'Actual line will appear after your first data.xlsx upload (the backend logs progress automatically each upload).';
    show('scurve-note');
  } else if (actualData.length === 1) {
    $('scurve-note').textContent =
      `Actual line has 1 data point so far (${actualData[0].x}). It grows into a real curve as you keep uploading updates.`;
    show('scurve-note');
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   Search
═══════════════════════════════════════════════════════════════════════ */
function setupSearch() {
  $('flat-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q || !state.data) { hide('search-result'); return; }

    const allFlats = Object.values(state.data.wings).flat();
    const match = allFlats.find(
      (f) => f.flatNo.toLowerCase() === q || f.flatNo.toLowerCase().startsWith(q)
    );

    const el = $('search-result');
    if (match) {
      const deadlines = buildDeadlines(state.data.schedule);
      const acts = Object.entries(match.activities || {})
        .map(([n, v]) => actPillHtml(n, v, deadlines))
        .join('');
      el.innerHTML = `
        <h3>${escHtml(match.flatNo)}</h3>
        <div class="search-meta">
          ${soldPillHtml(match.soldStatus)}
          <span class="pill pill-pend" style="background:#e2e8f0;color:#475569">${escHtml(match.type || 'Type not set')}</span>
          ${match.floor != null ? `<span style="font-size:.78rem;color:var(--muted);align-self:center">Floor ${match.floor}</span>` : ''}
        </div>
        <div class="search-acts">${acts}</div>`;
      show('search-result');
    } else {
      el.innerHTML = `<p style="color:var(--muted)">No flat found for "<strong>${escHtml(e.target.value)}</strong>"</p>`;
      show('search-result');
    }
  });
}

function clearSearch() {
  $('flat-search').value = '';
  hide('search-result');
}

/* ═══════════════════════════════════════════════════════════════════════
   Tabs
═══════════════════════════════════════════════════════════════════════ */
function setupTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = $(`tab-${tab.dataset.tab}`);
      if (panel) panel.classList.add('active');

      // Render S-Curve lazily when tab is first opened (canvas needs to be visible)
      if (tab.dataset.tab === 's-curve') {
        requestAnimationFrame(renderSCurve);
      }
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   Admin Modal
═══════════════════════════════════════════════════════════════════════ */
function openAdminModal() {
  show('admin-modal');
  if (state.isAdmin) {
    hide('admin-login');
    show('admin-panel');
  } else {
    show('admin-login');
    hide('admin-panel');
    $('admin-password').value = '';
  }
}

function closeAdminModal() { hide('admin-modal'); }

async function adminLogin() {
  const pw = $('admin-password').value;
  hide('login-error');

  try {
    const res = await fetch(`${CONFIG.backendUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });

    if (res.ok) {
      state.adminPassword = pw;
      state.isAdmin = true;
      hide('admin-login');
      show('admin-panel');
    } else {
      const err = await res.json();
      $('login-error').textContent = err.error || 'Incorrect password.';
      show('login-error');
    }
  } catch {
    $('login-error').textContent = 'Cannot reach server. Check if the backend URL in app.js is correct.';
    show('login-error');
  }
}

function adminLogout() {
  state.isAdmin = false;
  state.adminPassword = null;
  hide('admin-panel');
  show('admin-login');
  $('admin-password').value = '';
}

async function doUpload(type) {
  const fileInputId  = type === 'data' ? 'data-file' : 'schedule-file';
  const statusId     = type === 'data' ? 'data-status' : 'schedule-status';
  const fileInput    = $(fileInputId);
  const statusEl     = $(statusId);

  if (!fileInput.files[0]) {
    statusEl.textContent = 'Please select a file first.';
    statusEl.className   = 'upload-status error';
    return;
  }

  statusEl.textContent = '⏳ Uploading…';
  statusEl.className   = 'upload-status loading';

  const fd = new FormData();
  fd.append('password', state.adminPassword || '');
  fd.append('fileType', type);
  fd.append('file', fileInput.files[0]);

  try {
    const res  = await fetch(`${CONFIG.backendUrl}/api/upload`, { method: 'POST', body: fd });
    const json = await res.json();

    if (!res.ok) {
      statusEl.textContent = json.error || 'Upload failed.';
      statusEl.className   = 'upload-status error';
      if (res.status === 401) {
        // Session expired / wrong password
        state.isAdmin = false;
        hide('admin-panel');
        show('admin-login');
        $('login-error').textContent = 'Session expired — please log in again.';
        show('login-error');
      }
    } else {
      const pctNote = json.overallPercent != null ? ` — Overall: ${json.overallPercent}%` : '';
      statusEl.textContent = `✓ ${json.message}${pctNote}`;
      statusEl.className   = 'upload-status success';
      fileInput.value      = '';
      // Refresh dashboard after a short delay
      setTimeout(fetchData, 1200);
    }
  } catch {
    statusEl.textContent = 'Network error — check backend URL in app.js.';
    statusEl.className   = 'upload-status error';
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   Polling + Keep-alive
═══════════════════════════════════════════════════════════════════════ */
function startPolling() {
  // Re-fetch data every 30 seconds so all viewers see updates automatically
  setInterval(fetchData, CONFIG.pollInterval);

  // Ping backend every 24 min to prevent Render.com free-tier cold start
  setInterval(async () => {
    try { await fetch(`${CONFIG.backendUrl}/api/ping`); } catch { /* ignore */ }
  }, CONFIG.keepAliveInterval);
}

/* ═══════════════════════════════════════════════════════════════════════
   Init
═══════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupSearch();

  $('admin-btn').addEventListener('click', openAdminModal);

  // Close modal when clicking the backdrop
  $('admin-modal').addEventListener('click', (e) => {
    if (e.target === $('admin-modal')) closeAdminModal();
  });

  // Login on Enter key
  $('admin-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') adminLogin();
  });

  fetchData();
  startPolling();
});

/* ═══════════════════════════════════════════════════════════════════════
   Activity Summary Tab
═══════════════════════════════════════════════════════════════════════ */
function renderActivitySummary(containerId) {
  const el = document.getElementById(containerId) || document.querySelector(containerId) || $(containerId);
  if (!el || !state.data) return;

  const stats = {};
  const allFlats = Object.values(state.data.wings).flat();

  allFlats.forEach(f => {
    const isSold = String(f.soldStatus ?? '').trim().toLowerCase() === 'sold';
    if (!isSold) return;

    Object.entries(f.activities || {}).forEach(([act, val]) => {
      const aLow = act.toLowerCase();
      const allowed = ['blockwork', 'plum', 'electrical', 'first coat', 'floor', 'tile/floo', 'gypsum', 'guypsum', 'kitchen dado', 'platform', 'door', 'primer', 'putty', 'plaster', 'water proof', 'waterproof', 'toilet dado', 'conduit', 'db box'];
      const isAllowed = allowed.some(w => aLow.includes(w));
      if (!isAllowed) return;

      const v = String(val ?? '').trim().toLowerCase();
      if (NA_VALS.has(v)) return; 
      
      if (!stats[act]) stats[act] = { total: 0, done: 0 };
      stats[act].total++;
      if (DONE_VALS.has(v)) stats[act].done++;
    });
  });

  const SORT_ORDER = ['blockwork', 'plum', 'conduit', 'db box', 'plaster', 'water', 'gypsum', 'guypsum', 'floor', 'tile/floo', 'toilet dado', 'kitchen dado', 'platform', 'door', 'primer', 'putty', 'first coat', 'electrical'];
  function getSortRank(actName) {
    const low = actName.toLowerCase();
    for (let i = 0; i < SORT_ORDER.length; i++) {
      if (low.includes(SORT_ORDER[i])) return i;
    }
    return 999;
  }

  const acts = Object.entries(stats).sort((a, b) => {
    const rankA = getSortRank(a[0]);
    const rankB = getSortRank(b[0]);
    if (rankA !== rankB) return rankA - rankB;
    return a[0].localeCompare(b[0]);
  });

  if (acts.length === 0) {
    el.innerHTML = '<div class="empty">No activities found.</div>';
    return;
  }

  const schedMap = {};
  (state.data.schedule || []).forEach(s => {
    schedMap[String(s.activity).trim().toLowerCase()] = s;
  });

  const today = new Date();
  const dateUpdated = state.data.lastUpdated ? new Date(state.data.lastUpdated) : new Date();
  const dateStr = dateUpdated.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  const rows = acts.map(([act, s]) => {
    const balance = s.total - s.done;
    const pct = Math.round((s.done / s.total) * 100) || 0;
    const balColor = balance < 10 ? 'var(--green)' : 'var(--red)';
    const balText = balance === 0 ? 'Completed' : balance;

    let planned = s.total;
    const sched = schedMap[act.toLowerCase()];
    if (sched && sched.plannedStart && sched.plannedEnd) {
      const parseD = (str) => {
        if (!str) return new Date();
        const p = str.split('-');
        if (p.length === 3) return new Date(p[2], p[1]-1, p[0]); // DD-MM-YYYY
        return new Date(str);
      };
      const start = parseD(sched.plannedStart);
      const end = parseD(sched.plannedEnd);
      if (today <= start) {
        planned = 0;
      } else if (today >= end) {
        planned = s.total;
      } else {
        const totalDays = (end - start) / (1000 * 60 * 60 * 24);
        const elapsedDays = (today - start) / (1000 * 60 * 60 * 24);
        const p = Math.round(s.total * (elapsedDays / totalDays));
        planned = isNaN(p) ? s.total : p;
      }
    }

    const isAhead = (s.done >= planned) || (balance === 0);
    const statusText = balance === 0 ? 'Completed' : (isAhead ? 'Ahead' : 'Behind');
    const statusColor = isAhead ? 'var(--green)' : 'var(--red)';

    return `
      <tr style="border-bottom: 1px solid var(--border);">
        <td style="padding:14px 16px; font-weight:600; color:var(--navy);">${escHtml(act)}</td>
        <td style="padding:14px 16px; text-align:center;">${s.total}</td>
        <td style="padding:14px 16px; text-align:center; color:var(--blue); font-weight:600; font-size:1.1em;">${planned}</td>
        <td style="padding:14px 16px; text-align:center; color:var(--green); font-weight:700; font-size:1.1em;">${s.done}</td>
        <td style="padding:14px 16px; text-align:center; font-weight:700; color:${statusColor};">${statusText}</td>
        <td style="padding:14px 16px; text-align:center; color:${balColor}; font-weight:700; font-size:1.1em;">${balText}</td>
        <td style="padding:14px 16px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <div style="flex:1; background:var(--border); height:8px; border-radius:4px; overflow:hidden;">
              <div style="width:${pct}%; background:var(--green); height:100%;"></div>
            </div>
            <span style="font-size:0.8rem; font-weight:600; min-width:36px; text-align:right;">${pct}%</span>
          </div>
        </td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="card" style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; min-width:850px;">
        <thead>
          <tr style="background:var(--navy); color:white; text-align:left;">
            <th style="padding:14px 16px;">Activity Name</th>
            <th style="padding:14px 16px; text-align:center;">Total<br><span style="font-size:0.75em; opacity:0.8;">Flats</span></th>
            <th style="padding:14px 16px; text-align:center;">Planned Target<br><span style="font-size:0.75em; opacity:0.8;">(Schedule)</span></th>
            <th style="padding:14px 16px; text-align:center;">Actual Done<br><span style="font-size:0.75em; opacity:0.8;">(As of ${dateStr})</span></th>
            <th style="padding:14px 16px; text-align:center;">Status</th>
            <th style="padding:14px 16px; text-align:center;">Balance</th>
            <th style="padding:14px 16px; width:200px;">Progress</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>`;
}
function showBehindModal() {
  if (window.behindNames && window.behindNames.length > 0) {
    document.getElementById('behind-list').innerHTML = window.behindNames.map(n => `<li>${escHtml(n)}</li>`).join('');
  } else {
    document.getElementById('behind-list').innerHTML = "<li>All caught up!</li>";
  }
  document.getElementById('behind-modal').showModal();
}