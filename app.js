// ============================================================
// SCHEMA VERSION
// ============================================================
// Lets future changes detect and migrate old data instead of silently
// breaking when a field is missing from data saved under an older shape.
const CURRENT_SCHEMA_VERSION = 3;

function getSchemaVersion() {
  return parseInt(localStorage.getItem('schemaVersion')) || 1;
}
function setSchemaVersion(v) {
  localStorage.setItem('schemaVersion', String(v));
}
// No migrations exist yet since this is the first versioned release.
// Future changes add steps here, e.g.: if (getSchemaVersion() < 4) { ...migrate...; setSchemaVersion(4); }
setSchemaVersion(CURRENT_SCHEMA_VERSION);

// ============================================================
// DATA LAYER
// ============================================================

function getDrills() {
  const raw = localStorage.getItem('drills');
  return raw ? JSON.parse(raw) : [];
}
function saveDrills(drills) {
  localStorage.setItem('drills', JSON.stringify(drills));
}
function getDrillById(id) {
  return getDrills().find((d) => String(d.id) === String(id)) || null;
}

function getSessions() {
  const raw = localStorage.getItem('sessions');
  return raw ? JSON.parse(raw) : [];
}
function saveSessions(sessions) {
  localStorage.setItem('sessions', JSON.stringify(sessions));
}

function getActiveSessionId() {
  return localStorage.getItem('activeSessionId');
}
function setActiveSessionId(id) {
  if (id === null) {
    localStorage.removeItem('activeSessionId');
  } else {
    localStorage.setItem('activeSessionId', id);
  }
}
function findActiveSession() {
  const id = getActiveSessionId();
  if (!id) return null;
  return getSessions().find((s) => String(s.id) === String(id)) || null;
}

// ============================================================
// SCORING (generalized across scoring types)
// ============================================================

const POINTS_MINOR = { a: 5, c: 3, d: 1, m: 0, ns: -10 };
const POINTS_MAJOR = { a: 5, c: 4, d: 2, m: 0, ns: -10 };

// Builds the correct result object shape based on the drill's scoringType.
// This is the one place that needs to know about all three scoring types.
function buildStringResult(drill, timeSeconds, inputs) {
  const base = {
    id: Date.now(),
    timeSeconds,
    scoringType: drill.scoringType,
    loggedAt: new Date().toISOString(),
  };

  if (drill.scoringType === 'uspsa_zones') {
    const table = drill.powerFactor === 'major' ? POINTS_MAJOR : POINTS_MINOR;
    const hits = inputs.hits;
    const points =
      hits.a * table.a + hits.c * table.c + hits.d * table.d +
      hits.m * table.m + hits.ns * table.ns;
    const hitFactor = timeSeconds > 0 ? Math.round((points / timeSeconds) * 100) / 100 : 0;
    return { ...base, hits, points, hitFactor };
  }

  if (drill.scoringType === 'hit_miss') {
    const hitsCount = inputs.hitsCount;
    const missesCount = inputs.missesCount;
    const total = hitsCount + missesCount;
    const accuracyPercent = total > 0 ? Math.round((hitsCount / total) * 1000) / 10 : 0;
    const rate = timeSeconds > 0 ? Math.round((hitsCount / timeSeconds) * 100) / 100 : 0;
    return { ...base, hitsCount, missesCount, accuracyPercent, rate };
  }

  // time_only: no accuracy fields at all - time itself is the metric.
  return base;
}

// Storage stays ISO (YYYY-MM-DD) since it sorts correctly as plain text and
// is what JS Date parsing expects - only the display format changes here.
function formatDate(isoDateString) {
  if (!isoDateString) return '';
  const [year, month, day] = isoDateString.split('-');
  return `${month}/${day}/${year}`;
}

// Human-readable one-liner for a logged string, used in session, history, and PR views.
// Omits zero-value fields (e.g. no Misses, no No-Shoots) to keep it uncluttered.
function formatStringSummary(s) {
  if (s.scoringType === 'uspsa_zones') {
    const zoneParts = [];
    if (s.hits.a > 0) zoneParts.push(`A:${s.hits.a}`);
    if (s.hits.c > 0) zoneParts.push(`C:${s.hits.c}`);
    if (s.hits.d > 0) zoneParts.push(`D:${s.hits.d}`);
    if (s.hits.m > 0) zoneParts.push(`M:${s.hits.m}`);
    if (s.hits.ns > 0) zoneParts.push(`NS:${s.hits.ns}`);
    const zoneText = zoneParts.length > 0 ? zoneParts.join(' ') : 'No hits recorded';
    return `${s.timeSeconds}s — ${zoneText} — HF:${s.hitFactor}`;
  }
  if (s.scoringType === 'hit_miss') {
    const parts = [`${s.hitsCount} hits`];
    if (s.missesCount > 0) parts.push(`${s.missesCount} misses`); // only shown if there were any
    return `${s.timeSeconds}s — ${parts.join(' / ')} — ${s.accuracyPercent}% — Rate:${s.rate}/s`;
  }
  return `${s.timeSeconds}s`;
}

// ============================================================
// PERSONAL RECORDS (generalized)
// ============================================================

function getAllDrillStats() {
  const statsMap = {};

  getSessions().forEach((session) => {
    session.drillEntries.forEach((entry) => {
      if (!statsMap[entry.drillId]) {
        const drill = getDrillById(entry.drillId);
        statsMap[entry.drillId] = {
          drillId: entry.drillId,
          drillName: entry.drillName,
          scoringType: drill ? drill.scoringType : 'time_only',
          bestTime: null,
          bestHitFactor: null,
          bestRate: null,
          totalStrings: 0,
        };
      }
      const stat = statsMap[entry.drillId];

      entry.strings.forEach((s) => {
        stat.totalStrings++;
        if (stat.bestTime === null || s.timeSeconds < stat.bestTime) {
          stat.bestTime = s.timeSeconds;
        }
        if (s.scoringType === 'uspsa_zones' && (stat.bestHitFactor === null || s.hitFactor > stat.bestHitFactor)) {
          stat.bestHitFactor = s.hitFactor;
        }
        if (s.scoringType === 'hit_miss' && (stat.bestRate === null || s.rate > stat.bestRate)) {
          stat.bestRate = s.rate;
        }
      });
    });
  });

  return Object.values(statsMap);
}
function getDrillStat(drillId) {
  return getAllDrillStats().find((stat) => stat.drillId === drillId) || null;
}

// Shared PR check - a string counts as a PR if it matches the all-time best
// for its metric (time, hit factor, or rate depending on scoring type).
function isStringAPR(stat, s) {
  if (!stat) return false;
  const isBestTime = s.timeSeconds === stat.bestTime;
  const isBestHF = s.scoringType === 'uspsa_zones' && s.hitFactor === stat.bestHitFactor && s.hitFactor > 0;
  const isBestRate = s.scoringType === 'hit_miss' && s.rate === stat.bestRate && s.rate > 0;
  return isBestTime || isBestHF || isBestRate;
}

// The best string logged THIS SESSION for a given drill entry - independent
// of all-time PR status, which is checked separately via isStringAPR.
function getBestStringInEntry(entry, drill) {
  if (!entry.strings.length) return null;
  if (drill.scoringType === 'uspsa_zones') {
    return entry.strings.reduce((best, s) => (s.hitFactor > best.hitFactor ? s : best));
  }
  if (drill.scoringType === 'hit_miss') {
    return entry.strings.reduce((best, s) => (s.rate > best.rate ? s : best));
  }
  return entry.strings.reduce((best, s) => (s.timeSeconds < best.timeSeconds ? s : best)); // time_only: lowest wins
}

function renderPRList() {
  const stats = getAllDrillStats().sort((a, b) => a.drillName.localeCompare(b.drillName));
  const listEl = document.getElementById('pr-list');

  if (stats.length === 0) {
    listEl.innerHTML = `<p class="empty-state">No strings logged yet.</p>`;
    return;
  }

  listEl.innerHTML = stats.map((stat) => {
    const secondaryStat =
      stat.scoringType === 'uspsa_zones'
        ? `<div class="pr-stat"><span class="pr-label">Best Hit Factor</span><span class="pr-value">${stat.bestHitFactor}</span></div>`
        : stat.scoringType === 'hit_miss'
        ? `<div class="pr-stat"><span class="pr-label">Best Rate</span><span class="pr-value">${stat.bestRate}/s</span></div>`
        : '';

    return `
      <div class="pr-card">
        <h3>${stat.drillName}</h3>
        <div class="pr-row">
          <div class="pr-stat">
            <span class="pr-label">Best Time</span>
            <span class="pr-value">${stat.bestTime}s</span>
          </div>
          ${secondaryStat}
        </div>
        <p class="pr-count">${stat.totalStrings} string${stat.totalStrings === 1 ? '' : 's'} logged</p>
      </div>
    `;
  }).join('');
}

// ============================================================
// VIEW STATE
// ============================================================

let currentView = 'main'; // 'main', 'history', or 'prs'
let pendingNewDrillName = null; // holds the typed name while the new-drill setup panel is open
let editingContext = null; // { entryIndex, stringId } while editing a logged string, else null
let openMenuStringId = null; // which string's three-dot menu is currently open, if any

function showHistory() {
  currentView = 'history';
  renderApp();
}
function showPRs() {
  currentView = 'prs';
  renderApp();
}
function hideOverlayViews() {
  currentView = 'main';
  renderApp();
}

function renderHistoryList() {
  const sessions = [...getSessions()].reverse();
  const listEl = document.getElementById('history-list');

  if (sessions.length === 0) {
    listEl.innerHTML = `<p class="empty-state">No sessions logged yet.</p>`;
    return;
  }

  listEl.innerHTML = sessions.map((session) => {
    const totalStrings = session.drillEntries.reduce((sum, e) => sum + e.strings.length, 0);

    const drillLines = session.drillEntries.map((entry) => {
      const drill = getDrillById(entry.drillId);
      if (!drill) return '';
      const best = getBestStringInEntry(entry, drill);
      const bestText = best ? formatStringSummary(best) : 'No strings logged';
      return `
        <div class="history-drill-line">
          <span class="history-drill-name">${entry.drillName}</span>
          <span class="history-drill-best">${bestText}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="history-card">
        <div class="history-card-header">
          <strong>${session.name || 'Untitled Session'}</strong>
          <span class="history-date">${formatDate(session.date)}</span>
        </div>
        ${drillLines || '<p class="history-drills">No drills logged</p>'}
        <p class="history-count">${totalStrings} string${totalStrings === 1 ? '' : 's'} logged</p>
      </div>
    `;
  }).join('');
}

function toggleStringMenu(stringId) {
  openMenuStringId = openMenuStringId === stringId ? null : stringId;
  renderApp();
}

function startEditString(entryIndex, stringId) {
  editingContext = { entryIndex, stringId };
  openMenuStringId = null;
  renderApp();
}

function cancelEditString() {
  editingContext = null;
  renderApp();
}

function deleteString(entryIndex, stringId) {
  if (!confirm('Delete this logged string? This cannot be undone.')) return;

  const session = findActiveSession();
  if (!session) return;

  const entry = session.drillEntries[entryIndex];
  entry.strings = entry.strings.filter((s) => String(s.id) !== String(stringId));

  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  openMenuStringId = null;
  renderApp();
}

function updateString(entryIndex, stringId, timeSeconds, inputs) {
  const session = findActiveSession();
  if (!session) return;

  const entry = session.drillEntries[entryIndex];
  const drill = getDrillById(entry.drillId);
  if (!drill) return;

  const oldString = entry.strings.find((s) => String(s.id) === String(stringId));
  const updated = buildStringResult(drill, timeSeconds, inputs);
  updated.id = oldString ? oldString.id : Date.now(); // keep the same id, matching its original type
  updated.loggedAt = oldString ? oldString.loggedAt : updated.loggedAt;

  entry.strings = entry.strings.map((s) => (String(s.id) === String(stringId) ? updated : s));

  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  editingContext = null;
  renderApp();
}

// ============================================================
// BACKUP / RESTORE
// ============================================================
// Everything lives only in this device's localStorage, so this is the
// safety net against a cleared cache, phone reset, or PWA reinstall.

function exportData() {
  const data = {
    schemaVersion: getSchemaVersion(),
    drills: getDrills(),
    sessions: getSessions(),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `project-procedural-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    let data;
    try {
      data = JSON.parse(e.target.result);
    } catch (err) {
      alert('Could not read this file - make sure it\'s a Project Procedural backup.');
      return;
    }

    if (!confirm('This will overwrite ALL current data on this device with the backup file. This cannot be undone. Continue?')) {
      return;
    }

    if (data.drills) saveDrills(data.drills);
    if (data.sessions) saveSessions(data.sessions);
    if (data.schemaVersion) setSchemaVersion(data.schemaVersion);

    alert('Backup imported successfully.');
    renderApp();
  };
  reader.readAsText(file);
}

// ============================================================
// SESSION ACTIONS
// ============================================================

function startSession() {
  const sessions = getSessions();
  const newSession = {
    id: Date.now(),
    date: new Date().toISOString().split('T')[0],
    startedAt: new Date().toISOString(),
    name: '',
    drillEntries: [],
  };
  sessions.push(newSession);
  saveSessions(sessions);
  setActiveSessionId(newSession.id);
  renderApp();
}

function endSession() {
  if (!confirm('End this session? You can still view it later in Past Sessions.')) return;
  stopSessionTimer();
  setActiveSessionId(null);
  renderApp();
}

function endDrillEntry(entryIndex) {
  const session = findActiveSession();
  if (!session) return;
  const entry = session.drillEntries[entryIndex];

  if (!entry.strings || entry.strings.length === 0) {
    alert('Log at least one string before ending this drill.');
    return;
  }
  if (!confirm('Mark this drill as done for this session?')) return;

  entry.completed = true;
  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  renderApp();
}

function reactivateDrillEntry(entryIndex) {
  const session = findActiveSession();
  if (!session) return;
  session.drillEntries[entryIndex].completed = false;
  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  renderApp();
}

function removeDrillFromSession(entryIndex) {
  if (!confirm('Remove this drill and all strings logged under it in this session?')) return;

  const session = findActiveSession();
  if (!session) return;

  session.drillEntries.splice(entryIndex, 1);
  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  renderApp();
}

// ============================================================
// SESSION TIMER + ROUNDS FIRED
// ============================================================

let sessionTimerInterval = null;
let timerRunningForSessionId = null;

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function updateTimerDisplay(startedAt) {
  const el = document.getElementById('session-timer');
  if (!el) return; // view isn't showing right now - nothing to update
  const elapsedMs = Date.now() - new Date(startedAt).getTime();
  el.textContent = formatElapsed(Math.max(0, elapsedMs));
}

function startSessionTimer(session) {
  // Avoid restarting the interval on every render - only (re)start if this
  // is a different session than the one already being timed.
  if (timerRunningForSessionId === session.id) return;

  stopSessionTimer();
  const startedAt = session.startedAt || new Date().toISOString(); // fallback for pre-timer legacy data
  updateTimerDisplay(startedAt);
  sessionTimerInterval = setInterval(() => updateTimerDisplay(startedAt), 1000);
  timerRunningForSessionId = session.id;
}

function stopSessionTimer() {
  if (sessionTimerInterval) clearInterval(sessionTimerInterval);
  sessionTimerInterval = null;
  timerRunningForSessionId = null;
}

// Total rounds fired across the whole session so far, summed from every
// logged string. What counts as a "round" depends on the drill's scoring type.
function getSessionRoundsFired(session) {
  let total = 0;
  session.drillEntries.forEach((entry) => {
    entry.strings.forEach((s) => {
      if (s.scoringType === 'uspsa_zones') {
        total += s.hits.a + s.hits.c + s.hits.d + s.hits.m + s.hits.ns;
      } else if (s.scoringType === 'hit_miss') {
        total += s.hitsCount + s.missesCount;
      }
      // time_only strings don't track individual rounds fired
    });
  });
  return total;
}

function updateSessionName(value) {
  const session = findActiveSession();
  if (!session) return;
  session.name = value;
  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
}

// Called when "Add Drill" is clicked. Either adds an existing drill straight
// to the session, or opens the new-drill setup panel if the name is unrecognized.
function handleAddDrillClick() {
  const input = document.getElementById('add-drill-input');
  const name = input.value.trim();
  if (!name) return;

  const session = findActiveSession();
  if (!session) return;

  const alreadyInSession = session.drillEntries.some(
    (e) => e.drillName.toLowerCase() === name.toLowerCase()
  );
  if (alreadyInSession) {
    input.value = '';
    return;
  }

  const existingDrill = getDrills().find((d) => d.name.toLowerCase() === name.toLowerCase());

  if (existingDrill) {
    addDrillEntryToSession(existingDrill);
    input.value = '';
  } else {
    // New drill: open the setup panel instead of guessing at its scoring type.
    pendingNewDrillName = name;
    document.getElementById('new-drill-name-display').textContent = name;
    document.getElementById('new-drill-setup').classList.remove('hidden');
  }
}

function confirmNewDrill() {
  if (!pendingNewDrillName) return;

  const drill = {
    id: Date.now(),
    name: pendingNewDrillName,
    type: 'drill',
    discipline: document.getElementById('new-drill-discipline').value,
    scoringType: document.getElementById('new-drill-scoring-type').value,
    powerFactor: document.getElementById('new-drill-power-factor').value,
    roundCount: parseInt(document.getElementById('new-drill-round-count').value) || null,
    targetCount: parseInt(document.getElementById('new-drill-target-count').value) || null,
    parTime: parseFloat(document.getElementById('new-drill-par-time').value) || null,
    createdAt: new Date().toISOString(),
  };

  const drills = getDrills();
  drills.push(drill);
  saveDrills(drills);

  addDrillEntryToSession(drill);
  cancelNewDrill();
}

function cancelNewDrill() {
  pendingNewDrillName = null;
  document.getElementById('new-drill-setup').classList.add('hidden');
  document.getElementById('add-drill-input').value = '';
  document.getElementById('new-drill-round-count').value = '';
  document.getElementById('new-drill-target-count').value = '';
  document.getElementById('new-drill-par-time').value = '';
  renderApp();
}

function addDrillEntryToSession(drill) {
  const session = findActiveSession();
  if (!session) return;
  session.drillEntries.push({ drillId: drill.id, drillName: drill.name, strings: [] });
  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  renderApp();
}

function logString(drillEntryIndex, timeSeconds, inputs) {
  const session = findActiveSession();
  if (!session) return;

  const entry = session.drillEntries[drillEntryIndex];
  const drill = getDrillById(entry.drillId);
  if (!drill) return;

  const result = buildStringResult(drill, timeSeconds, inputs);
  entry.strings.push(result);

  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  renderApp();
}

// ============================================================
// RENDERING
// ============================================================

// Builds the correct mini-form HTML for a drill entry based on its scoring type.
// When editingString is provided, pre-fills values and swaps the button for Save/Cancel.
function buildMiniForm(drill, index, editingString) {
  const isEditing = !!editingString;
  const timeValue = isEditing ? editingString.timeSeconds : '';

  const actionButtons = isEditing
    ? `<button class="log-string-btn" data-index="${index}" data-scoring="${drill.scoringType}" data-editing-id="${editingString.id}">Save Changes</button>
       <button class="cancel-edit-btn secondary">Cancel</button>`
    : `<div class="log-end-row">
         <button class="log-string-btn" data-index="${index}" data-scoring="${drill.scoringType}">Log String</button>
         <button class="end-drill-btn" data-index="${index}">End Drill</button>
       </div>`;

  if (drill.scoringType === 'uspsa_zones') {
    const h = isEditing ? editingString.hits : { a: '', c: '', d: '', m: '', ns: '' };
    return `
      <input type="number" step="0.01" inputmode="decimal" class="mini-time" placeholder="Time (seconds)" value="${timeValue}">
      <div class="hits-row-mini">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="a" placeholder="A" min="0" value="${h.a}">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="c" placeholder="C" min="0" value="${h.c}">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="d" placeholder="D" min="0" value="${h.d}">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="m" placeholder="M" min="0" value="${h.m}">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="ns" placeholder="NS" min="0" value="${h.ns}">
      </div>
      ${actionButtons}
    `;
  }
  if (drill.scoringType === 'hit_miss') {
    const hitsCount = isEditing ? editingString.hitsCount : '';
    const missesCount = isEditing ? editingString.missesCount : '';
    return `
      <input type="number" step="0.01" inputmode="decimal" class="mini-time" placeholder="Time (seconds)" value="${timeValue}">
      <div class="hits-row-mini">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit-count" placeholder="Hits" min="0" value="${hitsCount}">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-miss-count" placeholder="Misses" min="0" value="${missesCount}">
      </div>
      ${actionButtons}
    `;
  }
  // time_only
  return `
    <input type="number" step="0.01" inputmode="decimal" class="mini-time" placeholder="Time (seconds)" value="${timeValue}">
    ${actionButtons}
  `;
}

function renderApp() {
  const session = findActiveSession();
  const startView = document.getElementById('session-start-view');
  const activeView = document.getElementById('active-session-view');
  const historyView = document.getElementById('history-view');
  const prView = document.getElementById('pr-view');

  if (currentView === 'history') {
    stopSessionTimer();
    startView.classList.add('hidden');
    activeView.classList.add('hidden');
    prView.classList.add('hidden');
    historyView.classList.remove('hidden');
    renderHistoryList();
    return;
  }
  if (currentView === 'prs') {
    stopSessionTimer();
    startView.classList.add('hidden');
    activeView.classList.add('hidden');
    historyView.classList.add('hidden');
    prView.classList.remove('hidden');
    renderPRList();
    return;
  }
  historyView.classList.add('hidden');
  prView.classList.add('hidden');

  if (!session) {
    stopSessionTimer();
    startView.classList.remove('hidden');
    activeView.classList.add('hidden');
    return;
  }

  startView.classList.add('hidden');
  activeView.classList.remove('hidden');

  startSessionTimer(session);
  document.getElementById('session-rounds').textContent =
    `${getSessionRoundsFired(session)} rounds fired`;

  document.getElementById('session-name').value = session.name || '';

  const datalist = document.getElementById('drill-options');
  datalist.innerHTML = getDrills().map((d) => `<option value="${d.name}">`).join('');

  const container = document.getElementById('drill-entries');
  container.innerHTML = session.drillEntries.map((entry, index) => {
    const drill = getDrillById(entry.drillId);
    if (!drill) return ''; // defensive - shouldn't happen, but avoids a crash if data is ever inconsistent

    const stat = getDrillStat(entry.drillId);
    const disciplineTag = drill.discipline === 'rifle' ? ' 🎯 Rifle' : '';

    const stringsHtml = entry.strings.map((s) => {
      const badge = isStringAPR(stat, s) ? ' <span class="pr-badge">🏆 PR</span>' : '';
      const menuOpen = String(openMenuStringId) === String(s.id);

      return `
        <li>
          <div class="string-row">
            <span class="string-text">${formatStringSummary(s)}${badge}</span>
            <button class="string-menu-btn" data-string-id="${s.id}">&#8942;</button>
          </div>
          <div class="string-menu ${menuOpen ? '' : 'hidden'}">
            <button class="edit-string-btn" data-entry-index="${index}" data-string-id="${s.id}">Edit</button>
            <button class="delete-string-btn" data-entry-index="${index}" data-string-id="${s.id}">Delete</button>
          </div>
        </li>
      `;
    }).join('');

    const editingString = (editingContext && editingContext.entryIndex === index)
      ? entry.strings.find((s) => String(s.id) === String(editingContext.stringId))
      : null;

    const hintParts = [];
    if (drill.roundCount) hintParts.push(`Rounds: ${drill.roundCount}`);
    if (drill.parTime) hintParts.push(`Par: ${drill.parTime}s`);
    const hintLine = hintParts.length ? `<p class="par-hint">${hintParts.join(' &middot; ')}</p>` : '';

    // Completed drills show a session-best summary instead of the logging form.
    let formArea;
    if (entry.completed) {
      const bestString = getBestStringInEntry(entry, drill);
      const isPR = bestString && isStringAPR(stat, bestString);
      formArea = `
        <div class="session-best-row">
          <div class="session-best ${isPR ? 'session-best-pr' : ''}">
            <span class="session-best-label">Best this session${isPR ? ' &mdash; 🏆 PR' : ''}</span>
            <span class="session-best-value">${bestString ? formatStringSummary(bestString) : '—'}</span>
          </div>
          <button class="edit-drill-btn" data-index="${index}">Edit</button>
        </div>
      `;
    } else {
      formArea = `${hintLine}${buildMiniForm(drill, index, editingString)}`;
    }

    return `
      <div class="drill-entry ${entry.completed ? 'drill-entry-completed' : ''}" data-index="${index}">
        <div class="drill-entry-header">
          <h3>${entry.drillName}<span class="discipline-tag">${disciplineTag}</span></h3>
          <button class="remove-drill-btn" data-index="${index}" title="Remove drill">&times;</button>
        </div>
        <ul class="string-list-mini">${stringsHtml}</ul>
        <div class="mini-form">
          ${formArea}
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================
// EVENT WIRING
// ============================================================

document.getElementById('start-session-btn').addEventListener('click', startSession);
document.getElementById('end-session-btn').addEventListener('click', endSession);
document.getElementById('view-history-btn').addEventListener('click', showHistory);
document.getElementById('back-from-history-btn').addEventListener('click', hideOverlayViews);
document.getElementById('view-prs-btn').addEventListener('click', showPRs);
document.getElementById('back-from-pr-btn').addEventListener('click', hideOverlayViews);

document.getElementById('export-data-btn').addEventListener('click', exportData);
document.getElementById('import-data-btn').addEventListener('click', () => {
  document.getElementById('import-file-input').click();
});
document.getElementById('import-file-input').addEventListener('change', (e) => {
  if (e.target.files.length > 0) importData(e.target.files[0]);
  e.target.value = ''; // reset so importing the same filename again still fires 'change'
});

document.getElementById('session-name').addEventListener('input', (e) => {
  updateSessionName(e.target.value);
});

document.getElementById('add-drill-btn').addEventListener('click', handleAddDrillClick);
document.getElementById('confirm-new-drill-btn').addEventListener('click', confirmNewDrill);
document.getElementById('cancel-new-drill-btn').addEventListener('click', cancelNewDrill);

// Only show the power factor picker when it's actually relevant (zone scoring).
document.getElementById('new-drill-scoring-type').addEventListener('change', (e) => {
  const row = document.getElementById('new-drill-power-factor-row');
  row.style.display = e.target.value === 'uspsa_zones' ? 'flex' : 'none';
});

// Event delegation: drill entries, strings, and their mini-forms are created dynamically.
document.getElementById('drill-entries').addEventListener('click', (e) => {
  if (e.target.matches('.remove-drill-btn')) {
    removeDrillFromSession(parseInt(e.target.dataset.index));
    return;
  }

  if (e.target.matches('.end-drill-btn')) {
    endDrillEntry(parseInt(e.target.dataset.index));
    return;
  }

  if (e.target.matches('.edit-drill-btn')) {
    reactivateDrillEntry(parseInt(e.target.dataset.index));
    return;
  }

  if (e.target.matches('.string-menu-btn')) {
    toggleStringMenu(e.target.dataset.stringId);
    return;
  }

  if (e.target.matches('.edit-string-btn')) {
    startEditString(parseInt(e.target.dataset.entryIndex), e.target.dataset.stringId);
    return;
  }

  if (e.target.matches('.delete-string-btn')) {
    deleteString(parseInt(e.target.dataset.entryIndex), e.target.dataset.stringId);
    return;
  }

  if (e.target.matches('.cancel-edit-btn')) {
    cancelEditString();
    return;
  }

  if (e.target.matches('.log-string-btn')) {
    const drillEntryIndex = parseInt(e.target.dataset.index);
    const scoringType = e.target.dataset.scoring;
    const editingId = e.target.dataset.editingId; // present only when saving an edit
    const card = e.target.closest('.drill-entry');

    const timeSeconds = parseFloat(card.querySelector('.mini-time').value);
    if (!timeSeconds || timeSeconds <= 0) {
      alert('Enter a time before logging.');
      return;
    }

    let inputs = {};
    if (scoringType === 'uspsa_zones') {
      const hits = {};
      card.querySelectorAll('.mini-hit').forEach((input) => {
        hits[input.dataset.zone] = parseInt(input.value) || 0;
      });
      inputs = { hits };
    } else if (scoringType === 'hit_miss') {
      inputs = {
        hitsCount: parseInt(card.querySelector('.mini-hit-count').value) || 0,
        missesCount: parseInt(card.querySelector('.mini-miss-count').value) || 0,
      };
    }

    if (editingId) {
      updateString(drillEntryIndex, editingId, timeSeconds, inputs);
    } else {
      logString(drillEntryIndex, timeSeconds, inputs);
    }
  }
});

// Pressing Enter in any mini-form field submits it, same as tapping the log/save button -
// saves reaching for the button every time at the range.
document.getElementById('drill-entries').addEventListener('keydown', (e) => {
  const isMiniFormInput = e.target.matches('.mini-time, .mini-hit, .mini-hit-count, .mini-miss-count');
  if (e.key !== 'Enter' || !isMiniFormInput) return;

  e.preventDefault();
  const card = e.target.closest('.drill-entry');
  const button = card.querySelector('.log-string-btn');
  if (button) button.click();
});

// ============================================================
// INIT
// ============================================================

renderApp();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js');
}
