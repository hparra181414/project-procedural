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

// Human-readable one-liner for a logged string, used in session, history, and PR views.
function formatStringSummary(s) {
  if (s.scoringType === 'uspsa_zones') {
    return `${s.timeSeconds}s — A:${s.hits.a} C:${s.hits.c} D:${s.hits.d} M:${s.hits.m} NS:${s.hits.ns} — HF:${s.hitFactor}`;
  }
  if (s.scoringType === 'hit_miss') {
    return `${s.timeSeconds}s — ${s.hitsCount} hits / ${s.missesCount} misses — ${s.accuracyPercent}% — Rate:${s.rate}/s`;
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
    const drillNames = session.drillEntries.map((e) => e.drillName).join(', ') || 'No drills logged';
    return `
      <div class="history-card">
        <div class="history-card-header">
          <strong>${session.name || 'Untitled Session'}</strong>
          <span class="history-date">${session.date}</span>
        </div>
        <p class="history-drills">${drillNames}</p>
        <p class="history-count">${totalStrings} string${totalStrings === 1 ? '' : 's'} logged</p>
      </div>
    `;
  }).join('');
}

// ============================================================
// SESSION ACTIONS
// ============================================================

function startSession() {
  const sessions = getSessions();
  const newSession = {
    id: Date.now(),
    date: new Date().toISOString().split('T')[0],
    name: '',
    drillEntries: [],
  };
  sessions.push(newSession);
  saveSessions(sessions);
  setActiveSessionId(newSession.id);
  renderApp();
}

function endSession() {
  setActiveSessionId(null);
  renderApp();
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
function buildMiniForm(drill, index) {
  if (drill.scoringType === 'uspsa_zones') {
    return `
      <input type="number" step="0.01" inputmode="decimal" class="mini-time" placeholder="Time (seconds)">
      <div class="hits-row-mini">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="a" placeholder="A" min="0">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="c" placeholder="C" min="0">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="d" placeholder="D" min="0">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="m" placeholder="M" min="0">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="ns" placeholder="NS" min="0">
      </div>
      <button class="log-string-btn" data-index="${index}" data-scoring="uspsa_zones">Log String</button>
    `;
  }
  if (drill.scoringType === 'hit_miss') {
    return `
      <input type="number" step="0.01" inputmode="decimal" class="mini-time" placeholder="Time (seconds)">
      <div class="hits-row-mini">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit-count" placeholder="Hits" min="0">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-miss-count" placeholder="Misses" min="0">
      </div>
      <button class="log-string-btn" data-index="${index}" data-scoring="hit_miss">Log String</button>
    `;
  }
  // time_only
  return `
    <input type="number" step="0.01" inputmode="decimal" class="mini-time" placeholder="Time (seconds)">
    <button class="log-string-btn" data-index="${index}" data-scoring="time_only">Log String</button>
  `;
}

function renderApp() {
  const session = findActiveSession();
  const startView = document.getElementById('session-start-view');
  const activeView = document.getElementById('active-session-view');
  const historyView = document.getElementById('history-view');
  const prView = document.getElementById('pr-view');

  if (currentView === 'history') {
    startView.classList.add('hidden');
    activeView.classList.add('hidden');
    prView.classList.add('hidden');
    historyView.classList.remove('hidden');
    renderHistoryList();
    return;
  }
  if (currentView === 'prs') {
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
    startView.classList.remove('hidden');
    activeView.classList.add('hidden');
    return;
  }

  startView.classList.add('hidden');
  activeView.classList.remove('hidden');

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
      const isBestTime = stat && s.timeSeconds === stat.bestTime;
      const isBestHF = stat && s.scoringType === 'uspsa_zones' && s.hitFactor === stat.bestHitFactor && s.hitFactor > 0;
      const isBestRate = stat && s.scoringType === 'hit_miss' && s.rate === stat.bestRate && s.rate > 0;
      const badge = (isBestTime || isBestHF || isBestRate) ? ' <span class="pr-badge">🏆 PR</span>' : '';
      return `<li>${formatStringSummary(s)}${badge}</li>`;
    }).join('');

    return `
      <div class="drill-entry" data-index="${index}">
        <h3>${entry.drillName}<span class="discipline-tag">${disciplineTag}</span></h3>
        <ul class="string-list-mini">${stringsHtml}</ul>
        <div class="mini-form">
          ${buildMiniForm(drill, index)}
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

// Event delegation: drill entries and their mini-forms are created dynamically.
document.getElementById('drill-entries').addEventListener('click', (e) => {
  if (!e.target.matches('.log-string-btn')) return;

  const drillEntryIndex = parseInt(e.target.dataset.index);
  const scoringType = e.target.dataset.scoring;
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

  logString(drillEntryIndex, timeSeconds, inputs);
});

// ============================================================
// INIT
// ============================================================

renderApp();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js');
}
